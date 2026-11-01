package com.zipper.app.data.api

import com.google.firebase.auth.FirebaseAuth
import com.zipper.app.BuildConfig
import com.zipper.app.util.Json
import com.zipper.app.util.jsonMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The app's client for the Zipper API — the same business core, the same
 * routes and the same server-side checks the CRM uses (mobile parity).
 *
 * ── IDENTITY: NOTHING NEW ───────────────────────────────────────────────────
 * The person is whoever is signed in to Firebase in this app. Their Firebase ID
 * token is exchanged at `POST /api/auth/signin` for an API session — exactly
 * what `zipper-crm/lib/api.ts` does — and that session is what every call
 * carries. The server decides who it is (staff row, partner record, or nobody:
 * "No account found") and every route still runs its own dependency. Nothing
 * here grants anything; a refusal is shown as a refusal.
 *
 * ── THE TOKEN ───────────────────────────────────────────────────────────────
 * Held in memory only. A cold start mints a fresh one from the Firebase
 * session the app already restores, which is one request — cheaper than
 * keeping a bearer credential on disk. It is dropped the moment the Firebase
 * user changes or signs out, renewed through `POST /api/auth/refresh` when its
 * `renew_at` passes, and given up with `POST /api/auth/signout` on [signOut].
 *
 * ── RETRIES ─────────────────────────────────────────────────────────────────
 * A 401 means the server refused the credential before running the route, so
 * one fresh sign-in and one retry is safe for every method — except on the
 * two-step CODE routes, where a 401 is the verdict on the code and a replay
 * would be counted as a second wrong one ([CODE_ROUTES]). Nothing else is
 * retried: a POST that reached the server is never sent twice from here.
 */
@Singleton
class ApiClient @Inject constructor(
    private val auth: FirebaseAuth,
    /** P1-A3b — the separate Owner work sign-in (never the personal one). */
    private val ownerWork: com.zipper.app.data.work.OwnerWorkFirebase,
) {

    /** `https://host` — no trailing slash. Blank = this build has no API configured. */
    val baseUrl: String = BuildConfig.ZIPPER_API_BASE.trim().trimEnd('/')

    val isConfigured: Boolean get() = baseUrl.isNotEmpty()

    private data class Session(val token: String, val renewAtMs: Long, val expiresAtMs: Long, val uid: String)

    @Volatile private var session: Session? = null
    @Volatile private var sessionUser: Map<String, Any?> = emptyMap()
    private val signInLock = Mutex()
    private val background = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + Dispatchers.IO)

    init {
        // A different person (or nobody) is signed in: the old session is not theirs.
        auth.addAuthStateListener { fa ->
            val uid = fa.currentUser?.uid
            val held = session
            if (held != null && uid != held.uid) {
                session = null
                sessionUser = emptyMap()
                ownerWork.signOut()   // P1-A3b: the Owner work session is not theirs either
                // The person signed out (or another signed in): give the old session up
                // on the server too, so it cannot outlive the app sign-in. Best effort.
                if (isConfigured) background.launch {
                    runCatching { send("POST", "/api/auth/signout", emptyMap(), emptyMap<String, Any?>(), held.token) }
                }
            }
        }
    }

    /** The `user` block of the last sign-in response (role, partner ids …). */
    fun signedInProfile(): Map<String, Any?> = sessionUser

    suspend fun get(path: String, query: Map<String, Any?> = emptyMap()): ApiResult =
        call("GET", path, query, null)

    suspend fun post(path: String, body: Any? = emptyMap<String, Any?>(), query: Map<String, Any?> = emptyMap()): ApiResult =
        call("POST", path, query, body)

    suspend fun patch(path: String, body: Any?): ApiResult = call("PATCH", path, emptyMap(), body)

    suspend fun delete(path: String): ApiResult = call("DELETE", path, emptyMap(), null)

    suspend fun call(method: String, path: String, query: Map<String, Any?>, body: Any?): ApiResult {
        if (!isConfigured) return ApiResult.Failure(ApiError.notConfigured())
        val token = when (val s = ensureSession(forceNew = false)) {
            is SessionOutcome.Ok -> s.token
            is SessionOutcome.Failed -> return ApiResult.Failure(s.error)
        }
        val first = send(method, path, query, withFirebaseSignIn(method, path, body), token)
        if (first is ApiResult.Failure && first.error.status == 401) {
            // A 401 from a two-step CODE route is, almost always, the server
            // judging the code (wrong or reused) — not refusing the session.
            // Replaying it would be charged as a second wrong code (five lock
            // sign-in for 15 minutes), so it goes back to the screen as it is.
            // Only when the session itself is gone (the server refuses it on
            // `/auth/me` too) is it dropped, so the next code is checked on a
            // fresh one — and the person is told the code was never checked.
            if (method == "POST" && path in CODE_ROUTES) {
                if (!sessionRefused(token)) return first
                if (session?.token == token) {
                    session = null
                    sessionUser = emptyMap()
                }
                return ApiResult.Failure(first.error.copy(message = CODE_NOT_CHECKED))
            }
            // Refused before the route ran — mint a new session once and retry.
            session = null
            val again = when (val s = ensureSession(forceNew = true)) {
                is SessionOutcome.Ok -> s.token
                is SessionOutcome.Failed -> return ApiResult.Failure(s.error)
            }
            return send(method, path, query, withFirebaseSignIn(method, path, body), again)
        }
        // P1-A3: an Owner's session from sign-in is limited to the MFA routes
        // until a code is verified. Verify / enrol-confirm answer with a NEW
        // session (the pending one is revoked server-side) — adopt it here, or
        // every later call would still carry the revoked token.
        if (first is ApiResult.Ok && method == "POST") {
            val uid = auth.currentUser?.uid
            val upgraded = when (path) {
                MFA_VERIFY -> first.body
                MFA_ENROL_CONFIRM -> first.body.jsonMap()?.get("session")
                else -> null
            }
            if (uid != null && upgraded != null) signInLock.withLock { adopt(upgraded, uid) }
            // P1-A3b: redeem the minted per-session `mfa_sid` custom token into
            // the separate ownerWork app and confirm it; return a body with the
            // custom token removed (it is a credential and must not reach a screen).
            if (uid != null && (path == MFA_VERIFY || path == MFA_ENROL_CONFIRM || path == MFA_BIND)) {
                return settleOwnerBinding(path, first, uid)
            }
        }
        return first
    }

    /** Is [token] itself refused (401 on `GET /auth/me`, which every session — pending ones included — may call)? */
    private suspend fun sessionRefused(token: String): Boolean {
        val probe = send("GET", "/api/auth/me", emptyMap(), null, token)
        return probe is ApiResult.Failure && probe.error.status == 401
    }

    private suspend fun settleOwnerBinding(path: String, result: ApiResult.Ok, uid: String): ApiResult {
        val body = result.body.jsonMap() ?: return result
        val minted: Map<String, Any?>? = when (path) {
            MFA_BIND -> body
            else -> sessionUser["mfa"].jsonMap()?.get("firestore_binding").jsonMap()
        }
        val settled = settle(minted, uid)
        // The session's user block (read by ownerFirestoreBinding()) holds the settled state only.
        sessionUser["mfa"].jsonMap()?.let { mfa ->
            sessionUser = sessionUser + ("mfa" to (mfa + ("firestore_binding" to settled)))
        }
        // The session token was adopted above; it is a credential and does not
        // travel on to a screen or a view-model (same rule as the custom token).
        val clean: Map<String, Any?> = when (path) {
            MFA_BIND -> settled
            MFA_VERIFY -> (body - "token") + ("user" to sessionUser)
            else -> body + ("session" to (((body["session"].jsonMap() ?: emptyMap()) - "token") + ("user" to sessionUser)))
        }
        return ApiResult.Ok(result.status, clean)
    }

    /** minted → sign ownerWork in with the custom token → confirm with ITS ID token. Fails closed. */
    private suspend fun settle(binding: Map<String, Any?>?, uid: String): Map<String, Any?> {
        if (binding == null) return mapOf("state" to "not_bound")
        val customToken = binding["custom_token"] as? String
        if (binding["state"] != "minted" || customToken.isNullOrBlank()) return binding - "custom_token"
        val idToken = try {
            ownerWork.redeem(customToken)
        } catch (_: Exception) {
            null
        } ?: return mapOf("state" to "failed", "reason" to "The secure Owner sign-in could not be started on this device.")
        val apiToken = session?.token ?: return mapOf("state" to "failed", "reason" to "Signed out.")
        return when (val r = send("POST", MFA_BIND_CONFIRM, emptyMap(), mapOf("firebase_id_token" to idToken), apiToken)) {
            is ApiResult.Ok -> {
                val out = r.body.jsonMap() ?: mapOf("state" to "failed")
                if (out["state"] == "bound") ownerWork.markConfirmed(uid) else ownerWork.signOut()
                out
            }
            is ApiResult.Failure -> {
                ownerWork.signOut()
                mapOf("state" to "failed", "reason" to r.error.message.ifBlank { "Could not confirm the secure sign-in." })
            }
        }
    }

    /**
     * P1-A3b — the Owner MFA calls also carry this app's CURRENT Firebase ID
     * token, so the server can bind THIS sign-in (the app's, separate from the
     * CRM's) for Firestore and Storage. Only these two paths; nothing else ever
     * sends a Firebase token. No token available → sent without one, and the
     * server answers `firestore_binding.state = "missing_token"`.
     */
    private suspend fun withFirebaseSignIn(method: String, path: String, body: Any?): Any? {
        if (method != "POST" || (path != MFA_VERIFY && path != MFA_ENROL_CONFIRM && path != MFA_BIND)) return body
        val idToken = try {
            auth.currentUser?.getIdToken(false)?.await()?.token
        } catch (_: Exception) {
            null
        } ?: return body
        @Suppress("UNCHECKED_CAST")
        val base = (body as? Map<String, Any?>) ?: emptyMap()
        return base + mapOf("firebase_id_token" to idToken, "client" to "android")
    }

    /**
     * P1-A3b — "bound" when this app's sign-in has Owner access in Firestore and
     * Storage; anything else ("missing_token", "failed", "not_bound", or "" for
     * a non-owner) means those stay locked. Read from the last session answer.
     */
    fun ownerFirestoreBinding(): String {
        val mfa = sessionUser["mfa"].jsonMap() ?: return ""
        return (mfa["firestore_binding"].jsonMap()?.get("state") as? String).orEmpty()
    }

    /** True while this is an Owner session that has not passed two-step sign-in. */
    fun ownerMfaPending(): Boolean {
        val u = sessionUser
        if (u["role"] != "owner") return false
        val mfa = u["mfa"].jsonMap() ?: return false
        return mfa["verified"] != true && mfa["required"] != false
    }

    /** Give up the API session (not the Firebase one). Best effort. */
    suspend fun signOut() {
        ownerWork.signOut()   // P1-A3b
        val s = session ?: return
        session = null
        sessionUser = emptyMap()
        if (isConfigured) runCatching { send("POST", "/api/auth/signout", emptyMap(), emptyMap<String, Any?>(), s.token) }
    }

    // ── Session ──────────────────────────────────────────────────────────────

    private sealed interface SessionOutcome {
        data class Ok(val token: String) : SessionOutcome
        data class Failed(val error: ApiError) : SessionOutcome
    }

    private suspend fun ensureSession(forceNew: Boolean): SessionOutcome = signInLock.withLock {
        val user = auth.currentUser ?: return@withLock SessionOutcome.Failed(ApiError.signedOut())
        val now = System.currentTimeMillis()
        val held = session?.takeIf { it.uid == user.uid }
        if (!forceNew && held != null) {
            if (now < held.renewAtMs) return@withLock SessionOutcome.Ok(held.token)
            if (now < held.expiresAtMs + RENEW_GRACE_MS) {
                // Due for renewal: rotate it. On failure fall through to a fresh sign-in.
                val renewed = send("POST", "/api/auth/refresh", emptyMap(), mapOf("token" to held.token), null)
                if (renewed is ApiResult.Ok && adopt(renewed.body, user.uid)) {
                    return@withLock SessionOutcome.Ok(session!!.token)
                }
            }
        }
        val idToken = try {
            user.getIdToken(forceNew).await().token
        } catch (e: Exception) {
            return@withLock SessionOutcome.Failed(ApiError.network(e.message))
        }
        if (idToken.isNullOrBlank()) return@withLock SessionOutcome.Failed(ApiError.signedOut())
        // B3: `client` names this session on `GET /auth/sessions` and is what the
        // Owner MFA binding is minted for; it grants nothing. An Owner's answer
        // is a PENDING session (`user.mfa.verified == false`) — see OwnerMfaGate.
        when (val r = send("POST", "/api/auth/signin", emptyMap(), mapOf("id_token" to idToken, "client" to "android"), null)) {
            is ApiResult.Ok -> if (adopt(r.body, user.uid)) SessionOutcome.Ok(session!!.token)
                else SessionOutcome.Failed(ApiError(0, "The server's sign-in answer could not be read.", ApiError.Kind.Server))
            is ApiResult.Failure -> SessionOutcome.Failed(
                // 401 at sign-in is "this account has no CRM role", not a bad token.
                if (r.error.status == 401) r.error.copy(kind = ApiError.Kind.NoAccount) else r.error
            )
        }
    }

    private fun adopt(body: Any?, uid: String): Boolean {
        val m = body.jsonMap() ?: return false
        val token = m["token"] as? String ?: return false
        val expires = ApiTime.parseIsoMillis(m["expires_at"] as? String) ?: return false
        val renew = ApiTime.parseIsoMillis(m["renew_at"] as? String) ?: expires
        session = Session(token, renew, expires, uid)
        sessionUser = m["user"].jsonMap() ?: emptyMap()
        return true
    }

    // ── HTTP ─────────────────────────────────────────────────────────────────

    private suspend fun send(method: String, path: String, query: Map<String, Any?>, body: Any?, token: String?): ApiResult =
        withContext(Dispatchers.IO) {
            val url = baseUrl + path + queryString(query)
            val conn = try {
                URL(url).openConnection() as HttpURLConnection
            } catch (e: Exception) {
                return@withContext ApiResult.Failure(ApiError.network(e.message))
            }
            try {
                conn.requestMethod = if (method == "PATCH") "POST" else method
                if (method == "PATCH") conn.setRequestProperty("X-HTTP-Method-Override", "PATCH")
                conn.connectTimeout = 15_000
                conn.readTimeout = 45_000
                conn.useCaches = false
                conn.setRequestProperty("Accept", "application/json")
                conn.setRequestProperty("X-Zipper-Client", "android/${BuildConfig.VERSION_CODE}")
                if (token != null) conn.setRequestProperty("Authorization", "Bearer $token")
                if (method == "PATCH") setPatch(conn)
                if (body != null && method != "GET" && method != "DELETE") {
                    val bytes = Json.write(body).toByteArray(Charsets.UTF_8)
                    conn.doOutput = true
                    conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    conn.setFixedLengthStreamingMode(bytes.size)
                    conn.outputStream.use { it.write(bytes) }
                }
                val status = conn.responseCode
                val stream = if (status in 200..299) conn.inputStream else conn.errorStream
                val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
                val parsed = if (text.isBlank()) null else runCatching { Json.parse(text) }.getOrElse { text }
                if (status in 200..299) ApiResult.Ok(status, parsed)
                else ApiResult.Failure(ApiError.fromResponse(status, parsed))
            } catch (e: IOException) {
                ApiResult.Failure(ApiError.network(e.message))
            } catch (e: Exception) {
                ApiResult.Failure(ApiError(0, e.message ?: "Request failed", ApiError.Kind.Network))
            } finally {
                conn.disconnect()
            }
        }

    /**
     * `HttpURLConnection` refuses "PATCH" as a method name. The platform
     * implementation keeps the method in a field, which is set directly — the
     * request then goes out as a real PATCH (two staff routes need it).
     */
    private fun setPatch(conn: HttpURLConnection) {
        try {
            conn.requestMethod = "PATCH"
            return
        } catch (_: Exception) { /* fall through */ }
        var cls: Class<*>? = conn.javaClass
        while (cls != null) {
            try {
                val f = cls.getDeclaredField("method")
                f.isAccessible = true
                f.set(conn, "PATCH")
                return
            } catch (_: NoSuchFieldException) {
                cls = cls.superclass
            }
        }
    }

    private fun queryString(query: Map<String, Any?>): String {
        val parts = query.flatMap { (k, v) ->
            when (v) {
                null -> emptyList()
                is Iterable<*> -> v.filterNotNull().map { "${enc(k)}=${enc(it.toString())}" }
                else -> if (v.toString().isEmpty()) emptyList() else listOf("${enc(k)}=${enc(v.toString())}")
            }
        }
        return if (parts.isEmpty()) "" else "?" + parts.joinToString("&")
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")

    private companion object {
        /** The server accepts a just-expired session for renewal; mirror the CRM's one-day window loosely. */
        const val RENEW_GRACE_MS = 6 * 60 * 60 * 1000L
        const val MFA_VERIFY = "/api/auth/mfa/verify"
        const val MFA_ENROL_CONFIRM = "/api/auth/mfa/enrol/confirm"
        const val MFA_BIND = "/api/auth/mfa/bind"
        const val MFA_BIND_CONFIRM = "/api/auth/mfa/bind/confirm"
        const val MFA_RECOVERY_CODES = "/api/auth/mfa/recovery-codes"

        /** The routes whose 401 is a verdict on a CODE, never replayed (see [call]). */
        val CODE_ROUTES = setOf(MFA_VERIFY, MFA_ENROL_CONFIRM, MFA_RECOVERY_CODES)

        const val CODE_NOT_CHECKED =
            "Your sign-in to the work server had ended, so that code was not checked. Enter a new code."
    }
}

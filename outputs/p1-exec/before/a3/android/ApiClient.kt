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
 * one fresh sign-in and one retry is safe for every method. Nothing else is
 * retried: a POST that reached the server is never sent twice from here.
 */
@Singleton
class ApiClient @Inject constructor(
    private val auth: FirebaseAuth,
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
        val first = send(method, path, query, body, token)
        if (first is ApiResult.Failure && first.error.status == 401) {
            // Refused before the route ran — mint a new session once and retry.
            session = null
            val again = when (val s = ensureSession(forceNew = true)) {
                is SessionOutcome.Ok -> s.token
                is SessionOutcome.Failed -> return ApiResult.Failure(s.error)
            }
            return send(method, path, query, body, again)
        }
        return first
    }

    /** Give up the API session (not the Firebase one). Best effort. */
    suspend fun signOut() {
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
        when (val r = send("POST", "/api/auth/signin", emptyMap(), mapOf("id_token" to idToken), null)) {
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
    }
}

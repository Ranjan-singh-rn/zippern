package com.zipper.app.ui.screens.auth

import com.zipper.app.data.api.ApiError
import com.zipper.app.data.api.ApiTime
import com.zipper.app.util.ObserverAccess

/**
 * APK 20 / spec §8 — OWNER TOTP ON THE APP LOGIN PATH.
 *
 * An Owner who signs in to the Android app (Google, phone, email, quick
 * login) must present a code from their authenticator app before the app lets
 * them past Splash into Main, exactly as the CRM does before its dashboard.
 * The Observer is refused outright ("This account cannot use the app"), and
 * everyone else has no second factor (spec §5.3).
 *
 * ── The sequence, as the backend agent specified it (routers/auth.py) ────────
 *
 *   1. Firebase sign-in → ID token T1 (the personal sign-in; untouched).
 *   2. `POST /api/auth/signin {id_token: T1, client: "android"}` → for an Owner
 *      a PENDING session: `user.mfa.verified == false`; every other Owner route
 *      answers 403 + `X-Zipper-MFA-Required`. A 403 whose `detail.code` is
 *      `observer_denied` is the Observer. (`ApiClient.ensureSession` does this
 *      on the first call; `GET /api/auth/me` is that first call here.)
 *   3. `GET /api/auth/mfa/status` → `{required, enrolled, verified, configured,
 *      locked_until, recovery_codes_left}`.
 *   4. Not enrolled: `POST /api/auth/mfa/enrol/start` → `{secret, otpauth_uri,
 *      expires_at}` (shown ONCE: manual key + copy + "open in authenticator"),
 *      then `POST /api/auth/mfa/enrol/confirm {code, firebase_id_token: T1,
 *      client: "android"}` → `{recovery_codes, session}` (codes shown once).
 *      Enrolled: `POST /api/auth/mfa/verify {code | recovery_code,
 *      firebase_id_token: T1, client: "android"}` → a SessionResponse.
 *      `ApiClient` attaches T1 + client, adopts the new session (token,
 *      renew_at, expires_at — in memory only) and revokes nothing itself.
 *   5. `session.user.mfa.firestore_binding == {state: "minted", custom_token}`
 *      → `ApiClient` signs the separate `ownerWork` Firebase app in with the
 *      custom token and calls `POST /api/auth/mfa/bind/confirm
 *      {firebase_id_token: <ownerWork ID token>}` → `{state: "bound"}`. Any
 *      other state leaves Owner Firestore locked; "Retry unlock" is
 *      `POST /api/auth/mfa/bind {firebase_id_token: T1, client: "android"}`.
 *   6. `POST /api/auth/refresh {token}` at `renew_at` (ApiClient); `POST
 *      /api/auth/signout` on sign-out. Five wrong codes → 429 for 15 minutes.
 *      A 401 from a code route is a verdict on the CODE: `ApiClient` never
 *      replays it (a replay would be charged as a second wrong code).
 *
 * The API session itself — pending or verified — lives in `ApiClient`'s
 * memory only and is never written to disk (no DataStore, no preferences): a
 * process death means the code is asked again, which is the point. Nothing
 * else here is a credential either: the setup key and the recovery codes are
 * shown once and never stored.
 *
 * ── Where it plugs in ────────────────────────────────────────────────────────
 *
 * `OwnerMfaGateHost` wraps the Main destination (navigation/ZipperNavGraph),
 * so every way into the app — cold start, Login, profile setup, face
 * verification, account recovery — passes it. It asks the API only when the
 * SERVER's last answer for this account (`resolveIdentity.crmRole`, cached by
 * SessionManager at sign-in and at every cold start) names an Owner; the
 * decision itself is `GET /api/auth/me` (`role == "owner"`), never a local
 * flag, and the server refuses every Owner route until the code is verified
 * whatever the client does.
 *
 * ── What stays pure ──────────────────────────────────────────────────────────
 *
 * [MfaMachine] is the whole decision: steps, events and `next()`. The
 * view-model only performs the call a step asks for and feeds the answer back,
 * so `OwnerMfaGateTest` runs the entire flow on the JVM. Never log codes,
 * recovery codes, the setup key or tokens (spec §12): nothing in this file or
 * its view-model writes to the log at all.
 */
object OwnerMfaGate {

    const val ME_PATH = "/api/auth/me"
    const val STATUS_PATH = "/api/auth/mfa/status"
    const val ENROL_START_PATH = "/api/auth/mfa/enrol/start"
    const val ENROL_CONFIRM_PATH = "/api/auth/mfa/enrol/confirm"
    const val VERIFY_PATH = "/api/auth/mfa/verify"
    const val BIND_PATH = "/api/auth/mfa/bind"
    const val RECOVERY_CODES_PATH = "/api/auth/mfa/recovery-codes"

    /** The server's role name for an Owner on `/api/auth/me`. */
    const val OWNER = "owner"

    const val OBSERVER_DENIED_MESSAGE = ObserverAccess.DENIED_MESSAGE

    const val NOT_CONFIGURED_MESSAGE =
        "Owner sign-in needs the Zipper work server, and this build has none configured. Use a build with the work server set."

    const val SERVER_NOT_READY_MESSAGE =
        "Two-step sign-in is not configured on the server yet (OWNER_MFA_ENCRYPTION_KEY). Ask whoever runs the deployment; " +
            "until then an Owner cannot use the app."

    /**
     * The CRM's wording (lib/mfaAvailability.ts), for a backend that has no
     * two-step routes (`/auth/mfa/…`) at all. (Never write the slash-star
     * glob in a comment here: Kotlin block comments nest, and it would open one.)
     */
    const val UNAVAILABLE_NOTICE =
        "Two-step sign-in is not available on this server yet. You are signed in with your app sign-in alone, as before. " +
            "The authenticator step turns on by itself once the next backend release is live."

    const val UNREACHABLE_MESSAGE =
        "Couldn't reach the Zipper work server to finish signing in. Check your connection and try again."

    const val WRONG_CODE_MESSAGE = "That code is not right. Check the time on your phone and try again."

    /**
     * Whether the app-login TOTP gate applies to the role the SERVER answered
     * at sign-in (`resolveIdentity.crmRole`). The CRM directory spells an
     * Owner `superadmin` (`crm_directory.CRM_ROLE`); the API spells it `owner`.
     * Both are accepted so a change in the spelling never opens the door.
     */
    fun appliesTo(crmRole: String): Boolean = crmRole.trim().lowercase() in setOf(OWNER, "superadmin")

    /** Wired (APK 20 part 2): the gate blocks exactly the accounts [appliesTo] names. */
    fun enforced(crmRole: String): Boolean = appliesTo(crmRole)
}

/** What the Firestore/Storage binding came to (P1-A3b). Only `bound` unlocks Owner screens that read Firestore. */
data class MfaBinding(val state: String, val reason: String? = null) {
    val bound: Boolean get() = state == "bound"

    companion object {
        val NOT_BOUND = MfaBinding("not_bound")

        /** From a session's `user.mfa.firestore_binding` block (already settled by ApiClient — no custom token). */
        fun from(block: Map<String, Any?>?): MfaBinding {
            val state = (block?.get("state") as? String).orEmpty().ifBlank { "not_bound" }
            return MfaBinding(state, block?.get("reason") as? String)
        }
    }
}

/** The gate's steps. Every one is a screen; `Checking` names the call in flight. */
sealed interface MfaStep {
    enum class Phase { Me, Status, EnrolStart }

    data class Checking(val phase: Phase) : MfaStep

    /** Not an Owner, or already verified on this session: go through. */
    data object NotRequired : MfaStep

    /**
     * The server has no two-step routes (404): say so — the CRM's notice
     * (lib/mfaAvailability) — and go through once the person taps Continue.
     */
    data class Unavailable(val notice: String) : MfaStep

    /** First-time set-up: the key is shown once; the first code confirms it. */
    data class Enrol(
        val secret: String,
        val otpauthUri: String,
        val expiresAt: String?,
        val lockedUntil: String? = null,
        val error: String? = null,
    ) : MfaStep

    /** Enrolled: a 6-digit code, or one recovery code. */
    data class Verify(
        val recoveryCodesLeft: Int,
        val lockedUntil: String? = null,
        val useRecovery: Boolean = false,
        val error: String? = null,
    ) : MfaStep

    /** Shown once after enrolment; the person confirms they saved them. */
    data class RecoveryCodes(val codes: List<String>, val binding: MfaBinding) : MfaStep

    /**
     * Verified. [binding] says whether Owner Firestore screens are unlocked too.
     * An unbound result is said once — the CRM's "Signed in — some screens are
     * locked", with Retry unlock — and passes when [acknowledged].
     */
    data class Done(val binding: MfaBinding, val acknowledged: Boolean = false) : MfaStep

    /** Cannot continue; the only way out is to sign out. */
    data class Blocked(val message: String) : MfaStep

    /** A transient failure: retry from the start, or sign out. */
    data class Trouble(val message: String) : MfaStep
}

/** What happened: a server answer, or the person's choice. */
sealed interface MfaEvent {
    data class MeLoaded(val role: String?, val mfaVerified: Boolean?) : MfaEvent
    data class StatusLoaded(
        val enrolled: Boolean?, val verified: Boolean, val configured: Boolean?,
        val lockedUntil: String?, val recoveryCodesLeft: Int,
    ) : MfaEvent
    data class EnrolStarted(val secret: String, val otpauthUri: String, val expiresAt: String?) : MfaEvent
    /** Verify or enrol-confirm succeeded; [recoveryCodes] only on enrolment. */
    data class CodeAccepted(val binding: MfaBinding, val recoveryCodes: List<String> = emptyList()) : MfaEvent
    /** Any call of the step failed; [status] is the HTTP status (0 = network / not configured). */
    data class Failed(val status: Int, val message: String, val kind: ApiError.Kind, val code: String? = null) : MfaEvent
    data object ToggleRecovery : MfaEvent
    data object RecoveryCodesSaved : MfaEvent
    data class Rebound(val binding: MfaBinding) : MfaEvent
    data object Retry : MfaEvent
    /** "Continue" on a notice (no two-step routes on the server; Owner screens still locked). */
    data object Continue : MfaEvent

    companion object {
        fun failed(e: ApiError) = Failed(e.status, e.message, e.kind, e.code)
    }
}

/** The pure state machine. `next` never performs a call; the view-model acts on the step it returns. */
object MfaMachine {

    val start: MfaStep = MfaStep.Checking(MfaStep.Phase.Me)

    fun next(step: MfaStep, event: MfaEvent): MfaStep = when (step) {
        is MfaStep.Checking -> when (step.phase) {
            MfaStep.Phase.Me -> afterMe(event)
            MfaStep.Phase.Status -> afterStatus(step, event)
            MfaStep.Phase.EnrolStart -> afterEnrolStart(event)
        }
        is MfaStep.Enrol -> when (event) {
            is MfaEvent.CodeAccepted ->
                if (event.recoveryCodes.isNotEmpty()) MfaStep.RecoveryCodes(event.recoveryCodes, event.binding)
                else MfaStep.Done(event.binding)
            is MfaEvent.Failed -> when (event.status) {
                410 -> MfaStep.Checking(MfaStep.Phase.EnrolStart)           // the set-up expired: a new key
                409 -> MfaStep.Checking(MfaStep.Phase.Status)               // set up from another window: re-read
                429 -> step.copy(error = event.message)                     // locked; status refresh fills locked_until
                401, 400, 422 -> step.copy(error = event.message)
                else -> if (transient(event)) MfaStep.Trouble(event.message) else MfaStep.Blocked(event.message)
            }
            is MfaEvent.StatusLoaded -> step.copy(lockedUntil = event.lockedUntil)
            is MfaEvent.Retry -> MfaMachine.start
            else -> step
        }
        is MfaStep.Verify -> when (event) {
            is MfaEvent.CodeAccepted -> MfaStep.Done(event.binding)
            is MfaEvent.Failed -> when (event.status) {
                409 -> MfaStep.Checking(MfaStep.Phase.Status)               // "not set up yet": re-read, then enrol
                429 -> step.copy(error = event.message)
                401, 400, 422 -> step.copy(error = event.message)
                else -> if (transient(event)) MfaStep.Trouble(event.message) else MfaStep.Blocked(event.message)
            }
            is MfaEvent.ToggleRecovery -> step.copy(useRecovery = !step.useRecovery, error = null)
            is MfaEvent.StatusLoaded -> step.copy(lockedUntil = event.lockedUntil, recoveryCodesLeft = event.recoveryCodesLeft)
            is MfaEvent.Retry -> MfaMachine.start
            else -> step
        }
        // The codes screen already says whether Owner screens were unlocked
        // (and offers Retry unlock), so "saved" is also the acknowledgement.
        is MfaStep.RecoveryCodes -> when (event) {
            is MfaEvent.RecoveryCodesSaved -> MfaStep.Done(step.binding, acknowledged = true)
            is MfaEvent.Rebound -> step.copy(binding = event.binding)
            else -> step
        }
        is MfaStep.Done -> when (event) {
            is MfaEvent.Rebound -> step.copy(binding = event.binding)
            is MfaEvent.Continue -> step.copy(acknowledged = true)
            else -> step
        }
        is MfaStep.Trouble -> when (event) {
            is MfaEvent.Retry -> MfaMachine.start
            else -> step
        }
        is MfaStep.Unavailable -> when (event) {
            is MfaEvent.Continue -> MfaStep.NotRequired
            else -> step
        }
        is MfaStep.Blocked, MfaStep.NotRequired -> step
    }

    private fun afterMe(event: MfaEvent): MfaStep = when (event) {
        is MfaEvent.MeLoaded -> when {
            event.role == "observer" -> MfaStep.Blocked(OwnerMfaGate.OBSERVER_DENIED_MESSAGE)
            event.role != OwnerMfaGate.OWNER -> MfaStep.NotRequired
            event.mfaVerified == true -> MfaStep.NotRequired
            else -> MfaStep.Checking(MfaStep.Phase.Status)
        }
        is MfaEvent.Failed -> when {
            // The server refused the Observer by name at sign-in.
            ObserverAccess.isDenied(event.code) -> MfaStep.Blocked(OwnerMfaGate.OBSERVER_DENIED_MESSAGE)
            // No staff or partner account behind this login: not an Owner.
            event.kind == ApiError.Kind.NoAccount -> MfaStep.NotRequired
            // This build cannot ask the question. Fail closed, and say why.
            event.kind == ApiError.Kind.NotConfigured -> MfaStep.Blocked(OwnerMfaGate.NOT_CONFIGURED_MESSAGE)
            event.kind == ApiError.Kind.SignedOut -> MfaStep.Blocked(event.message)
            transient(event) -> MfaStep.Trouble(OwnerMfaGate.UNREACHABLE_MESSAGE)
            // 403: deactivated, suspended, restricted — the server's sentence, and out.
            else -> MfaStep.Blocked(event.message)
        }
        is MfaEvent.Retry -> MfaMachine.start
        else -> MfaStep.Checking(MfaStep.Phase.Me)
    }

    private fun afterStatus(step: MfaStep.Checking, event: MfaEvent): MfaStep = when (event) {
        is MfaEvent.StatusLoaded -> when {
            event.verified -> MfaStep.NotRequired
            event.configured == false -> MfaStep.Blocked(OwnerMfaGate.SERVER_NOT_READY_MESSAGE)
            event.enrolled == true -> MfaStep.Verify(event.recoveryCodesLeft, event.lockedUntil)
            else -> MfaStep.Checking(MfaStep.Phase.EnrolStart)
        }
        is MfaEvent.Failed -> when {
            // Audit C-3 (CRM lib/mfaAvailability): no such route = no second step on this server.
            event.status == 404 || event.status == 405 -> MfaStep.Unavailable(OwnerMfaGate.UNAVAILABLE_NOTICE)
            transient(event) -> MfaStep.Trouble(OwnerMfaGate.UNREACHABLE_MESSAGE)
            else -> MfaStep.Blocked(event.message)
        }
        is MfaEvent.Retry -> MfaMachine.start
        else -> step
    }

    private fun afterEnrolStart(event: MfaEvent): MfaStep = when (event) {
        is MfaEvent.EnrolStarted -> MfaStep.Enrol(event.secret, event.otpauthUri, event.expiresAt)
        is MfaEvent.Failed -> when {
            event.status == 409 -> MfaStep.Verify(0)                         // already set up: ask for the code
            event.status == 503 -> MfaStep.Blocked(OwnerMfaGate.SERVER_NOT_READY_MESSAGE)
            transient(event) -> MfaStep.Trouble(OwnerMfaGate.UNREACHABLE_MESSAGE)
            else -> MfaStep.Blocked(event.message)
        }
        is MfaEvent.Retry -> MfaMachine.start
        else -> MfaStep.Checking(MfaStep.Phase.EnrolStart)
    }

    /** A failure that says nothing about the account: worth a retry, never a bypass. */
    private fun transient(e: MfaEvent.Failed): Boolean =
        e.kind == ApiError.Kind.Network || e.kind == ApiError.Kind.Server || e.kind == ApiError.Kind.Unavailable ||
            e.status in 500..599

    /**
     * A step the gate lets through. A notice (no two-step routes on the
     * server, or Owner screens still locked after a verified code) passes once
     * it has been read; nothing refused or pending ever does.
     */
    fun passes(step: MfaStep): Boolean = when (step) {
        is MfaStep.NotRequired -> true
        is MfaStep.Done -> step.binding.bound || step.acknowledged
        else -> false
    }

    /**
     * Spec §8: the Observer is refused outright — signed out at once with
     * "This account cannot use the app", nothing to press. Every other
     * refusal is read on the screen first and ends with the person's "Sign out".
     */
    fun signsOutAtOnce(step: MfaStep): Boolean =
        step is MfaStep.Blocked && step.message == OwnerMfaGate.OBSERVER_DENIED_MESSAGE

    // ── Codes (pure) ─────────────────────────────────────────────────────────

    /** Digits only, as typed into an authenticator field. */
    fun normaliseCode(raw: String): String = raw.filter { it.isDigit() }

    /** The server accepts 6–8 digits (`DIGITS`, ±1 step). */
    fun codeLooksValid(raw: String): Boolean = normaliseCode(raw).length in 6..8

    /** Recovery codes are compared case-insensitively with separators removed (`_norm_recovery`). */
    fun normaliseRecovery(raw: String): String = raw.uppercase().filter { it.isLetterOrDigit() }

    fun recoveryLooksValid(raw: String): Boolean = normaliseRecovery(raw).length in 8..20

    /** The body `POST /mfa/verify` wants for what was typed. */
    fun verifyBody(raw: String, useRecovery: Boolean): Map<String, Any?> =
        if (useRecovery) mapOf("recovery_code" to normaliseRecovery(raw)) else mapOf("code" to normaliseCode(raw))

    /** The key, grouped in fours so it can be read into another device. Display only. */
    fun groupedSecret(secret: String): String = secret.trim().chunked(4).joinToString(" ")

    /** Milliseconds of lock left at [nowMs]; 0 when not locked or unparseable. */
    fun lockRemainingMs(lockedUntilIso: String?, nowMs: Long): Long {
        val until = ApiTime.parseIsoMillis(lockedUntilIso) ?: return 0L
        return (until - nowMs).coerceAtLeast(0L)
    }

    /** "Locked for 12 more minutes" / "" when not locked. */
    fun lockSentence(lockedUntilIso: String?, nowMs: Long): String {
        val left = lockRemainingMs(lockedUntilIso, nowMs)
        if (left <= 0L) return ""
        val minutes = ((left + 59_999L) / 60_000L).toInt()
        return if (minutes <= 1) "Too many wrong codes. Try again in a minute." else "Too many wrong codes. Try again in $minutes minutes."
    }

    // ── Reading server answers (pure) ────────────────────────────────────────

    fun meEvent(body: Any?): MfaEvent {
        val m = body as? Map<*, *>
        return MfaEvent.MeLoaded(role = m?.get("role") as? String, mfaVerified = m?.get("mfa_verified") as? Boolean)
    }

    fun statusEvent(body: Any?): MfaEvent {
        val m = body as? Map<*, *>
        return MfaEvent.StatusLoaded(
            enrolled = m?.get("enrolled") as? Boolean,
            verified = m?.get("verified") == true,
            configured = m?.get("configured") as? Boolean,
            lockedUntil = m?.get("locked_until") as? String,
            recoveryCodesLeft = (m?.get("recovery_codes_left") as? Number)?.toInt() ?: 0,
        )
    }

    fun enrolStartEvent(body: Any?): MfaEvent {
        val m = body as? Map<*, *>
        val secret = (m?.get("secret") as? String).orEmpty()
        val uri = (m?.get("otpauth_uri") as? String).orEmpty()
        if (secret.isBlank()) return MfaEvent.Failed(0, "The server's set-up answer could not be read.", ApiError.Kind.Server)
        return MfaEvent.EnrolStarted(secret, uri, m?.get("expires_at") as? String)
    }

    /** `POST /mfa/verify` → SessionResponse (ApiClient has settled `user.mfa.firestore_binding`). */
    fun verifyEvent(body: Any?): MfaEvent {
        val user = (body as? Map<*, *>)?.get("user") as? Map<*, *>
        return MfaEvent.CodeAccepted(bindingOf(user))
    }

    /** `POST /mfa/enrol/confirm` → `{recovery_codes, session}`. */
    fun enrolConfirmEvent(body: Any?): MfaEvent {
        val m = body as? Map<*, *>
        val codes = (m?.get("recovery_codes") as? List<*>).orEmpty().mapNotNull { it as? String }
        val user = (m?.get("session") as? Map<*, *>)?.get("user") as? Map<*, *>
        return MfaEvent.CodeAccepted(bindingOf(user), codes)
    }

    /** `POST /mfa/bind` → the settled binding (ApiClient redeemed and confirmed it). */
    fun bindEvent(body: Any?): MfaEvent {
        @Suppress("UNCHECKED_CAST")
        return MfaEvent.Rebound(MfaBinding.from(body as? Map<String, Any?>))
    }

    @Suppress("UNCHECKED_CAST")
    private fun bindingOf(user: Map<*, *>?): MfaBinding {
        val mfa = user?.get("mfa") as? Map<*, *>
        return MfaBinding.from(mfa?.get("firestore_binding") as? Map<String, Any?>)
    }
}

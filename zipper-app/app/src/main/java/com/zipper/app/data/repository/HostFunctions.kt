package com.zipper.app.data.repository

import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.FirebaseFunctionsException
import com.zipper.app.util.ServerRefusals
import kotlinx.coroutines.tasks.await
import com.zipper.app.util.SessionManager
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Account state the user is not allowed to declare about themselves.
 *
 * Becoming a host, holding a verified badge, and carrying a role badge are all
 * claims the platform makes about a person, not claims a person makes about
 * themselves. Each used to be a direct write to the user's own document:
 * `isHost`, `agencyId`, `callRateBeans`, `isAgent`, `crmRole`. The Firestore
 * rules now refuse every one of them, which is what makes these calls the only
 * route.
 */
@Singleton
class HostFunctions @Inject constructor(
    private val functions: FirebaseFunctions,
    /** Phase 1A (SESSION-001): the active session id travels with every call. */
    private val sessionManager: SessionManager,
) {

    sealed interface Result<out T> {
        data class Ok<T>(val value: T) : Result<T>
        /**
         * [detail] is the server's own name for the refusal, from the
         * `details.code` of its `HttpsError` — the same field
         * `MoneyFunctions.Result.Failed.detail` reads. C8: `recoverAccount`
         * answers `RECOVERY_EXPIRED` there once the window has closed, which
         * the status code (`failed-precondition`) cannot tell apart from any
         * other precondition. Empty for every call that does not send one.
         */
        data class Failed(
            val code: String,
            val userMessage: String,
            val detail: String = "",
        ) : Result<Nothing>
    }

    // ── Referral code ────────────────────────────────────────────────────────

    /** Why a code was refused. The server does not say which field mismatched. */
    /**
     * Why a code was refused.
     *
     * Every value here must also be a reason `checkReferralCode` can return in
     * functions/src/hosts.ts, and every reason it can return must appear here —
     * the two lists drifting is how a real refusal becomes [UNKNOWN] and the
     * person is told "something went wrong" about a situation the server
     * described precisely.
     */
    enum class ReferralRefusal {
        NOT_FOUND, ALREADY_USED, REJECTED, NOT_APPROVED, ACCOUNT_MISMATCH,
        /** Banned, suspended, or pending deletion. Not about the code at all. */
        RESTRICTED,
        /** Already a host somewhere else. Moving agency is a staff operation. */
        OTHER_AGENCY,
        /** Phase 1A (AUTH-002): a guest account cannot become a host. */
        GUEST,
        /** C1 (B04): this account's Host role was revoked — reinstatement, not a code. */
        ROLE_REVOKED,
        UNKNOWN,
    }

    sealed interface CodeCheck {
        data class Valid(val agencyName: String) : CodeCheck
        data class Invalid(val reason: ReferralRefusal) : CodeCheck
        data class Failed(val message: String) : CodeCheck
    }

    /**
     * Pre-flight check for the code field, before the user commits.
     *
     * The app used to query `hostApplications` for this. That collection holds
     * every host's bank account, date of birth and KYC document URLs, so the
     * rule that allowed the lookup allowed reading all of it.
     */
    suspend fun checkReferralCode(
        code: String,
        phone: String = "",
        email: String = "",
    ): CodeCheck = when (
        val res = call("checkReferralCode", buildMap {
            put("referralCode", code)
            if (phone.isNotBlank()) put("phone", phone)
            if (email.isNotBlank()) put("email", email)
        }) { it }
    ) {
        is Result.Ok -> {
            val m = res.value
            if (m["valid"] == true) {
                CodeCheck.Valid(m["agencyName"] as? String ?: "")
            } else {
                CodeCheck.Invalid(
                    when (m["reason"] as? String) {
                        "not_found"        -> ReferralRefusal.NOT_FOUND
                        "already_used"     -> ReferralRefusal.ALREADY_USED
                        "rejected"         -> ReferralRefusal.REJECTED
                        "not_approved"     -> ReferralRefusal.NOT_APPROVED
                        "account_mismatch" -> ReferralRefusal.ACCOUNT_MISMATCH
                        "restricted"       -> ReferralRefusal.RESTRICTED
                        "other_agency"     -> ReferralRefusal.OTHER_AGENCY
                        "guest"            -> ReferralRefusal.GUEST
                        "role_revoked"     -> ReferralRefusal.ROLE_REVOKED
                        else               -> ReferralRefusal.UNKNOWN
                    }
                )
            }
        }
        is Result.Failed -> CodeCheck.Failed(res.userMessage)
    }

    // ── Activation ───────────────────────────────────────────────────────────

    data class Activation(val agencyId: String, val callRateBeans: Long, val alreadyActivated: Boolean)

    /**
     * Redeem the code and become a host.
     *
     * The rate is not sent. The server takes it from the agency's application
     * and clamps it to the CRM's min/max band — the agency dashboard accepts
     * any number, and it should not be able to set one the economy forbids.
     */
    suspend fun activateHost(
        referralCode: String,
        phone: String = "",
        email: String = "",
    ): Result<Activation> = call("activateHost", buildMap {
        put("referralCode", referralCode)
        if (phone.isNotBlank()) put("phone", phone)
        if (email.isNotBlank()) put("email", email)
    }) { m ->
        Activation(
            agencyId = m["agencyId"] as? String ?: "",
            callRateBeans = (m["callRateBeans"] as? Number)?.toLong() ?: 0L,
            alreadyActivated = m["alreadyActivated"] as? Boolean ?: false,
        )
    }

    // ── Call rate ────────────────────────────────────────────────────────────

    data class CallRate(
        val callRateBeans: Long,
        val level: Int,
        val minCallRateBeans: Long,
        val maxCallRateBeans: Long,
        /** The server lowered the rate to the ceiling this host's level allows. */
        val clamped: Boolean,
    )

    /**
     * Set what a minute of this host's time costs.
     *
     * Was a direct write of `callRateBeans` onto the user document, gated by a
     * security rule that compared it against one platform-wide maximum of 700.
     * The ceiling is not platform-wide — it comes from the host's rung on the
     * level ladder and goes to 2,400 — and a rule cannot read the ladder. So a
     * host who had earned their way up saw a slider offering a rate the write
     * then refused, with nothing to explain it.
     *
     * The server reads the ladder, clamps to the host's own rung and returns
     * what it actually wrote. Trust [CallRate.callRateBeans] over the requested
     * value: [CallRate.clamped] says the two differ.
     */
    suspend fun setCallRate(rateBeans: Int): Result<CallRate> =
        call("setCallRate", mapOf("callRateBeans" to rateBeans)) { m ->
            CallRate(
                callRateBeans    = (m["callRateBeans"] as? Number)?.toLong() ?: 0L,
                level            = (m["level"] as? Number)?.toInt() ?: 0,
                minCallRateBeans = (m["minCallRateBeans"] as? Number)?.toLong() ?: 0L,
                maxCallRateBeans = (m["maxCallRateBeans"] as? Number)?.toLong() ?: 0L,
                clamped          = m["clamped"] as? Boolean ?: false,
            )
        }

    // ── Verification ─────────────────────────────────────────────────────────

    enum class VerificationStatus { PENDING_CAPTURE, PENDING_MANUAL, VERIFIED, REJECTED, UNKNOWN }

    data class CaptureOutcome(val status: VerificationStatus, val aiScore: Double?)

    /**
     * Submit the live capture.
     *
     * Takes a Storage URL, not a similarity score. An on-device model can tell
     * the host whether their capture is usable before they press submit — good
     * UX, and free — but a score computed on the handset and posted here is a
     * number the handset chose, and this badge is what releases payouts.
     */
    suspend fun submitHostCapture(captureUrl: String): Result<CaptureOutcome> =
        call("submitHostCapture", mapOf("captureUrl" to captureUrl)) { m ->
            CaptureOutcome(
                status = when (m["status"] as? String) {
                    "pending_capture" -> VerificationStatus.PENDING_CAPTURE
                    "pending_manual"  -> VerificationStatus.PENDING_MANUAL
                    "verified"        -> VerificationStatus.VERIFIED
                    "rejected"        -> VerificationStatus.REJECTED
                    else              -> VerificationStatus.UNKNOWN
                },
                aiScore = (m["aiScore"] as? Number)?.toDouble(),
            )
        }

    // ── Likes ────────────────────────────────────────────────────────────────

    /**
     * @return true if the profile is liked after the call.
     *
     * Idempotent: liking something already liked changes nothing and returns
     * true, rather than adding a second like.
     */
    suspend fun toggleLike(targetUid: String, like: Boolean): Result<Boolean> =
        call("toggleLike", mapOf("targetUid" to targetUid, "like" to like)) { m ->
            m["liked"] as? Boolean ?: like
        }

    // ── Roles ────────────────────────────────────────────────────────────────

    /**
     * Refresh role badges after sign-in.
     *
     * Additive only — it never removes a role. Revoking one is a CRM action
     * with an audit trail, not a side effect of opening the app.
     */
    suspend fun syncMyRoles(): Result<List<String>> =
        call("syncMyRoles", emptyMap()) { m ->
            @Suppress("UNCHECKED_CAST")
            (m["roles"] as? List<String>) ?: emptyList()
        }

    // ── Account deletion and recovery ────────────────────────────────────────

    /**
     * Undo a deletion request, within the recovery window (60 days; after the
     * due date the server refuses with `details.code = RECOVERY_EXPIRED`).
     *
     * Server-side so that it is recorded and so the rules never have to let a
     * user edit their own deletion status.
     */
    suspend fun recoverAccount(): Result<Boolean> =
        call("recoverAccount", emptyMap()) { m -> m["recovered"] as? Boolean ?: false }

    /**
     * Destroy the account now instead of waiting out the grace period.
     *
     * Only valid from the deleted state — otherwise this would be a one-call
     * account destructor reachable by anything holding a token.
     */
    suspend fun purgeMyAccountNow(): Result<Boolean> =
        call("purgeMyAccountNow", emptyMap()) { m -> m["purged"] as? Boolean ?: false }

    // ── Plumbing ─────────────────────────────────────────────────────────────

    @Suppress("UNCHECKED_CAST")
    private suspend fun <T> call(
        name: String,
        payload: Map<String, Any>,
        parse: (Map<String, Any?>) -> T,
    ): Result<T> = try {
        val res = functions.getHttpsCallable(name).call(sessionManager.withSession(payload)).await()
        val map = res.data as? Map<String, Any?> ?: emptyMap()
        Result.Ok(parse(map))
    } catch (e: FirebaseFunctionsException) {
        // P0-1: a session refusal also signs this device out (SessionViewModel).
        ServerRefusals.report(e)
        Result.Failed(e.code.name, e.message ?: "Something went wrong.", detailCode(e))
    } catch (e: Exception) {
        Result.Failed("unavailable", "Could not reach the server. Check your connection.")
    }

    /**
     * `details.code` off the `HttpsError`, or "" — never a throw on a failure
     * path. The same reading as `MoneyFunctions.detailCode`.
     */
    @Suppress("UNCHECKED_CAST")
    private fun detailCode(e: FirebaseFunctionsException): String = try {
        ((e.details as? Map<String, Any?>)?.get("code") as? String).orEmpty()
    } catch (_: Exception) {
        ""
    }
}

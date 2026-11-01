package com.zipper.app.util

/**
 * A-9 (APK 20): does this device's sign-in predate the account's cut-off?
 *
 * `users/{uid}.credentialsValidAfter` is stamped by `startMobileSession` with
 * the new device's own `auth_time` (seconds), and moved forward by a
 * suspension, a deletion request or a security reset. A Firebase ID token
 * whose `auth_time` is OLDER belongs to a sign-in the account has moved past:
 * the displaced phone, or a stolen token. The rules' `sessionCurrent()` has
 * always refused such a token's direct writes, and every protected callable
 * refuses it (`assertActiveSession`); until now the APP never read the field,
 * so a stale device sat in Main with every write silently refused and no
 * sentence explaining why.
 *
 * Mirrors `signInPredatesCutoff` in functions/src/mobileSession.ts exactly,
 * including the clock-skew allowance, so the device and the server agree:
 *
 *   * no cut-off recorded → nothing to compare (an account that never started
 *     a mobile session);
 *   * a cut-off recorded and NO usable auth time → stale (a token always
 *     carries one; its absence is not a reason to wave the device through);
 *   * an auth time in the future beyond the skew → stale (a clock nobody can
 *     reason about);
 *   * equal passes: that is the device that set the cut-off.
 *
 * Pure. Seconds in, boolean out.
 */
object SessionCutoff {

    /** Same value as `CUTOFF_CLOCK_SKEW_SECONDS` on the server. */
    const val CLOCK_SKEW_SECONDS = 60L

    /** The sentence on the login screen after a cut-off sign-out. */
    const val SIGNED_OUT_MESSAGE =
        "You were signed out because this sign-in is older than your account allows — " +
            "it was opened elsewhere, or its security was reset. Please sign in again."

    fun signInPredatesCutoff(validAfterSec: Long?, authTimeSec: Long?, nowSec: Long): Boolean {
        val validAfter = validAfterSec ?: 0L
        if (validAfter <= 0L) return false
        val authTime = authTimeSec ?: 0L
        if (authTime <= 0L) return true
        if (authTime > nowSec + CLOCK_SKEW_SECONDS) return true
        return authTime < validAfter
    }

    /** Firestore hands the field back as Long, Double, or (never, but) a String; read whatever arrived. */
    fun validAfterOf(raw: Any?): Long? = when (raw) {
        is Number -> raw.toLong().takeIf { it > 0L }
        is String -> raw.trim().toLongOrNull()?.takeIf { it > 0L }
        else -> null
    }
}

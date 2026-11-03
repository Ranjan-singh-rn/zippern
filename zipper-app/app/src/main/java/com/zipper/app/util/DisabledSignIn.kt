package com.zipper.app.util

import com.zipper.app.data.repository.RestrictionKind

/**
 * QA #55 — a sign-in that Firebase itself refused because the login is
 * switched off.
 *
 * A ban disables the Firebase login (`set_user_disabled`), so somebody banned
 * while signed OUT is refused by Firebase before any of our code runs:
 * `FirebaseAuthInvalidUserException`, error code `ERROR_USER_DISABLED`, message
 * "The user account has been disabled by an administrator." That message is
 * what the person used to see — no Banned screen, no reason, no appeal.
 *
 * The answer now is the Banned screen. Its reason comes from the server's
 * `quickLoginRestriction` when this handset holds the account's quick-login key
 * (the proof that survives a ban); otherwise the screen says the account is
 * banned, where the reason was sent, and offers the appeals that do not need
 * the key (the public web page and support). The login itself stays disabled.
 *
 * Pure: no Android, no Firebase types — the caller passes the error code and
 * the server's answer, so the mapping runs in a JVM unit test.
 */
object DisabledSignIn {

    /** Firebase's error code for a disabled account (`FirebaseAuthException.errorCode`). */
    const val ERROR_USER_DISABLED = "ERROR_USER_DISABLED"

    /** Is this sign-in failure Firebase refusing a disabled (banned) login? */
    fun isAccountDisabled(errorCode: String?): Boolean = errorCode?.trim() == ERROR_USER_DISABLED

    /** Where the screen points when it could not show the reason itself. */
    const val REASON_ELSEWHERE =
        "Sign-in to this account is switched off. We can show the reason only on a phone " +
            "that was signed in to this account before, or in the email we sent when it " +
            "happened (if the account has a verified email). You can still appeal below."

    /** The screen to show, from what (if anything) the server said. */
    data class Verdict(
        val kind: RestrictionKind,
        /** Blank when the server could not be asked or would not say (not this device's account). */
        val reason: String,
        /** A suspension's end; 0 otherwise. */
        val untilMillis: Long,
        /** The account the restriction is about, when the device proved it; "" otherwise. */
        val uid: String,
        /**
         * May the device-key appeal (`submitAccountAppeal`) speak for this
         * restriction? Only when the server confirmed the key's account IS the
         * one that was tried — otherwise an appeal would be filed for whichever
         * account the key belongs to.
         */
        val deviceKeyAppeal: Boolean,
    )

    /**
     * [outcome] / [reason] / [message] / [suspendedUntilMs] / [uid] are the
     * server's answer; null [outcome] means it could not be asked (no key on
     * this phone, no network). A disabled login is a ban unless the server
     * says it is a suspension or a barred device.
     */
    fun verdict(
        outcome: String?,
        uid: String = "",
        reason: String = "",
        message: String = "",
        suspendedUntilMs: Long? = null,
    ): Verdict = when (outcome?.trim()) {
        "banned" -> Verdict(RestrictionKind.Account, reason.ifBlank { message }, 0L, uid, deviceKeyAppeal = true)
        "suspended" -> Verdict(RestrictionKind.Suspension, reason.ifBlank { message }, suspendedUntilMs ?: 0L, uid, deviceKeyAppeal = true)
        "device_banned" -> Verdict(RestrictionKind.Device, message, 0L, "", deviceKeyAppeal = false)
        // other_account, not_restricted, refused, null: Firebase said the login
        // is disabled, and only a ban does that — but nothing more is known.
        else -> Verdict(RestrictionKind.Account, "", 0L, "", deviceKeyAppeal = false)
    }
}

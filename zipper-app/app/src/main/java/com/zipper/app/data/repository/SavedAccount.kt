package com.zipper.app.data.repository

import com.zipper.app.util.IstTime
import com.zipper.app.util.QuickLoginStore

/**
 * B10 (4 Nov 2026) — one row of the account switcher and of the login screen's list: what may be SHOWN about an
 * account this device remembers.
 *
 * Deliberately no token. The secret stays inside [QuickLoginStore] and [AuthRepository]; a screen gets a name, a
 * photo and the same short ID the profile screens show ("ID 1A2B3C4D", the first eight characters of the uid), and
 * nothing it could sign in with.
 *
 * Pure — `SavedAccountTest` runs it on the JVM.
 */
data class SavedAccount(
    /** "" only for the one blob saved before B10, until its first redemption files it under its account. */
    val uid: String,
    val displayName: String,
    val photoUrl: String,
    /** The account signed in right now (the switcher's tick). */
    val isCurrent: Boolean = false,
) {
    /** What the row is called — a guest has no name, and "Continue as " with nothing after it read as a bug. */
    val title: String get() = displayName.trim().ifEmpty { "Guest" }

    /** The profile screens' ID, so the person recognises the account. Never the secret. */
    val idLabel: String get() = if (uid.isBlank()) "" else "ID ${uid.take(8).uppercase()}"

    companion object {
        const val ALREADY_SIGNED_IN = "You're already using this account."

        /**
         * The rows, from what the store holds (most recent first): one per account, the signed-in one first, the
         * rest in the order they were last used.
         */
        fun rowsOf(saved: List<QuickLoginStore.Saved>, currentUid: String?): List<SavedAccount> {
            val seen = HashSet<String>()
            val rows = saved.sortedByDescending { it.savedAtMs }.mapNotNull { s ->
                if (!seen.add(s.uid)) null
                else SavedAccount(
                    uid = s.uid,
                    displayName = s.displayName,
                    photoUrl = s.photoUrl,
                    isCurrent = !currentUid.isNullOrBlank() && s.uid == currentUid,
                )
            }
            // Stable: the current account to the top, everybody else keeps their order.
            return rows.sortedByDescending { it.isCurrent }
        }

        /**
         * What a switch ended in, decided from who was signed in before and after it — never from the result type
         * alone, because the result of a refused switch and of a failed one can be the same `Error`, and only one
         * of them still has the old account signed in.
         */
        fun afterSwitch(before: String?, after: String?, result: AuthResult, leavingName: String): SwitchOutcome =
            when {
                // The new account is in. Start the app again as it — Splash runs every gate a cold start runs.
                !after.isNullOrBlank() && after != before -> SwitchOutcome.OpenApp
                // Nobody is signed in (the new session failed after the old one was closed). The old account was
                // signed out the ordinary way, so it is on the sign-in screen one tap away.
                after.isNullOrBlank() -> SwitchOutcome.ToLogin(messageFor(result).ifBlank { COULD_NOT_SWITCH })
                // Refused before anything changed: still signed in as before. Say why, and that nothing changed.
                else -> SwitchOutcome.StayHere(
                    listOf(messageFor(result).ifBlank { COULD_NOT_SWITCH }, stillSignedIn(leavingName))
                        .joinToString(" "),
                )
            }

        const val COULD_NOT_SWITCH = "That account could not be opened just now."
        const val SIGN_IN_AGAIN =
            "That account's saved sign-in has stopped working (it expired, was signed out everywhere, or was opened " +
                "on another phone), so it has been removed from this device. Use Add account to sign in to it again."

        fun stillSignedIn(name: String): String =
            if (name.isBlank()) "You're still signed in." else "You're still signed in as ${name.trim()}."

        /** The sentence for a switch that did not open the other account. */
        fun messageFor(result: AuthResult): String = when (result) {
            is AuthResult.Banned -> when (result.kind) {
                RestrictionKind.Suspension -> buildString {
                    append("That account is suspended")
                    if (result.untilMillis > 0L) append(" until ${IstTime.format(result.untilMillis)}")
                    append('.')
                    if (result.reason.isNotBlank()) append(" Reason: ${result.reason.trim()}")
                }
                RestrictionKind.Account -> buildString {
                    append("That account is banned.")
                    if (result.reason.isNotBlank()) append(" Reason: ${result.reason.trim()}")
                }
                RestrictionKind.Device -> "This device has been blocked from Zipper."
            }
            // The server disowned that account's saved sign-in, and it has been forgotten here. Login's wording
            // ("sign in with your phone number…") is for Login; in the switcher the way back is Add account.
            is AuthResult.Error ->
                if (result.message == com.zipper.app.util.QuickLoginNotice.REMOVED) SIGN_IN_AGAIN else result.message
            is AuthResult.AccountDeleted -> result.message
            is AuthResult.IdentityTaken -> result.message
            AuthResult.ObserverDenied -> com.zipper.app.util.ObserverAccess.DENIED_MESSAGE
            else -> ""
        }
    }
}

/** B10 — where the switcher goes after a switch. */
sealed interface SwitchOutcome {
    /** Signed in as the other account: restart the app (Splash) with nothing of the old account on the stack. */
    data object OpenApp : SwitchOutcome
    /** Signed out with nothing open: the sign-in screen, with why. */
    data class ToLogin(val message: String) : SwitchOutcome
    /** Nothing changed: stay on the switcher and say why. */
    data class StayHere(val message: String) : SwitchOutcome
}

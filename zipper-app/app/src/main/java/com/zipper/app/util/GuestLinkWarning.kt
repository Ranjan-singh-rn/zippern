package com.zipper.app.util

/**
 * FX-21 (RF-14 / DUP-12), minimal — warn a device's guest before a phone or
 * Google sign-in opens a SEPARATE account, and offer the guest account instead.
 *
 * Login's phone OTP and "Continue with Google" are SIGN-INS, never links: they
 * land on whatever account that number or Google identity resolves to, or make
 * a new one. A guest who signed out and then used either got a second account,
 * silently, while their coins, diamonds and history stayed on the guest one.
 * Only Settings → Secure your account converts a guest in place (same uid).
 *
 * Confirmed: one canonical identity per person, no unsafe automatic merge. So
 * this does NOT merge or move anything. It tells the person, before the
 * sign-in starts, and offers the guest account — from which they can add the
 * phone or email in place. "Sign in separately" still works exactly as before.
 *
 * How the device knows it has a guest: at SIGN-OUT, the account being left is
 * remembered when it is still a guest (nothing but the synthetic `firebase`
 * provider attached, and the server has not said otherwise), and forgotten
 * when that same account has since been secured. The mark outlives the
 * session on purpose (`SessionManager.deviceGuestUid`, not removed by
 * `clear()`); it is a hint for a warning, never a credential — the way back to
 * the guest is still `signInAsGuest` and the device binding.
 *
 * Pure — no Android, no Firebase — so `GuestLinkWarningTest` runs it.
 */
object GuestLinkWarning {

    /** What signing out should do to the device's remembered guest. */
    sealed interface Mark {
        /** The account being left is still a guest: remember it. */
        data class Remember(val uid: String) : Mark
        /** The remembered guest has been secured since: forget it. */
        data object Forget : Mark
        /** Anything else: leave the mark as it is. */
        data object Leave : Mark
    }

    /**
     * @param uid the account being signed out of
     * @param providerIds `FirebaseUser.providerData` ids of that account
     * @param serverSaysGuest `SessionManager.isGuest` — null when never asked
     * @param rememberedGuestUid the current mark, "" when none
     */
    fun onSignOut(
        uid: String?,
        providerIds: List<String>,
        serverSaysGuest: Boolean?,
        rememberedGuestUid: String,
    ): Mark {
        val u = uid?.trim().orEmpty()
        if (u.isEmpty()) return Mark.Leave
        val hasProvider = providerIds.any { it.isNotBlank() && it != "firebase" }
        val stillGuest = !hasProvider && serverSaysGuest != false
        if (stillGuest) return Mark.Remember(u)
        // Not a guest. If it WAS the remembered one, it has been secured: a
        // phone or Google sign-in may now open this very account, so the
        // warning would be wrong.
        return if (u == rememberedGuestUid.trim()) Mark.Forget else Mark.Leave
    }

    /** Should tapping phone or Google show the warning first? */
    fun shouldWarn(rememberedGuestUid: String, acknowledged: Boolean): Boolean =
        rememberedGuestUid.isNotBlank() && !acknowledged

    const val TITLE = "You have a guest account on this phone"
    const val BODY =
        "Signing in with a phone number or Google opens a separate account. Your guest account — " +
            "its coins, diamonds, level and history — stays as it is: nothing is moved or merged. " +
            "To keep everything in one account, continue as guest and add your phone number or " +
            "email in Settings → Secure your account."
    const val CONTINUE_AS_GUEST = "Continue as guest"
    const val SIGN_IN_SEPARATELY = "Sign in separately"
}

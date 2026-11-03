package com.zipper.app.util

/**
 * QA #37 / #38 (3 Nov 2026) — the "Continue as …" button, and why it went away.
 *
 *   #37  After another phone took the account, tapping "Continue as …" made the
 *        button vanish with only a four-second snackbar ("That saved sign-in is
 *        no longer valid…"), while the older "you were signed out" banner stayed
 *        — so the screen never said why the button was gone. The reason is now
 *        said in that banner, and stays until it is dismissed.
 *   #38  Right after "Delete it for good", Login still offered "Continue as" the
 *        deleted account. `AuthRepository.deleteAccountNow` now forgets this
 *        phone's saved sign-in with the account.
 */
object QuickLoginNotice {
    /** Shown in Login's banner when the server refuses this phone's saved sign-in. */
    const val REMOVED =
        "Quick sign-in on this phone has been turned off. It stops working when your account is " +
            "opened on another phone, signed out everywhere, or deleted. Sign in with your phone " +
            "number or Google to continue."

    /** Is this sign-in error the one that belongs in the banner rather than a snackbar? */
    fun belongsInBanner(error: String?): Boolean = error == REMOVED
}

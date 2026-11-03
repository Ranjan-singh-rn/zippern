package com.zipper.app.util

/**
 * UGP-F — the PUBLIC appeal page, for an account that is banned or suspended.
 *
 * The in-app appeal needs a session (a ban disables the login) or this
 * install's saved quick-login credential. The web page needs neither: the
 * person identifies the account by its account ID and writes their appeal. It
 * lands in the same CRM appeals inbox, and filing it lifts nothing.
 *
 * [URL] is the CRM's public route (`zipper-crm/app/appeal`, served by the
 * Firebase Hosting site `zipperlive`). If the CRM moves to a custom domain this
 * is the one place to change (FLOW-MAP decision D24).
 */
object PublicAppeal {
    const val URL = "https://zipperlive.web.app/appeal/"

    /** What is shown to the person: the address without the scheme. */
    const val DISPLAY = "zipperlive.web.app/appeal"

    /**
     * The account a restriction screen is about, when it was learned WITHOUT a
     * session — the quick-login refusal carries the account's uid after the
     * device has proved itself. Process-level and in memory only: it is the
     * person's own account id, shown back to them so they can appeal on the
     * web, and it has no business outliving the process.
     */
    @Volatile
    var lastRestrictedUid: String = ""

    /**
     * QA #55 — may the in-app DEVICE-KEY appeal speak for the restriction on
     * screen? False when that screen was reached by a sign-in Firebase refused
     * (a disabled login) and the server could not confirm that this phone's
     * quick-login key belongs to the account that was tried: the key would file
     * the appeal for ITS account, which may be another one. Such a screen
     * offers the public web appeal and support instead. Process-level, in
     * memory, reset with [forgetRestrictedUid].
     */
    @Volatile
    var deviceKeyAppealAllowed: Boolean = true

    /**
     * Forget it. Called when a quick login starts and on sign-out, so a later
     * restriction screen — a device ban hit by somebody else on this phone, say
     * — never shows the previous person's account id (UGP review).
     */
    fun forgetRestrictedUid() {
        lastRestrictedUid = ""
        deviceKeyAppealAllowed = true
    }

    /** The id to show: the signed-in account's, else the one quick login reported. */
    fun accountIdToShow(signedInUid: String?): String =
        signedInUid?.takeIf { it.isNotBlank() } ?: lastRestrictedUid
}

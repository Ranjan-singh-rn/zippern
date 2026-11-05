package com.zipper.app.util

/**
 * WP2 (Owner, 5 Nov 2026) — the call screen's buttons, by side:
 *
 *   "receiver only have call end button but caller side show call end button, in call gift button, buy diamond
 *    button to buy diamonds while call ongoing and a menu button for both to flip camera, mute and other
 *    functionalities" — plus the in-call chat and the like button for both.
 *
 * "Caller" and "receiver" are read as the PAYING and the EARNING side, which is what they mean for a normal call (a user
 * rings a host). The server decides who pays (`earner` on the call document, `rateFor` in functions/src/calls.ts), so a
 * host who rings a user is the earner and gets End only, and the user they rang — who pays — gets Gift and Buy diamonds.
 * Until the call document has been read nobody is shown the paying side's buttons.
 *
 * Pure; tested by CallControlsTest.
 */
object CallControls {

    enum class Control { END, GIFT, BUY_DIAMONDS, CHAT, LIKE, MENU }

    enum class MenuItem { FLIP_CAMERA, MICROPHONE, SPEAKER, CAMERA, MINIMISE, REPORT, BLOCK }

    /** The menu is the same on both sides. */
    val MENU: List<MenuItem> = listOf(
        MenuItem.FLIP_CAMERA, MenuItem.MICROPHONE, MenuItem.SPEAKER, MenuItem.CAMERA,
        MenuItem.MINIMISE, MenuItem.REPORT, MenuItem.BLOCK,
    )

    private val BOTH = setOf(Control.END, Control.CHAT, Control.LIKE, Control.MENU)

    /** What [myUid] sees on the call [callerId] → [receiverId] whose earning side is [earner] ("caller" | "receiver"). */
    fun visible(myUid: String, callerId: String, receiverId: String, earner: String, callLoaded: Boolean): Set<Control> =
        if (callLoaded && isPayer(myUid, callerId, receiverId, earner)) BOTH + Control.GIFT + Control.BUY_DIAMONDS else BOTH

    /** Mirrors `ActiveCall.payerId`: the side that does not earn pays. */
    fun isPayer(myUid: String, callerId: String, receiverId: String, earner: String): Boolean {
        if (myUid.isBlank()) return false
        val payerId = if (earner == "caller") receiverId else callerId
        return myUid == payerId
    }
}

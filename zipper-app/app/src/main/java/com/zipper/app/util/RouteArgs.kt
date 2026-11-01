package com.zipper.app.util

/**
 * B2 — reading free-text route arguments back.
 *
 * Navigation already `Uri.decode`s a path argument before it reaches the
 * SavedStateHandle, so decoding it a second time garbles any text containing
 * `%` ("50% Coins" → "50" + junk) — the recharge form used to do that with the
 * seller's name. And `Screen.RechargeRequest.createRoute` stands in "-" for a
 * blank name (an empty path segment does not match the route), which is a
 * placeholder, not a name: the form then said "Paid -?".
 */
object RouteArgs {
    const val BLANK_PLACEHOLDER = "-"

    fun sellerName(navDecoded: String?): String =
        navDecoded.orEmpty().takeUnless { it == BLANK_PLACEHOLDER }.orEmpty()
}

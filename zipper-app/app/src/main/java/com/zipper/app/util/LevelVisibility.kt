package com.zipper.app.util

/**
 * Spec §10 / F-16 (APK 20): who sees the HOST level.
 *
 *   * A normal user sees the User (wealth) level and user-level items only.
 *   * A host sees the Host level AND the User level.
 *
 * The server stopped projecting `hostLevel` for non-hosts (profiles.ts); this
 * is the client half, used by the Level, Earnings and Edit Profile screens so
 * the three cannot disagree. Pure, and decided on `isHost` alone — not on
 * whether a host-level figure happens to be present, because a stale
 * `hostLevel` on an account whose host role was revoked must not keep the
 * host tab alive.
 */
object LevelVisibility {

    /** The two level tabs on the Level screen. */
    const val TAB_USER = 0
    const val TAB_HOST = 1

    data class Decision(
        /** Draw the Host/User switcher and the host ladder. */
        val showHostLevel: Boolean,
        /** The tab the screen must actually render — never the host tab for a non-host. */
        val effectiveTab: Int,
    )

    /** For the Level screen: whether the host tab exists, and which tab is really shown. */
    fun decide(isHost: Boolean, selectedTab: Int): Decision = Decision(
        showHostLevel = isHost,
        effectiveTab = if (isHost && selectedTab == TAB_HOST) TAB_HOST else TAB_USER,
    )

    /** Earnings: the host level card and the rate items are host-only. */
    fun showHostEarnings(isHost: Boolean, hostHomeLoaded: Boolean): Boolean = isHost && hostHomeLoaded

    /** Edit Profile: the call-rate card (a host-level item) is host-only. */
    fun showCallRateCard(isHost: Boolean): Boolean = isHost

    /**
     * The host level to display for a viewer, or null when there is none to
     * show. A non-host never gets a number, whatever the document carries.
     */
    fun hostLevelFor(isHost: Boolean, hostLevel: Int): Int? = if (isHost) hostLevel.coerceAtLeast(0) else null
}

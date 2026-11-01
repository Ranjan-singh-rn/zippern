package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * APK 20 / spec §10 / F-16 — a normal user sees the User level only; a host
 * sees the Host level and the User level. Level, Earnings and Edit Profile
 * all decide through `LevelVisibility`.
 */
class LevelVisibilityTest {

    @Test fun `a normal user never sees the host tab, whatever tab was selected`() {
        val d = LevelVisibility.decide(isHost = false, selectedTab = LevelVisibility.TAB_HOST)
        assertFalse(d.showHostLevel)
        assertEquals(LevelVisibility.TAB_USER, d.effectiveTab)
        assertEquals(LevelVisibility.TAB_USER, LevelVisibility.decide(false, LevelVisibility.TAB_USER).effectiveTab)
    }

    @Test fun `a host sees both and may stand on either tab`() {
        val host = LevelVisibility.decide(isHost = true, selectedTab = LevelVisibility.TAB_HOST)
        assertTrue(host.showHostLevel)
        assertEquals(LevelVisibility.TAB_HOST, host.effectiveTab)
        assertEquals(LevelVisibility.TAB_USER, LevelVisibility.decide(true, LevelVisibility.TAB_USER).effectiveTab)
    }

    @Test fun `host earnings and the call-rate card are host-only`() {
        assertTrue(LevelVisibility.showHostEarnings(isHost = true, hostHomeLoaded = true))
        assertFalse(LevelVisibility.showHostEarnings(isHost = true, hostHomeLoaded = false))
        assertFalse("a non-host with a host-home answer still sees nothing", LevelVisibility.showHostEarnings(false, true))
        assertTrue(LevelVisibility.showCallRateCard(true))
        assertFalse(LevelVisibility.showCallRateCard(false))
    }

    @Test fun `a stale host level on a non-host document is never shown`() {
        assertNull(LevelVisibility.hostLevelFor(isHost = false, hostLevel = 7))
        assertEquals(7, LevelVisibility.hostLevelFor(isHost = true, hostLevel = 7))
        assertEquals(0, LevelVisibility.hostLevelFor(isHost = true, hostLevel = -3))
    }

    @Test fun `the three screens decide through LevelVisibility`() {
        val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
        val level = File(main, "com/zipper/app/ui/screens/level/LevelScreen.kt").readText()
        assertTrue(level.contains("LevelVisibility.decide(state.isHost, selectedTab)"))
        assertTrue(level.contains("if (visibility.showHostLevel) {"))
        val earnings = File(main, "com/zipper/app/ui/screens/earnings/EarningsScreen.kt").readText()
        assertTrue(earnings.contains("LevelVisibility.showHostEarnings(state.isHost, state.home != null)"))
        assertTrue(earnings.contains("isHost          = snap.getBoolean(\"isHost\") == true"))
        val edit = File(main, "com/zipper/app/ui/screens/profile/EditProfileScreen.kt").readText()
        assertTrue(edit.contains("LevelVisibility.showCallRateCard(user?.isHost == true)"))
    }
}

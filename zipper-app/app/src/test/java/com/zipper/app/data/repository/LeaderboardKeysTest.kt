package com.zipper.app.data.repository

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.util.Date

/**
 * B8 (3 Nov 2026) — the app reads the same ranking the server writes: the IST period keys match
 * functions/src/leaderboards.ts `periodKeys` (test/leaderboards.test.js pins the same instants), and the Owner's
 * config reads as the server reads it (lucky off unless exactly on; supporters paid in diamonds).
 */
class LeaderboardKeysTest {
    private fun at(iso: String) = Date.from(Instant.parse(iso))

    @Test fun `the day turns at midnight IST`() {
        assertEquals("2026-11-03", LeaderboardKeys.keyFor("daily", at("2026-11-03T18:29:59Z")))
        assertEquals("2026-11-04", LeaderboardKeys.keyFor("daily", at("2026-11-03T18:30:00Z")))
    }

    @Test fun `the week is the ISO week cut in IST, and the month likewise`() {
        assertEquals("2026-W45", LeaderboardKeys.keyFor("weekly", at("2026-11-08T18:29:59Z")))
        assertEquals("2026-W46", LeaderboardKeys.keyFor("weekly", at("2026-11-08T18:30:00Z")))
        assertEquals("2026-11", LeaderboardKeys.keyFor("monthly", at("2026-11-30T18:29:59Z")))
        assertEquals("2026-12", LeaderboardKeys.keyFor("monthly", at("2026-11-30T18:30:00Z")))
        // The ISO week-year at the turn of the year: Sunday 3 Jan 2027 is still 2026-W53.
        assertEquals("2026-W53", LeaderboardKeys.keyFor("weekly", at("2027-01-03T12:00:00Z")))
    }

    @Test fun `the Owner's config reads as the server reads it`() {
        val d = LeaderboardKeys.configOf(null)
        assertTrue(d.enabled)
        assertFalse(d.boards.getValue("lucky"))
        assertTrue(d.boards.getValue("hosts"))
        val c = LeaderboardKeys.configOf(mapOf(
            "boards" to mapOf(
                "lucky" to mapOf("enabled" to "yes"),
                "supporters" to mapOf("weekly" to mapOf("currency" to "beans", "tiers" to listOf(mapOf("from" to 1, "to" to 1, "amount" to 500), mapOf("from" to 0, "amount" to 9)))),
                "hosts" to mapOf("daily" to mapOf("currency" to "beans")),
            ),
        ))
        assertFalse(c.boards.getValue("lucky"))
        assertEquals("diamonds", c.rewards.getValue("supporters_weekly").currency)
        assertEquals(listOf(LeaderboardRepository.Tier(1, 1, 500)), c.rewards.getValue("supporters_weekly").tiers)
        assertEquals("beans", c.rewards.getValue("hosts_daily").currency)
    }
}

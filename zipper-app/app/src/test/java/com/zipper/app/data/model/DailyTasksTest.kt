package com.zipper.app.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** O8 (5 Nov 2026): what the Daily tasks screen shows from the config, today's progress and who the person is. */
class DailyTasksTest {
    private val config = mapOf<String, Any?>(
        "enabled" to true,
        "tasks" to listOf(
            mapOf("id" to "gifts5", "title" to "Send 5 gifts", "audience" to "everyone", "metric" to "send_gifts", "target" to 5L, "rewardDiamonds" to 20L, "enabled" to true, "order" to 1L),
            mapOf("id" to "live30", "title" to "Go live 30 min", "audience" to "hosts", "metric" to "live_minutes", "target" to 30L, "rewardBeans" to 300L, "enabled" to true, "order" to 0L),
            mapOf("id" to "off", "title" to "Off", "audience" to "everyone", "metric" to "party_joins", "target" to 1L, "rewardDiamonds" to 5L, "enabled" to false, "order" to 2L),
            mapOf("id" to "bad", "metric" to "hack", "rewardDiamonds" to 5L),
        ),
    )

    @Test fun parsesSortsAndSkipsUnknownMeasures() {
        val (on, defs) = DailyTasks.parseConfig(config)
        assertTrue(on)
        assertEquals(listOf("live30", "gifts5", "off"), defs.map { it.id })
    }

    @Test fun aUserSeesEveryoneTasksNotHostTasks() {
        val (on, defs) = DailyTasks.parseConfig(config)
        val rows = DailyTasks.rows(on, defs, mapOf("send_gifts" to 3L), isHost = false)
        assertEquals(listOf("gifts5"), rows.map { it.def.id })
        assertEquals(3L, rows[0].progress)
        assertFalse(rows[0].canClaim)
    }

    @Test fun aHostSeesTheirTasksAndClaimedOnesStayClaimed() {
        val (on, defs) = DailyTasks.parseConfig(config)
        val progress = mapOf("live_minutes" to 31L, "send_gifts" to 5L, "claimed" to mapOf("gifts5" to mapOf("diamonds" to 20L)))
        val rows = DailyTasks.rows(on, defs, progress, isHost = true).associateBy { it.def.id }
        assertTrue(rows.getValue("live30").canClaim)
        assertTrue(rows.getValue("gifts5").claimed)
        assertFalse(rows.getValue("gifts5").canClaim)
        assertEquals(1f, rows.getValue("live30").fraction)
    }

    @Test fun masterSwitchOffShowsNothing() {
        val (_, defs) = DailyTasks.parseConfig(config)
        assertTrue(DailyTasks.rows(false, defs, null, isHost = false).isEmpty())
        assertTrue(DailyTasks.parseConfig(null).second.isEmpty())
    }

    @Test fun istDayKeyMatchesTheServer() {
        // 2026-11-05T19:00Z is 6 Nov 00:30 IST.
        assertEquals("2026-11-06", DailyTasks.istDateKey(1_793_905_200_000L))
        assertEquals("2026-11-05", DailyTasks.istDateKey(1_793_901_000_000L))
    }

    @Test fun rewardText() {
        val (_, defs) = DailyTasks.parseConfig(config)
        assertEquals("20 💎", DailyTasks.rewardText(defs.first { it.id == "gifts5" }))
        assertEquals("300 beans", DailyTasks.rewardText(defs.first { it.id == "live30" }))
    }
}

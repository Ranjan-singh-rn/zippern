package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.Instant
import java.util.TimeZone

/**
 * QA #54 — times a person reads are in IST, whatever zone the handset (or the
 * test emulator, which was UTC) is set to. Stored values stay UTC millis.
 */
class IstTimeTest {

    private fun ms(iso: String) = Instant.parse(iso).toEpochMilli()

    @Test fun `the server's words - day, short month, year, 12-hour clock, IST`() {
        // 22:21 UTC on 3 Nov is 3:51 am on 4 Nov in India (the QA example).
        assertEquals("4 Nov 2026, 3:51 am IST", IstTime.format(ms("2026-11-03T22:21:00Z")))
        assertEquals("4 Nov 2026, 3:45 pm IST", IstTime.format(ms("2026-11-04T10:15:00Z")))
        assertEquals("4 Nov 2026, 12:00 am IST", IstTime.format(ms("2026-11-03T18:30:00Z")))
        assertEquals("4 Nov 2026, 12:00 pm IST", IstTime.format(ms("2026-11-04T06:30:00Z")))
        assertEquals("4 November 2026", IstTime.longDate(ms("2026-11-03T22:21:00Z")))
        assertEquals("3:51 am IST", IstTime.time(ms("2026-11-03T22:21:00Z")))
    }

    @Test fun `the handset's own zone does not matter`() {
        val saved = TimeZone.getDefault()
        try {
            for (zone in listOf("UTC", "America/Los_Angeles", "Asia/Tokyo")) {
                TimeZone.setDefault(TimeZone.getTimeZone(zone))
                assertEquals(zone, "4 Nov 2026, 3:51 am IST", IstTime.format(ms("2026-11-03T22:21:00Z")))
            }
        } finally {
            TimeZone.setDefault(saved)
        }
    }

    @Test fun `the Host suspension sentence uses it - the same words as the server`() {
        assertEquals(
            "Your Host role is suspended until 4 Nov 2026, 3:45 pm IST — reason: x",
            HostSuspension.message(ms("2026-11-04T10:15:00Z"), "x"),
        )
    }

    @Test fun `the screens that show a moment use IST`() {
        val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
        fun src(p: String) = File(main, "com/zipper/app/$p").readText()
        assertTrue(src("ui/screens/auth/SuspendedScreen.kt").contains("com.zipper.app.util.IstTime.format(untilMillis)"))
        assertTrue(src("ui/screens/auth/RecoverAccountScreen.kt").contains("com.zipper.app.util.IstTime.longDate(state.dueAtMillis)"))
        assertTrue(src("ui/screens/feedback/FeedbackScreen.kt").contains("com.zipper.app.util.IstTime.format(ts)"))
        assertTrue(src("data/work/WorkSpec.kt").contains("com.zipper.app.util.IstTime.format(ms)"))
        assertTrue(src("ui/screens/messages/ChatScreen.kt").contains("timeZone = com.zipper.app.util.IstTime.ZONE"))
        assertFalse(src("ui/screens/auth/SuspendedScreen.kt").contains("SimpleDateFormat("))
    }
}

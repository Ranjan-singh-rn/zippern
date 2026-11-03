package com.zipper.app.util

import java.util.Calendar
import java.util.Locale
import java.util.TimeZone

/**
 * QA #54 — times a person reads are shown in India Standard Time.
 *
 * Every timestamp is STORED in UTC (Firestore Timestamps, epoch millis) and
 * that does not change. What changed is how one is SHOWN: the notices and
 * dialogs printed UTC, or whatever zone the handset happened to be set to (the
 * test emulator was UTC), so an Indian user read "until 03 Nov 2026, 22:21
 * UTC" for something that ends at 3:51 the next morning. Zipper's users are in
 * India; `Asia/Kolkata` is UTC+05:30 all year.
 *
 * The words are the server's (`backend email.when`, Functions `whenIst`):
 * "4 Nov 2026, 3:45 pm IST", written out by hand — no locale formatter — so a
 * notice, an email and a screen say the same thing.
 *
 * Pure — `IstTimeTest` runs it on the JVM.
 */
object IstTime {
    val ZONE: TimeZone = TimeZone.getTimeZone("Asia/Kolkata")

    private val MONTHS = arrayOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
    private val MONTHS_LONG = arrayOf(
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    )

    private fun cal(epochMs: Long): Calendar =
        Calendar.getInstance(ZONE, Locale.ROOT).apply { timeInMillis = epochMs }

    /** "4 Nov 2026, 3:45 pm IST". */
    fun format(epochMs: Long): String {
        val c = cal(epochMs)
        val h24 = c.get(Calendar.HOUR_OF_DAY)
        val h12 = if (h24 % 12 == 0) 12 else h24 % 12
        val min = c.get(Calendar.MINUTE).toString().padStart(2, '0')
        return "${c.get(Calendar.DAY_OF_MONTH)} ${MONTHS[c.get(Calendar.MONTH)]} ${c.get(Calendar.YEAR)}, " +
            "$h12:$min ${if (h24 < 12) "am" else "pm"} IST"
    }

    /** "4 November 2026" — the calendar day in IST, for a sentence. */
    fun longDate(epochMs: Long): String {
        val c = cal(epochMs)
        return "${c.get(Calendar.DAY_OF_MONTH)} ${MONTHS_LONG[c.get(Calendar.MONTH)]} ${c.get(Calendar.YEAR)}"
    }

    /** "3:45 pm IST" — the clock time in IST. */
    fun time(epochMs: Long): String {
        val c = cal(epochMs)
        val h24 = c.get(Calendar.HOUR_OF_DAY)
        val h12 = if (h24 % 12 == 0) 12 else h24 % 12
        return "$h12:${c.get(Calendar.MINUTE).toString().padStart(2, '0')} ${if (h24 < 12) "am" else "pm"} IST"
    }
}

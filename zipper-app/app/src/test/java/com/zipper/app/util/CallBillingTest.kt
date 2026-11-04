package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * APK 20 / spec §11 — the call screen's timer and price are the SERVER's
 * figures, mapped by `CallBilling`. The server side is pinned by
 * functions/test; this pins the client arithmetic to the same rule:
 * whole minutes, the first on connect, the started minute owed in full.
 */
class CallBillingTest {

    private val start = 1_700_000_000_000L

    @Test fun `elapsed is measured from the server's startedAt and never negative`() {
        assertEquals(0L, CallBilling.elapsedSeconds(null, start + 5_000))
        assertEquals(0L, CallBilling.elapsedSeconds(start, start - 5_000))
        assertEquals(61L, CallBilling.elapsedSeconds(start, start + 61_999))
    }

    @Test fun `next charge counts down to billedThroughMs, rounded up, floored at zero`() {
        val billedThrough = start + CallBilling.MINUTE_MS
        assertEquals(60L, CallBilling.secondsToNextCharge(billedThrough, start))
        assertEquals(1L, CallBilling.secondsToNextCharge(billedThrough, billedThrough - 1))
        assertEquals(1L, CallBilling.secondsToNextCharge(billedThrough, billedThrough - 999))
        assertEquals(0L, CallBilling.secondsToNextCharge(billedThrough, billedThrough))
        assertEquals(0L, CallBilling.secondsToNextCharge(billedThrough, billedThrough + 30_000))
        assertNull(CallBilling.secondsToNextCharge(null, start))
    }

    @Test fun `diamonds spent is minutes billed times the rate`() {
        assertEquals(0L, CallBilling.diamondsSpent(0, 750))
        assertEquals(750L, CallBilling.diamondsSpent(1, 750))
        assertEquals(2_250L, CallBilling.diamondsSpent(3, 750))
        assertEquals(0L, CallBilling.diamondsSpent(3, 0))
    }

    @Test fun `minutes started mirrors the server rule - the started minute is owed`() {
        assertEquals(1L, CallBilling.minutesStartedBy(0))
        assertEquals(1L, CallBilling.minutesStartedBy(59_999))
        assertEquals(2L, CallBilling.minutesStartedBy(60_000))
        assertEquals(3L, CallBilling.minutesStartedBy(125_000))
    }

    @Test fun `clock offset corrects a slow device onto the server's clock`() {
        // The server says 90 s have elapsed; the device thinks only 30 s have.
        val localNow = start + 30_000
        val offset = CallBilling.clockOffsetMs(start, 90, localNow)
        assertEquals(60_000L, offset)
        val serverNow = CallBilling.serverNowMs(localNow, offset)
        assertEquals(90L, CallBilling.elapsedSeconds(start, serverNow))
    }

    @Test fun `display derives every figure from the snapshot`() {
        val snap = CallBilling.Snapshot(
            startedAtMs = start,
            minutesBilled = 2,
            billedThroughMs = start + 2 * CallBilling.MINUTE_MS,
            perMinRateDiamonds = 750,
            affordableMinutes = 5,
        )
        val d = CallBilling.display(snap, start + 75_000)
        assertEquals(75L, d.elapsedSeconds)
        assertEquals(2L, d.minutesBilled)
        assertEquals(1_500L, d.diamondsSpent)
        assertEquals(45L, d.secondsToNextCharge)
        assertEquals(5L, d.minutesLeft)
        assertFalse(d.lowBalance)
    }

    @Test fun `low balance is fewer than two affordable minutes on a paid call`() {
        val paid = CallBilling.Snapshot(startedAtMs = start, minutesBilled = 1, billedThroughMs = start + 60_000, perMinRateDiamonds = 750, affordableMinutes = 1)
        assertTrue(CallBilling.display(paid, start).lowBalance)
        val fine = paid.copy(affordableMinutes = 2)
        assertFalse(CallBilling.display(fine, start).lowBalance)
        // A free call has no balance to run low.
        val free = paid.copy(perMinRateDiamonds = 0, affordableMinutes = null)
        val d = CallBilling.display(free, start, balanceDiamonds = 0)
        assertNull(d.minutesLeft)
        assertFalse(d.lowBalance)
    }

    @Test fun `without the server's affordable figure the balance is divided by the rate`() {
        val snap = CallBilling.Snapshot(startedAtMs = start, minutesBilled = 1, billedThroughMs = start + 60_000, perMinRateDiamonds = 750)
        assertEquals(3L, CallBilling.display(snap, start, balanceDiamonds = 2_400).minutesLeft)
        assertEquals(0L, CallBilling.display(snap, start, balanceDiamonds = 100).minutesLeft)
        assertNull(CallBilling.minutesCoveredBy(1_000, 0))
    }

    @Test fun `insufficient diamonds is explained to each side, an ordinary hang-up is not`() {
        val payer = CallBilling.endMessage(CallBilling.END_INSUFFICIENT_DIAMONDS, isPayer = true)
        assertTrue(payer!!.contains("enough diamonds"))
        assertTrue(payer.contains("stay charged"))
        val earner = CallBilling.endMessage(CallBilling.END_INSUFFICIENT_DIAMONDS, isPayer = false)
        assertTrue(earner!!.contains("other person"))
        // The legacy client name for the same thing still reads as the same thing.
        assertEquals(payer, CallBilling.endMessage(CallBilling.END_DIAMONDS_EXHAUSTED, isPayer = true))
        assertNull(CallBilling.endMessage("caller_ended", true))
        assertNull(CallBilling.endMessage(null, true))
        assertTrue(CallBilling.endMessage(CallBilling.END_SESSION_DISPLACED, true)!!.contains("another device"))
    }

    @Test fun `the liveness interval is ten seconds and inside the watchdog window`() {
        assertEquals(10L, CallBilling.LIVENESS_TICK_SECONDS)
        assertTrue(CallBilling.LIVENESS_TICK_SECONDS < 120L)
    }

    @Test fun `the pre-call confirmation says the first minute is charged on connect`() {
        val text = CallBilling.confirmText(750)
        assertTrue(text.contains("750 diamonds per minute"))
        assertTrue(text.contains("first minute is charged when the call connects"))
        assertTrue(text.contains("60-second mark"))
    }

    @Test fun `short of the first minute the confirmation offers recharge, a free call never is`() {
        assertTrue(CallBilling.isShort(balanceDiamonds = 749, perMinRateDiamonds = 750))
        assertFalse(CallBilling.isShort(balanceDiamonds = 750, perMinRateDiamonds = 750))
        assertFalse("a host ringing a user pays nothing", CallBilling.isShort(balanceDiamonds = 0, perMinRateDiamonds = 0))
    }

    @Test fun `duration formats as mm-ss and h-mm-ss`() {
        assertEquals("00:00", CallBilling.formatDuration(0))
        assertEquals("01:05", CallBilling.formatDuration(65))
        assertEquals("1:00:01", CallBilling.formatDuration(3_601))
        assertEquals("00:00", CallBilling.formatDuration(-5))
    }
}

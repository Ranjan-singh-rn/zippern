package com.zipper.app.util

/**
 * A-14 / spec §11 (APK 20): the call screen's timer and price, computed from
 * what the SERVER said and nothing else.
 *
 * ── The rule the server bills by (functions/src/calls.ts) ────────────────────
 *
 *   * the first full minute is charged when the call connects (`acceptCall`);
 *   * each next full minute is charged at the 60-second mark — a minute that
 *     has started is owed in full;
 *   * a call ended mid-minute has paid for that minute; there are no
 *     ten-second increments anywhere any more.
 *
 * The client's tick (`tickCall`, every ten seconds from BOTH devices) is a
 * liveness ping, not a charge: the server charges whole minutes from its own
 * clock whether or not a tick arrives on time, and the watchdog closes a call
 * whose last tick from either side is older than two minutes. What a tick does
 * bring back is the truth — `minutesBilled`, `billedThroughMs`, `startedAtMs`,
 * `elapsedSeconds` — and this object turns that into the figures on screen so
 * the two cannot disagree.
 *
 * Pure. Every input is a number the server returned or the device's clock,
 * and the tests exercise it without Firebase.
 */
object CallBilling {

    const val MINUTE_MS = 60_000L

    /**
     * How often each device pings `tickCall`. Comfortably inside the server's
     * two-minute watchdog window, and often enough that the billed figures on
     * screen are never more than ten seconds behind the server.
     */
    const val LIVENESS_TICK_SECONDS = 10L

    /** The server's end reason when the payer could not afford the next minute. */
    const val END_INSUFFICIENT_DIAMONDS = "insufficient_diamonds"

    /** The legacy client-side name for the same thing; still recognised when it comes back on a document. */
    const val END_DIAMONDS_EXHAUSTED = "diamonds_exhausted"

    /** The server decided the call must stop because a party is restricted or the payer's session moved. */
    const val END_PARTY_RESTRICTED = "party_restricted"
    const val END_SESSION_DISPLACED = "session_displaced"

    /** What the server last told us about the call's billing. */
    data class Snapshot(
        /** `startedAtMs` from the server, or null before the call connected. */
        val startedAtMs: Long? = null,
        /** Whole minutes charged so far. */
        val minutesBilled: Long = 0L,
        /** `startedAtMs + minutesBilled × 60 000`: when the next minute is charged. */
        val billedThroughMs: Long? = null,
        val perMinRateDiamonds: Long = 0L,
        /** Further whole minutes the payer's balance covers; null on a free call or when unknown. */
        val affordableMinutes: Long? = null,
    )

    /** The figures the call screen draws. */
    data class Display(
        val elapsedSeconds: Long,
        val minutesBilled: Long,
        /** `minutesBilled × perMinRateDiamonds`. */
        val diamondsSpent: Long,
        /** Seconds until the next whole minute is charged; null before the call connected. */
        val secondsToNextCharge: Long?,
        /** Minutes the balance still covers after the ones already charged; null on a free call. */
        val minutesLeft: Long?,
        /** Fewer than two more minutes affordable — time to top up. */
        val lowBalance: Boolean,
    )

    /**
     * The device's clock corrected onto the server's.
     *
     * A tick returns `startedAtMs` and `elapsedSeconds` measured by the
     * server; `startedAtMs + elapsedSeconds × 1000` is therefore the server's
     * "now" at the moment it answered. The difference from the device's own
     * clock at that moment is the offset to add to every later local reading,
     * so a phone whose clock is a minute slow still counts down to the next
     * charge at the same second the server charges it.
     */
    fun clockOffsetMs(startedAtMs: Long, elapsedSeconds: Long, localNowMs: Long): Long =
        (startedAtMs + elapsedSeconds * 1000L) - localNowMs

    /** The server's clock, as best this device can know it. */
    fun serverNowMs(localNowMs: Long, clockOffsetMs: Long): Long = localNowMs + clockOffsetMs

    /** Seconds since the call connected, never negative, 0 before it connected. */
    fun elapsedSeconds(startedAtMs: Long?, serverNowMs: Long): Long {
        if (startedAtMs == null || startedAtMs <= 0L) return 0L
        return ((serverNowMs - startedAtMs) / 1000L).coerceAtLeast(0L)
    }

    /**
     * Seconds until the next whole minute is charged. Rounded UP, so the
     * countdown reads "1" right up to the charge rather than "0" for a second.
     * Zero when the boundary has passed and the next tick will report it.
     */
    fun secondsToNextCharge(billedThroughMs: Long?, serverNowMs: Long): Long? {
        if (billedThroughMs == null || billedThroughMs <= 0L) return null
        val remainingMs = billedThroughMs - serverNowMs
        if (remainingMs <= 0L) return 0L
        return (remainingMs + 999L) / 1000L
    }

    /** What the payer has spent so far on this call, from the server's minute count. */
    fun diamondsSpent(minutesBilled: Long, perMinRateDiamonds: Long): Long =
        minutesBilled.coerceAtLeast(0L) * perMinRateDiamonds.coerceAtLeast(0L)

    /**
     * Whole minutes a balance still covers at a rate. Null on a free call, so a
     * screen does not show "∞ minutes left" or divide by zero.
     */
    fun minutesCoveredBy(balance: Long, perMinRateDiamonds: Long): Long? =
        if (perMinRateDiamonds <= 0L) null else (balance / perMinRateDiamonds).coerceAtLeast(0L)

    /**
     * The minutes the server will have charged at [elapsedMs] under its own
     * rule (`minutesStartedBy` in calls.ts): the minute that has started counts
     * in full. For the tests that pin the client to the server's arithmetic.
     */
    fun minutesStartedBy(elapsedMs: Long): Long = elapsedMs.coerceAtLeast(0L) / MINUTE_MS + 1L

    /** Everything the screen draws, from the last snapshot and the corrected clock. */
    fun display(snapshot: Snapshot, serverNowMs: Long, balanceDiamonds: Long? = null): Display {
        val minutesLeft = snapshot.affordableMinutes
            ?: balanceDiamonds?.let { minutesCoveredBy(it, snapshot.perMinRateDiamonds) }
        return Display(
            elapsedSeconds = elapsedSeconds(snapshot.startedAtMs, serverNowMs),
            minutesBilled = snapshot.minutesBilled.coerceAtLeast(0L),
            diamondsSpent = diamondsSpent(snapshot.minutesBilled, snapshot.perMinRateDiamonds),
            secondsToNextCharge = secondsToNextCharge(snapshot.billedThroughMs, serverNowMs),
            minutesLeft = minutesLeft,
            lowBalance = snapshot.perMinRateDiamonds > 0L && minutesLeft != null && minutesLeft < 2L,
        )
    }

    /**
     * The sentence for a call the SERVER ended, or null for an ordinary
     * hang-up. The payer and the earner read different things: one ran out of
     * diamonds, the other was not paid for a minute that never started.
     */
    fun endMessage(endReason: String?, isPayer: Boolean): String? = when (endReason) {
        END_INSUFFICIENT_DIAMONDS, END_DIAMONDS_EXHAUSTED ->
            if (isPayer) "The call ended because you did not have enough diamonds for the next minute. " +
                "The minutes already charged stay charged — recharge to call again."
            else "The call ended because the other person ran out of diamonds for the next minute."
        END_PARTY_RESTRICTED -> "The call was ended because an account on it is restricted."
        END_SESSION_DISPLACED -> "The call was ended because the account was opened on another device."
        else -> null
    }

    /** `mm:ss`, or `h:mm:ss` past an hour. */
    fun formatDuration(secs: Long): String {
        val s = secs.coerceAtLeast(0L)
        val h = s / 3600
        val m = (s % 3600) / 60
        val sec = s % 60
        return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%02d:%02d".format(m, sec)
    }

    /** The pre-call sentence: what the first minute costs and when it is taken. */
    fun confirmText(perMinRateDiamonds: Long): String =
        "This call costs $perMinRateDiamonds diamonds per minute. The first minute is charged " +
            "when the call connects; each following minute is charged at the 60-second mark. " +
            "A call ended part-way through a minute pays for that minute."
}

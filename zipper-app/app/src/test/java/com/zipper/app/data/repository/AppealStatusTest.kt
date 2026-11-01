package com.zipper.app.data.repository

import com.zipper.app.data.repository.AppealStatus.Outcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE CLIENT MUST NOT GUESS WHAT AN UNKNOWN APPEAL STATUS MEANS.
 *
 * ── WHAT WENT WRONG, AND WHY A TEST FILE EXISTS FOR FIVE LINES OF LOGIC ──────
 *
 * `BannedScreen` decided the headline with an `else` over a server string:
 * anything that was not `"overturned"` produced **"Your last appeal was not
 * accepted"**. That is a statement about a moderation decision, shown to the
 * person it concerns, and for any status this build does not know it is simply
 * false — nobody refused anything.
 *
 * It would also have shipped silently. No crash, no blank screen, no log line:
 * just a wrong sentence, appearing the day the backend gained a fourth status.
 *
 * The test that matters most here is `an unknown status is never reported as a
 * refusal`. If it ever fails, the bug is back.
 *
 * ── WHY THESE RUN WITHOUT A DEVICE ───────────────────────────────────────────
 *
 * `AppealStatus` imports nothing — no Android, no Firebase, no Compose — so
 * every branch is reachable from an ordinary JVM unit test under
 * `./gradlew testDebugUnitTest`. That is deliberate: it is the one piece of
 * appeal logic that can be proved correct without an emulator, so it is the
 * piece that carries the guarantee.
 */
class AppealStatusTest {

    // ── The three known statuses behave exactly as before ────────────────────

    @Test
    fun `overturned is reported as accepted`() {
        assertEquals(Outcome.ACCEPTED, AppealStatus.outcomeOf("overturned"))
    }

    @Test
    fun `upheld is reported as not accepted`() {
        assertEquals(Outcome.REFUSED, AppealStatus.outcomeOf("upheld"))
    }

    @Test
    fun `pending shows no verdict card`() {
        // A pending appeal is announced by its own panel state. Showing a
        // verdict card as well would say the same thing twice, in two tones.
        assertEquals(Outcome.NONE, AppealStatus.outcomeOf("pending"))
    }

    // ── The whole point of the file ──────────────────────────────────────────

    @Test
    fun `an unknown status is never reported as a refusal`() {
        // The regression guard. `resolved` is the state under discussion for
        // "the restriction was removed without a reviewer deciding"; the other
        // two stand in for anything at all that this build has not heard of.
        for (unknown in listOf("resolved", "moot", "withdrawn", "expired", "CLOSED", "42")) {
            val outcome = AppealStatus.outcomeOf(unknown)
            assertEquals(
                "an unknown status must be neutral, not a refusal: $unknown",
                Outcome.UNRECOGNISED,
                outcome,
            )
            assertFalse(
                "$unknown must never read as REFUSED",
                outcome == Outcome.REFUSED,
            )
            assertFalse(
                "$unknown must never read as ACCEPTED either",
                outcome == Outcome.ACCEPTED,
            )
        }
    }

    @Test
    fun `resolved - the proposed new state - is neutral today`() {
        // Named separately because it is the concrete case: the backend may
        // gain this value before the estate updates, and an old build must
        // behave itself when it does.
        assertEquals(Outcome.UNRECOGNISED, AppealStatus.outcomeOf("resolved"))
    }

    // ── Absent and malformed input ───────────────────────────────────────────

    @Test
    fun `null blank and whitespace show nothing`() {
        assertEquals(Outcome.NONE, AppealStatus.outcomeOf(null))
        assertEquals(Outcome.NONE, AppealStatus.outcomeOf(""))
        assertEquals(Outcome.NONE, AppealStatus.outcomeOf("   "))
    }

    @Test
    fun `case and surrounding space do not change a known verdict`() {
        // Not cosmetic. Under the old string comparison, " Overturned " fell to
        // the `else` and reported an ACCEPTED appeal as refused — the exact
        // failure this file exists to prevent, reachable without any new state
        // at all.
        assertEquals(Outcome.ACCEPTED, AppealStatus.outcomeOf(" Overturned "))
        assertEquals(Outcome.ACCEPTED, AppealStatus.outcomeOf("OVERTURNED"))
        assertEquals(Outcome.REFUSED, AppealStatus.outcomeOf("  upheld"))
        assertEquals(Outcome.NONE, AppealStatus.outcomeOf("Pending"))
    }

    // ── isPending / isConcluded ──────────────────────────────────────────────

    @Test
    fun `only pending is pending`() {
        assertTrue(AppealStatus.isPending("pending"))
        assertTrue(AppealStatus.isPending(" PENDING "))
        assertFalse(AppealStatus.isPending("upheld"))
        assertFalse(AppealStatus.isPending("overturned"))
        assertFalse(AppealStatus.isPending("resolved"))
        assertFalse(AppealStatus.isPending(null))
        assertFalse(AppealStatus.isPending(""))
    }

    @Test
    fun `an unknown status counts as concluded`() {
        // Correct rather than a concession: whatever a future value turns out
        // to mean, it is not "still waiting for a reviewer". This is what lets
        // the history picker find the most recent finished appeal even when it
        // cannot interpret the result.
        assertTrue(AppealStatus.isConcluded("resolved"))
        assertTrue(AppealStatus.isConcluded("upheld"))
        assertTrue(AppealStatus.isConcluded("overturned"))
    }

    @Test
    fun `pending and absent are not concluded`() {
        assertFalse(AppealStatus.isConcluded("pending"))
        assertFalse(AppealStatus.isConcluded(null))
        assertFalse(AppealStatus.isConcluded(""))
        assertFalse(AppealStatus.isConcluded("   "))
    }

    // ── The two functions must agree ─────────────────────────────────────────

    @Test
    fun `isPending and outcomeOf never contradict each other`() {
        // A status cannot both be waiting for a reviewer and carry a verdict.
        // Asserted as a property so a future edit to one function cannot drift
        // from the other.
        for (s in listOf(
            "pending", "upheld", "overturned", "resolved", "moot", "", "   ", "Pending",
        )) {
            if (AppealStatus.isPending(s)) {
                assertEquals(
                    "a pending appeal must show no verdict: '$s'",
                    Outcome.NONE,
                    AppealStatus.outcomeOf(s),
                )
                assertFalse("pending is not concluded: '$s'", AppealStatus.isConcluded(s))
            }
        }
    }

    @Test
    fun `every concluded status produces a showable outcome`() {
        // The inverse: if the history picker selects an appeal, the panel must
        // have something to render. A concluded status mapping to NONE would be
        // a card that is chosen and then draws nothing.
        for (s in listOf("upheld", "overturned", "resolved", "anything-at-all")) {
            assertTrue(s, AppealStatus.isConcluded(s))
            assertFalse(
                "a concluded appeal must not map to NONE: '$s'",
                AppealStatus.outcomeOf(s) == Outcome.NONE,
            )
        }
    }
}

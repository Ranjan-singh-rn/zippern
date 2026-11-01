package com.zipper.app.data.repository

/**
 * WHAT AN APPEAL'S STATUS MEANS TO THE PERSON READING IT.
 *
 * ── THE BUG THIS EXISTS TO MAKE IMPOSSIBLE ───────────────────────────────────
 *
 * `BannedScreen` used to decide the headline inline:
 *
 *     if (state.lastVerdict == "overturned") "Your last appeal was accepted"
 *     else                                   "Your last appeal was not accepted"
 *
 * An `else` over a string from the server is a promise that the server will
 * never send a third value. It already plans to: the backend's `AppealStatus`
 * is a `StrEnum`, the appeals module explicitly contemplates outcomes it cannot
 * express today, and the product question of what to call "the restriction went
 * away without a reviewer deciding" is open.
 *
 * The failure mode is not a blank screen or a crash. It is the app telling
 * somebody **"Your last appeal was not accepted"** when nobody refused it — a
 * false statement about a moderation decision, shown to the person it is about,
 * at the moment they are most likely to act on it. That is worse than showing
 * nothing, and it would have been shipped silently the day a new status
 * appeared, because no old client would have errored.
 *
 * ── WHAT THIS DOES INSTEAD ───────────────────────────────────────────────────
 *
 * One total function, `outcomeOf`, over every string the server could ever
 * send. Three known values keep today's behaviour exactly; everything else —
 * including values that do not exist yet — falls to [Outcome.UNRECOGNISED],
 * which says nothing about acceptance and shows the reviewer's own words if
 * there are any.
 *
 * ── WHY IT IS A SEPARATE, DEPENDENCY-FREE FILE ───────────────────────────────
 *
 * It imports nothing. Not Android, not Firebase, not Compose. That is what lets
 * `app/src/test/.../AppealStatusTest.kt` exercise every branch as an ordinary
 * JVM unit test under `testDebugUnitTest`, with no device and no emulator —
 * which matters here, because this is the one piece of appeal logic that can be
 * proved correct without one.
 *
 * It is deliberately NOT an enum of statuses. Modelling the server's vocabulary
 * as a closed Kotlin enum would move the same assumption one layer down: an
 * unknown value would fail to parse instead of failing to render, and the
 * client would still be asserting it knows the full set. The raw string stays
 * a string; only the DISPLAY DECISION is closed.
 */
object AppealStatus {

    // ── The vocabulary the server uses today ─────────────────────────────────
    //
    // Mirrors `AppealStatus` in backend/app/services/appeals.py. These three are
    // the complete set as of this writing; the point of this file is that the
    // client stays correct when that stops being true.

    /** Filed, nobody has decided it. */
    const val PENDING = "pending"

    /** Reviewed, and the original decision stands. The appeal was refused. */
    const val UPHELD = "upheld"

    /** Reviewed, and the original decision was wrong. The appeal succeeded. */
    const val OVERTURNED = "overturned"

    /** What the panel should say. Closed, unlike the status itself. */
    enum class Outcome {
        /** Nothing to show — no appeal, or one still waiting. */
        NONE,

        /** `overturned`. "Your last appeal was accepted." */
        ACCEPTED,

        /** `upheld`. "Your last appeal was not accepted." */
        REFUSED,

        /**
         * A status this build does not know.
         *
         * Neutral on purpose: it must not imply acceptance OR refusal, because
         * the client cannot know which — and guessing in either direction tells
         * the person something untrue about their own account.
         */
        UNRECOGNISED,
    }

    /**
     * Normalise a status off the wire.
     *
     * Trimmed and lower-cased before comparison. The server writes a Python
     * `StrEnum` value, so in practice it arrives exactly as the constants above
     * — but a stray space or a capital would otherwise have sent `overturned`
     * down the `else` branch and reported an accepted appeal as refused. This
     * can only turn a wrong answer into a right one; no known value changes
     * meaning.
     */
    private fun normalise(raw: String?): String = raw.orEmpty().trim().lowercase()

    /** Is this appeal still waiting on a reviewer? */
    fun isPending(raw: String?): Boolean = normalise(raw) == PENDING

    /**
     * Has this appeal been acted on in some way — i.e. is it NOT pending?
     *
     * An unknown status counts as decided, and that is correct rather than a
     * concession: whatever `resolved` or any future value turns out to mean, it
     * is not "still waiting". Only `pending` is still waiting. Used to pick the
     * most recent concluded appeal out of the history.
     */
    fun isConcluded(raw: String?): Boolean {
        val s = normalise(raw)
        return s.isNotEmpty() && s != PENDING
    }

    /**
     * The display decision for a concluded appeal. Total over all input.
     *
     * Absent, blank and `pending` all map to [Outcome.NONE] — a pending appeal
     * is announced by its own panel state, not by the verdict card, so showing
     * both would say the same thing twice in two different tones.
     */
    fun outcomeOf(raw: String?): Outcome = when (normalise(raw)) {
        "" -> Outcome.NONE
        PENDING -> Outcome.NONE
        OVERTURNED -> Outcome.ACCEPTED
        UPHELD -> Outcome.REFUSED
        else -> Outcome.UNRECOGNISED
    }
}

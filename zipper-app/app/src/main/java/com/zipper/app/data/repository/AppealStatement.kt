package com.zipper.app.data.repository

/**
 * WHETHER AN APPEAL HAS ENOUGH IN IT TO SEND, AND WHAT THE PERSON IS TOLD.
 *
 * ── THE BUG THIS EXISTS TO MAKE IMPOSSIBLE ───────────────────────────────────
 *
 * A banned user opened the appeal form, typed a short sentence — "I was
 * hacked", "not me" — and pressed a Send button that did nothing. It was
 * disabled, on a twenty-character minimum, and nothing on the screen said so.
 *
 * The only explanation anywhere in the product was an error string returned
 * from [AppealRepository.appealMyBan], and that string was unreachable by
 * construction: the button that would have called it was the thing being
 * disabled. So the rule existed, the remedy existed, and the person it was
 * for could reach neither. It was reported as "banned users cannot appeal",
 * which from where they were sitting is exactly what it was.
 *
 * ── WHY ONE OBJECT, AND NOT THREE EXPRESSIONS ────────────────────────────────
 *
 * The rule was written out three times — `text.length < MIN_STATEMENT` in the
 * repository, `state.statement.trim().length >= 20` on the button, and the
 * live count beside the field. Three copies is three chances for the counter
 * to read "20 / 20" next to a button that will not press: one of them trims,
 * one does not, and nobody notices until somebody with a trailing newline is
 * locked out of appealing their own ban.
 *
 * ── WHY IT IS A SEPARATE, DEPENDENCY-FREE FILE ───────────────────────────────
 *
 * It imports nothing — not Android, not Firebase, not Compose — so every
 * boundary is reachable from an ordinary JVM unit test under
 * `testDebugUnitTest`, with no device and no emulator. Same reason
 * [AppealStatus] is shaped the way it is, and for the same payoff: on this
 * screen, logic that can only be checked by hand is logic that ships wrong.
 *
 * See `app/src/test/.../AppealStatementTest.kt`.
 */
object AppealStatement {

    /**
     * The statement has to actually say something.
     *
     * Twenty characters is roughly "I did not do this" — short enough that one
     * honest sentence clears it, long enough that "no" does not. The number is
     * deliberately low: this screen is the only way a banned person can say
     * anything at all, and a minimum that works as a hurdle is a minimum that
     * loses real appeals.
     */
    const val MIN = 20

    /** Evidence beyond this is dropped before upload. */
    const val MAX_EVIDENCE = 3

    /**
     * How long this statement counts as.
     *
     * Trimmed, because [isSendable] trims. A counter that disagreed with the
     * button by one trailing newline is worse than no counter at all.
     */
    fun length(raw: String): Int = raw.trim().length

    /** May this be sent? The single copy of the rule. */
    fun isSendable(raw: String): Boolean = length(raw) >= MIN

    /**
     * What somebody whose statement is too short is told.
     *
     * It names the number, and says why the statement matters rather than only
     * that it is invalid. The old message did the first of those, but it was
     * returned from the repository — which the disabled button meant nobody
     * could ever reach. The screen says this before anything is pressed now;
     * this remains the backstop for callers that go straight to the repository.
     */
    const val TOO_SHORT: String =
        "Tell us what happened, in at least $MIN characters. " +
        "This is what a person reads when they look at your account."

    /**
     * RC (confirmed): "another appeal after a decision only with new evidence
     * or a valid reason". The same comparison the rules and the servers make:
     * case and spacing ignored.
     */
    fun normalise(raw: String): String = raw.trim().replace(Regex("\\s+"), " ").lowercase()

    /** What somebody re-sending the decided statement, with no new evidence, is told. */
    const val REAPPEAL_NEEDS_SOMETHING_NEW: String =
        "Your earlier appeal was already decided. To appeal again, add new evidence, " +
        "or explain what is new since the decision — repeating the earlier statement is not enough."
}

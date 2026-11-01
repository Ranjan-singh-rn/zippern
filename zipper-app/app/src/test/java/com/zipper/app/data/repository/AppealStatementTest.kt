package com.zipper.app.data.repository

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE MINIMUM HAS TO BE VISIBLE, AND IT HAS TO BE ONE RULE.
 *
 * ── WHAT WENT WRONG ──────────────────────────────────────────────────────────
 *
 * A banned user opened the appeal form, typed a short sentence — "I was
 * hacked", "not me" — and pressed a Send button that did nothing, because it
 * was disabled on a twenty-character minimum. Nothing on the screen said so.
 * The only explanation in the product was an error string returned from
 * `AppealRepository.appealMyBan`, and that string was unreachable by
 * construction: the button that would have called it was the thing being
 * disabled.
 *
 * It was reported as "banned users cannot appeal". An earlier investigation
 * concluded the form never rendered at all, gated on a missing session. The
 * user's own screenshots settled it — the form was there, with text and a
 * thumbnail in it, and a grey button. The gate was the undisclosed twenty
 * characters, and nothing else.
 *
 * ── WHY THE RULE IS AN OBJECT NOW ────────────────────────────────────────────
 *
 * It was written out three times: `text.length < MIN_STATEMENT` in the
 * repository, `state.statement.trim().length >= 20` on the button, and the
 * count beside the field. Three copies of one rule is three chances for the
 * counter to read "20 / 20" next to a button that will not press — on the one
 * screen in the product where somebody is trying to say they were punished by
 * mistake. [AppealStatement] is the only copy now, and these are its
 * boundaries.
 *
 * ── WHAT THESE TESTS CAN AND CANNOT REACH ────────────────────────────────────
 *
 * [AppealStatement] imports nothing — no Android, no Firebase, no Compose — so
 * every branch runs under `./gradlew testDebugUnitTest` with no device. That
 * is the whole reason it is a separate file; the same reasoning as
 * [AppealStatus].
 *
 * NOT covered here, because this project has no Robolectric and no mocking
 * library: the Compose rendering, the Firestore write, the evidence upload,
 * and the session-less `submitAccountAppeal` path. Those need an instrumented
 * test. What IS covered is the rule that decided whether any of them ever ran.
 */
class AppealStatementTest {

    private val min = AppealStatement.MIN

    // ── The boundary, from both sides ────────────────────────────────────────

    @Test
    fun `an empty statement cannot be sent`() {
        assertFalse(AppealStatement.isSendable(""))
        assertEquals(0, AppealStatement.length(""))
    }

    @Test
    fun `every length below the minimum is refused`() {
        // Each one individually rather than a sampled few: an off-by-one at 19
        // is exactly the kind of error a spot check walks past.
        for (n in 1 until min) {
            val text = "x".repeat(n)
            assertFalse("$n characters should not be sendable", AppealStatement.isSendable(text))
            assertEquals(n, AppealStatement.length(text))
        }
    }

    @Test
    fun `exactly the minimum can be sent`() {
        // Inclusive. Somebody who counts out twenty characters because the
        // screen told them to must not then be refused.
        val text = "x".repeat(min)
        assertTrue(AppealStatement.isSendable(text))
        assertEquals(min, AppealStatement.length(text))
    }

    @Test
    fun `anything longer can be sent`() {
        for (n in (min + 1)..(min + 40)) {
            assertTrue("$n characters should be sendable", AppealStatement.isSendable("x".repeat(n)))
        }
    }

    @Test
    fun `the statements from the bug report are refused, a real one is not`() {
        assertFalse(AppealStatement.isSendable("I was hacked"))   // 12
        assertFalse(AppealStatement.isSendable("not me"))         // 6
        assertTrue(
            AppealStatement.isSendable(
                "Someone used my account while I was at work. I did not send those messages."
            )
        )
    }

    // ── Whitespace, which is where a counter and a gate usually part ways ────

    @Test
    fun `whitespace alone is not a statement`() {
        for (blank in listOf(" ", "   ", "\n", "\t", "  \n\t  ", " ".repeat(min + 10))) {
            assertFalse(
                "blank input of length ${blank.length} must not be sendable",
                AppealStatement.isSendable(blank),
            )
            assertEquals(0, AppealStatement.length(blank))
        }
    }

    @Test
    fun `padding does not buy length`() {
        // Twenty spaces around ten characters is ten characters. If the gate
        // trimmed and the counter did not, this is the input that would show
        // "30 / 20" beside a dead button.
        val padded = "          " + "x".repeat(10) + "          "
        assertEquals(10, AppealStatement.length(padded))
        assertFalse(AppealStatement.isSendable(padded))
    }

    @Test
    fun `a sufficient statement survives its own padding`() {
        val padded = "\n\n  " + "x".repeat(min) + "  \n"
        assertEquals(min, AppealStatement.length(padded))
        assertTrue(AppealStatement.isSendable(padded))
    }

    @Test
    fun `internal whitespace counts, because it is part of what they wrote`() {
        val sentence = "I did not do this at all"
        assertEquals(sentence.length, AppealStatement.length(sentence))
        assertTrue(AppealStatement.isSendable(sentence))
    }

    @Test
    fun `the counter and the gate never disagree`() {
        // The property the three scattered copies could not guarantee: for any
        // input, the number shown beside the field and the button's enabled
        // state are derived from the same measurement.
        val inputs = listOf(
            "", " ", "short", "x".repeat(min - 1), "x".repeat(min), "x".repeat(min + 1),
            "  " + "x".repeat(min - 1) + "  ", "\t" + "x".repeat(min) + "\n",
            "I was hacked", "a b c d e f g h i j k", "accented caractères count too",
        )
        for (input in inputs) {
            val counterSaysReady = AppealStatement.length(input) >= min
            assertTrue(
                "the counter and the button disagree on \"${input.take(30)}\"",
                counterSaysReady == AppealStatement.isSendable(input),
            )
        }
    }

    // ── The message the user is given ────────────────────────────────────────

    @Test
    fun `the too-short message names the number`() {
        // A message that says "too short" without saying how short is the
        // version that was already there.
        assertTrue(AppealStatement.TOO_SHORT.contains(min.toString()))
    }

    @Test
    fun `it explains why the statement matters, not only that it is invalid`() {
        assertTrue(AppealStatement.TOO_SHORT.contains("a person reads", ignoreCase = true))
    }

    // ── The numbers themselves ───────────────────────────────────────────────

    @Test
    fun `the minimum is short enough for one honest sentence`() {
        // Not a style preference. This screen is the only way a banned person
        // can say anything, and a minimum long enough to be a hurdle is a
        // minimum that loses real appeals.
        assertTrue("the minimum has grown into a hurdle: $min", min in 1..60)
    }

    @Test
    fun `evidence is capped low enough that a reviewer reads all of it`() {
        // A reviewer who has to open twenty screenshots opens none of them.
        assertTrue(AppealStatement.MAX_EVIDENCE in 1..5)
    }
}

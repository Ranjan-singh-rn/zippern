package com.zipper.app.data.repository

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * RC (confirmed) — "another appeal after a decision only with new evidence or a
 * valid reason". The app refuses, before uploading anything, a re-appeal that
 * repeats the decided statement with no new evidence; the comparison is the one
 * the rules (`reappealOk`) and the servers (`appeal_policy`) make — case and
 * spacing ignored.
 */
class AppealReappealTest {

    @Test fun `the same statement with different case and spacing is the same statement`() {
        assertEquals(
            AppealStatement.normalise("  I was banned   by MISTAKE. "),
            AppealStatement.normalise("i was banned by mistake."),
        )
    }

    @Test fun `a different statement is different`() {
        assertNotEquals(
            AppealStatement.normalise("I was banned by mistake."),
            AppealStatement.normalise("Since the decision I found the recording that shows it was not me."),
        )
    }

    @Test fun `the refusal says what would be accepted`() {
        assertTrue(AppealStatement.REAPPEAL_NEEDS_SOMETHING_NEW.contains("new evidence"))
        assertTrue(AppealStatement.REAPPEAL_NEEDS_SOMETHING_NEW.contains("what is new"))
    }
}

package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * RF-30 — a write whose answer never arrived is recognised as UNKNOWN, never
 * as failed. The bridge's code, the SDK's deadline and a connection lost in
 * flight all count; a refusal the server explained does not.
 */
class WriteOutcomeTest {

    private val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
    private fun src(rel: String) = File(main, "com/zipper/app/$rel").readText()

    @Test fun `the bridge's OUTCOME_UNKNOWN is unknown`() {
        assertTrue(WriteOutcome.unknown("DEADLINE_EXCEEDED", "OUTCOME_UNKNOWN", transport = false))
        assertTrue(WriteOutcome.unknown("UNAVAILABLE", " OUTCOME_UNKNOWN ", transport = false))
    }

    @Test fun `the SDK's own deadline is unknown — the function may still have run`() {
        assertTrue(WriteOutcome.unknown("DEADLINE_EXCEEDED", null, transport = false))
        assertTrue(WriteOutcome.unknown("DEADLINE_EXCEEDED", "", transport = false))
    }

    @Test fun `a connection lost in flight is unknown`() {
        assertTrue(WriteOutcome.unknown("INTERNAL", "", transport = true))
    }

    @Test fun `a refusal the server explained is known`() {
        for (code in listOf("FAILED_PRECONDITION", "INVALID_ARGUMENT", "PERMISSION_DENIED", "UNAUTHENTICATED",
                            "INTERNAL", "UNAVAILABLE", "NOT_FOUND")) {
            assertFalse("$code must not read as unknown", WriteOutcome.unknown(code, "", transport = false))
        }
        assertFalse(WriteOutcome.unknown("PERMISSION_DENIED", "ACCOUNT_RESTRICTED", transport = false))
        assertFalse(WriteOutcome.unknown("FAILED_PRECONDITION", "CONTACT_REQUIRED", transport = false))
    }

    @Test fun `the code matches the bridge's, letter for letter`() {
        assertEquals("OUTCOME_UNKNOWN", WriteOutcome.OUTCOME_UNKNOWN)
        val repo = listOf(File("../functions/src/index.ts"), File("../../functions/src/index.ts")).firstOrNull { it.exists() }
        if (repo != null) assertTrue(repo.readText().contains("const OUTCOME_UNKNOWN = 'OUTCOME_UNKNOWN'"))
    }

    @Test fun `every partner callable failure carries the classification`() {
        val fns = src("data/repository/PartnerFunctions.kt")
        val call = fns.substring(fns.indexOf("private suspend fun <T> call("))
        assertTrue(call.contains("outcomeUnknown = WriteOutcome.unknown("))
        assertTrue(call.contains("ServerRefusals.detailCodeOf(e)"))
        assertTrue(call.contains("e.cause is java.io.IOException"))
        // No Functions exception at all: nothing said what happened.
        assertTrue(call.contains("\"Could not reach the server. Check your connection.\", outcomeUnknown = true"))
        // The session refusal is still reported first (P0-1).
        assertTrue(call.indexOf("ServerRefusals.report(e)") < call.indexOf("outcomeUnknown = WriteOutcome.unknown("))
    }
}

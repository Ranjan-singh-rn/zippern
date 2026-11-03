package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Decision 15 (RC) — the app's reading of "an approved role starts only once
 * BOTH contacts are verified". The server decides
 * (`backend/tests/test_rc_contact_verification.py`,
 * `functions/test/rcContactProof.test.js`); these pin how the app turns the
 * server's answer into words and the verification flows to offer.
 */
class ActivationRequirementTest {

    @Test fun `the eligibility activation block is read`() {
        val a = ActivationRequirement.fromEligibility(
            mapOf("requirement" to "both", "complete" to false, "missing" to listOf("email"), "emailUnproved" to true),
        )!!
        assertFalse(a.complete)
        assertEquals(listOf("email"), a.missing)
        assertTrue(a.emailUnproved)
        assertTrue(a.beforeApplying.contains("BOTH"))
        assertTrue(a.beforeApplying.contains("your email address"))
    }

    @Test fun `an older server sends no block`() {
        assertNull(ActivationRequirement.fromEligibility(null))
    }

    @Test fun `complete means nothing to say before applying`() {
        val a = ActivationRequirement.fromEligibility(mapOf("complete" to true, "missing" to emptyList<String>()))!!
        assertEquals("", a.beforeApplying)
        assertEquals(emptyList<VerifyAction>(), a.actions)
    }

    @Test fun `a CONTACT_VERIFICATION_REQUIRED refusal is recognised, nothing else is`() {
        val a = ActivationRequirement.fromRefusal(
            mapOf("code" to "CONTACT_VERIFICATION_REQUIRED", "missing" to listOf("phone", "email")),
            "Both are needed.",
        )!!
        assertEquals(listOf("phone", "email"), a.missing)
        assertEquals("Both are needed.", a.message)
        assertNull(ActivationRequirement.fromRefusal(mapOf("code" to "CONTACT_REQUIRED"), "x"))
        assertNull(ActivationRequirement.fromRefusal("not a map", "x"))
    }

    @Test fun `the verification block from the check is read, with the unproved email`() {
        val a = ActivationRequirement.fromVerification(
            mapOf(
                "complete" to false, "missing" to listOf("email"),
                "phone" to mapOf("verified" to true), "email" to mapOf("verified" to false, "unproved" to true),
            ),
        )!!
        assertEquals(listOf("email"), a.missing)
        assertTrue(a.emailUnproved)
        assertEquals(listOf(VerifyAction.EMAIL), a.actions)
    }

    @Test fun `actions offer exactly what is missing`() {
        val both = ActivationRequirement(complete = false, missing = listOf("phone", "email"), emailUnproved = false)
        assertEquals(listOf(VerifyAction.PHONE, VerifyAction.EMAIL), both.actions)
        val phoneOnly = ActivationRequirement(complete = false, missing = listOf("phone"), emailUnproved = false)
        assertEquals(listOf(VerifyAction.PHONE), phoneOnly.actions)
        val confirmEmail = ActivationRequirement(complete = false, missing = listOf("phone", "email"), emailUnproved = true)
        assertEquals(VerifyAction.EMAIL, confirmEmail.actions.first())
    }

    @Test fun `the waiting line names what is still needed`() {
        val one = ActivationRequirement(complete = false, missing = listOf("phone"), emailUnproved = false)
        assertTrue(one.waitingLine.contains("your phone number is verified"))
        val two = ActivationRequirement(complete = false, missing = listOf("phone", "email"), emailUnproved = false)
        assertTrue(two.waitingLine.contains("are verified"))
        val none = ActivationRequirement(complete = false, missing = emptyList(), emailUnproved = false)
        assertTrue(none.waitingLine.contains("both your phone number and your email address"))
    }

    /**
     * E2E round 2 (3 Nov 2026, QA #51): an invited host verified an email that
     * is not the one the agency registered. Both contacts are verified, the
     * server refused to start the role and said why — the line said "Your role
     * is starting." for ever.
     */
    @Test fun `contacts verified but the role refused - the server's reason, not 'starting'`() {
        val why = "Your agency invited you with another email address (q•••@example.com). " +
            "Verify that address to start your Host role, or ask your agency to send a new invitation."
        val refused = ActivationRequirement(complete = true, missing = emptyList(), emailUnproved = false, notStarted = why)
        assertEquals(why, refused.waitingLine)
        assertFalse(refused.waitingLine.contains("starting"))
        val plain = ActivationRequirement(complete = true, missing = emptyList(), emailUnproved = false)
        assertEquals("Both contacts are verified. Your role is starting.", plain.waitingLine)
        // A contact still missing is said as before, whatever else was sent.
        val missing = ActivationRequirement(complete = false, missing = listOf("email"), emailUnproved = false, notStarted = why)
        assertTrue(missing.waitingLine.contains("your email address is verified"))
    }
}

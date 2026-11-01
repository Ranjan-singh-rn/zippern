package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Approved contact rule — the app's reading of the server's machine-readable
 * contact answer (`CONTACT_REQUIRED`).
 *
 * The server decides from the Firebase Auth record (backend
 * `partner_applications.ContactRequired`); these pin how the app turns that
 * answer into an explanation and the verification flows to offer. The
 * server-side cases (email-only, phone-only, neither, unverified, direct API)
 * are in `backend/tests/test_fx_record_integrity.py` and
 * `functions/test/fxRecordIntegrity.test.js`.
 */
class ContactRequirementTest {

    private fun refusal(
        missing: List<String>? = listOf("phone", "email"),
        emailUnverified: Boolean = false,
        code: String = "CONTACT_REQUIRED",
    ): Map<String, Any?> = buildMap {
        put("code", code)
        put("requirement", "one_of")
        if (missing != null) put("missing", missing)
        put("emailUnverified", emailUnverified)
    }

    // ── refusals ────────────────────────────────────────────────────────────

    @Test fun `a CONTACT_REQUIRED refusal becomes a requirement`() {
        val c = ContactRequirement.fromRefusal(refusal(), "Verify a phone number or an email first.")!!
        assertTrue(c.required)
        assertEquals(listOf("phone", "email"), c.missing)
        assertFalse(c.emailUnverified)
        assertEquals("Verify a phone number or an email first.", c.message)
        assertEquals(listOf(VerifyAction.PHONE, VerifyAction.EMAIL), c.actions)
    }

    @Test fun `any other refusal stays a sentence`() {
        assertNull(ContactRequirement.fromRefusal(refusal(code = "PERMISSION_DENIED"), "No."))
        assertNull(ContactRequirement.fromRefusal(null, "No."))
        assertNull(ContactRequirement.fromRefusal("CONTACT_REQUIRED", "a string is not a details map"))
        assertNull(ContactRequirement.fromRefusal(mapOf("missing" to listOf("phone")), "no code"))
    }

    @Test fun `an unverified email is offered first, as confirming it`() {
        val c = ContactRequirement.fromRefusal(refusal(emailUnverified = true), null)!!
        assertTrue(c.emailUnverified)
        assertEquals(listOf(VerifyAction.EMAIL, VerifyAction.PHONE), c.actions)
        assertTrue(c.explanation.contains("has not been confirmed"))
        assertEquals("", c.message)
    }

    @Test fun `a refusal with no list still means either contact would do`() {
        val c = ContactRequirement.fromRefusal(refusal(missing = null), null)!!
        assertEquals(listOf("phone", "email"), c.missing)
        assertEquals(listOf(VerifyAction.PHONE, VerifyAction.EMAIL), c.actions)
    }

    @Test fun `unknown contact names are ignored, never offered`() {
        val c = ContactRequirement.fromRefusal(refusal(missing = listOf("fax", "phone")), null)!!
        assertEquals(listOf("phone"), c.missing)
        assertEquals(listOf(VerifyAction.PHONE), c.actions)
    }

    @Test fun `each action appears once`() {
        val c = ContactRequirement.fromRefusal(refusal(missing = listOf("email", "phone"), emailUnverified = true), null)!!
        assertEquals(c.actions.distinct(), c.actions)
        assertEquals(2, c.actions.size)
    }

    // ── the eligibility block ───────────────────────────────────────────────

    @Test fun `the eligibility block says whether verification is required`() {
        val need = ContactRequirement.fromEligibility(
            mapOf("required" to true, "requirement" to "one_of", "missing" to listOf("phone", "email"),
                "emailUnverified" to false, "message" to "Verify first."),
        )!!
        assertTrue(need.required)
        assertEquals("Verify first.", need.message)

        val ok = ContactRequirement.fromEligibility(
            mapOf("required" to false, "requirement" to "one_of", "missing" to emptyList<String>(), "emailUnverified" to false),
        )!!
        assertFalse("a verified contact needs nothing", ok.required)
    }

    @Test fun `an older server without the block is not a requirement`() {
        assertNull(ContactRequirement.fromEligibility(null))
        assertNull(ContactRequirement.fromEligibility("not a map"))
    }

    @Test fun `only an explicit true is required`() {
        assertFalse(ContactRequirement.fromEligibility(mapOf("required" to "true"))!!.required)
        assertFalse(ContactRequirement.fromEligibility(emptyMap<String, Any>())!!.required)
    }

    @Test fun `one verified contact is enough — the explanation says so`() {
        val c = ContactRequirement.fromRefusal(refusal(), null)!!
        assertTrue(c.explanation.contains("One verified contact is enough"))
    }
}

package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * QA #51 — an invited host who signed up by phone is told which contact is
 * missing (and what the agency registered), never "Details don't match".
 */
class ReferralContactsTest {

    @Test fun `phone sign-up is told to verify the registered email`() {
        val line = ReferralContacts.validLine("QA Agency CRM", listOf("email"), mapOf("email" to "i•••@example.test"))
        assertTrue(line, line.startsWith("Valid code — joining QA Agency CRM."))
        assertTrue(line, line.contains("the email address your agency registered (i•••@example.test)"))
        assertTrue(line, line.contains("Me → Settings"))
        assertFalse(line, line.contains("don't match"))
    }

    @Test fun `Google sign-up is told to verify the registered phone`() {
        val line = ReferralContacts.validLine("", listOf("phone"), mapOf("phone" to "••••0004"))
        assertTrue(line, line.contains("the phone number your agency registered (••••0004)"))
    }

    @Test fun `nothing missing reads as before`() {
        assertEquals(
            "Valid code — joining A. You'll be registered as a host.",
            ReferralContacts.validLine("A", emptyList(), emptyMap()),
        )
    }

    @Test fun `no hint still names the contact`() {
        assertEquals("your email address", ReferralContacts.describe(listOf("email"), emptyMap()))
        assertEquals(
            "your phone number and your email address",
            ReferralContacts.describe(listOf("phone", "email"), emptyMap()),
        )
        assertEquals("", ReferralContacts.describe(listOf("fax"), emptyMap()))
    }

    @Test fun `the after-save notice says the role starts by itself`() {
        val n = ReferralContacts.awaitingNotice(listOf("email"), mapOf("email" to "i•••@example.test"))
        assertTrue(n, n.contains("starts by itself"))
        assertTrue(n, n.contains("i•••@example.test"))
        assertTrue(n, n.contains("do not need the code again"))
    }
}

package com.zipper.app.util

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * UGP-A / UGP-1.7 — what the app concludes about an account's contacts.
 *
 * The partner card's wording follows the SERVER's contact rule
 * (`partner_applications.ContactRequired`, `is_unverified_guest`): a phone, or
 * an email Firebase has confirmed. Settings rows follow the BOUND state: on the
 * Auth record AND on `users/{uid}`.
 *
 * Approved contact rule: an account with no verified contact now SEES the card
 * (it used to see nothing, which explained nothing), and the card says a
 * verified contact comes first. The server still refuses the application.
 */
class ContactRulesTest {

    @Test fun `a guest with no contact sees the card, and it says a verified contact comes first`() {
        assertTrue(ContactRules.partnerEntryVisible("", null, null, false))
        assertTrue(ContactRules.partnerEntryVisible("", "", "", false))
        assertTrue(ContactRules.partnerEntryNeedsContact(null, null, false))
        assertTrue(ContactRules.partnerEntryNeedsContact("", "", false))
    }

    @Test fun `an unverified email is not a contact`() {
        assertFalse(ContactRules.hasVerifiedContact(null, "a@example.com", false))
        assertTrue(ContactRules.partnerEntryNeedsContact(null, "a@example.com", false))
    }

    @Test fun `a verified email or a phone is enough on its own`() {
        // email-only
        assertTrue(ContactRules.hasVerifiedContact(null, "a@example.com", true))
        assertFalse(ContactRules.partnerEntryNeedsContact(null, "a@example.com", true))
        // phone-only
        assertTrue(ContactRules.hasVerifiedContact("+919800000001", null, false))
        assertFalse(ContactRules.partnerEntryNeedsContact("+919800000001", null, false))
        assertTrue(ContactRules.partnerEntryVisible("", "+919800000001", null, false))
    }

    @Test fun `a verified email with no address is not a contact`() {
        assertFalse(ContactRules.hasVerifiedContact("", "", true))
        assertTrue(ContactRules.partnerEntryNeedsContact("", "", true))
    }

    @Test fun `staff never see the card, contact or not`() {
        assertFalse(ContactRules.partnerEntryVisible("superadmin", "+919800000001", "a@example.com", true))
        assertFalse(ContactRules.partnerEntryVisible("app_admin", "+919800000001", null, false))
    }

    @Test fun `a phone linked on Auth but not bound on the account still offers the row`() {
        assertFalse(ContactRules.phoneBound("+919800000001", ""))
        assertFalse(ContactRules.phoneBound("", "+919800000001"))
        assertTrue(ContactRules.phoneBound("+919800000001", "+919800000001"))
    }

    @Test fun `an email counts as bound only when verified on Auth and recorded`() {
        assertFalse(ContactRules.emailBound("a@example.com", false, "a@example.com"))
        assertFalse(ContactRules.emailBound("a@example.com", true, ""))
        assertFalse(ContactRules.emailBound(null, true, "a@example.com"))
        assertTrue(ContactRules.emailBound("a@example.com", true, "a@example.com"))
    }
}

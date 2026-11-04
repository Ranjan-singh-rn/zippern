package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** QA #7 (India pinned in the country picker) and QA #8 (the phone number is checked, with a reason). */
class CountryPickerAndPhoneTest {
    private val india = ALL_COUNTRIES.first { it.dialCode == "+91" }
    private val uae = ALL_COUNTRIES.first { it.dialCode == "+971" }

    @Test fun `India is first in the picker`() {
        assertEquals("+91", countriesForPicker().first().dialCode)
        assertEquals(ALL_COUNTRIES.size, countriesForPicker().size)
    }

    @Test fun `India stays first in a search that matches it, and a search that does not leaves it out`() {
        assertEquals("India", countriesForPicker("ind").first().name)  // also matches Indonesia
        assertTrue(countriesForPicker("Indonesia").none { it.dialCode == "+91" })
    }

    @Test fun `an Indian number needs ten digits starting 6 to 9`() {
        assertNull(phoneNumberProblem("9990010001", india))
        assertNull(phoneNumberProblem("6123456789", india))
        assertNotNull(phoneNumberProblem("999001000", india))     // nine digits
        assertNotNull(phoneNumberProblem("5990010001", india))    // starts with 5
        assertNotNull(phoneNumberProblem("", india))
    }

    @Test fun `elsewhere only the length is checked`() {
        assertNull(phoneNumberProblem("501234567", uae))
        assertNotNull(phoneNumberProblem("1234", uae))
    }

    @Test fun `the reason shows at the right moment`() {
        assertTrue("a wrong first digit at once", showPhoneProblemNow("5", india, submitted = false))
        assertFalse("not while a good number is still being typed", showPhoneProblemNow("99900", india, submitted = false))
        assertTrue("once the field is full", showPhoneProblemNow("9990010001", india, submitted = false))
        assertTrue("or when they try to send it", showPhoneProblemNow("99900", india, submitted = true))
        assertFalse("an empty field says nothing until a send", showPhoneProblemNow("", india, submitted = false))
    }
}

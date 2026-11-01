package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * FX-21 (minimal) — the Login screen warns a device's guest before a phone or
 * Google sign-in opens a separate account, and offers the guest account
 * instead. Nothing is merged or moved. These pin what the device remembers at
 * sign-out and when the warning shows.
 */
class GuestLinkWarningTest {

    @Test fun `signing out of a guest remembers it`() {
        assertEquals(
            GuestLinkWarning.Mark.Remember("G1"),
            GuestLinkWarning.onSignOut("G1", listOf("firebase"), serverSaysGuest = true, rememberedGuestUid = ""),
        )
    }

    @Test fun `a long-standing guest the server was never asked about is remembered too`() {
        assertEquals(
            GuestLinkWarning.Mark.Remember("G1"),
            GuestLinkWarning.onSignOut("G1", emptyList(), serverSaysGuest = null, rememberedGuestUid = ""),
        )
    }

    @Test fun `the remembered guest, secured since, is forgotten`() {
        assertEquals(
            GuestLinkWarning.Mark.Forget,
            GuestLinkWarning.onSignOut("G1", listOf("firebase", "phone"), serverSaysGuest = false, rememberedGuestUid = "G1"),
        )
    }

    @Test fun `a server that says not-a-guest wins even with no provider listed`() {
        assertEquals(
            GuestLinkWarning.Mark.Forget,
            GuestLinkWarning.onSignOut("G1", emptyList(), serverSaysGuest = false, rememberedGuestUid = "G1"),
        )
    }

    @Test fun `signing out of a different, registered account leaves the guest remembered`() {
        assertEquals(
            GuestLinkWarning.Mark.Leave,
            GuestLinkWarning.onSignOut("N1", listOf("google.com"), serverSaysGuest = false, rememberedGuestUid = "G1"),
        )
    }

    @Test fun `no account, nothing changes`() {
        assertEquals(GuestLinkWarning.Mark.Leave, GuestLinkWarning.onSignOut(null, emptyList(), null, "G1"))
        assertEquals(GuestLinkWarning.Mark.Leave, GuestLinkWarning.onSignOut("  ", emptyList(), null, "G1"))
    }

    @Test fun `the warning shows once a guest is remembered, until acknowledged`() {
        assertTrue(GuestLinkWarning.shouldWarn("G1", acknowledged = false))
        assertFalse(GuestLinkWarning.shouldWarn("G1", acknowledged = true))
        assertFalse(GuestLinkWarning.shouldWarn("", acknowledged = false))
    }

    @Test fun `the words say separate, nothing merged, and how to keep one account`() {
        assertTrue(GuestLinkWarning.BODY.contains("separate account"))
        assertTrue(GuestLinkWarning.BODY.contains("nothing is moved or merged"))
        assertTrue(GuestLinkWarning.BODY.contains("Secure your account"))
    }
}

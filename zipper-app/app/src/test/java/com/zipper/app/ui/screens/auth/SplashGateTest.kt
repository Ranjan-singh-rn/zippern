package com.zipper.app.ui.screens.auth

import com.zipper.app.data.repository.MoneyFunctions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * AUTH-003 (Phase 1A) — the cold-start gate fails CLOSED.
 *
 * The pure decision is tested directly; the screen is pinned at the source so
 * the old "any exception → Main" fallback and the cache-served read cannot
 * quietly come back.
 */
class SplashGateTest {

    private fun id(decision: String, reason: String = "", until: Long = 0L) = MoneyFunctions.Identity(
        decision = decision, uid = "u", exists = true, isProfileComplete = true,
        displayName = "", photoUrl = "", crmRole = "", isHost = false, isGuest = false,
        requiresPhone = false, requiresEmail = false, deletionDueAtMs = 0L,
        reason = reason, suspendedUntilMs = until,
    )

    @Test fun `no server answer is never Continue`() {
        assertTrue(SplashGate.decide(null) is SplashVerdict.Unverified)
    }

    @Test fun `an unknown decision is never Continue`() {
        assertTrue(SplashGate.decide(id("something_new")) is SplashVerdict.Unverified)
    }

    @Test fun `allow continues`() {
        assertEquals(SplashVerdict.Continue, SplashGate.decide(id("allow")))
    }

    @Test fun `suspended routes to the suspension screen with its end date`() {
        val v = SplashGate.decide(id("suspended", "spam", 123L))
        assertEquals(SplashVerdict.Suspended("spam", 123L), v)
    }

    @Test fun `banned and device banned route to their screens`() {
        assertTrue(SplashGate.decide(id("banned")) is SplashVerdict.Banned)
        assertTrue(SplashGate.decide(id("device_banned")) is SplashVerdict.DeviceBanned)
    }

    @Test fun `pending deletion must be answered first`() {
        assertEquals(SplashVerdict.Recover, SplashGate.decide(id("deleted_recoverable")))
    }

    @Test fun `retry is bounded`() {
        assertEquals(3, SplashGate.MAX_ATTEMPTS)
        val total = (1..SplashGate.MAX_ATTEMPTS).sumOf { SplashGate.backoffMs(it) }
        assertTrue("total backoff must stay short", total <= 3_000L)
    }

    @Test fun `the splash no longer opens Main on failure and reads from the server`() {
        val src = listOf(
            File("src/main/java/com/zipper/app/ui/screens/auth/SplashScreen.kt"),
            File("app/src/main/java/com/zipper/app/ui/screens/auth/SplashScreen.kt"),
        ).first { it.exists() }.readText()
        assertFalse(
            "the catch-all must not navigate to Main",
            Regex("""catch \(e: Exception\) \{\s*onNavigateToMain\(\)""").containsMatchIn(src),
        )
        assertTrue("the user document is read from the server", src.contains("get(Source.SERVER)"))
        assertTrue("the server gate runs on cold start", src.contains("splashViewModel.verifyIdentity("))
        assertTrue("there is a retry", src.contains("Try again"))
    }
}

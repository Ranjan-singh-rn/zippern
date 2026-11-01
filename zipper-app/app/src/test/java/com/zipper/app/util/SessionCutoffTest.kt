package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * APK 20 / A-9 — the device reads `credentialsValidAfter` and signs itself out
 * when its sign-in is older than the account's cut-off. Mirrors
 * `signInPredatesCutoff` in functions/src/mobileSession.ts, case for case.
 */
class SessionCutoffTest {

    private val now = 1_800_000_000L

    @Test fun `no cut-off recorded means nothing to compare`() {
        assertFalse(SessionCutoff.signInPredatesCutoff(null, now - 100, now))
        assertFalse(SessionCutoff.signInPredatesCutoff(0L, now - 100, now))
        assertFalse(SessionCutoff.signInPredatesCutoff(-5L, null, now))
    }

    @Test fun `a cut-off with no usable auth time is stale`() {
        assertTrue(SessionCutoff.signInPredatesCutoff(now - 50, null, now))
        assertTrue(SessionCutoff.signInPredatesCutoff(now - 50, 0L, now))
    }

    @Test fun `an auth time before the cut-off is stale, equal or later passes`() {
        val cutoff = now - 1_000
        assertTrue(SessionCutoff.signInPredatesCutoff(cutoff, cutoff - 1, now))
        assertFalse("the device that set the cut-off passes", SessionCutoff.signInPredatesCutoff(cutoff, cutoff, now))
        assertFalse(SessionCutoff.signInPredatesCutoff(cutoff, cutoff + 1, now))
    }

    @Test fun `an auth time in the future beyond the skew is stale, within it passes`() {
        val cutoff = now - 1_000
        assertFalse(SessionCutoff.signInPredatesCutoff(cutoff, now + SessionCutoff.CLOCK_SKEW_SECONDS, now))
        assertTrue(SessionCutoff.signInPredatesCutoff(cutoff, now + SessionCutoff.CLOCK_SKEW_SECONDS + 1, now))
        assertEquals(60L, SessionCutoff.CLOCK_SKEW_SECONDS)
    }

    @Test fun `the field is read whatever number type Firestore returns`() {
        assertEquals(123L, SessionCutoff.validAfterOf(123L))
        assertEquals(123L, SessionCutoff.validAfterOf(123.0))
        assertEquals(123L, SessionCutoff.validAfterOf("123"))
        assertNull(SessionCutoff.validAfterOf(0L))
        assertNull(SessionCutoff.validAfterOf(null))
        assertNull(SessionCutoff.validAfterOf("soon"))
    }

    @Test fun `the own-user listener reads the cut-off and a session-less device claims one at Splash`() {
        val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
        val session = File(main, "com/zipper/app/ui/screens/auth/SessionViewModel.kt").readText()
        assertTrue(session.contains("SessionCutoff.validAfterOf(snap.get(\"credentialsValidAfter\"))"))
        assertTrue(session.contains("SessionCutoff.signInPredatesCutoff("))
        assertTrue("a stale sign-in is a SignedOut event", session.contains("_events.emit(SessionEvent.SignedOut(message))"))
        val splash = File(main, "com/zipper/app/ui/screens/auth/SplashScreen.kt").readText()
        assertTrue(splash.contains("if (localSessionId.isBlank()) {"))
        assertTrue(splash.contains("splashViewModel.ensureSession(deviceId)"))
        assertTrue("a failed claim stays on the retry screen", splash.contains("gateError = refusal.message"))
        assertTrue("the observer is told why", splash.contains("ForcedSignOut.raise(SplashGate.OBSERVER_DENIED_MESSAGE)"))
        assertEquals("This account cannot use the app.", com.zipper.app.ui.screens.auth.SplashGate.OBSERVER_DENIED_MESSAGE)
        val repo = File(main, "com/zipper/app/data/repository/AuthRepository.kt").readText()
        assertTrue(repo.contains("suspend fun ensureMobileSession(deviceId: String): AuthResult?"))
    }
}

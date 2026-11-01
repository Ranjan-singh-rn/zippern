package com.zipper.app.ui.screens.auth

import com.zipper.app.data.repository.MoneyFunctions
import com.zipper.app.util.DeletionWindow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.IOException
import java.net.UnknownHostException
import java.util.concurrent.TimeoutException

/**
 * B03 — a cold start with no signal no longer logs anybody out — and C8 (B27):
 * a deleted account past its window is never entered from Splash.
 *
 * Firebase's own refusals (`FirebaseAuthInvalidUserException`,
 * `FirebaseAuthInvalidCredentialsException`) cannot be constructed on the JVM —
 * their constructor reaches an Android stub — so the classifier is tested on
 * every OTHER kind of failure, which must all be retries, and on the decision
 * that only a refused credential ends the session. The two `is` checks are
 * pinned at the source.
 */
class SplashReloadTest {

    @Test fun `a network failure is not a dead credential`() {
        for (e in listOf(IOException("offline"), UnknownHostException("no dns"), TimeoutException(), RuntimeException("?"))) {
            assertEquals(SplashGate.ReloadFailure.Unreachable, SplashGate.reloadFailure(e))
        }
    }

    @Test fun `only a refused credential ends the session`() {
        assertTrue(SplashGate.endsSession(SplashGate.ReloadFailure.CredentialRefused))
        assertFalse(SplashGate.endsSession(SplashGate.ReloadFailure.Unreachable))
    }

    @Test fun `an unreachable server keeps the session on every kind of failure`() {
        for (e in listOf<Throwable>(IOException(), IllegalStateException(), Exception())) {
            assertFalse(SplashGate.endsSession(SplashGate.reloadFailure(e)))
        }
    }

    private fun id(decision: String) = MoneyFunctions.Identity(
        decision = decision, uid = "u", exists = true, isProfileComplete = true,
        displayName = "", photoUrl = "", crmRole = "", isHost = false, isGuest = false,
        requiresPhone = false, requiresEmail = false, deletionDueAtMs = 0L,
    )

    @Test fun `a permanently deleted account is told so and signed out, never entered`() {
        val v = SplashGate.decide(id("deleted_permanent"))
        assertEquals(SplashVerdict.AccountDeleted(DeletionWindow.ACCOUNT_DELETED), v)
    }

    @Test fun `the observer is still signed out without a deletion notice`() {
        assertEquals(SplashVerdict.SignOut, SplashGate.decide(id("observer_denied")))
    }

    @Test fun `a role that owes a contact still continues on a cold start`() {
        val owes = MoneyFunctions.Identity(
            decision = "allow", uid = "u", exists = true, isProfileComplete = true,
            displayName = "", photoUrl = "", crmRole = "agency", isHost = false, isGuest = false,
            requiresPhone = true, requiresEmail = false, deletionDueAtMs = 0L,
        )
        assertEquals(SplashVerdict.Continue, SplashGate.decide(owes))
    }

    @Test fun `the splash classifies the reload failure instead of always signing out`() {
        val src = listOf(
            File("src/main/java/com/zipper/app/ui/screens/auth/SplashScreen.kt"),
            File("app/src/main/java/com/zipper/app/ui/screens/auth/SplashScreen.kt"),
        ).first { it.exists() }.readText()
        val reload = src.substring(src.indexOf("user.reload().await()"), src.indexOf("splashViewModel.verifyIdentity("))
        assertTrue(reload.contains("SplashGate.endsSession(SplashGate.reloadFailure(e))"))
        assertTrue("a network failure stops on the retry state", reload.contains("gateError = "))
        assertTrue(src.contains("is SplashVerdict.AccountDeleted ->"))
        // B44: a lifted device bar (isActive == false) is not a bar.
        assertTrue(src.contains("DeviceBan.applies(deviceBanSnap.exists(), deviceBanSnap.getBoolean(\"isActive\"))"))

        val vm = listOf(
            File("src/main/java/com/zipper/app/ui/screens/auth/SplashViewModel.kt"),
            File("app/src/main/java/com/zipper/app/ui/screens/auth/SplashViewModel.kt"),
        ).first { it.exists() }.readText()
        assertTrue(vm.contains("is FirebaseAuthInvalidUserException,"))
        assertTrue(vm.contains("is FirebaseAuthInvalidCredentialsException -> ReloadFailure.CredentialRefused"))
    }
}

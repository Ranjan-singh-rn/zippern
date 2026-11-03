package com.zipper.app.util

import com.zipper.app.data.repository.RestrictionKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * QA #55 — a banned person signing in by phone saw only Firebase's
 * "The user account has been disabled by an administrator.".
 *
 * Both paths into the Banned screen are pinned here: a FRESH sign-in that
 * Firebase refuses (`ERROR_USER_DISABLED`, mapped by [DisabledSignIn]) and an
 * EXISTING session the ban lands on (SessionViewModel's listener, by wiring).
 */
class DisabledSignInTest {

    private val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
    private fun src(path: String) = File(main, "com/zipper/app/$path").readText()

    @Test fun `only Firebase's disabled-login code is a ban`() {
        assertTrue(DisabledSignIn.isAccountDisabled("ERROR_USER_DISABLED"))
        assertFalse(DisabledSignIn.isAccountDisabled("ERROR_USER_NOT_FOUND"))
        assertFalse(DisabledSignIn.isAccountDisabled("ERROR_INVALID_VERIFICATION_CODE"))
        assertFalse(DisabledSignIn.isAccountDisabled(null))
    }

    @Test fun `the device proved the account - the reason and the device-key appeal`() {
        val v = DisabledSignIn.verdict("banned", uid = "U2", reason = "Repeated harassment (R-1042)", message = "x")
        assertEquals(RestrictionKind.Account, v.kind)
        assertEquals("Repeated harassment (R-1042)", v.reason)
        assertEquals("U2", v.uid)
        assertTrue(v.deviceKeyAppeal)
    }

    @Test fun `a ban with no recorded reason falls back to the server's sentence`() {
        val v = DisabledSignIn.verdict("banned", uid = "U2", reason = "", message = "Your account has been banned. Please contact support to appeal this decision.")
        assertTrue(v.reason.startsWith("Your account has been banned"))
    }

    @Test fun `a suspension is never shown the ban screen and keeps its end`() {
        val v = DisabledSignIn.verdict("suspended", uid = "U3", reason = "Spam in chat", suspendedUntilMs = 1_800_000_000_000L)
        assertEquals(RestrictionKind.Suspension, v.kind)
        assertEquals(1_800_000_000_000L, v.untilMillis)
    }

    @Test fun `without proof the screen is still the Banned screen, with no reason and no device-key appeal`() {
        for (outcome in listOf(null, "other_account", "not_restricted", "refused", "")) {
            val v = DisabledSignIn.verdict(outcome)
            assertEquals(RestrictionKind.Account, v.kind)
            assertEquals("", v.reason)
            assertEquals("", v.uid)
            assertFalse("outcome=$outcome", v.deviceKeyAppeal)
        }
        assertTrue(DisabledSignIn.REASON_ELSEWHERE.contains("You can still appeal"))
    }

    @Test fun `a barred handset is the device screen`() {
        val v = DisabledSignIn.verdict("device_banned", message = "Your device is banned.")
        assertEquals(RestrictionKind.Device, v.kind)
        assertFalse(v.deviceKeyAppeal)
    }

    @Test fun `fresh sign-in - phone and Google map the disabled login to the Banned screen`() {
        val repo = src("data/repository/AuthRepository.kt")
        assertTrue(repo.contains("} catch (e: FirebaseAuthInvalidUserException) {"))
        assertTrue(repo.contains("restrictionAfterDisabledSignIn(deviceId, phone, \"\")"))
        assertTrue(repo.contains("restrictionAfterDisabledSignIn(deviceId, \"\", com.zipper.app.util.JwtClaims.string(idToken, \"email\"))"))
        val fn = repo.substring(repo.indexOf("private suspend fun restrictionAfterDisabledSignIn("))
        // Through the marked sign-out (QA #31), so the session watcher does not take it
        // for a lost session.
        assertTrue("never signs anybody in", fn.substring(0, 2400).contains("try { signOutFirebase() }"))
        assertTrue(fn.contains("money.quickLoginRestriction("))
        assertTrue(fn.contains("PublicAppeal.deviceKeyAppealAllowed = v.deviceKeyAppeal"))
        assertTrue(fn.contains("return AuthResult.Banned("))
        // the number the code went to travels with the sign-in
        assertTrue(src("ui/screens/auth/AuthViewModel.kt").contains("repo.verifyOtp(verificationId, code, deviceId, otpPhone)"))
    }

    @Test fun `an unproved restriction is appealed on the web, not with the device key`() {
        val appeals = src("data/repository/AppealRepository.kt")
        val fn = appeals.substring(appeals.indexOf("suspend fun appealRoute()"))
        assertTrue(fn.indexOf("if (!com.zipper.app.util.PublicAppeal.deviceKeyAppealAllowed)") in 0 until fn.indexOf("quickLogin.load()"))
        PublicAppeal.deviceKeyAppealAllowed = false
        PublicAppeal.forgetRestrictedUid()
        assertTrue("reset with the uid", PublicAppeal.deviceKeyAppealAllowed)
    }

    @Test fun `existing session - the ban lands on the Banned screen with its reason`() {
        val vm = src("ui/screens/auth/SessionViewModel.kt")
        assertTrue(vm.contains("AccountRestriction.Banned -> {"))
        assertTrue(vm.contains("viewModelScope.launch { _events.emit(SessionEvent.Banned(reason)) }"))
        assertTrue(vm.contains("snap.getString(\"banReason\")"))
    }
}

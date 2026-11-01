package com.zipper.app.ui.screens.auth

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * FX-15 (RF-28) — one action at a time on the sign-in and binding screens.
 *
 * The guard itself is trivial; what these pin is that EVERY entry point asks it
 * before it starts something irreversible (an SMS, a sign-in, a profile save
 * that may redeem a referral code, a phone link, a phone unlink), and that the
 * screens show busy from the first tap rather than after their delays.
 *
 * Source-level for the call sites: they are Compose screens and Hilt view
 * models with Firebase callbacks, and no runtime test tooling is installed.
 */
class SubmitGuardTest {

    @Test fun `nothing starts while something is in flight`() {
        assertTrue(SubmitGuard.mayStart(inFlight = false))
        assertFalse(SubmitGuard.mayStart(inFlight = true))
    }

    private val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
    private fun src(name: String) = File(main, "com/zipper/app/ui/screens/auth/$name").readText()

    private fun bodyOf(source: String, signature: String, length: Int = 400): String {
        val at = source.indexOf(signature)
        assertTrue("missing: $signature", at >= 0)
        return source.substring(at, minOf(source.length, at + length))
    }

    @Test fun `the view model refuses a second SMS, sign-in or save`() {
        val vm = src("AuthViewModel.kt")
        for (sig in listOf("fun sendOtp(", "fun verifyOtp(", "fun saveProfile(")) {
            val fn = vm.substring(vm.indexOf(sig))
            val guard = fn.indexOf("if (!SubmitGuard.mayStart(_uiState.value.isLoading)) return")
            val busy = fn.indexOf("isLoading = true")
            assertTrue("$sig is guarded", guard >= 0)
            assertTrue("$sig: the guard comes before isLoading is set", guard < busy)
            assertTrue("$sig: …and before any work is launched", guard < fn.indexOf("viewModelScope.launch"))
        }
    }

    @Test fun `an auto-filled code is used once`() {
        assertTrue(src("AuthViewModel.kt").contains("fun consumeAutoFilledOtp() = _uiState.update { it.copy(otpAutoFilled = null) }"))
        assertTrue(src("LoginScreen.kt").contains(
            "uiState.otpAutoFilled?.let { otp = it; viewModel.verifyOtp(it, deviceId); viewModel.consumeAutoFilledOtp() }"))
    }

    @Test fun `the keyboard Done on the code is gated like the Verify button`() {
        assertTrue(src("LoginScreen.kt").contains("onDone = { if (SubmitGuard.mayStart(loading)) onVerify() }"))
    }

    @Test fun `login shows busy from the first tap, before its 500 ms delay`() {
        val fn = bodyOf(src("LoginScreen.kt"), "fun sendOtp() {", 700)
        val guard = fn.indexOf("if (!SubmitGuard.mayStart(uiState.isLoading || otpStarting)) return")
        val starting = fn.indexOf("otpStarting = true")
        val delay = fn.indexOf("delay(500)")
        assertTrue(guard in 0 until starting)
        assertTrue("busy is set before the delay", starting < delay)
        assertTrue("…and released only after the view model has taken over",
            fn.indexOf("otpStarting = false") > fn.indexOf("viewModel.sendOtp("))
        assertTrue(src("LoginScreen.kt").contains("loading = uiState.isLoading || otpStarting,"))
    }

    @Test fun `profile setup shows busy from the first tap, before its 300 ms delay`() {
        val setup = src("ProfileSetupScreen.kt")
        val fn = bodyOf(setup, "fun submit() {", 2600)
        val guard = fn.indexOf("if (!SubmitGuard.mayStart(uiState.isLoading || saveStarting)) return")
        val starting = fn.indexOf("saveStarting = true")
        assertTrue(guard in 0 until starting)
        assertTrue("busy is set before the delay", starting < fn.indexOf("delay(300)"))
        assertTrue(fn.indexOf("saveStarting = false") > fn.indexOf("viewModel.saveProfile("))
        assertTrue(setup.contains("loading = uiState.isLoading || saveStarting,"))
    }

    @Test fun `a phone bind links once and cannot be unlinked mid-bind`() {
        val vm = src("SecureAccountViewModel.kt")
        val link = bodyOf(vm, "private fun link(credential: PhoneAuthCredential) {", 300)
        assertTrue(link.contains("if (!SubmitGuard.mayStart(linkInFlight)) return"))
        assertTrue(link.indexOf("linkInFlight = true") < link.indexOf("viewModelScope.launch"))
        val fn = vm.substring(vm.indexOf("private fun link(credential: PhoneAuthCredential) {"))
        assertTrue("released whatever the outcome", fn.contains("} finally {\n                linkInFlight = false"))
        // SMS auto-retrieval does not start a second link over a typed one.
        assertTrue(vm.contains("if (SubmitGuard.mayStart(linkInFlight)) link(credential)"))
        // "Use a different number" — and the Back arrow, which calls it — wait.
        assertTrue(bodyOf(vm, "fun useDifferentNumber() {", 600)
            .contains("if (!SubmitGuard.mayStart(_state.value.busy || linkInFlight)) return"))
    }
}

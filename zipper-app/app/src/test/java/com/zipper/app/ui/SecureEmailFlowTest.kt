package com.zipper.app.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * UGP-C — the email one-time-code flow, as fixed after the independent review.
 *
 * Source-level, like [PartnerEntryTest]: the ViewModel is a Hilt ViewModel over
 * Firebase, and what is pinned is the shape of the code paths.
 *
 *  1. "Already bound" (a retry after a lost verify reply) refreshes the device
 *     exactly as a fresh bind does — reload, token refresh, roles, guest flag,
 *     and the same-uid session token when the server sends one.
 *  2. The SDK's own timeout is not treated as "this code is finished".
 *  3. The flow survives process death without ever saving the code.
 *  4. "Use a different address" cannot fire while a request is in flight.
 *  5. Settings no longer promises that an email signs anybody in.
 */
class SecureEmailFlowTest {

    private val root = File("src/main/java/com/zipper/app")
    private fun src(path: String): String = File(root, path).readText()

    @Test
    fun `already bound refreshes the session exactly like a fresh bind`() {
        val repo = src("data/repository/AuthRepository.kt")
        val request = repo.substring(repo.indexOf("suspend fun requestEmailCode("), repo.indexOf("sealed class EmailCodeVerify"))
        assertTrue(request.contains("afterEmailBound(res.value.customToken)"))
        val verify = repo.substring(repo.indexOf("suspend fun verifyEmailCode("), repo.indexOf("private suspend fun afterEmailBound("))
        assertTrue(verify.contains("afterEmailBound(res.value.customToken)"))
        val after = repo.substring(repo.indexOf("private suspend fun afterEmailBound("), repo.indexOf("private suspend fun adoptSameUidSession("))
        for (step in listOf("adoptSameUidSession(customToken)", "reload()", "getIdToken(true)", "syncRoles()", "setGuest(false)")) {
            assertTrue("afterEmailBound must $step", after.contains(step))
        }
        // The server's already-bound answer carries the token through to the app.
        assertTrue(src("data/repository/MoneyFunctions.kt").contains("customToken = m[\"customToken\"] as? String ?: \"\",\n            )\n        }\n\n    suspend fun verifyEmailBindCode("))
    }

    @Test
    fun `a client-side timeout is a retry with the same code, not a dead code`() {
        val repo = src("data/repository/AuthRepository.kt")
        val verify = repo.substring(repo.indexOf("suspend fun verifyEmailCode("), repo.indexOf("private suspend fun afterEmailBound("))
        assertFalse(verify.contains("res.code == \"DEADLINE_EXCEEDED\""))
        assertTrue(verify.contains("res.detail in setOf(\"no_code\", \"used\", \"expired\", \"locked\")"))
        assertTrue(verify.contains("res.detail == \"locked_out\" -> EmailCodeVerify.Refused("))
    }

    @Test
    fun `the flow survives process death and never saves the code`() {
        val vm = src("ui/screens/auth/SecureEmailViewModel.kt")
        assertTrue(vm.contains("private val saved: SavedStateHandle"))
        for (key in listOf("KEY_STAGE", "KEY_EMAIL", "KEY_MASKED", "KEY_EXPIRES", "KEY_TAKEN")) {
            assertTrue("saves $key", vm.contains("saved[$key] = "))
        }
        assertFalse("the code is never saved", Regex("saved\\[[A-Z_]*CODE").containsMatchIn(vm))
        // Every change goes through `edit`, so saved state cannot drift from what is shown.
        assertFalse(vm.contains("_state.update { it.copy("))
        val screen = src("ui/screens/auth/SecureEmailScreen.kt")
        assertTrue(screen.contains("var email by rememberSaveable { mutableStateOf(\"\") }"))
        assertTrue(screen.contains("var code by remember { mutableStateOf(\"\") }"))
    }

    @Test
    fun `use a different address waits for the request in flight`() {
        val vm = src("ui/screens/auth/SecureEmailViewModel.kt")
        val fn = vm.substring(vm.indexOf("fun useDifferentEmail()"))
        assertTrue(fn.substring(0, 120).contains("if (_state.value.busy) return"))
        val screen = src("ui/screens/auth/SecureEmailScreen.kt")
        val back = screen.substring(screen.indexOf("Icons.AutoMirrored.Filled.ArrowBack, \"Back\", onChangeEmail,"))
        // The whole IconButtonCircle(...) call, up to its closing parenthesis.
        assertTrue(back.substring(0, back.indexOf("\n        )")).contains("enabled = !busy,"))
        // …and the Close button on the address step waits too.
        assertTrue(screen.contains("IconButtonCircle(Icons.Default.Close, \"Close\", onCancel, background = c.bgRaised, enabled = !busy)"))
    }

    @Test
    fun `the code step and the refusal use the server's own words`() {
        val screen = src("ui/screens/auth/SecureEmailScreen.kt")
        assertFalse(screen.contains("It expires in 10 minutes."))
        assertTrue(screen.contains("expiresInSec = state.expiresInSec,"))
        assertTrue(screen.contains("serverMessage = state.takenMessage,"))
    }

    @Test
    fun `settings no longer promises that an email signs you in`() {
        val settings = src("ui/screens/settings/SettingsScreen.kt")
        assertFalse(settings.contains("you can sign in with \" +"))
        assertFalse(settings.contains("Adding either one keeps it."))
        assertTrue(settings.contains("A phone number lets you sign in on any phone."))
        // and the rows wait for the profile instead of flashing up for everyone
        val nav = src("navigation/ZipperNavGraph.kt")
        assertTrue(nav.contains("hasPhone                      = state.user == null || "))
        assertTrue(nav.contains("hasEmail                      = state.user == null || "))
    }
}

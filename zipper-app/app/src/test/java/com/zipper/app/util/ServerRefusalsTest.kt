package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * P0-1 — the app acts on the server's session refusals.
 *
 * `assertActiveSession` (functions/src/mobileSession.ts) refuses a protected
 * callable with `details.code` SESSION_DISPLACED or ACCOUNT_RESTRICTED. These
 * tests pin the client half: the codes are recognised, every callable wrapper
 * reports them, `SessionViewModel` turns them into a sign-out or restriction
 * screen, and a session that cannot be started fails the sign-in (SESS-4).
 */
class ServerRefusalsTest {

    private val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
    private fun source(rel: String) = File(main, rel).readText()

    @Test fun `the two server codes are recognised`() {
        assertEquals(ServerRefusals.Kind.Displaced, ServerRefusals.classify("SESSION_DISPLACED"))
        assertEquals(ServerRefusals.Kind.Restricted, ServerRefusals.classify("ACCOUNT_RESTRICTED"))
        assertEquals(ServerRefusals.Kind.Displaced, ServerRefusals.classify(" SESSION_DISPLACED "))
    }

    @Test fun `anything else is not a session refusal`() {
        for (code in listOf("", "SESSION_REQUIRED", "RECENT_SIGN_IN_REQUIRED", "expired", "device_banned", "session_displaced")) {
            assertNull("'$code' must not sign anybody out", ServerRefusals.classify(code))
        }
        assertNull(ServerRefusals.classify(null))
    }

    @Test fun `every callable wrapper reports its FirebaseFunctionsException`() {
        val offenders = mutableListOf<String>()
        var catches = 0
        main.walkTopDown().filter { it.extension == "kt" }.forEach { f ->
            val lines = f.readLines()
            if (lines.none { it.contains("getHttpsCallable(") }) return@forEach
            lines.forEachIndexed { i, line ->
                if (line.contains("catch (e: FirebaseFunctionsException)")) {
                    catches++
                    val window = lines.subList(i, minOf(i + 4, lines.size)).joinToString("\n")
                    if (!window.contains("ServerRefusals.report(e)")) offenders += "${f.name}:${i + 1}"
                }
            }
        }
        assertTrue("found no callable wrappers — the scan is broken", catches >= 5)
        assertEquals("wrappers that swallow session refusals: $offenders", emptyList<String>(), offenders)
    }

    @Test fun `SessionViewModel acts on reported refusals and MainActivity handles the new event`() {
        val vm = source("com/zipper/app/ui/screens/auth/SessionViewModel.kt")
        assertTrue(vm.contains("ServerRefusals.events.collect"))
        assertTrue(vm.contains("data class SignedOut("))
        assertTrue(source("com/zipper/app/MainActivity.kt").contains("is SessionEvent.SignedOut ->"))
    }

    @Test fun `a session that cannot be started fails the sign-in (SESS-4)`() {
        val auth = source("com/zipper/app/data/repository/AuthRepository.kt")
        val start = auth.indexOf("private suspend fun generateSession(")
        assertTrue("generateSession not found", start >= 0)
        val body = auth.substring(start, auth.indexOf("\n    }\n", start))
        assertTrue("generateSession must return a refusal", body.contains("): AuthResult? {"))
        assertEquals("generateSession must retry once", 2, Regex("startMobileSession\\(").findAll(body).count())
        assertTrue("generateSession must refuse on failure", body.contains("AuthResult.Error("))
        val calls = Regex("generateSession\\(uid, deviceId\\)(.*)").findAll(auth).map { it.groupValues[1].trim() }.toList()
        // Four sign-in paths: quick login, phone credential, Google, guest. The
        // fifth, the email-link sign-in, was removed with the email deep link (UGP-C).
        assertTrue("found no sign-in paths", calls.size >= 4)
        assertTrue("every sign-in path must stop on a failed session: $calls", calls.all { it == "?.let { return it }" })
    }
}

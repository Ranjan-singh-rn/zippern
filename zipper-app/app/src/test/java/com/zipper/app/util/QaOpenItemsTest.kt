package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The QA items that were still OPEN on 4 Nov 2026, held in place by the source (these screens and ViewModels need
 * Firebase and Compose to run, so their wiring is checked as text; the pure parts have their own tests).
 */
class QaOpenItemsTest {
    private val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
    private fun src(path: String) = File(main, "com/zipper/app/$path").readText()

    @Test fun `21 - the default welcome is a sentence, the same on both ends`() {
        assertTrue(src("data/model/PartyRoom.kt").contains("const val DEFAULT_WELCOME = \"Welcome to my room. Have fun!\""))
        val fn = listOf(File("../functions/src/party.ts"), File("../../functions/src/party.ts")).firstOrNull { it.exists() }
        if (fn != null) assertTrue(fn.readText().contains("export const DEFAULT_WELCOME = 'Welcome to my room. Have fun!'"))
    }

    @Test fun `22 - a rejoin posts no second joined line`() {
        val vm = src("ui/screens/party/PartyRoomViewModel.kt")
        assertEquals(2, Regex("""if \(!res\.value\.rejoined\) announceArrival\(\)""").findAll(vm).count())
        assertFalse("no unguarded arrival line", Regex("""\n\s+announceArrival\(\)\n""").containsMatchIn(vm))
        assertEquals(2, Regex("""rejoined = m\["rejoined"] as\? Boolean \?: false""").findAll(src("data/repository/PartyRepository.kt")).count())
    }

    @Test fun `17 - streamed time and the go-live hint are for hosts only`() {
        val p = src("ui/screens/profile/ProfileScreen.kt")
        val streamed = p.indexOf("KeyValueRow(\"Streamed Time\"")
        assertTrue(streamed > 0)
        assertTrue("guarded by isHost", p.substring(maxOf(0, streamed - 400), streamed).contains("if (user.isHost) {"))
        assertTrue(p.contains("if (user.isHost) \"No gifts received yet. Go live to receive some.\" else \"No gifts received yet.\""))
    }

    @Test fun `16 - back and edit are pinned above the scrolling page`() {
        val p = src("ui/screens/profile/ProfileScreen.kt")
        val pinned = p.indexOf("// The pinned bar over the page (QA #16).")
        assertTrue(pinned > 0)
        assertTrue(p.substring(pinned).contains("IconButtonCircle(Icons.AutoMirrored.Filled.ArrowBack, \"Back\""))
        assertEquals("the buttons exist once (no longer inside the hero)", 1, Regex("""IconButtonCircle\(Icons\.AutoMirrored\.Filled\.ArrowBack, "Back""").findAll(p).count())
    }

    @Test fun `24 - host earnings are asked for once, and only for a host`() {
        val vm = src("ui/screens/profile/ProfileViewModel.kt")
        val init = vm.substring(vm.indexOf("    init {"))
        assertFalse("not from init for everybody", init.substringBefore("currentUserFlow()").contains("hostStats.hostHome()"))
        assertTrue(vm.contains("if (user?.isHost == true) loadHostCeilingOnce()"))
        assertTrue(vm.contains("if (hostCeilingRequested) return"))
    }

    @Test fun `9 - a spent code sends the person back to the number`() {
        assertTrue(src("data/repository/AuthRepository.kt").contains("AuthResult.Error(SESSION_NOT_STARTED_MESSAGE)"))
        val vm = src("ui/screens/auth/AuthViewModel.kt")
        assertTrue(vm.contains("if (result.message == com.zipper.app.data.repository.SESSION_NOT_STARTED_MESSAGE)"))
        assertTrue(src("ui/screens/auth/LoginScreen.kt").contains("if (uiState.otpNeedsNewCode) { otpStage = false; otp = \"\"; resendIn = 0;"))
    }

    @Test fun `O1 - the live Calls off switch is saved on the room, not only on this screen`() {
        val vm = src("ui/screens/live/GoLiveViewModel.kt")
        val toggle = vm.substring(vm.indexOf("fun toggleCallProtection()"))
        assertTrue(toggle.substring(0, 900).contains("repo.setCallsBlocked(s.roomId, blocked)"))
        assertTrue("rolled back when the write fails", toggle.substring(0, 900).contains("callProtectionEnabled = !blocked"))
        assertTrue(src("data/repository/LiveRepository.kt").contains("update(\"hostBlocksCalls\", blocked)"))
    }

    @Test fun `7 and 8 - the login form uses the pinned list and the phone check`() {
        val l = src("ui/screens/auth/LoginScreen.kt")
        assertTrue(l.contains("com.zipper.app.util.countriesForPicker(query)"))
        assertTrue(l.contains("val canSubmit = phoneProblem == null && termsAccepted && !loading"))
    }
}

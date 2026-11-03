package com.zipper.app.util

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * QA #31 — when Firebase ends the session on its own, the app goes to Login
 * with a message instead of sitting in the main shell with empty data; a
 * sign-out the app makes itself is not mistaken for one.
 */
class AuthLossTest {

    @After fun forget() = AuthLoss.reset()

    @Test fun `a session Firebase ended on its own is unexpected`() {
        assertTrue(AuthLoss.isUnexpected("uid-1", null, nowMs = 1_000_000L))
        assertTrue(AuthLoss.isUnexpected("uid-1", "", nowMs = 1_000_000L))
    }

    @Test fun `a sign-out the app just made is not`() {
        AuthLoss.expect(nowMs = 1_000_000L)
        assertFalse(AuthLoss.isUnexpected("uid-1", null, nowMs = 1_000_000L + 2_000L))
        // Firebase delivers the change later, on the main thread: still inside the window.
        assertFalse(AuthLoss.isUnexpected("uid-1", null, nowMs = 1_000_000L + AuthLoss.EXPECTED_WINDOW_MS))
        // Long after, a loss is the account's again.
        assertTrue(AuthLoss.isUnexpected("uid-1", null, nowMs = 1_000_000L + AuthLoss.EXPECTED_WINDOW_MS + 1))
    }

    @Test fun `nobody signed in before, or somebody still signed in, is not a loss`() {
        assertFalse(AuthLoss.isUnexpected(null, null, nowMs = 1_000_000L))
        assertFalse(AuthLoss.isUnexpected("", null, nowMs = 1_000_000L))
        assertFalse(AuthLoss.isUnexpected(null, "uid-1", nowMs = 1_000_000L))
        // Switching account replaces the user without passing through "nobody".
        assertFalse(AuthLoss.isUnexpected("uid-1", "uid-2", nowMs = 1_000_000L))
    }

    @Test fun `the session watcher listens, and every app sign-out is marked`() {
        val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
        fun src(p: String) = File(main, "com/zipper/app/$p").readText()

        val vm = src("ui/screens/auth/SessionViewModel.kt")
        assertTrue(vm.contains("FirebaseAuth.getInstance().addAuthStateListener(authListener)"))
        assertTrue(vm.contains("FirebaseAuth.getInstance().removeAuthStateListener(authListener)"))
        assertTrue(vm.contains("watchingUid != null && com.zipper.app.util.AuthLoss.isUnexpected(was, now)"))
        assertTrue(vm.contains("_events.emit(SessionEvent.SignedOut(ForcedSignOut.SESSION_EXPIRED))"))
        // The teardown's own fallback sign-out is marked as the app's.
        assertTrue(vm.contains("com.zipper.app.util.AuthLoss.expect()   // QA #31: the app's own sign-out"))

        val repo = src("data/repository/AuthRepository.kt")
        val lines = repo.lines()
        fun code(i: Int) = lines[i].trimStart().let { !it.startsWith("*") && !it.startsWith("//") && !it.startsWith("/*") }
        fun markedBefore(i: Int) = i > 0 && lines[i - 1].contains("com.zipper.app.util.AuthLoss.expect()")
        // Every Firebase sign-out on the default instance is marked on the line before it:
        // the helper every other sign-out goes through, and signOut()'s guarded tail, which
        // spells the call out where its guard is (SignInRoutingTest reads it there).
        val signOuts = lines.indices.filter { code(it) && Regex("""\bauth\.signOut\(\)""").containsMatchIn(lines[it]) }
        assertEquals(2, signOuts.size)
        for (i in signOuts) assertTrue("line ${i + 1}: a sign-out the session watcher would take for a lost session", markedBefore(i))
        assertTrue(repo.contains("com.zipper.app.util.AuthLoss.expect()\n        auth.signOut()"))
        // Deleting the login signs it out as well — leaving sign-up half-way, a refused
        // Observer, a discarded guest — so every deletion of the signed-in user is marked too
        // (Login used to say "Your session has expired" after "Leave and delete").
        val deletions = lines.indices.filter {
            code(it) && Regex("""\b(auth\.currentUser\?|doomed|user)\.delete\(\)""").containsMatchIn(lines[it])
        }
        assertEquals(6, deletions.size)
        for (i in deletions) assertTrue("line ${i + 1}: a login deletion the watcher would take for a lost session", markedBefore(i))
        // The account deleted by the server is the app's own doing as well.
        val purge = repo.substring(repo.indexOf("suspend fun deleteAccountNow()"))
        assertTrue(purge.indexOf("com.zipper.app.util.AuthLoss.expect()") in 0 until purge.indexOf("signOutFirebase()"))

        // MainActivity already turns SignedOut into teardown → Login with the message.
        val activity = src("MainActivity.kt")
        assertTrue(activity.contains("is SessionEvent.SignedOut -> {"))
        assertTrue(activity.contains("ForcedSignOut.raise(event.message)"))
    }
}

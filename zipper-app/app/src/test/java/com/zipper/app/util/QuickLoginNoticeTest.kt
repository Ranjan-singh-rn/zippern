package com.zipper.app.util

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * QA #37 — when "Continue as …" stops working, Login says why, in the banner,
 * until dismissed. QA #38 — "Delete it for good" forgets this phone's saved
 * sign-in, so Login never offers "Continue as" a deleted account.
 */
class QuickLoginNoticeTest {

    @Test fun `the refusal says why the button went away`() {
        val m = QuickLoginNotice.REMOVED
        assertTrue(m.contains("opened on another phone"))
        assertTrue(m.contains("deleted"))
        assertTrue(m.contains("Sign in with your phone number or Google"))
        assertTrue(QuickLoginNotice.belongsInBanner(m))
        assertFalse(QuickLoginNotice.belongsInBanner("Wrong code"))
        assertFalse(QuickLoginNotice.belongsInBanner(null))
    }

    @Test fun `the repository and Login are wired to it`() {
        val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
        fun src(p: String) = File(main, "com/zipper/app/$p").readText()

        val repo = src("data/repository/AuthRepository.kt")
        assertTrue(repo.contains("AuthResult.Error(com.zipper.app.util.QuickLoginNotice.REMOVED)"))
        assertFalse(repo.contains("That saved sign-in is no longer valid, so it has been"))
        // QA #38: the deletion forgets the saved sign-in, before the sign-out.
        // B10 (4 Nov 2026): the DELETED account's saved sign-in — not every account this phone remembers
        // (`clear()` would have signed the other accounts out of the switcher along with it).
        val delete = repo.substring(repo.indexOf("suspend fun deleteAccountNow()"))
            .substringBefore("// ── Realtime user listener")
        assertTrue(delete.contains("try { uid?.let { quickLogin.remove(it) } } catch (_: Exception) {}"))
        assertTrue(delete.indexOf("quickLogin.remove(") < delete.indexOf("signOutFirebase()"))
        assertFalse(delete.contains("quickLogin.clear()"))
        // …and so does the ordinary deletion (E2E re-run, 3 Nov 2026): the server revokes the saved
        // sign-in when the account is marked deleted, so the card could only fail.
        val soft = repo.substring(repo.indexOf("suspend fun softDeleteAccount()"), repo.indexOf("suspend fun pendingDeletion()"))
        assertTrue(soft.contains("try { quickLogin.remove(uid) } catch (_: Exception) {}"))
        assertTrue(soft.indexOf("quickLogin.remove(uid)") in soft.indexOf("money.requestAccountDeletion()") until soft.indexOf("signOutFirebase()"))
        assertFalse(soft.contains("quickLogin.clear()"))

        val login = src("ui/screens/auth/LoginScreen.kt")
        assertTrue(login.contains("if (com.zipper.app.util.QuickLoginNotice.belongsInBanner(it)) {"))
        assertTrue(login.contains("forcedSignOutReason = it"))
    }
}

package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * UGP-F — a restricted person is shown the web appeal address and their own
 * account ID, including when the restriction was learned without a session.
 */
class PublicAppealTest {

    private val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
    private fun src(p: String) = File(main, "com/zipper/app/$p").readText()

    @Test fun `the signed-in account id wins, the quick-login one is the fallback`() {
        PublicAppeal.lastRestrictedUid = "QL-UID"
        assertEquals("SIGNED-IN", PublicAppeal.accountIdToShow("SIGNED-IN"))
        assertEquals("QL-UID", PublicAppeal.accountIdToShow(null))
        assertEquals("QL-UID", PublicAppeal.accountIdToShow(""))
        PublicAppeal.lastRestrictedUid = ""
        assertEquals("", PublicAppeal.accountIdToShow(null))
    }

    @Test fun `the address is the CRM public route`() {
        assertTrue(PublicAppeal.URL.startsWith("https://"))
        assertTrue(PublicAppeal.URL.endsWith("/appeal/"))
    }

    @Test fun `both restriction screens offer the web appeal`() {
        val banned = src("ui/screens/auth/BannedScreen.kt")
        assertTrue(banned.contains("WebAppealCard("))
        assertTrue(banned.contains("PublicAppeal.accountIdToShow("))
        // The suspension caption no longer says the appeal can ONLY be sent signed in.
        assertFalse(src("ui/screens/auth/SuspendedScreen.kt").contains("it has to be sent while you "))
    }

    @Test fun `a quick-login ban hands the account id to the screen`() {
        val repo = src("data/repository/AuthRepository.kt")
        assertTrue(repo.contains("com.zipper.app.util.PublicAppeal.lastRestrictedUid = value.uid"))
    }

    @Test fun `a public-web appeal neither blocks the owner's own appeal nor reads as theirs`() {
        val repo = src("data/repository/AppealRepository.kt")
        val pending = repo.substring(repo.indexOf("suspend fun pendingAppeal("), repo.indexOf("suspend fun appealMyBan("))
        assertTrue(pending.contains(".any { it.getString(\"source\") != PUBLIC_WEB_SOURCE }"))
        assertFalse(pending.contains(".isEmpty"))
        val mine = repo.substring(repo.indexOf("suspend fun myAppeals("))
        assertTrue(mine.contains(".filter { it.getString(\"source\") != PUBLIC_WEB_SOURCE }"))
        assertTrue(repo.contains("const val PUBLIC_WEB_SOURCE = \"public_web\""))
    }

    @Test fun `the id is forgotten, so a later screen never shows the previous person's`() {
        PublicAppeal.lastRestrictedUid = "PREVIOUS"
        PublicAppeal.forgetRestrictedUid()
        assertEquals("", PublicAppeal.accountIdToShow(null))
        // …and the repository forgets it when a quick login starts and on sign-out.
        val repo = src("data/repository/AuthRepository.kt")
        val quick = repo.substring(repo.indexOf("suspend fun signInWithQuickLogin("))
        assertTrue(quick.indexOf("PublicAppeal.forgetRestrictedUid()") in 0 until quick.indexOf("quickLogin.load()"))
        val signOut = repo.substring(repo.indexOf("suspend fun signOut("))
        assertTrue(signOut.substring(0, 400).contains("PublicAppeal.forgetRestrictedUid()"))
    }
}

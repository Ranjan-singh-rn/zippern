package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * C8 (B27, B28) — sixty days, said the same everywhere, and nobody walks into a
 * deleted account once the window has closed.
 */
class DeletionWindowTest {

    private val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
    private fun src(rel: String) = File(main, "com/zipper/app/$rel").readText()

    @Test fun `the window is the server's sixty days`() {
        assertEquals(60, DeletionWindow.GRACE_DAYS)
    }

    @Test fun `RECOVERY_EXPIRED and only it means the window has closed`() {
        assertTrue(DeletionWindow.isRecoveryExpired("RECOVERY_EXPIRED"))
        assertTrue(DeletionWindow.isRecoveryExpired(" RECOVERY_EXPIRED "))
        for (other in listOf(null, "", "expired", "recovery_expired", "SESSION_DISPLACED")) {
            assertFalse("'$other'", DeletionWindow.isRecoveryExpired(other))
        }
    }

    @Test fun `deleted_permanent ends the account, the recoverable state does not`() {
        assertTrue(DeletionWindow.endsAccount("deleted_permanent"))
        for (other in listOf(null, "", "deleted_recoverable", "allow", "banned", "suspended")) {
            assertFalse("'$other'", DeletionWindow.endsAccount(other))
        }
    }

    @Test fun `the notice says the account was deleted and names no number of days`() {
        val m = DeletionWindow.ACCOUNT_DELETED
        assertTrue(m.contains("deleted", ignoreCase = true))
        assertFalse(m.contains("30"))
        assertFalse(m.contains("thirty", ignoreCase = true))
    }

    @Test fun `no deactivation copy promises thirty days any more`() {
        val thirty = Regex("""(?i)\b(30|thirty)[\s-]+days?\b""")
        for (rel in listOf(
            "ui/screens/settings/SettingsScreen.kt",
            "ui/screens/settings/PrivacyPolicyScreen.kt",
            "ui/screens/auth/RecoverAccountScreen.kt",
        )) {
            val hit = thirty.find(src(rel))
            assertTrue("$rel still says '${hit?.value}'", hit == null)
        }
        assertTrue(src("ui/screens/settings/SettingsScreen.kt").contains("For \${DeletionWindow.GRACE_DAYS} days nothing is destroyed."))
        assertTrue(src("ui/screens/settings/PrivacyPolicyScreen.kt").contains("within \${DeletionWindow.GRACE_DAYS} days"))
        assertTrue(src("data/repository/AuthRepository.kt").contains("const val GRACE_DAYS = com.zipper.app.util.DeletionWindow.GRACE_DAYS"))
    }

    @Test fun `the sign-in gate and recovery refuse instead of entering`() {
        val repo = src("data/repository/AuthRepository.kt")
        assertTrue(repo.contains("if (com.zipper.app.util.DeletionWindow.endsAccount(id.decision))"))
        assertTrue(repo.contains("com.zipper.app.util.DeletionWindow.isRecoveryExpired(res.detail)"))
        assertTrue(src("data/repository/HostFunctions.kt").contains("detailCode(e))"))
    }
}

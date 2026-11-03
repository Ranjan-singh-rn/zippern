package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * QA #47 (owner decision, 3 Nov 2026) — the app names the official addresses
 * only: support@zipperlive.org on the Banned screen and in the Privacy Policy,
 * and as the map lookup's required contact. No address on another domain is
 * left in the app's source, and the backend, Functions and CRM agree.
 */
class ZipperContactsTest {

    private val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
    private fun src(p: String) = File(main, "com/zipper/app/$p").readText()

    @Test fun `the three addresses`() {
        assertEquals("zipperlive.org", ZipperContacts.DOMAIN)
        assertEquals("no-reply@zipperlive.org", ZipperContacts.NO_REPLY)
        assertEquals("support@zipperlive.org", ZipperContacts.SUPPORT)
        assertEquals("info@zipperlive.org", ZipperContacts.INFO)
    }

    @Test fun `the screens name support@ from one place`() {
        val banned = src("ui/screens/auth/BannedScreen.kt")
        assertEquals(2, Regex("""\$\{com\.zipper\.app\.util\.ZipperContacts\.SUPPORT\}""").findAll(banned).count())
        val privacy = src("ui/screens/settings/PrivacyPolicyScreen.kt")
        assertEquals(2, Regex("""\$\{com\.zipper\.app\.util\.ZipperContacts\.SUPPORT\}""").findAll(privacy).count())
        assertTrue(src("ui/screens/auth/ProfileSetupScreen.kt")
            .contains("\"ZipperApp/1.0 (\${com.zipper.app.util.ZipperContacts.SUPPORT})\""))
    }

    @Test fun `no old address anywhere in the app`() {
        val old = Regex("""@zipperlive\.(com|app)\b|@zipper\.app\b|314zipper@|privacy@""")
        val offenders = main.walkTopDown()
            .filter { it.isFile && (it.name.endsWith(".kt") || it.name.endsWith(".java")) }
            .filter { old.containsMatchIn(it.readText()) }
            .map { it.name }
            .toList()
        assertEquals(emptyList<String>(), offenders)
        val res = listOf(File("src/main/res"), File("app/src/main/res")).firstOrNull { it.exists() }
        if (res != null) {
            val inRes = res.walkTopDown().filter { it.isFile && it.name.endsWith(".xml") }
                .filter { old.containsMatchIn(it.readText()) }.map { it.name }.toList()
            assertEquals(emptyList<String>(), inRes)
        }
    }

    @Test fun `the backend, Functions and CRM carry the same three`() {
        val repo = listOf(File("../.."), File("..")).firstOrNull { File(it, "backend/app/core/contacts.py").exists() }
            ?: return   // the app checked out on its own: nothing to compare with
        val py = File(repo, "backend/app/core/contacts.py").readText()
        assertTrue(py.contains("OFFICIAL_DOMAIN = \"zipperlive.org\""))
        assertTrue(py.contains("SUPPORT = f\"support@{OFFICIAL_DOMAIN}\""))
        val ts = File(repo, "functions/src/mail.ts").readText()
        assertTrue(ts.contains("export const OFFICIAL_EMAIL_DOMAIN = 'zipperlive.org'"))
        assertTrue(ts.contains("const DEFAULT_FROM_EMAIL = 'no-reply@zipperlive.org'"))
        val crm = File(repo, "zipper-crm/lib/contacts.ts").readText()
        assertTrue(crm.contains("export const OFFICIAL_EMAIL_DOMAIN = 'zipperlive.org'"))
    }
}

package com.zipper.app.data.work

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * "Open the full CRM" (5 Nov 2026): which page a session starts on, which builds offer it, and that the entry hands
 * the CRM nothing but an address — the CRM signs the person in itself.
 */
class CrmWebLinkTest {

    private val owner = Caps(uid = "o1", role = "owner", isInternal = true, isOwner = true, canWrite = true)
    private val observer = Caps(uid = "observer:x", role = "observer", isInternal = true, isObserver = true)
    private val agency = Caps(uid = "a1", role = "agency", isExternal = true, partnerIds = mapOf("agency" to "AG1"), partnerStatus = "approved")
    private val seller = Caps(uid = "b1", role = "seller", isExternal = true, partnerIds = mapOf("seller" to "SL1"), partnerStatus = "approved")
    private val dual = Caps(uid = "d1", role = "agency", isExternal = true, partnerIds = mapOf("agency" to "AG2", "seller" to "SL2"), partnerStatus = "approved")
    private val pending = Caps(uid = "p1", role = "agency", isExternal = true, partnerStatus = "pending")

    private val repoRoot: File = generateSequence(File("").absoluteFile) { it.parentFile }
        .first { File(it, "backend/app/core/deps.py").exists() }

    @Test fun `each session starts on its own CRM page`() {
        val base = "https://zipperlive.web.app"
        assertEquals("https://zipperlive.web.app/agency-dashboard/", CrmWebLink.url(base, agency))
        assertEquals("https://zipperlive.web.app/seller-dashboard/", CrmWebLink.url(base, seller))
        // Both roles: the CRM's role switcher; staff: the front door; an applicant: the CRM routes them to their waiting page.
        for (c in listOf(dual, owner, observer, pending)) assertEquals("https://zipperlive.web.app/", CrmWebLink.url(base, c))
        assertEquals("a trailing slash on the base is not doubled", "https://zipperlive.web.app/seller-dashboard/",
            CrmWebLink.url("https://zipperlive.web.app/", seller))
    }

    @Test fun `a build without a CRM address, or with something that is not http(s), offers nothing`() {
        assertNull(CrmWebLink.url("", owner))
        assertNull(CrmWebLink.url("   ", owner))
        assertNull(CrmWebLink.url("javascript:alert(1)", owner))
        assertNull(CrmWebLink.url("file:///sdcard/x.html", owner))
        assertNull(CrmWebLink.url("intent://x#Intent;end", owner))
        assertNull(CrmWebLink.url("https://", owner))
        assertEquals("http://10.0.2.2:3001/", CrmWebLink.url("http://10.0.2.2:3001", owner))
    }

    @Test fun `offered to every work account, never to a session the server gave no work role`() {
        for (c in listOf(owner, observer, agency, seller, dual, pending)) assertTrue(c.role, CrmWebLink.offered(c))
        assertFalse(CrmWebLink.offered(Caps()))
    }

    @Test fun `the builds point at the right CRM, and the entry opens a browser tab, never a WebView`() {
        val gradle = listOf(File("build.gradle.kts"), File("app/build.gradle.kts")).first { it.exists() }.readText()
        assertEquals("release, debug, prod and emu each name a CRM address", 4,
            Regex("buildConfigField\\(\"String\", \"CRM_WEB_URL\"").findAll(gradle).count())
        assertTrue(gradle.contains("buildConfigField(\"String\", \"CRM_WEB_URL\", \"\\\"\$zipperApiBaseRelease\\\"\")"))
        assertTrue("the local CRM as the emulator reaches it", gradle.contains("\"CRM_WEB_URL\", \"\\\"http://10.0.2.2:3001\\\"\""))
        val entry = File(repoRoot, "zipper-app/app/src/main/java/com/zipper/app/ui/screens/work/CrmWebEntry.kt").readText()
        assertTrue(entry.contains("Intent(Intent.ACTION_VIEW, Uri.parse(url))"))
        assertTrue(entry.contains("\"android.support.customtabs.extra.SESSION\""))
        assertFalse("no WebView: no page script runs in the app's process", entry.contains("WebView"))
        assertFalse("the app's sign-in is never handed to the page", Regex("token|idToken|password", RegexOption.IGNORE_CASE)
            .containsMatchIn(entry.substringAfter("internal fun openCrmTab").substringBefore("@Composable")))
        val hub = File(repoRoot, "zipper-app/app/src/main/java/com/zipper/app/ui/screens/work/WorkScreens.kt").readText()
        assertTrue(hub.contains("CrmWebCard(caps)"))
        // The local CRM serves the emulators and the API under its own origin, so the emulator's browser reaches all of it.
        val next = File(repoRoot, "zipper-crm/next.config.js").readText()
        assertTrue(next.contains("NEXT_PUBLIC_FIREBASE_EMULATORS_SAME_ORIGIN: 'true'"))
    }

    @Test fun `the CRM is laid out for a phone - the sidebar is a drawer below md`() {
        val layout = File(repoRoot, "zipper-crm/app/layout.tsx").readText()
        assertTrue(layout.contains("md:translate-x-0"))
        assertTrue(layout.contains("-translate-x-full"))
        assertEquals("both shells (staff/partner and observer) give the page the full width on a phone", 2,
            Regex("""<main className="md:ml-64 min-h-screen p-4 md:p-8""").findAll(layout).count())
        assertFalse("no shell keeps the fixed 256 px margin on a phone", layout.contains("<main className=\"ml-64"))
    }
}

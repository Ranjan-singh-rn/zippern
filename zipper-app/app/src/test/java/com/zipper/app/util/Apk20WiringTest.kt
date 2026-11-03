package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * APK 20 — the facts the audit items depend on, pinned at the source so they
 * cannot quietly come back: the Agora uid and renewal (A-6/A-7), the
 * publicProfiles reads (A-8), the build identity (A-4/A-17/A-18) and the
 * notice shape (item 10).
 */
class Apk20WiringTest {

    private val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
    private val gradle = listOf(File("build.gradle.kts"), File("app/build.gradle.kts")).first { it.exists() }.readText()
    private fun src(path: String) = File(main, "com/zipper/app/$path").readText()

    @Test fun `every join uses the uid the token was signed for, and the engine renews`() {
        val manager = src("ui/screens/live/AgoraManager.kt")
        assertTrue(manager.contains("override fun onTokenPrivilegeWillExpire("))
        assertTrue(manager.contains("override fun onRequestToken()"))
        assertTrue(manager.contains("eng.renewToken(fresh)"))
        assertTrue(manager.contains("var tokenRenewer: (suspend (channelId: String) -> String?)?"))

        val repo = src("data/repository/AgoraTokenRepository.kt")
        assertTrue("the grant carries the server's uid", repo.contains("uid = signedUid"))
        assertTrue(repo.contains("suspend fun renewToken(channelId: String): String?"))
        assertFalse("no caller joins with a bare token any more", repo.contains("suspend fun fetchToken("))

        val watch = src("ui/screens/live/WatchLiveViewModel.kt")
        assertTrue(watch.contains("AgoraManager.joinAsAudience(roomId, r.token, r.uid)"))
        assertTrue(watch.contains("AgoraManager.tokenRenewer = { channel -> agoraTokenRepo.renewToken(channel) }"))
        val goLive = src("ui/screens/live/GoLiveViewModel.kt")
        assertTrue(goLive.contains("AgoraManager.joinAsBroadcaster(roomId, liveGrant?.token, liveGrant?.uid ?: 0)"))
        assertTrue(goLive.contains("AgoraManager.joinAsBroadcaster(channelId, grant?.token, grant?.uid ?: 0)"))
        assertTrue(goLive.contains("AgoraManager.tokenRenewer = { channel -> agoraTokenRepo.renewToken(channel) }"))
        val call = src("ui/screens/call/VideoCallViewModel.kt")
        assertTrue(call.contains("AgoraManager.joinAsBroadcaster(callId, grant?.token, grant?.uid ?: 0)"))
        assertTrue(call.contains("AgoraManager.tokenRenewer = { channel -> agoraTokenRepo.renewToken(channel) }"))
        val party = src("ui/screens/party/PartyRoomViewModel.kt")
        assertTrue(party.contains("if (r.uid > 0) myAgoraUid = r.uid"))
        assertTrue(party.contains("AgoraManager.tokenRenewer = { channel -> agoraTokenRepo.renewToken(channel) }"))
        // The one place the function is called.
        val callers = File(main, "com/zipper/app").walkTopDown()
            .filter { it.isFile && it.extension == "kt" && it.readText().contains("\"generateAgoraToken\"") }
            .map { it.name }.toList()
        assertEquals(listOf("AgoraTokenRepository.kt"), callers)
    }

    @Test fun `other people's names come from publicProfiles, never their user document`() {
        val share = src("ui/screens/live/LiveShareSheet.kt")
        assertTrue(share.contains("firestore.collection(\"publicProfiles\").document(uid).get()"))
        assertFalse(share.contains("firestore.collection(\"users\").document(uid).get()"))
        val live = src("data/repository/LiveRepository.kt")
        val report = live.substring(live.indexOf("suspend fun reportUser("))
        assertTrue(report.contains("val col = if (uid == myUid) \"users\" else \"publicProfiles\""))
    }

    // Track B release (4 Nov 2026): APK 21 / 1.2.7 — release/trackb-20261104 publishes it with minSupported 21.
    // The prod-type checks below are unchanged from build 20.
    @Test fun `build 21 ships a non-debuggable prod type on the debug key and reads its channel by name`() {
        assertTrue(gradle.contains("versionCode = 21"))
        assertTrue(gradle.contains("versionName = \"1.2.7\""))
        val prod = gradle.substring(gradle.indexOf("create(\"prod\")"))
        assertTrue(prod.contains("initWith(getByName(\"release\"))"))
        assertTrue(prod.contains("isDebuggable = false"))
        assertTrue(prod.contains("isMinifyEnabled = true"))
        assertTrue(prod.contains("isShrinkResources = true"))
        assertTrue("the fleet's key, by name", prod.contains("signingConfig = signingConfigs.getByName(\"debug\")"))
        assertTrue(prod.contains("buildConfigField(\"String\", \"OTA_CHANNEL\", \"\\\"debug\\\"\")"))
        assertTrue(prod.contains("buildConfigField(\"String\", \"ZIPPER_API_BASE\", \"\\\"\$zipperApiBaseRelease\\\"\")"))
        assertTrue(gradle.contains("val zipperApiBaseProduction = \"https://zipperlive.web.app\""))
        // Every build type declares its channel; nothing inherits a guess. Four build types:
        // release, debug, prod — and emu, the local test copy (3 Nov 2026), which never
        // updates itself and is never published.
        assertEquals(4, Regex("buildConfigField\\(\"String\", \"OTA_CHANNEL\"").findAll(gradle).count())
        val emu = gradle.substring(gradle.indexOf("create(\"emu\")"))
        assertTrue(emu.contains("buildConfigField(\"boolean\", \"OTA_ENABLED\", \"false\")"))
        assertTrue(emu.contains("buildConfigField(\"String\", \"EMULATOR_PROJECT_ID\", \"\\\"demo-zipper\\\"\")"))
        // Nothing about the signing identity changed.
        assertFalse(gradle.contains("storeFile = file(\"zipper-release.jks\")"))
        assertTrue(gradle.contains("applicationId = \"com.zipper.app\""))
        assertEquals("debug", com.zipper.app.data.repository.UpdateRepository.channelFor("DEBUG"))
        assertEquals("release", com.zipper.app.data.repository.UpdateRepository.channelFor("release"))
        assertEquals("debug", com.zipper.app.data.repository.UpdateRepository.channelFor("typo"))
    }

    @Test fun `the app reads top-level notifications and feedbackTickets in the server's shape`() {
        val chat = src("data/repository/ChatRepository.kt")
        assertTrue(chat.contains("firestore.collection(\"notifications\")"))
        assertTrue(chat.contains("firestore.collection(\"feedbackTickets\")"))
        assertTrue(chat.contains(".whereEqualTo(\"userId\", myUid)"))
        assertTrue("both spellings of the read flag", chat.contains("doc.getBoolean(\"isRead\") ?: doc.getBoolean(\"read\")"))
        assertTrue("the related id, flat or under meta", chat.contains("doc.getString(\"relatedId\")") && chat.contains("meta?.get(\"ticket_id\")"))
        assertTrue(chat.contains("doc.getString(\"body\") ?: doc.getString(\"message\")"))
    }

    @Test fun `owner TOTP on the app login is wired at the Main door (APK 20 part 2)`() {
        val gate = src("ui/screens/auth/OwnerMfaGate.kt")
        assertFalse("no longer a TODO", gate.contains("TODO(APK 20"))
        assertTrue(gate.contains("STATUS_PATH = \"/api/auth/mfa/status\""))
        assertTrue(com.zipper.app.ui.screens.auth.OwnerMfaGate.enforced("owner"))
        assertTrue(com.zipper.app.ui.screens.auth.OwnerMfaGate.appliesTo("Owner"))
        assertTrue("the CRM directory's spelling of an Owner", com.zipper.app.ui.screens.auth.OwnerMfaGate.appliesTo("superadmin"))
        assertFalse(com.zipper.app.ui.screens.auth.OwnerMfaGate.appliesTo("observer"))
        assertFalse(com.zipper.app.ui.screens.auth.OwnerMfaGate.appliesTo("ops_admin"))
        // Every way into Main passes the host; the pre-filter is the server's role, cached at both gates.
        val graph = src("navigation/ZipperNavGraph.kt")
        assertTrue(graph.contains("OwnerMfaGateHost("))
        assertTrue(Regex("""composable\(Screen\.Main\.route\) \{\s*com\.zipper\.app\.ui\.screens\.auth\.OwnerMfaGateHost\(""").containsMatchIn(graph))
        assertTrue(src("ui/screens/auth/SplashViewModel.kt").contains("sessionManager.setCrmRole(last.crmRole)"))
        assertTrue(src("data/repository/AuthRepository.kt").contains("sessionManager.setCrmRole(id.crmRole)"))
    }
}

package com.zipper.app.util

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * O10 (5 Nov 2026) — "the app is extremely slow, on a real phone too". The audited causes, each pinned so it does
 * not come back: the root no longer collects a ViewModel it does not use, strong skipping is on, screen changes are
 * not 700 ms cross-fades, the LIVE dot repaints instead of recomposing cards, the splash does not sleep, and the
 * listeners that grew with an account's history or a room's audience are bounded and parsed off the main thread.
 */
class SpeedPassTest {

    private val root: File = generateSequence(File("").absoluteFile) { it.parentFile }
        .first { File(it, "zipper-app/app/build.gradle.kts").exists() }
    private fun src(rel: String) = File(root, "zipper-app/app/src/main/java/com/zipper/app/$rel").readText()

    @Test fun `the root composes the app without the profile listeners, and strong skipping is on`() {
        val main = src("MainActivity.kt")
        assertFalse("MainActivity creates ProfileViewModel at launch again", main.contains("ProfileViewModel by viewModels()"))
        assertFalse(main.contains("profileViewModel.state"))
        assertTrue(main.contains("ZipperTheme {"))
        val gradle = File(root, "zipper-app/app/build.gradle.kts").readText()
        assertTrue(gradle.contains("enableStrongSkippingMode = true"))
    }

    @Test fun `screen changes are short and tab changes are instant`() {
        val graph = src("navigation/ZipperNavGraph.kt")
        assertTrue(graph.contains("enterTransition = { androidx.compose.animation.fadeIn(androidx.compose.animation.core.tween(150)) }"))
        val tabs = src("ui/screens/main/MainScreen.kt")
        assertTrue(tabs.contains("enterTransition = { androidx.compose.animation.EnterTransition.None }"))
    }

    @Test fun `the live dot is the only thing that pulses, in the draw phase`() {
        val badges = src("ui/components/Badges.kt")
        assertTrue(badges.contains("if (kind == LiveBadgeKind.Live) LiveDot() else"))
        assertTrue(badges.contains(".graphicsLayer { alpha = dotAlpha.value }"))
        assertFalse(badges.contains(".alpha(if (kind == LiveBadgeKind.Live) dotAlpha else 1f)"))
    }

    @Test fun `the splash does not sleep and does not wait for the role refresh`() {
        val splash = src("ui/screens/auth/SplashScreen.kt")
        assertFalse(splash.contains("delay(800)"))
        assertTrue(splash.contains("splashViewModel.refreshRolesInBackground()"))
        assertFalse(splash.contains("splashViewModel.refreshRoles()\n"))
    }

    @Test fun `listeners are bounded and the busy ones run off the main thread`() {
        val profile = src("data/repository/ProfileRepository.kt")
        assertTrue(profile.contains(".limit(TRANSACTIONS_SHOWN)"))
        assertTrue("follower counts are aggregate counts", profile.contains(".count().get(com.google.firebase.firestore.AggregateSource.SERVER)"))
        val chat = src("data/repository/ChatRepository.kt")
        assertTrue(chat.contains(".limitToLast(limit)"))
        assertTrue(chat.contains(".limit(CONVERSATIONS_SHOWN)"))
        val live = src("data/repository/LiveRepository.kt")
        assertTrue(live.contains(".limit(LIVE_ROOMS_SHOWN)"))
        assertTrue(live.contains(".limit(VIEWERS_SHOWN)"))
        assertFalse("no reflection per viewer row", live.contains("toObject(ViewerPresence::class.java)"))
        assertTrue(live.contains(".addSnapshotListener(BackgroundListeners.executor)"))
        assertTrue(src("data/repository/DiscoverRepository.kt").contains("q.addSnapshotListener(BackgroundListeners.executor)"))
        // The ordered live list has its index, and a fallback until it is deployed.
        val indexes = File(root, "firestore.indexes.json").readText()
        assertTrue(Regex(""""collectionGroup": "liveRooms",[\s\S]{0,200}"isActive"[\s\S]{0,120}"viewerCount",\s*"order": "DESCENDING"""").containsMatchIn(indexes))
    }

    @Test fun `typing and ticking clocks redraw only their own small composables`() {
        val chatVm = src("ui/screens/messages/ChatViewModel.kt")
        assertTrue(chatVm.contains("val input: StateFlow<String>"))
        assertFalse(chatVm.contains("messageInput"))
        assertTrue(src("ui/screens/messages/ChatScreen.kt").contains("private fun TextComposer("))
        val goLive = src("ui/screens/live/GoLiveViewModel.kt")
        assertTrue(goLive.contains("val duration: StateFlow<Long>"))
        assertFalse(goLive.contains("liveDurationSeconds = it.liveDurationSeconds + 1"))
        val overlay = src("ui/screens/live/GiftAnimationOverlay.kt")
        assertFalse(overlay.contains("LaunchedEffect(composition, progress)"))
        val party = src("ui/screens/party/PartyRoomScreen.kt")
        assertFalse("seats get their own values, not the whole room state", party.contains("AudioSeat(index, state, onSeatTap, onToggleLock)"))
    }
}

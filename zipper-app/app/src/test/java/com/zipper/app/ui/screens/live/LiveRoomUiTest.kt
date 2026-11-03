package com.zipper.app.ui.screens.live

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * B12 (4 Nov 2026) — live streaming: the words and small decisions on the JVM, and the wiring that keeps the
 * money, the counts and the PK on the server (pinned against the source).
 */
class LiveRoomUiTest {

    @Test fun `the PK verdict from this room's side`() {
        assertEquals("Asha won the PK 1,200 to 900", LiveRoomUi.pkVerdict("Asha", "H1", "H1", 1200, 900))
        assertEquals("Asha lost the PK 300 to 1,000", LiveRoomUi.pkVerdict("Asha", "H1", "H2", 300, 1000))
        assertEquals("The PK ended in a draw (500 each)", LiveRoomUi.pkVerdict("Asha", "H1", "", 500, 500))
        assertEquals("The host won the PK 1 to 0", LiveRoomUi.pkVerdict(" ", "H1", "H1", 1, 0))
    }

    @Test fun `Indian grouping and durations`() {
        assertEquals("1,23,456", LiveRoomUi.group(123456))
        assertEquals("12,34,56,789", LiveRoomUi.group(123456789))
        assertEquals("999", LiveRoomUi.group(999))
        assertEquals("1h 05m", LiveRoomUi.duration(3900))
        assertEquals("12m 03s", LiveRoomUi.duration(723))
        assertEquals("45s", LiveRoomUi.duration(45))
        assertEquals("0s", LiveRoomUi.duration(-5))
    }

    @Test fun `a pinned message is trimmed to what the rules accept`() {
        assertEquals(140, LiveRoomUi.pinned("  " + "x".repeat(200) + "  ").length)
        assertEquals("hello", LiveRoomUi.pinned("  hello "))
    }

    private val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
    private fun src(p: String) = File(main, "com/zipper/app/$p").readText()

    @Test fun `no phone writes the viewer count, the PK score or the other host's room any more`() {
        val live = src("data/repository/LiveRepository.kt")
        assertFalse("join/leave counters are gone", live.contains("\"viewerCount\", FieldValue.increment"))
        assertFalse(live.contains("put(\"viewerCount\""))
        val pk = src("data/repository/PKRepository.kt")
        assertFalse("the PK score is the server's", pk.contains("fun addPKScore"))
        assertFalse("no batch into both rooms", pk.contains("firestore.batch()"))
        assertTrue(pk.contains("call(\"pkMatch\"") && pk.contains("call(\"pkRespond\"") && pk.contains("call(\"pkEnd\""))
        val watch = src("ui/screens/live/WatchLiveViewModel.kt")
        assertFalse(watch.contains("addPKScore"))
        assertFalse(watch.contains("repo.joinRoom(") || watch.contains("repo.leaveRoom("))
    }

    @Test fun `both sides say they are still there`() {
        assertTrue(src("ui/screens/live/GoLiveViewModel.kt").contains("repo.hostHeartbeat(roomId)"))
        assertTrue(src("ui/screens/live/WatchLiveViewModel.kt").contains("repo.viewerHeartbeat(roomId)"))
        val live = src("data/repository/LiveRepository.kt")
        assertTrue(live.contains("\"hostHeartbeatAt\", FieldValue.serverTimestamp()"))
        assertTrue(live.contains("\"lastSeenAt\" to FieldValue.serverTimestamp()"))
    }

    @Test fun `a muted viewer is told, a paused live says so, the host can block and delete`() {
        val watch = src("ui/screens/live/WatchLiveScreen.kt")
        assertTrue(watch.contains("LiveRoomUi.MUTED_PLACEHOLDER"))
        assertTrue(watch.contains("LiveRoomUi.PAUSED_TITLE"))
        assertTrue(watch.contains("Block host"))
        val host = src("ui/screens/live/GoLiveScreen.kt")
        assertTrue(host.contains("viewModel::togglePause") && host.contains("viewModel::toggleCamera"))
        assertTrue(host.contains("viewModel.deleteComment(cm.id)"))
        assertTrue(host.contains("onBlock = viewModel::blockViewer"))
    }
}

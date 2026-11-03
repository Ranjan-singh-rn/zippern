package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * B2a (3 Nov 2026) — a party room stays open while anybody is in it.
 *
 * The app used to close a room two seconds after its last SEAT emptied, from every client still watching, so people
 * listening in the lobby were thrown out. The server now decides (functions/test/partyLobby.test.js); the app sends a
 * heartbeat, rejoins quietly if the server dropped it for silence, and no longer closes rooms itself.
 */
class PartyLobbyB2aTest {

    private val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
    private fun src(path: String) = File(main, "com/zipper/app/$path").readText()

    @Test fun `a heartbeat answer becomes one action`() {
        assertEquals(PartyHeartbeatPolicy.Action.NOTHING, PartyHeartbeatPolicy.actionFor(active = true, present = true))
        assertEquals(PartyHeartbeatPolicy.Action.REJOIN, PartyHeartbeatPolicy.actionFor(active = true, present = false))
        assertEquals(PartyHeartbeatPolicy.Action.ROOM_ENDED, PartyHeartbeatPolicy.actionFor(active = false, present = false))
        assertEquals(PartyHeartbeatPolicy.Action.ROOM_ENDED, PartyHeartbeatPolicy.actionFor(active = false, present = true))
    }

    @Test fun `the beat is well inside the server's three-minute removal`() {
        // functions/src/party.ts: LISTENER_STALE_MS = 3 min, PARTY_HEARTBEAT_EVERY_MS = 60 s.
        assertEquals(60_000L, PartyHeartbeatPolicy.EVERY_MS)
        assertTrue(3 * 60_000L >= 3 * PartyHeartbeatPolicy.EVERY_MS)
    }

    @Test fun `only a room nobody is in is hidden from the list`() {
        assertTrue(PartyHeartbeatPolicy.isClosing(occupantCount = 0, listenerCount = 0))
        assertFalse("people in the lobby, no one seated: still a room", PartyHeartbeatPolicy.isClosing(0, 3))
        assertFalse(PartyHeartbeatPolicy.isClosing(2, 0))
    }

    @Test fun `the room screen no longer closes rooms by itself, and beats while open`() {
        val vm = src("ui/screens/party/PartyRoomViewModel.kt")
        assertFalse(vm.contains("watchForEmptyRoom"))
        assertFalse(vm.contains("EMPTY_ROOM_GRACE_MS"))
        assertFalse("only the owner's explicit End room calls endRoom", Regex("repo\\.endRoom\\(").findAll(vm).count() > 1)
        assertTrue(vm.contains("repo.heartbeat(roomId)"))
        assertTrue(vm.contains("PartyHeartbeatPolicy.Action.REJOIN -> rejoinQuietly()"))
        val list = src("ui/screens/party/PartyListViewModel.kt")
        assertTrue(list.contains("PartyHeartbeatPolicy.isClosing(it.occupantCount, it.listenerCount)"))
    }
}

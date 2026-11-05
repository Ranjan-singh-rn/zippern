package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * WP2 (5 Nov 2026, Owner): every call button follows the person's calls switch — "Calls off" while they broadcast or
 * host a party with calls off, "Busy" on another call — the same decision startCall makes on the server.
 */
class CallAvailabilityTest {
    private val host = CallAvailability.Presence(uid = "h1", name = "Asha", isLive = true, liveRoomId = "L1")

    @Test fun liveWithCallsOffIsOff() {
        val r = CallAvailability.resolve(host, CallAvailability.RoomSwitch("L1", "h1", isActive = true, callsOff = true), null)
        assertEquals(CallAvailability.State.CALLS_OFF, r.state)
        assertFalse(r.canCall)
        assertEquals("Calls off", r.label)
    }

    @Test fun liveWithCallsOnIsCallable() {
        assertTrue(CallAvailability.resolve(host, CallAvailability.RoomSwitch("L1", "h1", true, callsOff = false), null).canCall)
    }

    @Test fun someoneElsesRoomOrAnEndedRoomDoesNotCount() {
        assertTrue(CallAvailability.resolve(host, CallAvailability.RoomSwitch("L1", "other", true, true), null).canCall)
        assertTrue(CallAvailability.resolve(host, CallAvailability.RoomSwitch("L1", "h1", isActive = false, callsOff = true), null).canCall)
        assertTrue(CallAvailability.resolve(host, CallAvailability.RoomSwitch("L2", "h1", true, true), null).canCall)
    }

    @Test fun anyPartyOwnerWithCallsOffIsOff() {
        val owner = CallAvailability.Presence(uid = "u7", name = "Ravi", isInParty = true, partyRoomId = "P1")
        val r = CallAvailability.resolve(owner, null, CallAvailability.RoomSwitch("P1", "u7", true, callsOff = true))
        assertEquals(CallAvailability.State.CALLS_OFF, r.state)
        // A member (not the owner) of a calls-off room can still be called.
        val member = owner.copy(uid = "u8")
        assertTrue(CallAvailability.resolve(member, null, CallAvailability.RoomSwitch("P1", "u7", true, true)).canCall)
    }

    @Test fun onAnotherCallIsBusy() {
        val r = CallAvailability.resolve(CallAvailability.Presence(uid = "x", isInCall = true), null, null)
        assertEquals(CallAvailability.State.BUSY, r.state)
        assertFalse(r.canCall)
    }

    @Test fun unknownPersonIsCallableAndTheServerDecides() {
        assertTrue(CallAvailability.resolve(null, null, null).canCall)
    }
}

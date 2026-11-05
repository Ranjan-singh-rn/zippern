package com.zipper.app.util

/**
 * WP2 (Owner, 5 Nov 2026) — "all call buttons depend on the call on or off [of] that person".
 *
 * What a Call button shows for one person, worked out from what anybody may read about them: their public presence
 * (`publicProfiles/{uid}` — `isLive`/`liveRoomId`, `isInParty`/`partyRoomId`, `isInCall`) and the switch on the room
 * they are in (`liveRooms/{id}.hostBlocksCalls` while they broadcast, `partyRooms/{id}.ownerBlocksCalls` while they host
 * a party — anybody who owns a party room, host or not). It mirrors what `startCall` (functions/src/calls.ts) refuses —
 * `PEER_IN_LIVE`, `PEER_IN_PARTY`, in the same words — so the button says beforehand what the server would answer. The
 * server still decides: an unknown or unreadable presence is AVAILABLE here and the call is simply placed.
 *
 * Pure; tested by CallAvailabilityTest. [com.zipper.app.data.repository.CallAvailabilityRepository] feeds it.
 */
object CallAvailability {

    enum class State { AVAILABLE, CALLS_OFF, BUSY }

    /** A room's calls switch, as far as the button needs it. */
    data class RoomSwitch(
        val roomId: String,
        val hostUid: String,
        val isActive: Boolean,
        /** `hostBlocksCalls` on a live room, `ownerBlocksCalls` on a party room. */
        val callsOff: Boolean,
    )

    /** The person's public presence (`publicProfiles/{uid}`). */
    data class Presence(
        val uid: String,
        val name: String = "",
        val isLive: Boolean = false,
        val liveRoomId: String = "",
        val isInParty: Boolean = false,
        val partyRoomId: String = "",
        val isInCall: Boolean = false,
    )

    data class Result(
        val state: State,
        /** The button's own word: "Call", "Calls off", "Busy". */
        val label: String,
        /** Said when the button is tapped while it cannot ring; blank when it can. */
        val message: String,
    ) {
        val canCall: Boolean get() = state == State.AVAILABLE
    }

    val AVAILABLE = Result(State.AVAILABLE, "Call", "")

    const val LABEL_OFF = "Calls off"
    const val LABEL_BUSY = "Busy"

    /** The live room whose switch matters: the one they are broadcasting. */
    fun liveRoomToWatch(p: Presence?): String? =
        p?.takeIf { it.isLive }?.liveRoomId?.takeIf { it.isNotBlank() }

    /** The party room whose switch matters: the one they are in (it only counts if they own it). */
    fun partyRoomToWatch(p: Presence?): String? =
        p?.takeIf { it.isInParty }?.partyRoomId?.takeIf { it.isNotBlank() }

    fun resolve(p: Presence?, live: RoomSwitch?, party: RoomSwitch?): Result {
        if (p == null || p.uid.isBlank()) return AVAILABLE
        val who = p.name.ifBlank { "They" }
        // startCall: `peer.isLive && liveRoomId` -> the room is active, theirs, and `hostBlocksCalls` -> PEER_IN_LIVE.
        val liveId = liveRoomToWatch(p)
        if (liveId != null && live != null && live.roomId == liveId && live.isActive && live.hostUid == p.uid && live.callsOff) {
            return Result(State.CALLS_OFF, LABEL_OFF, "$who is live and not taking calls right now.")
        }
        // startCall: `peer.isInParty && partyRoomId` -> the room is active, they OWN it, and `ownerBlocksCalls` -> PEER_IN_PARTY.
        val partyId = partyRoomToWatch(p)
        if (partyId != null && party != null && party.roomId == partyId && party.isActive && party.hostUid == p.uid && party.callsOff) {
            return Result(State.CALLS_OFF, LABEL_OFF, "$who is hosting a party room and is not taking calls right now.")
        }
        // On another call (`isInCall`, kept by the server from the call documents — syncCallPresence).
        if (p.isInCall) return Result(State.BUSY, LABEL_BUSY, "$who is on another call. Try again in a few minutes.")
        return AVAILABLE
    }
}

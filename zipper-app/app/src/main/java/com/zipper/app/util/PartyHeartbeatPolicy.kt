package com.zipper.app.util

/**
 * B2a (3 Nov 2026) — a party room stays open while anybody is in it, seated or not.
 *
 * The app used to close a room two seconds after its last SEAT emptied, from every client still watching — people
 * listening in the lobby included. Now the server decides: a room is empty only when nobody is on a seat and nobody
 * is in the lobby, and presence is proved by a heartbeat (`partyHeartbeat`) every [EVERY_MS]. A listener that misses
 * three is removed by the server's sweep, so a dead phone cannot keep a room open for ever.
 */
object PartyHeartbeatPolicy {
    /** How often the room screen says "still here". The server removes a listener after three missed beats. */
    const val EVERY_MS = 60_000L

    enum class Action {
        /** All well. */
        NOTHING,
        /** The server no longer has me in the room (removed after a long silence): join again, quietly. */
        REJOIN,
        /** The room has closed. */
        ROOM_ENDED,
    }

    fun actionFor(active: Boolean, present: Boolean): Action = when {
        !active -> Action.ROOM_ENDED
        !present -> Action.REJOIN
        else -> Action.NOTHING
    }

    /**
     * A room the list should not offer: nobody on a seat and nobody in it. The server closes it on its next sweep
     * (within a minute); until then, tapping it would open an empty room that is about to shut.
     */
    fun isClosing(occupantCount: Int, listenerCount: Int): Boolean = occupantCount <= 0 && listenerCount <= 0
}

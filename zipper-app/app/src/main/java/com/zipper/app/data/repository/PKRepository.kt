package com.zipper.app.data.repository

import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.FirebaseFunctionsException
import com.zipper.app.data.model.PkInvite
import com.zipper.app.data.model.User
import com.zipper.app.util.ServerRefusals
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await
import javax.inject.Inject
import javax.inject.Singleton

/** PK Battle duration in milliseconds (3 minutes) — the server's `PK_DURATION_MS` sets the real end time. */
const val PK_DURATION_MS = 3 * 60 * 1000L

/**
 * PK battles.
 *
 * ── B12 (4 Nov 2026): THE SERVER WRITES BOTH ROOMS ───────────────────────────
 *
 * Matching, accepting and ending a PK used to be batches from one host's phone into BOTH hosts' rooms, and the
 * PK score a second write from the viewer's phone into both rooms. `firestore.rules` lets a host change only their
 * own room, so every one of those writes was refused for the other room and PK could never start. They are
 * callables now (`pkMatch`, `pkRespond`, `pkEnd` — functions/src/live.ts), the end time is the server's clock, and
 * the score is added by `settleGift` in the gift's own transaction. This class only asks and listens.
 */
@Singleton
class PKRepository @Inject constructor(
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
    private val functions: FirebaseFunctions,
    private val sessionManager: com.zipper.app.util.SessionManager,
) {

    private val invitesCol get() = firestore.collection("pkInvites")
    private val roomsCol   get() = firestore.collection("liveRooms")

    /** Thrown with the server's sentence so the screen can show it. */
    class PkRefused(message: String) : Exception(message)

    @Suppress("UNCHECKED_CAST")
    private suspend fun call(name: String, payload: Map<String, Any>): Map<String, Any?> = try {
        val res = functions.getHttpsCallable(name).call(sessionManager.withSession(payload)).await()
        res.data as? Map<String, Any?> ?: emptyMap()
    } catch (e: FirebaseFunctionsException) {
        ServerRefusals.report(e)
        throw PkRefused(e.message ?: "That did not go through.")
    }

    // ── Matchmaking ───────────────────────────────────────────────────────────

    /**
     * Enter the PK queue. Returns the invite id when another waiting host was matched at once, or null when this
     * host is now waiting (the invite then arrives through [pkInviteFlow]).
     */
    @Suppress("UNUSED_PARAMETER")
    suspend fun enterPKQueue(myRoomId: String, myUser: User): String? {
        val r = call("pkMatch", mapOf("roomId" to myRoomId))
        return (r["inviteId"] as? String)?.takeIf { it.isNotBlank() }
    }

    /** Leave the matchmaking queue without starting PK — the host's own room, so a direct write. */
    suspend fun cancelPKQueue(myRoomId: String) {
        roomsCol.document(myRoomId).update("pkWaiting", false).await()
    }

    // ── Invite listener ───────────────────────────────────────────────────────

    /**
     * Real-time flow of the pending or started [PkInvite] for [myUid].
     * Uses `array-contains` on the `participants` field so both host A and B receive it.
     */
    fun pkInviteFlow(myUid: String): Flow<PkInvite?> = callbackFlow {
        val listener = invitesCol
            .whereArrayContains("participants", myUid)
            .whereIn("status", listOf("pending", "started"))
            .addSnapshotListener { snap, err ->
                if (err != null || snap == null) { trySend(null); return@addSnapshotListener }
                val invite = snap.documents.firstOrNull()?.let { doc ->
                    doc.toObject(PkInvite::class.java)?.copy(id = doc.id)
                }
                trySend(invite)
            }
        awaitClose { listener.remove() }
    }

    // ── Accept / Reject ───────────────────────────────────────────────────────

    /**
     * Accept the invite. True when this acceptance started the PK (the other host had already accepted); false
     * while waiting for them. A room that ended meanwhile cancels the invite.
     */
    @Suppress("UNUSED_PARAMETER")
    suspend fun acceptInvite(invite: PkInvite, myUid: String): Boolean {
        val r = call("pkRespond", mapOf("inviteId" to invite.id, "accept" to true))
        return r["status"] == "started"
    }

    /** Either host declines — the invite is marked rejected so both screens dismiss it. */
    suspend fun rejectInvite(inviteId: String) {
        call("pkRespond", mapOf("inviteId" to inviteId, "accept" to false))
    }

    // ── End PK ────────────────────────────────────────────────────────────────

    /** End the PK on both rooms; the server records the result (`lastPk` on each room). */
    @Suppress("UNUSED_PARAMETER")
    suspend fun endPK(myRoomId: String, partnerRoomId: String) {
        call("pkEnd", mapOf("roomId" to myRoomId))
    }
}

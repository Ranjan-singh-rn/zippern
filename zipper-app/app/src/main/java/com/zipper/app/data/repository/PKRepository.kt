package com.zipper.app.data.repository

import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.app.data.model.LiveRoom
import com.zipper.app.data.model.PkInvite
import com.zipper.app.data.model.User
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await
import javax.inject.Inject
import javax.inject.Singleton

/** PK Battle duration in milliseconds (3 minutes). */
const val PK_DURATION_MS = 3 * 60 * 1000L

@Singleton
class PKRepository @Inject constructor(
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
) {

    private val invitesCol get() = firestore.collection("pkInvites")
    private val roomsCol   get() = firestore.collection("liveRooms")

    // ── Matchmaking ───────────────────────────────────────────────────────────

    /**
     * Enter the PK queue.
     *
     * - Queries for another host already waiting.
     * - If found: atomically creates a [PkInvite] for both and clears their waiting flags.
     * - If not found: sets this host's room to `pkWaiting = true` and returns null
     *   (the host's VM should then listen via [pkInviteFlow]).
     *
     * Returns the invite ID if a match was found immediately, null if now queued.
     */
    suspend fun enterPKQueue(myRoomId: String, myUser: User): String? {
        // Look for another host who is waiting
        val snap = roomsCol
            .whereEqualTo("pkWaiting", true)
            .whereEqualTo("isActive", true)
            .whereEqualTo("pkActive", false)
            .limit(10)
            .get().await()

        val candidate = snap.documents
            .mapNotNull { doc -> LiveRoom.from(doc) }
            .firstOrNull { it.roomId != myRoomId && it.hostUid != myUser.uid }

        return if (candidate != null) {
            // Try to atomically claim this candidate via a transaction
            try {
                firestore.runTransaction { tx ->
                    val targetSnap = tx.get(roomsCol.document(candidate.roomId))
                    val stillWaiting = targetSnap.getBoolean("pkWaiting") ?: false
                    if (!stillWaiting) throw Exception("Target host is no longer waiting")

                    // Clear waiting on both
                    tx.update(roomsCol.document(myRoomId), "pkWaiting", false)
                    tx.update(roomsCol.document(candidate.roomId), "pkWaiting", false)

                    // Create a single invite both hosts will see
                    val inviteRef = invitesCol.document()
                    tx.set(
                        inviteRef, hashMapOf(
                            "hostAUid" to myUser.uid,
                            "hostAName" to myUser.name,
                            "hostAPhotoUrl" to myUser.photoUrl,
                            "hostARoomId" to myRoomId,
                            "hostBUid" to candidate.hostUid,
                            "hostBName" to candidate.hostName,
                            "hostBPhotoUrl" to candidate.hostPhotoUrl,
                            "hostBRoomId" to candidate.roomId,
                            "participants" to listOf(myUser.uid, candidate.hostUid),
                            "hostAAccepted" to false,
                            "hostBAccepted" to false,
                            "status" to "pending",
                            "createdAt" to System.currentTimeMillis(),
                        )
                    )
                    inviteRef.id
                }.await()
            } catch (_: Exception) {
                // Candidate was claimed by someone else — join queue instead
                roomsCol.document(myRoomId).update("pkWaiting", true).await()
                null
            }
        } else {
            // No candidate found — enter queue and wait
            roomsCol.document(myRoomId).update("pkWaiting", true).await()
            null
        }
    }

    /** Leave the matchmaking queue without starting PK. */
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
     * Host accepts the PK invite.
     *
     * Updates their acceptance flag. If the other host already accepted,
     * atomically activates PK on both rooms and sets status = "started".
     *
     * Returns true if PK is now active (both accepted), false if still waiting for partner.
     */
    suspend fun acceptInvite(invite: PkInvite, myUid: String): Boolean {
        val iAmHostA = invite.hostAUid == myUid
        val partnerAlreadyAccepted = if (iAmHostA) invite.hostBAccepted else invite.hostAAccepted
        val myField = if (iAmHostA) "hostAAccepted" else "hostBAccepted"

        return if (partnerAlreadyAccepted) {
            // Both accepted — start PK
            val pkChannelId = "pk_${invite.hostARoomId}_${invite.hostBRoomId}"
            val pkEndTime = System.currentTimeMillis() + PK_DURATION_MS

            val batch = firestore.batch()
            batch.update(invitesCol.document(invite.id), "status", "started")

            val pkBase = mapOf(
                "pkWaiting" to false,
                "pkActive" to true,
                "pkScore" to 0L,
                "pkPartnerScore" to 0L,
                "pkEndTime" to pkEndTime,
                "pkChannelId" to pkChannelId,
            )
            batch.update(
                roomsCol.document(invite.hostARoomId),
                pkBase + mapOf(
                    "pkPartnerId" to invite.hostBRoomId,
                    "pkPartnerUid" to invite.hostBUid,
                    "pkPartnerName" to invite.hostBName,
                    "pkPartnerPhotoUrl" to invite.hostBPhotoUrl,
                )
            )
            batch.update(
                roomsCol.document(invite.hostBRoomId),
                pkBase + mapOf(
                    "pkPartnerId" to invite.hostARoomId,
                    "pkPartnerUid" to invite.hostAUid,
                    "pkPartnerName" to invite.hostAName,
                    "pkPartnerPhotoUrl" to invite.hostAPhotoUrl,
                )
            )
            batch.commit().await()
            true
        } else {
            // Mark my acceptance, wait for partner
            invitesCol.document(invite.id).update(myField, true).await()
            false
        }
    }

    /** Either host rejects the invite — marks it rejected so both VMs dismiss. */
    suspend fun rejectInvite(inviteId: String) {
        invitesCol.document(inviteId).update("status", "rejected").await()
    }

    // ── End PK ────────────────────────────────────────────────────────────────

    suspend fun endPK(myRoomId: String, partnerRoomId: String) {
        val clearMap = mapOf(
            "pkWaiting" to false,
            "pkActive" to false,
            "pkPartnerId" to "",
            "pkPartnerUid" to "",
            "pkPartnerName" to "",
            "pkPartnerPhotoUrl" to "",
            "pkScore" to 0L,
            "pkPartnerScore" to 0L,
            "pkEndTime" to 0L,
            "pkChannelId" to "",
        )
        val batch = firestore.batch()
        batch.update(roomsCol.document(myRoomId), clearMap)
        if (partnerRoomId.isNotBlank()) {
            batch.update(roomsCol.document(partnerRoomId), clearMap)
        }
        batch.commit().await()
    }

    // ── Score ─────────────────────────────────────────────────────────────────

    /**
     * Atomically increments [myRoomId].pkScore and [partnerRoomId].pkPartnerScore
     * so both rooms reflect the updated ratio immediately.
     */
    suspend fun addPKScore(myRoomId: String, partnerRoomId: String, amount: Long) {
        val batch = firestore.batch()
        batch.update(roomsCol.document(myRoomId), "pkScore", FieldValue.increment(amount))
        if (partnerRoomId.isNotBlank()) {
            batch.update(roomsCol.document(partnerRoomId), "pkPartnerScore", FieldValue.increment(amount))
        }
        batch.commit().await()
    }
}

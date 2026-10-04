package com.zipper.app.data.repository

import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.zipper.app.data.model.GiftLeaderboardEntry
import com.zipper.app.data.model.LiveComment
import com.zipper.app.data.model.LiveGiftEvent
import com.zipper.app.data.model.LiveRoom
import com.zipper.app.data.model.User
import com.zipper.app.data.model.ViewerPresence
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await
import javax.inject.Inject
import javax.inject.Singleton

/**
 * A room's gifters: the rows worth showing, and how many people there were.
 *
 * [top] is capped at 20, which is as much as a leaderboard sheet can usefully
 * show. [count] is every distinct gifter, and it travels separately because the
 * post-live card states how many people gifted this session — reading that off
 * a truncated list would report 20 for a room where 300 people gifted, and a
 * host who was told "20 gifters" has no way to know the number was clipped.
 */
data class RoomGifters(
    val top: List<GiftLeaderboardEntry> = emptyList(),
    val count: Int = 0,
)

@Singleton
class LiveRepository @Inject constructor(
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
    private val money: MoneyFunctions,
) {

    private val liveRoomsCol get() = firestore.collection("liveRooms")

    // ── Live room listing ─────────────────────────────────────────────────────

    fun liveRoomsFlow(): Flow<List<LiveRoom>> = callbackFlow {
        val listener = liveRoomsCol
            .whereEqualTo("isActive", true)
            .addSnapshotListener { snap, err ->
                if (err != null || snap == null) {
                    trySend(emptyList())
                    return@addSnapshotListener
                }
                val rooms = snap.documents
                    .mapNotNull { doc ->
                        LiveRoom.from(doc)
                    }
                    .sortedByDescending { it.viewerCount }
                trySend(rooms)
            }
        awaitClose { listener.remove() }
    }

    fun roomFlow(roomId: String): Flow<LiveRoom?> = callbackFlow {
        val listener = liveRoomsCol.document(roomId)
            .addSnapshotListener { snap, err ->
                if (err != null || snap == null) {
                    trySend(null)
                    return@addSnapshotListener
                }
                val room = LiveRoom.from(snap)
                trySend(room)
            }
        awaitClose { listener.remove() }
    }

    fun commentsFlow(roomId: String): Flow<List<LiveComment>> = callbackFlow {
        val listener = liveRoomsCol.document(roomId)
            .collection("comments")
            .orderBy("timestamp", Query.Direction.ASCENDING)
            .limitToLast(100)
            .addSnapshotListener { snap, err ->
                if (err != null || snap == null) {
                    trySend(emptyList())
                    return@addSnapshotListener
                }
                val comments = snap.documents.mapNotNull { doc -> LiveComment.from(doc) }
                trySend(comments)
            }
        awaitClose { listener.remove() }
    }

    fun liveGiftsFlow(roomId: String): Flow<List<LiveGiftEvent>> = callbackFlow {
        val listener = liveRoomsCol.document(roomId)
            .collection("gifts")
            .orderBy("timestamp", Query.Direction.DESCENDING)
            .limit(20)
            .addSnapshotListener { snap, err ->
                if (err != null || snap == null) {
                    trySend(emptyList())
                    return@addSnapshotListener
                }
                val gifts = snap.documents.mapNotNull { doc -> LiveGiftEvent.from(doc) }
                trySend(gifts)
            }
        awaitClose { listener.remove() }
    }

    // ── Host actions ──────────────────────────────────────────────────────────

    suspend fun startLive(title: String, category: String, hostUser: User): String {
        // Close anything this host left behind. A crash (or a killed process)
        // never runs endLive, so the old room stayed `isActive: true` forever
        // and the host showed up twice in the live list. Best-effort: a rules
        // error here must never stop someone from going live.
        try {
            val stale = liveRoomsCol
                .whereEqualTo("hostUid", hostUser.uid)
                .whereEqualTo("isActive", true)
                .get().await()
            val now = com.google.firebase.Timestamp.now()
            stale.documents.forEach { doc ->
                try {
                    doc.reference.update(mapOf("isActive" to false, "endedAt" to now)).await()
                } catch (_: Exception) {}
            }
        } catch (_: Exception) {}

        val roomData = hashMapOf(
            "hostUid" to hostUser.uid,
            "hostName" to hostUser.name,
            "hostPhotoUrl" to hostUser.photoUrl,
            "hostGender" to hostUser.gender,
            "agencyId" to hostUser.agencyId,
            "title" to title,
            "category" to category,
            "viewerCount" to 0,
            "isActive" to true,
            // No endedAt placeholder: absent until the room ends, then a Timestamp.
            // A Long 0 here and a Timestamp later is two types under one name.
            "startedAt" to com.google.firebase.Timestamp.now(),
            "totalGiftsReceived" to 0L,
            "totalBeansEarned" to 0L,
        )
        val docRef = liveRoomsCol.add(roomData).await()
        // `isLive` / `liveRoomId` on the user doc are owner-protected and are
        // written by the `syncLivePresence` trigger from this room document.
        // Writing them here was PERMISSION_DENIED and aborted every Go Live.
        return docRef.id
    }

    suspend fun endLive(roomId: String, durationSeconds: Long = 0L) {
        val uid = auth.currentUser?.uid ?: return
        liveRoomsCol.document(roomId).update(
            mapOf(
                "isActive" to false,
                "endedAt" to com.google.firebase.Timestamp.now(),
                "durationSeconds" to durationSeconds,
            )
        ).await()
        // Presence and streamed time are derived server-side (syncLivePresence).
    }

    // ── Viewer actions ────────────────────────────────────────────────────────

    suspend fun joinRoom(roomId: String) {
        liveRoomsCol.document(roomId)
            .update("viewerCount", FieldValue.increment(1))
            .await()
    }

    suspend fun leaveRoom(roomId: String) {
        liveRoomsCol.document(roomId)
            .update("viewerCount", FieldValue.increment(-1))
            .await()
    }

    suspend fun sendComment(roomId: String, message: String) {
        val uid = auth.currentUser?.uid ?: return
        val userSnap = firestore.collection("users").document(uid).get().await()
        val name = userSnap.getString("name") ?: ""
        val photoUrl = userSnap.getString("photoUrl") ?: ""
        val comment = hashMapOf(
            "uid" to uid,
            "name" to name,
            "photoUrl" to photoUrl,
            "message" to message,
            "timestamp" to System.currentTimeMillis(),
            "isJoin" to false,
        )
        liveRoomsCol.document(roomId).collection("comments").add(comment).await()
    }

    suspend fun sendJoinEvent(roomId: String, userName: String) {
        val uid = auth.currentUser?.uid ?: return
        val comment = hashMapOf(
            "uid" to uid,
            "name" to userName,
            "photoUrl" to "",
            "message" to "$userName joined",
            "timestamp" to System.currentTimeMillis(),
            "isJoin" to true,
        )
        liveRoomsCol.document(roomId).collection("comments").add(comment).await()
    }

    /**
     * Send a gift inside a live room.
     *
     * Was the worst of the client-side money paths: it took [diamondCost] and
     * the bean reward as arguments, never checked the sender could afford it,
     * and wrote both balances in a client batch. A viewer with no diamonds
     * could gift, and the balance simply went negative.
     *
     * Now it sends a gift id. `settleGift` prices it, refuses it if the sender
     * cannot pay, moves the money, and writes the room's ticker row and
     * totals itself.
     *
     * @return null on success, or a message to show the sender.
     */
    suspend fun sendGiftInLive(
        roomId: String,
        hostUid: String,
        giftId: String,
        quantity: Int,
        idempotencyKey: String = money.newIdempotencyKey(),
    ): String? = when (
        val res = money.settleGift(
            giftId = giftId,
            receiverUid = hostUid,
            quantity = quantity.coerceIn(1, 9999),
            context = "live",
            roomId = roomId,
            idempotencyKey = idempotencyKey,
        )
    ) {
        is MoneyFunctions.Result.Ok -> null
        is MoneyFunctions.Result.Failed -> res.userMessage
    }

    /**
     * Gift sent during PK. Identical settlement — the PK score is added
     * separately by the caller via PKRepository.addPKScore.
     */
    suspend fun sendGiftInLivePK(
        roomId: String,
        hostUid: String,
        giftId: String,
        quantity: Int,
        idempotencyKey: String = money.newIdempotencyKey(),
    ): String? = sendGiftInLive(roomId, hostUid, giftId, quantity, idempotencyKey)

    // ── Viewer presence ───────────────────────────────────────────────────────

    /** Real-time list of viewers in a room. */
    fun viewersFlow(roomId: String): Flow<List<ViewerPresence>> = callbackFlow {
        val listener = liveRoomsCol.document(roomId).collection("viewers")
            .orderBy("joinedAt", Query.Direction.ASCENDING)
            .addSnapshotListener { snap, _ ->
                val list = snap?.documents?.mapNotNull { it.toObject(ViewerPresence::class.java) } ?: emptyList()
                trySend(list)
            }
        awaitClose { listener.remove() }
    }

    suspend fun addViewerPresence(roomId: String, user: User) {
        val uid = auth.currentUser?.uid ?: return
        liveRoomsCol.document(roomId).collection("viewers").document(uid).set(
            mapOf(
                "uid" to uid,
                "name" to user.name,
                "photoUrl" to user.photoUrl,
                "level" to user.level,
                "joinedAt" to System.currentTimeMillis(),
            )
        ).await()
    }

    suspend fun removeViewerPresence(roomId: String) {
        val uid = auth.currentUser?.uid ?: return
        liveRoomsCol.document(roomId).collection("viewers").document(uid).delete().await()
    }

    // ── Gift leaderboard ──────────────────────────────────────────────────────

    /**
     * Real-time gift leaderboard for a room: the top 20 gifters this session,
     * and how many distinct people gifted at all. See [RoomGifters] for why the
     * count is not `top.size`.
     */
    fun giftLeaderboardFlow(roomId: String): Flow<RoomGifters> = callbackFlow {
        val listener = liveRoomsCol.document(roomId).collection("gifts")
            .orderBy("timestamp", Query.Direction.ASCENDING)
            .addSnapshotListener { snap, _ ->
                if (snap == null) { trySend(RoomGifters()); return@addSnapshotListener }
                // Group by sender uid, sum diamond costs
                val totals = mutableMapOf<String, Triple<String, String, Long>>() // uid → (name, photo, total)
                snap.documents.forEach { doc ->
                    val uid = doc.getString("uid") ?: return@forEach
                    val name = doc.getString("senderName") ?: ""
                    val photo = doc.getString("senderPhotoUrl") ?: ""
                    val cost = doc.getLong("diamondCost") ?: (doc.getLong("quantity") ?: 1L)
                    val prev = totals[uid] ?: Triple(name, photo, 0L)
                    totals[uid] = Triple(prev.first.ifBlank { name }, prev.second.ifBlank { photo }, prev.third + cost)
                }
                val leaderboard = totals.entries
                    .sortedByDescending { it.value.third }
                    .take(20)
                    .map { (uid, triple) ->
                        GiftLeaderboardEntry(uid = uid, name = triple.first, photoUrl = triple.second, totalDiamonds = triple.third)
                    }
                trySend(RoomGifters(top = leaderboard, count = totals.size))
            }
        awaitClose { listener.remove() }
    }

    // ── Comments from join time ───────────────────────────────────────────────

    /** Only load comments that arrived after [fromTimestamp] (viewer's join time). */
    fun commentsFromFlow(roomId: String, fromTimestamp: Long): Flow<List<LiveComment>> = callbackFlow {
        val listener = liveRoomsCol.document(roomId)
            .collection("comments")
            .whereGreaterThanOrEqualTo("timestamp", fromTimestamp)
            .orderBy("timestamp", Query.Direction.ASCENDING)
            .limitToLast(100)
            .addSnapshotListener { snap, _ ->
                val comments = snap?.documents?.mapNotNull { LiveComment.from(it) } ?: emptyList()
                trySend(comments)
            }
        awaitClose { listener.remove() }
    }

    // ── Likes ─────────────────────────────────────────────────────────────────

    suspend fun addLike(roomId: String) {
        liveRoomsCol.document(roomId).update("likeCount", FieldValue.increment(1)).await()
    }

    // ── Kick / block viewer ───────────────────────────────────────────────────

    /**
     * Remove a viewer and keep them out. One batch so the host's viewer list
     * and the count move together: marking them kicked alone left them sitting
     * in `viewers/` until their own device noticed and cleaned up after itself.
     */
    /**
     * Bar someone from this broadcast and drop their presence row.
     *
     * The decrement is conditional on the presence row still existing. It used to
     * be unconditional, which double-counted the ordinary case: a viewer who has
     * already closed the stream has removed their own row and decremented the
     * count on the way out, and a host kicking them afterwards — which is exactly
     * when a host reaches for it, having just been insulted by someone who then
     * left — took a second viewer off the tally. Enough of those and the count
     * goes negative and the "N watching" chip reads as nonsense.
     *
     * `kickedViewers` is still written either way. Barring someone who is not
     * currently present is the point: it stops them coming back.
     */
    suspend fun kickViewer(roomId: String, targetUid: String) {
        val roomRef = liveRoomsCol.document(roomId)
        val viewerRef = roomRef.collection("viewers").document(targetUid)
        val stillPresent = try {
            viewerRef.get().await().exists()
        } catch (_: Exception) {
            // Cannot tell — do not guess downward. An over-count corrects itself
            // on the next join or leave; an under-count does not.
            false
        }

        val roomUpdates = buildMap<String, Any> {
            put("kickedViewers", FieldValue.arrayUnion(targetUid))
            if (stillPresent) put("viewerCount", FieldValue.increment(-1))
        }

        val batch = firestore.batch()
        batch.update(roomRef, roomUpdates)
        if (stillPresent) batch.delete(viewerRef)
        batch.commit().await()
    }

    // ── Report ────────────────────────────────────────────────────────────────

    /**
     * Report somebody.
     *
     * The names are written alongside the uids, and that is not decoration.
     * The CRM's report queue is a list a human works through, and every row
     * read `Aq1EIj85fKZy0eS1AuiS9RC15IN2 reported 3kP2…` — two opaque strings
     * and a reason, with no way to tell a serial reporter from a first-time
     * one, or to recognise a host who is already in trouble, without opening
     * two profiles per row.
     *
     * They are a CONVENIENCE, not the record: the uids are what the decision
     * acts on, and a display name can be changed by its owner between the
     * report and the review. A reviewer looking at the account sees the name
     * as it is now; this is the name as it was then.
     *
     * Throws if nobody is signed in. This used to be `?: return` — a no-op that
     * handed the caller a normal return, so the viewer was shown the "thanks,
     * we'll review this" acknowledgement for a report that was never filed.
     * Abuse reporting is the last thing that should lie about having worked;
     * the caller can only tell the truth if failure reaches it.
     */
    suspend fun reportUser(targetUid: String, reason: String) {
        val myUid = auth.currentUser?.uid
            ?: throw IllegalStateException("Sign in to report someone")

        // Best-effort, and deliberately not awaited into a failure: a report
        // that cannot be filed because a name lookup failed is worse than a
        // report filed without the names.
        suspend fun nameOf(uid: String): String = try {
            firestore.collection("users").document(uid).get().await()
                .getString("name").orEmpty()
        } catch (_: Exception) {
            ""
        }

        firestore.collection("reports").add(
            mapOf(
                "reporterUid" to myUid,
                "reporterName" to nameOf(myUid),
                "targetUid" to targetUid,
                "targetName" to nameOf(targetUid),
                "reason" to reason,
                "timestamp" to System.currentTimeMillis(),
                // The CRM orders and indexes on createdAt.
                "createdAt" to FieldValue.serverTimestamp(),
                "status" to "pending",
            )
        ).await()
    }

    // ── Welcome message ───────────────────────────────────────────────────────

    suspend fun updateWelcomeMessage(roomId: String, message: String) {
        liveRoomsCol.document(roomId).update("welcomeMessage", message).await()
    }
}

package com.zipper.app.data.repository

import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.zipper.app.data.model.BroadcastMessage
import com.zipper.app.data.model.ChatMessage
import com.zipper.app.data.model.Conversation
import com.zipper.app.data.model.SupportTicket
import com.zipper.app.data.model.UserNotification
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await
import javax.inject.Inject
import javax.inject.Singleton
import com.zipper.app.util.millis

@Singleton
class ChatRepository @Inject constructor(
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
) {

    private val convoCol get() = firestore.collection("conversations")
    private val broadcastCol get() = firestore.collection("broadcasts")
    // B2: the collection FeedbackScreen writes and the CRM support page answers.
    // It was `supportTickets`, which nothing in the app writes — the tab was
    // permanently empty. Same owner rule on both (firestore.rules).
    private val ticketsCol get() = firestore.collection("feedbackTickets")
    private val notifCol get() = firestore.collection("notifications")

    // ── Conversation ID: sorted pair of UIDs ─────────────────────────────────
    fun convoId(uid1: String, uid2: String): String =
        listOf(uid1, uid2).sorted().joinToString("_")

    // ── Conversations list ────────────────────────────────────────────────────

    fun conversationsFlow(myUid: String): Flow<List<Conversation>> = callbackFlow {
        val listener = convoCol
            .whereArrayContains("participants", myUid)
            .orderBy("lastMessageAt", Query.Direction.DESCENDING)
            .addSnapshotListener { snap, _ ->
                val list = snap?.documents?.mapNotNull { doc ->
                    val participants = doc.get("participants") as? List<*> ?: return@mapNotNull null
                    val otherUid = participants.firstOrNull { it != myUid }?.toString() ?: ""
                    Conversation(
                        id                   = doc.id,
                        participants         = participants.mapNotNull { it?.toString() },
                        otherUserUid         = otherUid,
                        otherUserName        = doc.getString("otherUserName_$myUid") ?: doc.getString("name_$otherUid") ?: "",
                        otherUserPhotoUrl    = doc.getString("otherUserPhotoUrl_$myUid") ?: "",
                        lastMessage          = doc.getString("lastMessage") ?: "",
                        lastMessageAt        = doc.getLong("lastMessageAt") ?: 0L,
                        lastMessageSenderUid = doc.getString("lastMessageSenderUid") ?: "",
                        unreadCount          = (doc.get("unreadCount") as? Map<*, *>)
                            ?.mapNotNull { (k, v) -> if (k is String && v is Long) k to v else null }
                            ?.toMap() ?: emptyMap(),
                    )
                } ?: emptyList()
                trySend(list)
            }
        awaitClose { listener.remove() }
    }

    // ── Messages in a conversation ────────────────────────────────────────────

    fun messagesFlow(convoId: String): Flow<List<ChatMessage>> = callbackFlow {
        val listener = convoCol.document(convoId).collection("messages")
            .orderBy("timestamp", Query.Direction.ASCENDING)
            .addSnapshotListener { snap, _ ->
                val msgs = snap?.documents?.mapNotNull { doc ->
                    ChatMessage(
                        id              = doc.id,
                        senderUid       = doc.getString("senderUid") ?: "",
                        senderName      = doc.getString("senderName") ?: "",
                        text            = doc.getString("text") ?: "",
                        imageUrl        = doc.getString("imageUrl") ?: "",
                        type            = doc.getString("type") ?: "text",
                        inviteRoomId    = doc.getString("inviteRoomId") ?: "",
                        inviteHostName  = doc.getString("inviteHostName") ?: "",
                        timestamp       = doc.millis("timestamp"),
                        isRead          = doc.getBoolean("isRead") ?: false,
                    )
                } ?: emptyList()
                trySend(msgs)
            }
        awaitClose { listener.remove() }
    }

    // ── Send text message ─────────────────────────────────────────────────────

    suspend fun sendMessage(
        myUid: String,
        myName: String,
        myPhotoUrl: String,
        otherUid: String,
        otherName: String,
        otherPhotoUrl: String,
        text: String,
    ): String {
        val cid = convoId(myUid, otherUid)
        val msgRef = convoCol.document(cid).collection("messages").document()
        val now = System.currentTimeMillis()

        val batch = firestore.batch()

        // Message doc
        batch.set(msgRef, mapOf(
            "senderUid"  to myUid,
            "senderName" to myName,
            "text"       to text,
            "type"       to "text",
            "timestamp"  to now,
            "isRead"     to false,
        ))

        // Conversation doc — upsert
        val convoRef = convoCol.document(cid)
        batch.set(convoRef, mapOf(
            "participants"              to listOf(myUid, otherUid),
            "lastMessage"               to text,
            "lastMessageAt"             to now,
            "lastMessageSenderUid"      to myUid,
            // Per-viewer display names (each side sees their counterpart's info)
            "otherUserName_$myUid"      to otherName,
            "otherUserPhotoUrl_$myUid"  to otherPhotoUrl,
            "otherUserName_$otherUid"   to myName,
            "otherUserPhotoUrl_$otherUid" to myPhotoUrl,
            "unreadCount"               to mapOf(otherUid to FieldValue.increment(1L)),
        ), com.google.firebase.firestore.SetOptions.merge())

        batch.commit().await()
        return cid
    }

    // ── Send live invite ──────────────────────────────────────────────────────

    suspend fun sendInvite(
        myUid: String,
        myName: String,
        myPhotoUrl: String,
        otherUid: String,
        otherName: String,
        otherPhotoUrl: String,
        roomId: String,
        hostName: String,
    ) {
        val cid = convoId(myUid, otherUid)
        val msgRef = convoCol.document(cid).collection("messages").document()
        val now = System.currentTimeMillis()
        val inviteText = "📺 $hostName is live! Tap to join."

        val batch = firestore.batch()

        batch.set(msgRef, mapOf(
            "senderUid"      to myUid,
            "senderName"     to myName,
            "text"           to inviteText,
            "type"           to "invite",
            "inviteRoomId"   to roomId,
            "inviteHostName" to hostName,
            "timestamp"      to now,
            "isRead"         to false,
        ))

        val convoRef = convoCol.document(cid)
        batch.set(convoRef, mapOf(
            "participants"              to listOf(myUid, otherUid),
            "lastMessage"               to inviteText,
            "lastMessageAt"             to now,
            "lastMessageSenderUid"      to myUid,
            "otherUserName_$myUid"      to otherName,
            "otherUserPhotoUrl_$myUid"  to otherPhotoUrl,
            "otherUserName_$otherUid"   to myName,
            "otherUserPhotoUrl_$otherUid" to myPhotoUrl,
            "unreadCount"               to mapOf(otherUid to FieldValue.increment(1L)),
        ), com.google.firebase.firestore.SetOptions.merge())

        batch.commit().await()
    }

    // ── Mark conversation as read ─────────────────────────────────────────────

    suspend fun markRead(convoId: String, myUid: String) {
        try {
            convoCol.document(convoId).update("unreadCount.$myUid", 0L).await()
        } catch (_: Exception) {}
    }

    // ── Broadcasts (admin → all users) ───────────────────────────────────────

    fun broadcastsFlow(): Flow<List<BroadcastMessage>> = callbackFlow {
        val listener = broadcastCol
            .orderBy("createdAt", Query.Direction.DESCENDING)
            .limit(50)
            .addSnapshotListener { snap, _ ->
                val list = snap?.documents?.mapNotNull { doc ->
                    BroadcastMessage(
                        id           = doc.id,
                        title        = doc.getString("title") ?: "",
                        // `message` is the field the CRM wrote before the two
                        // sides were reconciled on `title`/`body`. Every
                        // broadcast sent up to then carries only that, and
                        // reading `body` alone rendered all of them as blank
                        // cards. The writer emits the canonical shape now; this
                        // fallback is what makes the ones already in the
                        // collection readable.
                        body         = doc.getString("body") ?: doc.getString("message") ?: "",
                        imageUrl     = doc.getString("imageUrl") ?: "",
                        createdAt    = doc.millis("createdAt"),
                        targetGender = doc.getString("targetGender") ?: "all",
                        senderName   = doc.getString("senderName")?.trim().orEmpty(),
                    )
                } ?: emptyList()
                trySend(list)
            }
        awaitClose { listener.remove() }
    }

    // ── Notifications (addressed to one user) ────────────────────────────────

    /**
     * Everything in `notifications` addressed to [myUid], newest first.
     *
     * This is the other half of the Official tab. `broadcastsFlow` is what the
     * team sends to everybody; this is what the system sends to one person —
     * an official warning, a recharge that went through or stalled, an agency
     * approval, a payout approval. All of it was being written and none of it
     * was being read.
     *
     * ── THE QUERY NEEDS AN INDEX, AND IT IS DECLARED ────────────────────────
     *
     * An equality filter plus an `orderBy` on a DIFFERENT field is exactly the
     * shape Firestore needs a composite index for — the same shape that took
     * four of the five CRM appeal tabs down. `notifications(userId ASC,
     * createdAt DESC)` is declared in `firestore.indexes.json`; without it
     * deployed, this listener fails and the tab falls back to broadcasts
     * alone.
     *
     * The equality on `userId` is also what makes the query legal: the
     * deployed rule allows a read only where `resource.data.userId ==
     * request.auth.uid`, and Firestore rejects a query it cannot prove in
     * advance will stay inside that. Widening this filter would not return
     * more rows — it would return `PERMISSION_DENIED`.
     */
    fun myNotificationsFlow(myUid: String): Flow<List<UserNotification>> = callbackFlow {
        if (myUid.isBlank()) {
            // Signed out, or called before auth resolved. `whereEqualTo` on an
            // empty string would be a real query for a real (empty) uid, which
            // the rule denies — so emit nothing and hold the flow open rather
            // than firing one off.
            trySend(emptyList())
            awaitClose { }
            return@callbackFlow
        }
        val listener = notifCol
            .whereEqualTo("userId", myUid)
            .orderBy("createdAt", Query.Direction.DESCENDING)
            .limit(50)
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    // Logged rather than swallowed. A silent empty list here is
                    // indistinguishable from "you have no messages", which is
                    // how an undeployed index or a rules change would present
                    // itself: as the user having been told nothing.
                    android.util.Log.w("Notifications", "listener failed for $myUid", err)
                    return@addSnapshotListener
                }
                val list = snap?.documents?.map { doc ->
                    /*
                     * THE NOTICE SHAPE (APK 20, item 10). One writer on the
                     * server — `backend/app/services/notices.py` — and the
                     * Cloud Functions write the top-level `notifications`
                     * collection as
                     *
                     *   { userId, type, title, body, isRead, createdAt,
                     *     reason?, meta?: { ticket_id | partner_id | … } }
                     *
                     * The canonical shape agreed for the CRM is
                     *   { userId, type, title, body, relatedId, createdAt, read }
                     * and the CRM itself no longer writes notices directly
                     * (every ticket reply goes through the API). Both
                     * spellings of the read flag and of the related id are
                     * accepted here so neither writer renders a blank or an
                     * always-unread card.
                     */
                    @Suppress("UNCHECKED_CAST")
                    val meta = doc.get("meta") as? Map<String, Any?>
                    UserNotification(
                        id        = doc.id,
                        type      = doc.getString("type") ?: "",
                        title     = doc.getString("title") ?: "",
                        // `body` is the canonical field, written by the backend
                        // and by all four Cloud Functions. `message` is what
                        // the CRM's own notification writer used; reading only
                        // one of them renders the other as a blank card.
                        body      = doc.getString("body") ?: doc.getString("message") ?: "",
                        createdAt = doc.millis("createdAt"),
                        isRead    = doc.getBoolean("isRead") ?: doc.getBoolean("read") ?: false,
                        relatedId = doc.getString("relatedId")
                            ?: (meta?.get("relatedId") ?: meta?.get("ticket_id") ?: meta?.get("partner_id")
                                ?: meta?.get("recharge_id") ?: meta?.get("id"))?.toString()
                            ?: "",
                        reason    = doc.getString("reason")?.trim().orEmpty(),
                    )
                } ?: emptyList()
                trySend(list)
            }
        awaitClose { listener.remove() }
    }

    // ── Support tickets ───────────────────────────────────────────────────────

    fun myTicketsFlow(myUid: String): Flow<List<SupportTicket>> = callbackFlow {
        val listener = ticketsCol
            .whereEqualTo("userId", myUid)
            // `createdAt` — the field the writer sets, and the order of the
            // existing (userId, createdAt desc) index on feedbackTickets.
            // `updatedAt` is never written there, and ordering on a field a
            // document lacks drops that document from the result.
            .orderBy("createdAt", Query.Direction.DESCENDING)
            .limit(50)
            .addSnapshotListener { snap, _ ->
                val list = snap?.documents?.mapNotNull { doc ->
                    SupportTicket.fromFeedbackTicket(
                        id              = doc.id,
                        userId          = doc.getString("userId"),
                        subject         = doc.getString("subject"),
                        message         = doc.getString("message"),
                        body            = doc.getString("body"),
                        status          = doc.getString("status"),
                        response        = doc.getString("response"),
                        adminReply      = doc.getString("adminReply"),
                        statusMessage   = doc.getString("statusMessage"),
                        // `millis`, not `getLong`: both are serverTimestamp()s.
                        createdAt       = doc.millis("createdAt"),
                        statusChangedAt = doc.millis("statusChangedAt"),
                    )
                } ?: emptyList()
                trySend(list)
            }
        awaitClose { listener.remove() }
    }
}

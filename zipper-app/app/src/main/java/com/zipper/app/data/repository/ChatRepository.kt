package com.zipper.app.data.repository

import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.zipper.app.data.model.BroadcastMessage
import com.zipper.app.data.model.ChatMessage
import com.zipper.app.data.model.Conversation
import com.zipper.app.data.model.SupportTicket
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
    private val ticketsCol get() = firestore.collection("supportTickets")

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
            .orderBy("updatedAt", Query.Direction.DESCENDING)
            .addSnapshotListener { snap, _ ->
                val list = snap?.documents?.mapNotNull { doc ->
                    SupportTicket(
                        id            = doc.id,
                        userId        = doc.getString("userId") ?: "",
                        subject       = doc.getString("subject") ?: "",
                        body          = doc.getString("body") ?: "",
                        status        = doc.getString("status") ?: "open",
                        // The reply staff actually write is `adminReply`
                        // (`respondToTicket` in the CRM). `statusMessage` is
                        // read here and written by nothing in the system, so
                        // the "Reply from Zipper" block below never appeared —
                        // support answered tickets and the answer reached
                        // nobody. It is kept as a fallback rather than dropped,
                        // in case an older document carries one.
                        statusMessage = doc.getString("adminReply")
                            ?: doc.getString("statusMessage") ?: "",
                        createdAt     = doc.millis("createdAt"),
                        // `millis`, not `getLong`: the CRM writes this with
                        // `serverTimestamp()`, which arrives as a Timestamp and
                        // made `getLong` return null on every replied ticket.
                        updatedAt     = doc.millis("updatedAt"),
                    )
                } ?: emptyList()
                trySend(list)
            }
        awaitClose { listener.remove() }
    }
}

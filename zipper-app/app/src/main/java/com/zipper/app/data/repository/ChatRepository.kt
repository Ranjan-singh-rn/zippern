package com.zipper.app.data.repository

import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.ListenerRegistration
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.QuerySnapshot
import com.google.firebase.storage.FirebaseStorage
import com.google.firebase.storage.StorageMetadata
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
import com.zipper.app.util.ChatParse

@Singleton
class ChatRepository @Inject constructor(
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
    private val storage: FirebaseStorage,
) {

    companion object {
        private const val TAG = "Chat"
        /** O10: how many chats the Messages list streams, newest first. */
        const val CONVERSATIONS_SHOWN = 100L
        /** O10: a thread opens on its newest messages; "Show earlier messages" adds this many at a time. */
        const val MESSAGES_PAGE = 100L
    }

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

    /**
     * O5: the list, and whether reading it FAILED. The listener used to drop its error on the floor, so a refused or
     * broken query looked exactly like "No chats yet" — somebody with a new message saw nothing and nothing said so.
     */
    data class ConversationsUpdate(val conversations: List<Conversation>, val failed: Boolean = false)

    fun conversationsFlow(myUid: String): Flow<ConversationsUpdate> = callbackFlow {
        var fallback: ListenerRegistration? = null
        val primary = convoCol
            .whereArrayContains("participants", myUid)
            .orderBy("lastMessageAt", Query.Direction.DESCENDING)
            // O10 (5 Nov 2026), speed: the latest 100 chats, not every conversation the account ever had.
            .limit(CONVERSATIONS_SHOWN)
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    android.util.Log.w(TAG, "conversations listener failed; reading them unordered", err)
                    // The ordered query needs its composite index; the unordered one needs none, and
                    // ChatParse.visible sorts the rows here. Started once.
                    if (fallback == null) {
                        fallback = convoCol.whereArrayContains("participants", myUid)
                            .limit(CONVERSATIONS_SHOWN)
                            .addSnapshotListener { s2, e2 ->
                                if (e2 != null) {
                                    android.util.Log.w(TAG, "conversations fallback failed", e2)
                                    trySend(ConversationsUpdate(emptyList(), failed = true))
                                } else trySend(ConversationsUpdate(parseConversations(s2, myUid)))
                            }
                    }
                    return@addSnapshotListener
                }
                trySend(ConversationsUpdate(parseConversations(snap, myUid)))
            }
        awaitClose { primary.remove(); fallback?.remove() }
    }

    /** One unreadable document is skipped on its own; it never takes the list down (ChatParse). */
    private fun parseConversations(snap: QuerySnapshot?, myUid: String): List<Conversation> =
        ChatParse.visible(snap?.documents?.mapNotNull { d ->
            runCatching { ChatParse.conversation(d.id, d.data ?: emptyMap(), myUid) }.getOrNull()
        }.orEmpty())

    /**
     * This viewer's own deletion mark on one conversation (`clearedAt.{uid}`), live. 0 when there is none — and also
     * when the conversation does not exist yet, which the rules answer with a refusal (they read `participants` of a
     * document that is not there); a new chat has nothing to hide, so that refusal means 0 too.
     */
    fun clearedAtFlow(convoId: String, myUid: String): Flow<Long> = callbackFlow {
        val listener = convoCol.document(convoId).addSnapshotListener { snap, err ->
            if (err != null) { trySend(0L); return@addSnapshotListener }
            trySend(ChatParse.long((snap?.get("clearedAt") as? Map<*, *>)?.get(myUid)))
        }
        awaitClose { listener.remove() }
    }

    /**
     * O5: "delete chat" for the selected conversations — for THIS viewer only. Their list hides each one until a
     * newer message arrives, and their thread shows only what came after; the other person's copy is untouched
     * (the messages are as much theirs). Marked at the later of now and the last message, so a sender whose clock
     * runs ahead cannot leave the chat showing.
     */
    suspend fun clearForMe(convos: Collection<Conversation>, myUid: String) {
        if (convos.isEmpty() || myUid.isBlank()) return
        val now = System.currentTimeMillis()
        val batch = firestore.batch()
        convos.forEach { c ->
            batch.update(convoCol.document(c.id), mapOf(
                "clearedAt.$myUid" to maxOf(now, c.lastMessageAt),
                "unreadCount.$myUid" to 0L,
            ))
        }
        batch.commit().await()
    }

    // ── Messages in a conversation ────────────────────────────────────────────

    data class MessagesUpdate(val messages: List<ChatMessage>, val failed: Boolean = false)

    /**
     * The newest [limit] messages, oldest first. O10 (5 Nov 2026), speed: the thread used to stream its WHOLE history
     * and re-parse all of it on every new message; "Show earlier messages" raises [limit] a page at a time.
     */
    fun messagesFlow(convoId: String, limit: Long = MESSAGES_PAGE): Flow<MessagesUpdate> = callbackFlow {
        val listener = convoCol.document(convoId).collection("messages")
            .orderBy("timestamp", Query.Direction.ASCENDING)
            .limitToLast(limit)
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    android.util.Log.w(TAG, "messages listener failed for $convoId", err)
                    trySend(MessagesUpdate(emptyList(), failed = true))
                    return@addSnapshotListener
                }
                val msgs = snap?.documents?.mapNotNull { doc ->
                    runCatching { ChatParse.message(doc.id, doc.data ?: emptyMap()) }.getOrNull()
                }.orEmpty()
                trySend(MessagesUpdate(msgs))
            }
        awaitClose { listener.remove() }
    }

    // ── Send ──────────────────────────────────────────────────────────────────

    /**
     * Send one message of a kind a phone may send (text, photo, voice; firestore.rules allows exactly those and
     * `invite`). A gift is NOT sent from here: settleGift writes it with the money.
     */
    suspend fun send(
        myUid: String,
        myName: String,
        myPhotoUrl: String,
        otherUid: String,
        otherName: String,
        otherPhotoUrl: String,
        type: String,
        text: String = "",
        extra: Map<String, Any> = emptyMap(),
    ): String {
        require(type in ChatParse.CLIENT_TYPES) { "not a message kind a phone sends: $type" }
        val cid = convoId(myUid, otherUid)
        val msgRef = convoCol.document(cid).collection("messages").document()
        val now = System.currentTimeMillis()

        val batch = firestore.batch()
        batch.set(msgRef, mapOf(
            "senderUid"  to myUid,
            "senderName" to myName,
            "text"       to text,
            "type"       to type,
            "timestamp"  to now,
            "isRead"     to false,
        ) + extra)
        batch.set(
            convoCol.document(cid),
            conversationUpsert(myUid, myName, myPhotoUrl, otherUid, otherName, otherPhotoUrl, ChatParse.preview(type, text), now),
            com.google.firebase.firestore.SetOptions.merge(),
        )
        batch.commit().await()
        return cid
    }

    /** The conversation fields a send writes. A blank name or photo is left out, so it never blanks a stored one. */
    private fun conversationUpsert(
        myUid: String, myName: String, myPhotoUrl: String,
        otherUid: String, otherName: String, otherPhotoUrl: String,
        lastMessage: String, now: Long,
    ): Map<String, Any> {
        val m = linkedMapOf<String, Any>(
            "participants"         to listOf(myUid, otherUid),
            "lastMessage"          to lastMessage,
            "lastMessageAt"        to now,
            "lastMessageSenderUid" to myUid,
            "unreadCount"          to mapOf(otherUid to FieldValue.increment(1L)),
        )
        // Per-viewer display names (each side sees their counterpart's info)
        if (otherName.isNotBlank()) m["otherUserName_$myUid"] = otherName
        if (otherPhotoUrl.isNotBlank()) m["otherUserPhotoUrl_$myUid"] = otherPhotoUrl
        if (myName.isNotBlank()) m["otherUserName_$otherUid"] = myName
        if (myPhotoUrl.isNotBlank()) m["otherUserPhotoUrl_$otherUid"] = myPhotoUrl
        return m
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
    ): String = send(myUid, myName, myPhotoUrl, otherUid, otherName, otherPhotoUrl, type = "text", text = text)

    /**
     * O5: a chat photo or voice note, uploaded under `chatMedia/{convoId}/{myUid}/` (storage.rules: the two people in
     * the chat read it; only its sender writes it). Returns the download URL the message stores.
     */
    suspend fun uploadChatMedia(convoId: String, myUid: String, bytes: ByteArray, contentType: String, ext: String): String {
        val name = "${System.currentTimeMillis()}_${java.util.UUID.randomUUID().toString().take(8)}.$ext"
        val ref = storage.reference.child(ChatParse.mediaPath(convoId, myUid, name))
        ref.putBytes(bytes, StorageMetadata.Builder().setContentType(contentType).build()).await()
        return ref.downloadUrl.await().toString()
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
        /** "live" or "party" (Owner, 5 Nov 2026: party rooms are shared into a chat too). */
        kind: String = "live",
    ) {
        val party = kind == "party"
        send(
            myUid, myName, myPhotoUrl, otherUid, otherName, otherPhotoUrl,
            type = "invite",
            text = if (party) "🎉 Join $hostName's party room! Tap to join." else "📺 $hostName is live! Tap to join.",
            extra = mapOf("inviteRoomId" to roomId, "inviteHostName" to hostName, "inviteKind" to if (party) "party" else "live"),
        )
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

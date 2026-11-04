package com.zipper.app.util

import com.zipper.app.data.model.ChatMessage
import com.zipper.app.data.model.Conversation

/**
 * O5 (5 Nov 2026) — reading the chat documents, pure (maps in, models out), so `ChatParseTest` runs it on the JVM.
 *
 * The old reader used `getLong("lastMessageAt")`, which THROWS on any value that is not a whole number (a server
 * timestamp, a double) — inside a snapshot listener, where the throw ends the listener and the Chats tab shows
 * "No chats yet" for good. Every number here is read leniently instead, and a document that cannot be read is
 * skipped on its own rather than taking the list down with it.
 */
object ChatParse {

    /** Message kinds a phone may send (firestore.rules allows exactly these on create). */
    val CLIENT_TYPES = setOf("text", "image", "voice", "invite")

    /** A voice note: at most a minute (MediaRecorder stops itself there), and anything under a second is a slip. */
    const val VOICE_MAX_MS = 60_000L
    const val VOICE_MIN_MS = 1_000L

    /** A number, a time (Timestamp / Date) or nothing, as a Long; never throws. */
    fun long(v: Any?): Long = when (v) {
        null -> 0L
        is Number -> v.toLong()
        is java.util.Date -> v.time
        is String -> v.trim().toLongOrNull() ?: 0L
        else -> v.asMillis()   // a Firestore Timestamp
    }

    fun conversation(id: String, data: Map<String, Any?>, myUid: String): Conversation? {
        val participants = (data["participants"] as? List<*>)?.mapNotNull { it?.toString() } ?: return null
        if (myUid !in participants) return null
        val otherUid = participants.firstOrNull { it != myUid }.orEmpty()
        val unread = (data["unreadCount"] as? Map<*, *>)
            ?.mapNotNull { (k, v) -> if (k is String) k to long(v) else null }?.toMap().orEmpty()
        val cleared = (data["clearedAt"] as? Map<*, *>)?.get(myUid)
        return Conversation(
            id = id,
            participants = participants,
            otherUserUid = otherUid,
            otherUserName = (data["otherUserName_$myUid"] as? String) ?: (data["name_$otherUid"] as? String) ?: "",
            otherUserPhotoUrl = (data["otherUserPhotoUrl_$myUid"] as? String).orEmpty(),
            lastMessage = (data["lastMessage"] as? String).orEmpty(),
            lastMessageAt = long(data["lastMessageAt"]),
            lastMessageSenderUid = (data["lastMessageSenderUid"] as? String).orEmpty(),
            unreadCount = unread,
            clearedAtMine = long(cleared),
        )
    }

    /** The list a viewer sees: newest first, without the chats they deleted (until something newer arrives). */
    fun visible(all: List<Conversation>): List<Conversation> =
        all.filterNot { it.hiddenForMe }.sortedByDescending { it.lastMessageAt }

    fun message(id: String, data: Map<String, Any?>): ChatMessage = ChatMessage(
        id = id,
        senderUid = (data["senderUid"] as? String).orEmpty(),
        senderName = (data["senderName"] as? String).orEmpty(),
        text = (data["text"] as? String).orEmpty(),
        imageUrl = (data["imageUrl"] as? String).orEmpty(),
        type = (data["type"] as? String)?.takeIf { it.isNotBlank() } ?: "text",
        inviteRoomId = (data["inviteRoomId"] as? String).orEmpty(),
        inviteHostName = (data["inviteHostName"] as? String).orEmpty(),
        timestamp = long(data["timestamp"]),
        isRead = data["isRead"] == true,
        audioUrl = (data["audioUrl"] as? String).orEmpty(),
        durationMs = long(data["durationMs"]),
        giftName = (data["giftName"] as? String).orEmpty(),
        giftImageUrl = (data["giftImageUrl"] as? String).orEmpty(),
        giftEmoji = (data["giftEmoji"] as? String).orEmpty(),
        quantity = long(data["quantity"]).toInt().coerceAtLeast(1),
    )

    /**
     * The thread a viewer sees after deleting the chat: only what came after, oldest first by the time each message
     * carries. Sorted here as well as by the query: Firestore orders every number before every Timestamp, so one
     * message stamped by a server clock (a fixture did exactly this, 5 Nov 2026) jumped below newer texts. Stable,
     * so messages with the same time keep the query's order.
     */
    fun after(messages: List<ChatMessage>, clearedAtMine: Long): List<ChatMessage> =
        (if (clearedAtMine <= 0L) messages else messages.filter { it.timestamp > clearedAtMine }).sortedBy { it.timestamp }

    /** The line the Chats list shows for a message this phone sends. */
    fun preview(type: String, text: String): String = when (type) {
        "image" -> "📷 Photo"
        "voice" -> "🎤 Voice message"
        else -> text
    }

    /** "0:07" for a voice note's length. */
    fun clock(ms: Long): String {
        val s = (ms.coerceAtLeast(0L) + 500L) / 1000L
        return "${s / 60}:${(s % 60).toString().padStart(2, '0')}"
    }

    /** Where a chat photo or voice note is stored (storage.rules `chatMedia/{convoId}/{uid}/{fileName}`). */
    fun mediaPath(convoId: String, myUid: String, fileName: String): String = "chatMedia/$convoId/$myUid/$fileName"
}

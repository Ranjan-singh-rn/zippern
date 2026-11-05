package com.zipper.app.data.model

data class ChatMessage(
    val id: String = "",
    val senderUid: String = "",
    val senderName: String = "",
    val text: String = "",
    val imageUrl: String = "",
    /** "text" | "image" | "voice" | "invite" | "gift" (a gift is written only by settleGift — O5). */
    val type: String = "text",
    val inviteRoomId: String = "",
    val inviteHostName: String = "",
    /** "live" | "party" — an invite without one is a live (older app versions). */
    val inviteKind: String = "live",
    val timestamp: Long = 0L,
    val isRead: Boolean = false,
    /** O5: a voice note — its download URL and length. */
    val audioUrl: String = "",
    val durationMs: Long = 0L,
    /** O5: a gift sent from the chat (or a profile / a call), as the server recorded it. */
    val giftName: String = "",
    val giftImageUrl: String = "",
    val giftEmoji: String = "",
    val quantity: Int = 1,
)

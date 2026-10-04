package com.zipper.app.data.model

data class ChatMessage(
    val id: String = "",
    val senderUid: String = "",
    val senderName: String = "",
    val text: String = "",
    val imageUrl: String = "",
    val type: String = "text",         // "text" | "image" | "invite"
    val inviteRoomId: String = "",
    val inviteHostName: String = "",
    val timestamp: Long = 0L,
    val isRead: Boolean = false,
)

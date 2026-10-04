package com.zipper.app.data.model

data class Conversation(
    val id: String = "",
    val participants: List<String> = emptyList(),
    val otherUserUid: String = "",
    val otherUserName: String = "",
    val otherUserPhotoUrl: String = "",
    val lastMessage: String = "",
    val lastMessageAt: Long = 0L,
    val lastMessageSenderUid: String = "",
    val unreadCount: Map<String, Long> = emptyMap(),
)

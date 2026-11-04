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
    /**
     * O5: when THIS viewer deleted the chat from their list (`clearedAt.{uid}`, epoch millis; 0 = never). Their list
     * hides it until a newer message arrives, and their thread shows only messages after it. The other person's copy
     * is untouched.
     */
    val clearedAtMine: Long = 0L,
) {
    /** Deleted by this viewer and nothing newer since. */
    val hiddenForMe: Boolean get() = clearedAtMine > 0L && lastMessageAt <= clearedAtMine
}

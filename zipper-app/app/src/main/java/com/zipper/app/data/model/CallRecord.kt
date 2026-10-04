package com.zipper.app.data.model

data class CallRecord(
    val id: String = "",
    val otherUserUid: String = "",
    val otherUserName: String = "",
    val otherUserPhotoUrl: String = "",
    val type: String = "outgoing",   // "incoming" | "outgoing" | "missed"
    val durationSeconds: Long = 0L,
    val timestamp: Long = 0L,
    val costBeans: Long = 0L,
)

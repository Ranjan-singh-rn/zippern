package com.zipper.app.data.model

data class BroadcastMessage(
    val id: String = "",
    val title: String = "",
    val body: String = "",
    val imageUrl: String = "",
    val createdAt: Long = 0L,
    val targetGender: String = "all",   // "all" | "male" | "female"
)

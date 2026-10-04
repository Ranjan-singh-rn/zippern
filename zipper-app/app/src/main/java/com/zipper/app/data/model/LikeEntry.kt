package com.zipper.app.data.model

data class LikeEntry(
    val uid: String = "",
    val name: String = "",
    val photoUrl: String = "",
    val level: Int = 0,
    val isOnline: Boolean = false,
    val gender: String = "",
    val city: String = "",
    val likedAt: Long = 0L,
)

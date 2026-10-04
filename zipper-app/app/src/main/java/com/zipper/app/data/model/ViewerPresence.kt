package com.zipper.app.data.model

data class ViewerPresence(
    val uid: String = "",
    val name: String = "",
    val photoUrl: String = "",
    val level: Int = 0,
    val joinedAt: Long = 0L,
)

package com.zipper.app.data.model

data class SellerProfile(
    val uid: String = "",
    val sellerId: String = "",
    val name: String = "",
    val photoUrl: String = "",
    val gender: String = "",
    val location: String = "",
    val isOnline: Boolean = false,
)

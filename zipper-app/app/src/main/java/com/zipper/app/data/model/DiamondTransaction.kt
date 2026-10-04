package com.zipper.app.data.model

data class DiamondTransaction(
    val id: String = "",
    val type: String = "credit",  // "credit" | "debit"
    val amount: Long = 0L,
    val reason: String = "",
    val reasonLabel: String = "",
    val timestamp: Long = 0L,
    val relatedUserName: String = "",
)

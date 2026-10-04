package com.zipper.app.data.model

data class SupportTicket(
    val id: String = "",
    val userId: String = "",
    val subject: String = "",
    val body: String = "",
    val status: String = "open",          // "open" | "in_progress" | "resolved" | "closed"
    val statusMessage: String = "",
    val createdAt: Long = 0L,
    val updatedAt: Long = 0L,
)

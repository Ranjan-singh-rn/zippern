package com.zipper.app.data.model

data class BroadcastMessage(
    val id: String = "",
    val title: String = "",
    val body: String = "",
    val imageUrl: String = "",
    val createdAt: Long = 0L,
    val targetGender: String = "all",   // "all" | "male" | "female"
    /**
     * Who the announcement is from, as typed in the CRM's Broadcasts screen
     * (`senderName`, default "Zipper Team"). QA (3 Nov 2026): written by the
     * CRM, never read here, so every announcement showed no sender.
     */
    val senderName: String = "",
)

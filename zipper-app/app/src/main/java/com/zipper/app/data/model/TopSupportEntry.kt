package com.zipper.app.data.model

/**
 * A weekly top-supporter or top-host ranking entry.
 *
 * For hosts  → stored in [User.topSupporters]: who gifted the host the most this week.
 * For users  → stored in [User.topHosts]: which hosts the user gifted the most this week.
 *
 * Reset every Sunday via Cloud Function.
 * Firestore-safe: all fields have default values.
 */
data class TopSupportEntry(
    val uid: String = "",
    val name: String = "",
    val photoUrl: String = "",
    val totalDiamonds: Long = 0L,
    val rank: Int = 0,
)

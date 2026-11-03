package com.zipper.app.util

/**
 * Which Messages tab opens, and how an Official notice reads.
 *
 * QA (3 Nov 2026):
 *   * Messages always opened on Chats — a person whose account had just been
 *     warned, suspended or banned, or whose appeal was decided, landed on an
 *     empty chat list with the notice one tap away and nothing saying so.
 *   * A ban notice arrived without its reason: `notices.py` writes the reason
 *     as its own `reason` field, and the card showed only title and body.
 *   * An announcement never showed who sent it (`senderName`, typed in the CRM).
 *
 * Pure — `MessagesTabsTest` runs it on the JVM.
 */
object MessagesTabs {
    const val OFFICIAL = 0
    const val FEEDBACK = 1
    const val CHATS = 2

    /**
     * The tab to open. [requested] ("official" / "feedback" / "chats") is a
     * caller asking for one — a deep link from an Official notification.
     * Otherwise Official opens when something there is unread and no chat is,
     * and Chats in every other case (as before).
     */
    fun initialTab(requested: String?, unreadOfficial: Int, unreadChats: Int): Int =
        when (requested?.trim()?.lowercase()) {
            "official" -> OFFICIAL
            "feedback" -> FEEDBACK
            "chats" -> CHATS
            else -> if (unreadOfficial > 0 && unreadChats <= 0) OFFICIAL else CHATS
        }

    /** The reason line of a notice, or null when there is none or the body already says it. */
    fun reasonLine(body: String, reason: String): String? {
        val r = reason.trim()
        if (r.isEmpty()) return null
        if (body.contains(r)) return null
        return "Reason: $r"
    }

    /** "From Zipper Team" — or null when the announcement names nobody. */
    fun senderLine(senderName: String): String? =
        senderName.trim().takeIf { it.isNotEmpty() }?.let { "From $it" }
}

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

    /**
     * O5 (5 Nov 2026): official notices the person has not SEEN yet. A notice is never marked read on the server
     * (firestore.rules lets no client write `notifications`), so counting `!isRead` alone kept "Official · 14" up
     * for ever — and Messages opened on Official every single time, with the chats a tab away. A notice counts as
     * seen once the Official tab has been opened after it arrived ([seenAt], kept on the phone per account).
     */
    fun unseenOfficial(notices: List<com.zipper.app.data.model.UserNotification>, seenAt: Long): Int =
        notices.count { !it.isRead && it.createdAt > seenAt }

    /** The "seen up to" mark to store when the Official tab is opened: now, or the newest notice if its clock is ahead. */
    fun seenMark(notices: List<com.zipper.app.data.model.UserNotification>, now: Long): Long =
        maxOf(now, notices.maxOfOrNull { it.createdAt } ?: 0L)

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

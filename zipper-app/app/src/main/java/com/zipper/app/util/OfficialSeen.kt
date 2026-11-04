package com.zipper.app.util

import android.content.Context

/**
 * O5 (5 Nov 2026): when this account last opened the Official tab, on this phone. See [MessagesTabs.unseenOfficial].
 * Kept per account (uid), so the account switcher never carries one person's "seen" onto another's notices.
 */
object OfficialSeen {
    private const val PREFS = "zipper_messages"
    private fun key(uid: String) = "official_seen_at_$uid"

    fun get(context: Context, uid: String): Long =
        if (uid.isBlank()) 0L else context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(key(uid), 0L)

    fun set(context: Context, uid: String, at: Long) {
        if (uid.isBlank()) return
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong(key(uid), at).apply()
    }
}

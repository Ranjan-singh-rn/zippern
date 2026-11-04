package com.zipper.app.util

import com.zipper.app.data.model.PublicProfile

/**
 * O11 (Owner, 5 Nov 2026) — what the Home feed shows, and in what order.
 *
 *   "Never show an official owner ID in the home screen … you can show agencies, sub-agencies, coin sellers, but don't
 *    show officials. If the person is female, show the male first. If male, show the female first. If transgender,
 *    show normally."
 *
 * Officials are also kept out by the server (`publicProfiles.isListed` is false for `isOfficial`); this filter is the
 * same rule on the phone, so an official never shows while an older projection is still being rewritten. The order
 * within each group is the server's (live → party → online → … then most recent): the sort is stable.
 */
object HomeOrder {

    fun visible(p: PublicProfile): Boolean = !p.isOfficial

    /** The gender a viewer sees first, or null for the plain order. */
    fun preferredGender(viewerGender: String): String? = when (viewerGender.trim().lowercase()) {
        "female" -> "male"
        "male" -> "female"
        else -> null
    }

    fun order(profiles: List<PublicProfile>, viewerGender: String): List<PublicProfile> {
        val shown = profiles.filter(::visible)
        val first = preferredGender(viewerGender) ?: return shown
        return shown.sortedBy { if (it.gender.trim().equals(first, ignoreCase = true)) 0 else 1 }
    }
}

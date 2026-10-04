package com.zipper.app.data.model

import com.google.firebase.firestore.DocumentSnapshot
import com.zipper.app.util.UserLanguage

/**
 * What one user may see about another.
 *
 * The feed used to deserialise whole `User` documents — twenty at a time,
 * complete with `phoneNumber`, `email`, `dob`, `deviceId`, `fcmToken`,
 * `diamonds` and `beans`, because `users/{uid}` is readable by any signed-in
 * account. This is the projection `publicProfiles/{uid}` holds instead, and it
 * is everything a stranger is meant to see.
 *
 * Maintained by the `syncPublicProfile` Cloud Function. Nothing writes it from
 * the app.
 */
data class PublicProfile(
    val uid: String = "",
    val name: String = "",
    val photoUrl: String = "",
    val bio: String = "",
    val gender: String = "",
    val country: String = "",
    val city: String = "",
    /** Age, not date of birth — the card shows "24", not a birthday. */
    val age: Int = 0,
    val level: Int = 0,
    val hostLevel: Int = 0,
    val isHost: Boolean = false,
    val isVerifiedHost: Boolean = false,
    val isOfficial: Boolean = false,
    val isLive: Boolean = false,
    val isOnline: Boolean = false,
    val isInCall: Boolean = false,
    val isInParty: Boolean = false,
    /**
     * Presence flattened to one sortable integer: live 40, in a party 35,
     * online 30, in call 20, offline 0.
     *
     * Firestore cannot order across three booleans, and the old feed worked
     * around that by sorting in Kotlin — which meant it only ever sorted the
     * page it had already fetched.
     */
    val presenceRank: Int = 0,
    val lastSeen: Long = 0L,
    val languageCodes: List<String> = emptyList(),
    val hobbies: List<String> = emptyList(),
    val likes: List<String> = emptyList(),
    /**
     * The host's per-minute bean income — a PRICE, not a balance. The caller's
     * diamond cost is derived from it, so a profile cannot show what a call
     * costs without it.
     */
    val callRateBeans: Int = 0,
    val isSeller: Boolean = false,
    val totalLikesReceived: Long = 0L,
    val followerCount: Int = 0,
    // ── Profile screen ───────────────────────────────────────────────────────
    val coverPhotoUrl: String = "",
    val mediaUrls: List<String> = emptyList(),
    val mediaThumbs: List<String> = emptyList(),
    /** Full objects for display; [languageCodes] is the queryable flat form. */
    val languages: List<UserLanguage> = emptyList(),
    val topSupporters: List<TopSupportEntry> = emptyList(),
    val topHosts: List<TopSupportEntry> = emptyList(),
    val totalLikesGiven: Long = 0L,
    val isAgent: Boolean = false,
    val liveRoomId: String = "",
    val partyRoomId: String = "",
    val equippedFrame: String = "",
    val equippedChatBubble: String = "",
    val equippedProfileCard: String = "",
    val equippedIdFrame: String = "",
    val equippedEntrance: String = "",
) {
    companion object {
        private fun topEntry(m: Map<String, Any?>) = TopSupportEntry(
            uid           = m["uid"] as? String ?: "",
            name          = m["name"] as? String ?: "",
            photoUrl      = m["photoUrl"] as? String ?: "",
            totalDiamonds = (m["totalDiamonds"] as? Number)?.toLong() ?: 0L,
            rank          = (m["rank"] as? Number)?.toInt() ?: 0,
        )

        fun from(doc: DocumentSnapshot): PublicProfile? {
            val uid = doc.getString("uid") ?: doc.id
            if (uid.isBlank()) return null
            fun strings(field: String) =
                (doc.get(field) as? List<*>)?.mapNotNull { it as? String } ?: emptyList()

            @Suppress("UNCHECKED_CAST")
            fun maps(field: String): List<Map<String, Any?>> =
                (doc.get(field) as? List<*>)?.mapNotNull { it as? Map<String, Any?> } ?: emptyList()
            return PublicProfile(
                uid                = uid,
                name               = doc.getString("name") ?: "",
                photoUrl           = doc.getString("photoUrl") ?: "",
                bio                = doc.getString("bio") ?: "",
                gender             = doc.getString("gender") ?: "",
                country            = doc.getString("country") ?: "",
                city               = doc.getString("city") ?: "",
                age                = (doc.getLong("age") ?: 0L).toInt(),
                level              = (doc.getLong("level") ?: 0L).toInt(),
                hostLevel          = (doc.getLong("hostLevel") ?: 0L).toInt(),
                isHost             = doc.getBoolean("isHost") ?: false,
                isVerifiedHost     = doc.getBoolean("isVerifiedHost") ?: false,
                isOfficial         = doc.getBoolean("isOfficial") ?: false,
                isLive             = doc.getBoolean("isLive") ?: false,
                isOnline           = doc.getBoolean("isOnline") ?: false,
                isInCall           = doc.getBoolean("isInCall") ?: false,
                isInParty          = doc.getBoolean("isInParty") ?: false,
                presenceRank       = (doc.getLong("presenceRank") ?: 0L).toInt(),
                lastSeen           = doc.getLong("lastSeen") ?: 0L,
                languageCodes      = strings("languageCodes"),
                hobbies            = strings("hobbies"),
                likes              = strings("likes"),
                callRateBeans      = (doc.getLong("callRateBeans") ?: 0L).toInt(),
                isSeller           = doc.getBoolean("isSeller") ?: false,
                totalLikesReceived = doc.getLong("totalLikesReceived") ?: 0L,
                followerCount      = (doc.getLong("followerCount") ?: 0L).toInt(),
                coverPhotoUrl      = doc.getString("coverPhotoUrl") ?: "",
                mediaUrls          = strings("mediaUrls"),
                mediaThumbs        = strings("mediaThumbs"),
                languages          = maps("languages").map {
                    UserLanguage(
                        id   = (it["id"] as? Number)?.toInt() ?: 0,
                        code = it["code"] as? String ?: "",
                        name = it["name"] as? String ?: "",
                    )
                },
                topSupporters      = maps("topSupporters").map(::topEntry),
                topHosts           = maps("topHosts").map(::topEntry),
                totalLikesGiven    = doc.getLong("totalLikesGiven") ?: 0L,
                isAgent            = doc.getBoolean("isAgent") ?: false,
                liveRoomId         = doc.getString("liveRoomId") ?: "",
                partyRoomId        = doc.getString("partyRoomId") ?: "",
                equippedFrame       = doc.getString("equippedFrame") ?: "",
                equippedChatBubble  = doc.getString("equippedChatBubble") ?: "",
                equippedProfileCard = doc.getString("equippedProfileCard") ?: "",
                equippedIdFrame     = doc.getString("equippedIdFrame") ?: "",
                equippedEntrance    = doc.getString("equippedEntrance") ?: "",
            )
        }
    }

    /**
     * Adapt to [User] so the shared `ProfileScreen` can render a stranger.
     *
     * A bridge, and labelled as one. `ProfileScreen` takes a `User` and is used
     * for both your own profile and someone else's; the fields it shows only on
     * your own — email, phone, referral code, balances, streamed time — are
     * left at their defaults here, so there is nothing private to leak even if
     * a future edit forgets an `isOwnProfile` check.
     *
     * When the screens are rebuilt from the Figma designs, the other-profile
     * screen should take a `PublicProfile` directly and this goes away.
     */
    fun toUser(): User = User(
        uid = uid,
        name = name,
        photoUrl = photoUrl,
        coverPhotoUrl = coverPhotoUrl,
        bio = bio,
        gender = gender,
        country = country,
        city = city,
        age = age,
        level = level,
        hostLevel = hostLevel,
        isHost = isHost,
        isVerifiedHost = isVerifiedHost,
        isOfficial = isOfficial,
        isAgent = isAgent,
        isSeller = isSeller,
        isLive = isLive,
        isOnline = isOnline,
        isInCall = isInCall,
        isInParty = isInParty,
        lastSeen = lastSeen,
        languages = languages,
        hobbies = hobbies,
        likes = likes,
        mediaUrls = mediaUrls,
        mediaThumbs = mediaThumbs,
        topSupporters = topSupporters,
        topHosts = topHosts,
        totalLikesReceived = totalLikesReceived,
        totalLikesGiven = totalLikesGiven,
        callRateBeans = callRateBeans,
        liveRoomId = liveRoomId,
        partyRoomId = partyRoomId,
        equippedFrame = equippedFrame,
        equippedChatBubble = equippedChatBubble,
        equippedProfileCard = equippedProfileCard,
        equippedIdFrame = equippedIdFrame,
        equippedEntrance = equippedEntrance,
    )
}

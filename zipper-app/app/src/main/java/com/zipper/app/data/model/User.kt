package com.zipper.app.data.model

import com.google.firebase.firestore.DocumentSnapshot
import com.zipper.app.util.UserLanguage
import com.zipper.app.util.millis

data class User(
    val uid: String = "",
    val name: String = "",
    val photoUrl: String = "",
    val coverPhotoUrl: String = "",          // Hero/banner image on profile
    val bio: String = "",
    val gender: String = "",                 // "male", "female", "transgender" — set once at registration
    val age: Int = 0,
    val dob: Long = 0L,
    val city: String = "",                   // Stored as-is; UI labels it "Area"
    val country: String = "",               // Detected from GPS via Nominatim at profile setup

    // Contact / identity
    val email: String = "",
    val phoneNumber: String = "",
    val deviceId: String = "",

    // Interests (multi-select, stored as string lists)
    val hobbies: List<String> = emptyList(), // e.g. ["Travelling","Gaming","Singing"]
    val likes: List<String> = emptyList(),   // e.g. ["Friendship","Dating","Live Streaming"]
    val languages: List<UserLanguage> = emptyList(),

    // Media
    val mediaUrls: List<String> = emptyList(),    // gallery photos + videos (max 10 slots)
    val mediaThumbs: List<String> = emptyList(),  // parallel to mediaUrls; thumb JPEG URL for videos, "" for images

    // Social counts
    val totalLikesReceived: Long = 0,
    val totalLikesGiven: Long = 0,
    val totalGiftsReceived: Long = 0,
    val totalGiftsSent: Long = 0,

    // Economy
    val diamonds: Long = 0,
    val beans: Long = 0,
    val totalGemsSpent: Long = 0,            // drives user level
    val videoCards: Int = 0,                 // consumable free-call cards earned from daily rewards

    // Levels
    val level: Int = 0,                       // user spending level (0–25), backend-calculated
    val wealthLevel: Int = 0,

    // Host
    val isHost: Boolean = false,
    /** The agency this person works under AS A HOST. Never their own agency. */
    val agencyId: String = "",
    /**
     * The person's OWN Agency / Sub-agency, while they hold the Agency role.
     * Written server-side (`syncMyRoles`, `push_app_role_flags`). Kept apart
     * from [agencyId] so a Host who also runs a Sub-agency keeps both.
     */
    val ownAgencyId: String = "",
    val callRateBeans: Int = 375,
    val hostLevel: Int = 0,                  // 0–10, based on total beans earned from calls+gifts
    val hostCallEarnings: Long = 0,          // total beans from calls
    val hostGiftEarnings: Long = 0,          // total beans from gifts

    // Badges
    val isOfficial: Boolean = false,
    val isAgent: Boolean = false,
    val isSeller: Boolean = false,           // coin seller

    // The CRM role, stamped by `syncMyRoles` from `crmUsers/{uid}` — the same
    // document `resolveIdentity` reads, so the two always agree.
    //
    // Values: "superadmin" (what the CRM calls an OWNER), or one of the twelve
    // department roles — app / ops / finance / tech / support / marketing,
    // each as `_admin` or `_member` — or "" for everybody else.
    //
    // Agencies and coin sellers are NOT here. They are external, they are
    // flagged by `isAgent` / `isSeller`, and `syncMyRoles` leaves this empty
    // for them so a partner can never be rendered as staff.
    //
    // The old comment listed "admin" | "ops" | "tech" | "finance" | "support",
    // which was the vocabulary the CRM dropped when departments gained admin
    // and member tiers. Nothing writes those strings any more.
    val crmRole: String = "",

    // Real-time presence
    val isOnline: Boolean = false,
    val isInCall: Boolean = false,
    val isLive: Boolean = false,
    val isInParty: Boolean = false,
    val liveRoomId: String = "",
    val partyRoomId: String = "",
    val lastSeen: Long = System.currentTimeMillis(),

    // Streamed time (seconds)
    val streamedTimeSeconds: Long = 0,

    // Items / cosmetics
    // ── Equipped cosmetics ─────────────────────────────────────────────────
    //
    // One field per CRM bagItems category: frame, chat_bubble, profile_card,
    // id_frame, entrance. Three names disagreed before — the app wrote
    // `equippedChatStyle` and `equippedCover`, the expiry job cleared
    // `equippedChatBubble` and `equippedProfileCard`, and `equippedIdFrame` was
    // read by the bag screen but written by nothing. So an expiring chat bubble
    // stayed equipped forever, and equipping a profile card or an ID frame fell
    // through BagRepository's `else` branch and overwrote the avatar frame.
    val equippedFrame: String = "",
    val equippedChatBubble: String = "",
    val equippedProfileCard: String = "",
    val equippedIdFrame: String = "",
    val equippedEntrance: String = "",

    // Status
    val isProfileComplete: Boolean = false,
    /**
     * Host identity verification. Written ONLY by the verification functions —
     * it is what releases weekly payouts, so a client that could set it would
     * be approving its own withdrawals.
     *
     * Replaces `isFaceVerified` / `facePhotoUrl`, which every user carried
     * because the liveness check sat in the signup flow for everybody. Storing
     * a photograph of an ordinary user's face served no purpose the DPDP Act
     * would recognise, so the check is host-only and the URL lives in
     * `hostVerification/{uid}`, not on the public user document.
     */
    val isVerifiedHost: Boolean = false,
    val hasRecharged: Boolean = false,
    val referralCode: String = "",
    val fcmToken: String = "",

    // Moderation
    //
    // ── WHY THERE ARE THREE FIELDS HERE AND NOT ONE ────────────────────────
    //
    // `isBanned` is the app's single gate and means "this account cannot use
    // the product". It is true for a SUSPENSION as well as for a ban, and it
    // stays that way — every reader of it, in the rules, in the Cloud
    // Functions and on half a dozen screens here, would have to be widened to
    // understand two flags otherwise. Do not narrow its meaning.
    //
    // The other two say WHICH, and therefore what will let the person back in:
    // a suspension ends by itself (or when a reviewer lifts it) and leaves the
    // DEVICE alone, so the person may sign in with another eligible account on
    // the same phone; a ban bars the account and every device it was seen on.
    // The app showed one screen with one word for both, which is what these
    // fields exist to end. See [restrictionOf].
    val isBanned: Boolean = false,
    val banReason: String = "",
    /** One of [AccountStates]. Empty on a document written before it existed. */
    val accountState: String = "",
    /** True for a suspension ONLY. `isBanned` is true for both. */
    val isSuspended: Boolean = false,
    /**
     * When the suspension ends, in millis — or 0 when there is none.
     *
     * 0 means INDEFINITE, not "expired": the CRM omits the field entirely for a
     * suspension that runs until somebody lifts it by hand, and the screens
     * must say that rather than formatting a date out of a zero (1 January
     * 1970, presented to somebody as the day they get their account back).
     *
     * Read through [millis] like every other time on this document, because the
     * server writes it as a Firestore `Timestamp` and `getLong` on a Timestamp
     * THROWS rather than returning null — see util/FirestoreTime.kt.
     */
    val suspendedUntil: Long = 0L,
    val sessionToken: String = "",

    val createdAt: Long = System.currentTimeMillis(),

    // ── Preferences (saved per device via Firestore, applied on startup) ──────
    val theme: String = "system",       // "light" | "dark" | "system"
    val appLanguage: String = "en",     // ISO 639-1 code e.g. "en", "hi", "ar"

    // ── Weekly rankings (reset by Cloud Function every Sunday) ─────────────
    // For hosts: people who gifted them the most this week (most→least)
    val topSupporters: List<TopSupportEntry> = emptyList(),
    // For users: hosts they supported the most this week (most→least)
    val topHosts: List<TopSupportEntry> = emptyList(),

    // ── Daily check-in rewards ─────────────────────────────────────────────
    //
    // Server-owned. `claimDailyReward` writes both, and the day key is computed
    // in IST on the server rather than from a device clock — the old
    // "24 hours since lastDailyRewardTimestamp" check was satisfiable by
    // changing the phone's date.
    val dailyStreak: Int = 0,
    /** IST calendar day of the last claim, `yyyy-MM-dd`. Empty = never. */
    val lastDailyClaimDate: String = "",
) {
    companion object {
        private fun topEntry(m: Map<String, Any?>) = TopSupportEntry(
            uid = m["uid"] as? String ?: "",
            name = m["name"] as? String ?: "",
            photoUrl = m["photoUrl"] as? String ?: "",
            totalDiamonds = (m["totalDiamonds"] as? Number)?.toLong() ?: 0L,
            rank = (m["rank"] as? Number)?.toInt() ?: 0,
        )

        /**
         * Explicit parse instead of `toObject()`.
         *
         * `createdAt`, `lastSeen` and `dob` are written as Firestore Timestamps
         * by the server (and by registration), and `toObject` maps a Timestamp
         * onto a `Long` by throwing — which crashed the app on the first
         * snapshot of every user document after sign-in. Every time field goes
         * through [millis], which accepts either representation.
         */
        fun from(doc: com.google.firebase.firestore.DocumentSnapshot): User? {
            if (!doc.exists()) return null
            fun strings(field: String) = (doc.get(field) as? List<*>)?.mapNotNull { it as? String } ?: emptyList()
            @Suppress("UNCHECKED_CAST")
            fun maps(field: String) = (doc.get(field) as? List<*>)?.mapNotNull { it as? Map<String, Any?> } ?: emptyList()
            return User(
            uid = doc.getString("uid") ?: "",
            name = doc.getString("name") ?: "",
            photoUrl = doc.getString("photoUrl") ?: "",
            coverPhotoUrl = doc.getString("coverPhotoUrl") ?: "",
            bio = doc.getString("bio") ?: "",
            gender = doc.getString("gender") ?: "",
            age = (doc.getLong("age") ?: 0L).toInt(),
            dob = doc.millis("dob", 0L),
            city = doc.getString("city") ?: "",
            country = doc.getString("country") ?: "",
            email = doc.getString("email") ?: "",
            phoneNumber = doc.getString("phoneNumber") ?: "",
            deviceId = doc.getString("deviceId") ?: "",
            hobbies = strings("hobbies"),
            likes = strings("likes"),
            languages = maps("languages").map { UserLanguage(id = (it["id"] as? Number)?.toInt() ?: 0, code = it["code"] as? String ?: "", name = it["name"] as? String ?: "") },
            mediaUrls = strings("mediaUrls"),
            mediaThumbs = strings("mediaThumbs"),
            totalLikesReceived = doc.getLong("totalLikesReceived") ?: 0L,
            totalLikesGiven = doc.getLong("totalLikesGiven") ?: 0L,
            totalGiftsReceived = doc.getLong("totalGiftsReceived") ?: 0L,
            totalGiftsSent = doc.getLong("totalGiftsSent") ?: 0L,
            diamonds = doc.getLong("diamonds") ?: 0L,
            beans = doc.getLong("beans") ?: 0L,
            totalGemsSpent = doc.getLong("totalGemsSpent") ?: 0L,
            videoCards = (doc.getLong("videoCards") ?: 0L).toInt(),
            level = (doc.getLong("level") ?: 0L).toInt(),
            wealthLevel = (doc.getLong("wealthLevel") ?: 0L).toInt(),
            isHost = doc.getBoolean("isHost") ?: false,
            agencyId = doc.getString("agencyId") ?: "",
            ownAgencyId = doc.getString("ownAgencyId") ?: "",
            callRateBeans = (doc.getLong("callRateBeans") ?: 375L).toInt(),
            hostLevel = (doc.getLong("hostLevel") ?: 0L).toInt(),
            hostCallEarnings = doc.getLong("hostCallEarnings") ?: 0L,
            hostGiftEarnings = doc.getLong("hostGiftEarnings") ?: 0L,
            isOfficial = doc.getBoolean("isOfficial") ?: false,
            isAgent = doc.getBoolean("isAgent") ?: false,
            isSeller = doc.getBoolean("isSeller") ?: false,
            crmRole = doc.getString("crmRole") ?: "",
            isOnline = doc.getBoolean("isOnline") ?: false,
            isInCall = doc.getBoolean("isInCall") ?: false,
            isLive = doc.getBoolean("isLive") ?: false,
            isInParty = doc.getBoolean("isInParty") ?: false,
            liveRoomId = doc.getString("liveRoomId") ?: "",
            partyRoomId = doc.getString("partyRoomId") ?: "",
            lastSeen = doc.millis("lastSeen", 0L),
            streamedTimeSeconds = doc.getLong("streamedTimeSeconds") ?: 0L,
            equippedFrame = doc.getString("equippedFrame") ?: "",
            equippedChatBubble = doc.getString("equippedChatBubble") ?: "",
            equippedProfileCard = doc.getString("equippedProfileCard") ?: "",
            equippedIdFrame = doc.getString("equippedIdFrame") ?: "",
            equippedEntrance = doc.getString("equippedEntrance") ?: "",
            isProfileComplete = doc.getBoolean("isProfileComplete") ?: false,
            isVerifiedHost = doc.getBoolean("isVerifiedHost") ?: false,
            hasRecharged = doc.getBoolean("hasRecharged") ?: false,
            referralCode = doc.getString("referralCode") ?: "",
            fcmToken = doc.getString("fcmToken") ?: "",
            isBanned = doc.getBoolean("isBanned") ?: false,
            banReason = doc.getString("banReason") ?: "",
            accountState = doc.getString("accountState") ?: "",
            isSuspended = doc.getBoolean("isSuspended") ?: false,
            // `millis`, NOT `getLong`. The CRM writes this one as a Firestore
            // Timestamp, and `getLong` on a Timestamp raises rather than
            // returning null — which would take down the snapshot callback
            // this runs inside, on the document of every suspended user.
            suspendedUntil = doc.millis("suspendedUntil", 0L),
            sessionToken = doc.getString("sessionToken") ?: "",
            createdAt = doc.millis("createdAt", 0L),
            theme = doc.getString("theme") ?: "system",
            appLanguage = doc.getString("appLanguage") ?: "en",
            topSupporters = maps("topSupporters").map(::topEntry),
            topHosts = maps("topHosts").map(::topEntry),
            dailyStreak = (doc.getLong("dailyStreak") ?: 0L).toInt(),
            lastDailyClaimDate = doc.getString("lastDailyClaimDate") ?: "",
            ).let { if (it.uid.isBlank()) it.copy(uid = doc.id) else it }
        }
    }
}

/**
 * The five values `users/{uid}.accountState` can hold.
 *
 * **The strings are shared with three other runtimes** — `AccountState` in
 * `backend/app/services/users.py`, `STATE_*` in `functions/src/accounts.ts`,
 * and the CRM. None of them can import from another, so every copy is written
 * out by hand and every copy says so. If one changes they all must.
 */
object AccountStates {
    const val ACTIVE = "active"
    /** Restricted by a moderator, temporarily. The device is NOT barred. */
    const val SUSPENDED = "suspended"
    /** Restricted by a moderator, and every device the account used is barred. */
    const val BANNED = "banned"
    /** Deletion requested, inside the grace window. See RecoverAccountScreen. */
    const val RECOVERY_PENDING = "recovery_pending"
    /** Grace elapsed, the login released, the history kept. */
    const val PERMANENTLY_DEACTIVATED = "permanently_deactivated"
}

/**
 * Is this account suspended, banned, or neither.
 *
 * Deliberately NOT the deletion states: a deleted account is a different
 * question with a different screen (RecoverAccountScreen), and folding it in
 * here would have somebody who asked to leave shown an appeal form.
 */
enum class AccountRestriction { None, Suspended, Banned }

/**
 * Which restriction an account is under — the app's copy of `restriction_of`
 * in `backend/app/services/users.py`, and it must keep agreeing with it.
 *
 * ── WHY THIS IS A FUNCTION AND NOT `doc.getString("accountState")` ───────────
 *
 * Every account restricted before `accountState` carried a moderation value has
 * no moderation value on it — the field was added later, and nothing migrated
 * the documents that already existed. Those documents still answer correctly,
 * from the two fields they do have:
 *
 *   isSuspended = true  → a suspension, WHATEVER `isBanned` says. The CRM has
 *                         always set both (a suspension is a shut-out, so it
 *                         raises the gate as well), and a stray suspension left
 *                         with `isBanned` false is still a suspension.
 *   isBanned = true     → a ban.
 *
 * `accountState` is asked first, because it is the only one of the three that
 * can tell "banned" and "suspended" apart on its own. It is ignored when it
 * holds anything else — `active`, a deletion state, or a value from a newer
 * server than this build knows — and the booleans decide, rather than a
 * suspension being read as "no restriction" because the string was unfamiliar.
 *
 * Takes the snapshot rather than a [User] so the two callers that have only a
 * raw document — SplashScreen's cold-start check and SessionViewModel's live
 * listener — do not have to parse forty fields to ask one question.
 */
fun restrictionOf(doc: DocumentSnapshot): AccountRestriction {
    when (doc.getString("accountState")?.trim()) {
        AccountStates.SUSPENDED -> return AccountRestriction.Suspended
        AccountStates.BANNED -> return AccountRestriction.Banned
    }
    if (doc.getBoolean("isSuspended") == true) return AccountRestriction.Suspended
    if (doc.getBoolean("isBanned") == true) return AccountRestriction.Banned
    return AccountRestriction.None
}

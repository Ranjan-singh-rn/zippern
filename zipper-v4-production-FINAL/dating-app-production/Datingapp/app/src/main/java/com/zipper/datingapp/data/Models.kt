package com.zipper.datingapp.data

import androidx.annotation.Keep
import com.google.firebase.firestore.Exclude
import com.google.firebase.firestore.IgnoreExtraProperties
import com.google.firebase.firestore.PropertyName

// ─────────────────────────────────────────────────────────────────────────────
// ENUMS
// ─────────────────────────────────────────────────────────────────────────────

/** Registered gender — IMMUTABLE after first profile save. */
enum class Gender { MALE, FEMALE }

/** Platform role assigned at registration. */
enum class UserRole {
    USER,   // Regular user — joins via normal registration (no referral code)
    HOST,   // Host — comes via agency referral code; earns beans from gifts/calls
    GUEST,  // Guest — read-only limited access before registration
    /** Legacy alias for female-registered users (used in older ViewModel code). */
    GIRL,
    /** Legacy alias for male-registered users (used in older ViewModel code). */
    BOY
}

/** Face / identity verification state. */
@Keep
enum class VerificationStatus {
    NOT_SUBMITTED,
    PENDING,
    APPROVED,
    REJECTED
}

/** High-level 1:1 call UI state machine. */
enum class CallState {
    IDLE,
    DIALING,   // Outgoing — local ringback
    RINGING,   // Incoming — presented to callee
    CONNECTING,
    ACTIVE,
    ENDED
}

/** Agora-level WebRTC call quality signal. */
enum class CallStatus {
    NONE,
    CONNECTING,
    CONNECTED,
    RECONNECTING,
    DISCONNECTED
}

/** Party room join mode — who can take a seat without asking. */
enum class PartyRoomMode { FREE, CONSENT }

/** Battle / PK state. */
enum class BattleStatus {
    SEARCHING,
    MATCHED,
    ACTIVE,
    ENDED,
    CANCELLED,
    /** Alias: lobby open, waiting for a second player. */
    WAITING,
    /** Alias: match is currently live. */
    LIVE,
    /** Alias: match starts shortly. */
    STARTING_SOON,
    /** Alias: match is finished (results shown). */
    FINISHED,
}

/** Gift type — determines the economy split. */
enum class GiftType { REGULAR, LUCKY }

/** Transaction direction / category for ledger. */
enum class TransactionType {
    GIFT_SEND,
    GIFT_RECEIVE,
    CALL_CHARGE,
    CALL_EARN,
    RECHARGE,
    BEANS_CONVERT,
    GAME_BET,
    GAME_WIN,
    GAME_LOSS,
    PK_SUPPORT_SEND,
    PK_SUPPORT_RECEIVE
}

/** App language options. */
enum class AppLanguage(val label: String, val code: String) {
    ENGLISH("English", "en"),
    HINDI("हिन्दी", "hi"),
    GUJARATI("ગુજરાતી", "gu"),
    KONKANI("Konkani", "kok"),
    SPANISH("Español", "es"),
    FRENCH("Français", "fr")
}

/** Live stream content category tag. */
enum class LiveCategory(val label: String) {
    ALL("All"),
    SINGING("Singing"),
    DANCING("Dancing"),
    GAMING("Gaming"),
    TALKING("Talking"),
    MUSIC("Music"),
    COMEDY("Comedy"),
    FITNESS("Fitness"),
    ART("Art"),
    OTHER("Other")
}

// ─────────────────────────────────────────────────────────────────────────────
// USER PROFILE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Central user document stored in Firestore `users/{uid}`.
 *
 * Key invariants:
 * - [gender] is IMMUTABLE after the first profile save.
 * - [city] is always set to a city name (not neighbourhood/area).
 * - [role] is set at registration — USER if no referral, HOST if valid referral.
 * - [diamondBalance] / [beanBalance] are kept in sync by Cloud Functions to prevent
 *   client-side cheating. UI reads them from here; writes go through Functions.
 */
@Keep
@IgnoreExtraProperties
data class UserProfile(
    val id: String = "",
    val name: String = "",

    /** Immutable after first save. Stored as "MALE" or "FEMALE". */
    val gender: String = "",

    val age: Int = 0,
    val dateOfBirth: Long? = null,

    /** Role assigned at registration: "USER" | "HOST" | "GUEST". */
    val role: String = UserRole.USER.name,

    // ── Contact / Location ────────────────────────────────────────────────
    val mobile: String = "",
    val email: String = "",

    /** City-level location (NOT area/neighbourhood). From Geocoder.locality. */
    val city: String = "",
    val country: String = "",
    val region: String = "",
    val latitude: Double = 0.0,
    val longitude: Double = 0.0,

    // ── Profile Media ─────────────────────────────────────────────────────
    val photoUrl: String = "",
    /** Primary gallery (formerly galleryUrls — both field names kept for Firestore compat). */
    val galleryUrls: List<String> = emptyList(),
    /** Alias for [galleryUrls] used in newer screen code. */
    val galleryPhotos: List<String> = emptyList(),
    val bio: String = "",

    // ── Discovery Tags ────────────────────────────────────────────────────
    val hobbies: List<String> = emptyList(),
    val likes: List<String> = emptyList(),
    val dislikes: List<String> = emptyList(),
    val languages: List<String> = emptyList(),
    /** User interests (hobbies alias for newer UI code). */
    val interests: List<String> = emptyList(),

    // ── Verification ──────────────────────────────────────────────────────
    val isFaceVerified: Boolean = false,
    val faceVerificationStatus: String = VerificationStatus.NOT_SUBMITTED.name,
    /** URL of the selfie submitted for face verification. */
    val faceVerificationImageUrl: String? = null,

    /** Call verification = face verified AND gender matches ML model result. */
    val isCallVerificationApproved: Boolean = false,

    /** Blue tick shown on profile card / live. */
    val hasBlueTick: Boolean = false,

    // ── Agency (Host only) ────────────────────────────────────────────────
    /** Referral code used at registration — null for regular users. */
    val referralCode: String? = null,
    val agencyId: String? = null,
    val agencyName: String? = null,

    // ── Economy Balances (read from Firestore; writes via Cloud Functions) ──
    // NOTE: diamondBalance and beanBalance are excluded from constructor deserialization.
    // Some Firestore documents store these as NaN (a floating-point value from server-side JS),
    // which causes CustomClassMapper to throw "Numeric value out of 64-bit long range: NaN"
    // when deserializing into Long. Moved to class body with @get:Exclude so Firestore skips
    // deserialization entirely. Raw map writes (Cloud Functions) still work fine.
    // See: beanBalance below as well.
    /** Spendable bean balance as Int (synced from beanBalance). */
    val beans: Int = 0,
    /** Total diamonds earned (host payouts, games). */
    val diamondsEarned: Long = 0L,
    /** Total diamonds spent specifically on gifts (subset of totalDiamondsSpent). */
    val giftDiamondsSpentTotal: Long = 0L,
    /** Total INR earnings (for host payout display). */
    val earnings: Double = 0.0,
    /** Legacy int alias for diamond balance (used in older gift screens). */
    val gems: Int = 0,

    // ── Level & Progression ────────────────────────────────────────────────
    /**
     * Host level: 0–10, calculated from [totalBeansEarned].
     * User level: 0–25, calculated from [totalDiamondsSpent].
     */
    val level: Int = 0,

    /**
     * Display-facing profile level shown in UI (may differ from [level] for legacy reasons).
     * Falls back to [level] if not explicitly set.
     */
    val displayProfileLevel: Int = 0,

    /** Cumulative beans earned — used for host level calculation. */
    val totalBeansEarned: Long = 0L,

    /** Cumulative diamonds spent — used for user level calculation. */
    val totalDiamondsSpent: Long = 0L,

    // ── Streaming Stats ────────────────────────────────────────────────────
    /** Total minutes this user has hosted a live stream (Firestore `streamingMinutesTotal`). */
    val totalLiveMinutes: Int = 0,
    /** Alias for [totalLiveMinutes] used in newer analytics code. */
    val totalStreamingMinutes: Int = 0,

    // ── Visual Perks (unlocked by level) ─────────────────────────────────
    val profileFrameId: String? = null,
    val profileRingId: String? = null,
    val entryEffectId: String? = null,

    // ── Call Rates (Host only — beans per minute) ─────────────────────────
    /**
     * How many beans/min the host wants to earn on audio calls.
     * System converts to diamond cost shown to caller based on gender ratio.
     */
    val audioCallRateBeansPerMin: Int = 200,

    /**
     * How many beans/min the host wants to earn on video calls.
     */
    val videoCallRateBeansPerMin: Int = 500,

    // ── Presence ──────────────────────────────────────────────────────────
    val isOnline: Boolean = false,
    val isLive: Boolean = false,
    val isInPartyRoom: Boolean = false,
    val lastSeen: Long = 0L,
    /** Firestore doc ID of the host's active live stream (null when not live). */
    val liveRoomId: String? = null,
    /** True when the host's live stream is audio-only (no camera). */
    val liveStreamAudioOnly: Boolean = false,

    // ── Social ────────────────────────────────────────────────────────────
    val followers: Long = 0L,
    val following: Long = 0L,
    val likeMeCount: Long = 0L,
    /** List of UIDs who follow this user (subset maintained client-side). */
    val followerIds: List<String> = emptyList(),
    /** List of UIDs this user follows (maintained client-side for fast lookup). */
    val followingIds: List<String> = emptyList(),
    /** List of UIDs this user has blocked (maintained client-side). */
    val blockedUserIds: List<String> = emptyList(),

    // ── Misc ──────────────────────────────────────────────────────────────
    val isGuest: Boolean = false,
    /** Android device ID stored on guest accounts for auto-login on re-open / reinstall. */
    val deviceId: String = "",
    /** True once a guest user has bound a phone number or email to their account. */
    val isBound: Boolean = false,
    val profileNumber: String = "",    // 5-digit display ID
    val isVerified: Boolean = false,   // Legacy compat alias for hasBlueTick
    val customAudioPrice: Int? = null,   // Legacy compat — nullable so Elvis works at call sites
    val customVideoPrice: Int? = null,   // Legacy compat — nullable so Elvis works at call sites
    val createdAt: Long = 0L,

    // ── Spendable balance fields (client-side; synced from diamondBalance / beanBalance) ──
    /** Spendable coin (diamond) balance — kept in sync with [diamondBalance]. */
    val coins: Int = 0,
    /** Alias for [coins] — kept in sync with every spend/earn operation. */
    val walletBalance: Int = 0,

    // ── Social arrays ─────────────────────────────────────────────────────────
    /** Firebase UIDs of users who have liked this profile (Firestore `likedByUserIds` array). */
    val likedByUserIds: List<String> = emptyList(),

    // ── Streaking ─────────────────────────────────────────────────────────────
    /** Number of consecutive days this host has gone live (Firestore `liveDaysStreak`). */
    val liveDaysStreak: Int = 0,

    // ── Verification & Badges ─────────────────────────────────────────────────
    /** True when the host has uploaded an intro video. */
    val hasIntroVideo: Boolean = false,
    /** Video verification state: "NONE" | "PENDING" | "APPROVED" | "REJECTED". */
    val videoVerificationStatus: String = "NONE",
    /** True when both face and video verification are approved. */
    val isFullyVerified: Boolean = false,
    /** Star badge unlocked after full verification. */
    val hasStarBadge: Boolean = false,

    // ── Live Stream Flags (host-only) ─────────────────────────────────────────
    /** When true, the next [toggleLive] call should reset the stream session start time. */
    val resetStreamSessionStart: Boolean = false,
    /** True when the host's current live stream is audio-only (mic broadcast, no camera). */
    val audioOnlyStream: Boolean = false,
    /** Stage seat capacity for audio-party streams (6, 10, 14, or 17). */
    val audioPartySeatCount: Int = 10,
) {
    // Moved out of the primary constructor so Firestore's BeanMapper uses setter-based
    // deserialization for this field, making @get:Exclude actually take effect.
    // Some Firestore documents store updatedAt as a server Timestamp, others as epoch-millis
    // Long — excluding it prevents the "Failed to convert Timestamp to long" crash in
    // observeProfiles. Raw map writes (mapOf("updatedAt" to millis)) still work fine.
    @get:Exclude var updatedAt: Long = 0L

    // Excluded from constructor deserialization — some Firestore documents store these as
    // NaN (a floating-point special value written by server-side JS), which causes
    // CustomClassMapper to throw "Numeric value out of 64-bit long range: NaN" when
    // deserializing into Long. Cloud Functions write these via raw map updates, which bypass
    // this class entirely, so exclusion here does not affect balance updates.
    @get:Exclude var diamondBalance: Long = 0L
    @get:Exclude var beanBalance: Long = 0L

    @Exclude
    fun toRole(): UserRole = when (role.uppercase()) {
        "HOST" -> UserRole.HOST
        "GUEST" -> UserRole.GUEST
        "GIRL" -> UserRole.GIRL
        "BOY" -> UserRole.BOY
        else -> UserRole.USER
    }

    @Exclude
    fun toGender(): Gender? = when (gender.uppercase()) {
        "MALE" -> Gender.MALE
        "FEMALE" -> Gender.FEMALE
        else -> null
    }

    /** Human-readable gender string ("male" / "female" / raw). */
    @get:Exclude
    val genderText: String get() = gender.lowercase().ifBlank { "—" }

    /** Calculated age from [dateOfBirth]; falls back to [age] if no DOB stored. */
    @get:Exclude
    val currentAge: Int get() {
        if (dateOfBirth == null || dateOfBirth <= 0L) return age
        val dob = java.util.Calendar.getInstance().apply { timeInMillis = dateOfBirth }
        val now = java.util.Calendar.getInstance()
        var years = now.get(java.util.Calendar.YEAR) - dob.get(java.util.Calendar.YEAR)
        if (now.get(java.util.Calendar.DAY_OF_YEAR) < dob.get(java.util.Calendar.DAY_OF_YEAR)) years--
        return maxOf(0, years)
    }

    @Exclude
    fun isHost(): Boolean = role.uppercase() == "HOST"

    /** Effective level for leaderboard sorting — host level when hosting, user level otherwise. */
    @get:Exclude
    val currentLevel: Int get() = if (isHost()) level else level

    @Exclude
    fun isUser(): Boolean = role.uppercase() == "USER"

    @Exclude
    fun displayCallRate(isVideo: Boolean, callerGender: String): Int {
        val rate = if (isVideo) videoCallRateBeansPerMin else audioCallRateBeansPerMin
        return com.zipper.datingapp.economy.VirtualEconomyMath
            .diamondCostPerMinuteForCaller(rate, callerGender, gender)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// LIVE STREAM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Active live stream document — `live_streams/{streamId}`.
 * Created when host goes live; deleted (or isActive=false) when they end.
 */
@Keep
@IgnoreExtraProperties
data class LiveStream(
    val id: String = "",
    val hostId: String = "",
    val hostName: String = "",
    val hostPhotoUrl: String = "",
    val hostGender: String = "",
    val hostLevel: Int = 0,
    val hostRingId: String? = null,
    val title: String = "",
    val category: String = LiveCategory.OTHER.name,
    val isActive: Boolean = false,
    val isAudioOnly: Boolean = false,
    val agoraChannelId: String = "",
    val agoraToken: String = "",      // Short-lived; refreshed by Function
    val startedAt: Long = 0L,
    val viewerCount: Int = 0,
    val viewerIds: List<String> = emptyList(),
    val likeCount: Long = 0L,
    val totalDiamondsReceived: Long = 0L,
    val isPkActive: Boolean = false,
    val pkPartnerId: String? = null,
    val pkBattleId: String? = null,
    val thumbnailUrl: String? = null,
    // Discovery filters
    val city: String = "",
    val country: String = "",
    val language: String = "",
    val hobbies: List<String> = emptyList(),
)

// ─────────────────────────────────────────────────────────────────────────────
// PARTY ROOM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Single seat in a party room. `null` means the seat is empty.
 */
@Keep
@IgnoreExtraProperties
data class PartySeat(
    val userId: String = "",
    val userName: String = "",
    val userPhotoUrl: String = "",
    val userLevel: Int = 0,
    val userRingId: String? = null,
    val isMuted: Boolean = false,
    val isLocked: Boolean = false,   // No one can take this seat
    val isReserved: Boolean = false, // Held for a specific user
    val reservedForUserId: String? = null,
)

/**
 * Pending seat request in CONSENT mode party rooms.
 */
@Keep
@IgnoreExtraProperties
data class SeatRequest(
    val userId: String = "",
    val userName: String = "",
    val userPhotoUrl: String = "",
    val userLevel: Int = 0,
    val requestedAt: Long = 0L,
    val targetSeatNumber: Int = -1,   // -1 = any available seat
)

/**
 * Active party room — `party_rooms/{roomId}`.
 */
@Keep
@IgnoreExtraProperties
data class PartyRoom(
    val id: String = "",
    val ownerId: String = "",
    val ownerName: String = "",
    val ownerPhotoUrl: String = "",
    val ownerLevel: Int = 0,
    val title: String = "",
    val backgroundId: String = "bg_default",
    val maxSeats: Int = 10,              // 10, 12, or 15
    val mode: String = PartyRoomMode.FREE.name,
    val isActive: Boolean = false,
    val agoraChannelId: String = "",
    val agoraToken: String = "",
    val createdAt: Long = 0L,
    /** Seat number (1-indexed) to PartySeat (or null if empty). Stored as Map in Firestore. */
    val seats: Map<String, PartySeat?> = emptyMap(),
    val pendingRequests: List<SeatRequest> = emptyList(),
    val adminIds: List<String> = emptyList(),
    val kickedUserIds: List<String> = emptyList(),
    val participantCount: Int = 0,
    val totalDiamondsReceived: Long = 0L,
    // Discovery filters
    val city: String = "",
    val language: String = "",
    val hobbies: List<String> = emptyList(),
)

// ─────────────────────────────────────────────────────────────────────────────
// GIFT CATALOG
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gift definition from Firestore `gifts/{giftId}`.
 * Economy splits are determined by [giftType].
 *
 * REGULAR gift: 50% beans to recipient, 50% to company.
 * LUCKY gift:   5% beans to recipient, 95% to company.
 */
@Keep
@IgnoreExtraProperties
data class Gift(
    val id: String = "",
    val name: String = "",
    val category: String = "",
    val giftType: String = GiftType.REGULAR.name,  // "REGULAR" | "LUCKY"
    /** Diamond cost to send this gift. Stored as `price` in Firestore for legacy compat. */
    val price: Int = 0,
    val lottieUrl: String? = null,
    val videoUrl: String? = null,
    val thumbnailUrl: String = "",
    val soundUrl: String? = null,
    val sortOrder: Int = 0,
    val isActive: Boolean = true,
    /** Convenience alias — always equals [price]. */
    val diamondCost: Int = 0,
    /** Extra fields used by CRM premium gifts. */
    val isCrmGift: Boolean = false,
    val crmDocId: String = "",
    val displayDurationSeconds: Int = 0,
    val points: Int = 0,
    @get:Exclude val iconRes: Int = 0,
) {
    @Exclude
    fun isLucky(): Boolean = giftType.uppercase() == GiftType.LUCKY.name

    /** Effective diamond price — prefers [price] over [diamondCost] for legacy data. */
    @Exclude
    fun effectivePrice(): Int = if (price > 0) price else diamondCost
}

/**
 * Gift visual state for the overlay animation — ephemeral, not stored in Firestore.
 */
data class GiftVisualEvent(
    val gift: Gift,
    val senderName: String,
    val senderPhotoUrl: String,
    val quantity: Int = 1,
    val nonce: Long = System.currentTimeMillis(),  // Deduplication key
)

// ─────────────────────────────────────────────────────────────────────────────
// CALL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Active or historical call document — `calls/{callId}`.
 */
@Keep
@IgnoreExtraProperties
data class CallSession(
    val id: String = "",
    val callerId: String = "",
    val calleeId: String = "",
    val callerGender: String = "",
    val calleeGender: String = "",
    val callerRole: String = UserRole.USER.name,   // "HOST" | "USER"
    val calleeRole: String = UserRole.USER.name,
    val callerName: String = "",
    val calleeName: String = "",
    val callerPhotoUrl: String = "",
    val calleePhotoUrl: String = "",
    val isVideoCall: Boolean = true,
    val status: String = "PENDING",  // PENDING|ACTIVE|ENDED|DECLINED|MISSED
    val agoraChannelId: String = "",
    val agoraToken: String = "",
    val startedAt: Long = 0L,
    val endedAt: Long = 0L,
    val durationSeconds: Int = 0,
    val diamondRatePerMin: Int = 0,   // Diamonds charged to caller per minute
    val beanRatePerMin: Int = 0,      // Beans earned by callee per minute
    val totalDiamondsCharged: Int = 0,
    val totalBeansAwarded: Int = 0,
)

/** Incoming call notification payload — held in UI state only. */
data class IncomingCall(
    val callId: String,
    val roomId: String,
    val callerId: String,
    val callerName: String,
    val callerPhotoUrl: String,
    val isVideoCall: Boolean,
)

/** Call history entry for display in CallHistoryScreen. */
@Keep
@IgnoreExtraProperties
data class CallHistoryEntry(
    val id: String = "",
    val partnerId: String = "",
    val partnerName: String = "",
    val partnerPhotoUrl: String = "",
    val isVideoCall: Boolean = true,
    val wasOutgoing: Boolean = true,
    val durationSeconds: Int = 0,
    val diamondsSpent: Int = 0,
    val beansEarned: Int = 0,
    val timestamp: Long = 0L,
    val status: String = "ENDED",
)

// ─────────────────────────────────────────────────────────────────────────────
// PK BATTLE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PK battle session — `battles/{battleId}`.
 * Created when two live hosts accept a PK challenge.
 */
@Keep
@IgnoreExtraProperties
data class PkBattleSession(
    val id: String = "",
    val hostUserId: String = "",
    val guestUserId: String = "",
    val hostUserName: String = "",
    val guestUserName: String = "",
    val hostUserPhotoUrl: String = "",
    val guestUserPhotoUrl: String = "",
    val hostLiveStreamId: String = "",
    val guestLiveStreamId: String = "",
    val hostAgoraChannelId: String = "",
    val guestAgoraChannelId: String = "",
    val status: String = BattleStatus.SEARCHING.name,
    val durationSeconds: Int = 180,           // 3 minutes default
    val pkStartTimeMillis: Long = 0L,
    val endsAtMillis: Long = 0L,
    val hostDiamondSupport: Long = 0L,
    val guestDiamondSupport: Long = 0L,
    val winnerId: String? = null,
    val createdAt: Long = 0L,
)

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGES / CHAT
// ─────────────────────────────────────────────────────────────────────────────

@Keep
@IgnoreExtraProperties
data class ChatMessage(
    val id: String = "",
    val senderId: String = "",
    val senderName: String = "",
    val senderPhotoUrl: String = "",
    /** Recipient uid — used by DM send path and inbox aggregation. */
    val receiverId: String = "",
    val text: String = "",
    val imageUrl: String? = null,
    /** URL of an image attachment in a gift or photo message. */
    val giftImageUrl: String? = null,
    val giftId: String? = null,
    val type: String = "TEXT",   // TEXT | IMAGE | GIFT | CALL
    val timestamp: Long = 0L,
    val isRead: Boolean = false,
)

@Keep
@IgnoreExtraProperties
data class ChatThread(
    val id: String = "",                 // "${uid1}_${uid2}" sorted
    val participants: List<String> = emptyList(),
    val participantNames: Map<String, String> = emptyMap(),
    val participantPhotos: Map<String, String> = emptyMap(),
    val lastMessage: String = "",
    val lastMessageAt: Long = 0L,
    val lastSenderId: String = "",
    val unreadCounts: Map<String, Int> = emptyMap(),
    val createdAt: Long = 0L,
)

/** Live stream / party room real-time chat message — ephemeral. */
@Keep
@IgnoreExtraProperties
data class LiveChatMessage(
    val id: String = "",
    val senderId: String = "",
    val senderName: String = "",
    val senderPhotoUrl: String = "",
    val senderLevel: Int = 0,
    val senderRingId: String? = null,
    val text: String = "",
    val type: String = "TEXT",    // TEXT | GIFT | JOIN | SYSTEM
    val giftId: String? = null,
    val timestamp: Long = System.currentTimeMillis(),
)

/** Returns true when this is a system/join notification rather than a user chat message. */
fun LiveChatMessage.isLiveSystemMessage(): Boolean = type.equals("SYSTEM", ignoreCase = true) || type.equals("JOIN", ignoreCase = true)

/** Stable key for LazyColumn that combines the profile's UID with its list position. */
fun UserProfile.composeLazyKey(index: Int): String = "$id:$index"

// ─────────────────────────────────────────────────────────────────────────────
// TRANSACTIONS / ECONOMY LEDGER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Economy ledger entry — `transactions/{txId}`.
 * Every diamond spend and bean earn creates one entry.
 */
@Keep
@IgnoreExtraProperties
data class Transaction(
    val id: String = "",
    val userId: String = "",
    val type: String = "",
    val diamonds: Long = 0L,   // Negative = spent, positive = received
    val beans: Long = 0L,      // Negative = spent, positive = received
    val refId: String? = null, // callId / giftId / battleId / gameId
    val counterpartId: String? = null,
    val counterpartName: String? = null,
    val note: String = "",
    val timestamp: Long = 0L,
)

// ─────────────────────────────────────────────────────────────────────────────
// AGENCY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Agency document — `agencies/{agencyId}`.
 * Agencies recruit hosts and earn a commission from host bean earnings.
 */
@Keep
@IgnoreExtraProperties
data class Agency(
    val id: String = "",
    val name: String = "",
    val ownerName: String = "",
    val contactPhone: String = "",
    val referralCode: String = "",  // Unique code hosts use at registration
    val hostIds: List<String> = emptyList(),
    val totalBeansUnderAgency: Long = 0L,
    val totalPayoutOwed: Long = 0L,   // In Rs (beans / 100)
    val totalPayoutPaid: Long = 0L,
    val isActive: Boolean = true,
    val createdAt: Long = 0L,
)

// ─────────────────────────────────────────────────────────────────────────────
// LEVEL CONFIG
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Host level thresholds — cumulative beans required.
 * Stored in Firestore `levels_config/host_levels`.
 */
data class HostLevelConfig(
    val thresholds: List<Long> = listOf(
        0L,              // Level 0 → default
        100_000L,        // Level 1
        200_000L,        // Level 2
        600_000L,        // Level 3
        2_400_000L,      // Level 4
        12_000_000L,     // Level 5
        72_000_000L,     // Level 6
        504_000_000L,    // Level 7
        4_032_000_000L,  // Level 8
        36_288_000_000L, // Level 9
        362_880_000_000L // Level 10
    ),
    /** Min/max bean rate per minute that hosts can set at each level. */
    val callRateRanges: List<Pair<Int, Int>> = listOf(
        100 to 500,     // Level 0
        100 to 1_000,   // Level 1
        100 to 2_000,   // Level 2
        100 to 5_000,   // Level 3
        100 to 10_000,  // Level 4
        100 to 20_000,  // Level 5
        100 to 30_000,  // Level 6
        100 to 50_000,  // Level 7
        100 to 75_000,  // Level 8
        100 to 100_000, // Level 9
        100 to 150_000  // Level 10
    )
)

/**
 * User level thresholds — cumulative diamonds spent.
 * Stored in Firestore `levels_config/user_levels`.
 * Same factorial pattern, max level 25.
 */
data class UserLevelConfig(
    val thresholds: List<Long> = buildUserThresholds(),
)

private fun buildUserThresholds(): List<Long> {
    val t = mutableListOf<Long>()
    t.add(0L)               // Level 0
    t.add(100_000L)         // Level 1
    var prev = 100_000L
    var multiplier = 2
    for (i in 2..25) {
        val next = prev * multiplier
        t.add(next)
        prev = next
        if (multiplier < 10) multiplier++
    }
    return t
}

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE VISUAL ASSETS
// ─────────────────────────────────────────────────────────────────────────────

/** Profile frame / border shown on the avatar card. */
@Keep
@IgnoreExtraProperties
data class ProfileFrame(
    val id: String = "",
    val name: String = "",
    val imageUrl: String = "",
    val minLevel: Int = 0,
    val isPremium: Boolean = false,
    val animatedUrl: String? = null,
)

/** Ring shown around avatar in live / party. */
@Keep
@IgnoreExtraProperties
data class ProfileRing(
    val id: String = "",
    val name: String = "",
    val imageUrl: String = "",
    val animatedUrl: String? = null,
    val minLevel: Int = 0,
    val color: String = "#FF2D78",
)

/** Entry effect animation when joining live / party. */
@Keep
@IgnoreExtraProperties
data class EntryEffect(
    val id: String = "",
    val name: String = "",
    val lottieUrl: String = "",
    val thumbnailUrl: String = "",
    val minLevel: Int = 0,
)

// ─────────────────────────────────────────────────────────────────────────────
// CRM / ANNOUNCEMENTS
// ─────────────────────────────────────────────────────────────────────────────

/** CRM broadcast shown under Messages → Announcements tab. */
@Keep
@IgnoreExtraProperties
data class CrmAnnouncement(
    val id: String = "",
    val title: String = "",
    val body: String = "",
    val createdAtMs: Long = 0L,
    val imageUrl: String? = null,
    val deepLink: String? = null,
)

// ─────────────────────────────────────────────────────────────────────────────
// LUCKY GIFTS
// ─────────────────────────────────────────────────────────────────────────────

/** Result of a lucky gift spin — shown in jackpot celebration dialog. */
data class LuckyGiftResult(
    val giftId: String,
    val giftName: String,
    val giftThumbnail: String,
    val diamondWon: Int,
    val isJackpot: Boolean,
    val transactionId: String,
)

// ─────────────────────────────────────────────────────────────────────────────
// DIAMOND SHOP
// ─────────────────────────────────────────────────────────────────────────────

/** Diamond recharge package offered in the shop. */
data class DiamondPackage(
    val id: String,
    val diamonds: Long,
    val priceRs: Int,
    val bonusDiamonds: Long = 0L,
    val label: String = "",
    val isBestValue: Boolean = false,
    val isPopular: Boolean = false,
) {
    /** Total diamonds including bonus (base + bonus). */
    val totalDiamonds: Long get() = diamonds + bonusDiamonds
    /** Alias for [bonusDiamonds] used in older DiamondPackageCard. */
    val bonus: Long get() = bonusDiamonds
    /** Alias for [priceRs] — INR price as Int. */
    val priceInr: Int get() = priceRs
    /** Alias for [diamonds] — base coin/diamond count before bonus. */
    val coins: Long get() = diamonds
}

// ─────────────────────────────────────────────────────────────────────────────
// GAMES
// ─────────────────────────────────────────────────────────────────────────────

enum class GameType(val label: String, val icon: String = "🎮", val iconRes: Int = 0) {
    AVIATOR("Aviator", "✈️"),
    FISHING("Fishing", "🐟"),
    TEEN_PATTI("Teen Patti", "🃏"),
    SLOTS("Slots", "🎰"),
    /** Live head-to-head PK battle (no game content, score tracked via gifts). */
    LIVE_PK("Live PK", "⚡"),
    QUIZ("Quiz", "🧠"),
    SPIN("Spin Wheel", "🎡"),
    MYSTERY("Mystery Box", "🎁"),
}

data class GameDefinition(
    val type: GameType,
    val title: String,
    val description: String,
    val thumbnailUrl: String = "",
    val webUrl: String,      // URL to load in WebView
    val minBetDiamonds: Int = 10,
    val maxBetDiamonds: Int = 10_000,
    val houseEdgePercent: Double = 5.0,
)

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS / DEEP LINKS
// ─────────────────────────────────────────────────────────────────────────────

/** Parsed deep-link actions from FCM notification tap. */
sealed class DeepLinkAction {
    data class OpenIncomingCall(val callId: String, val callerId: String, val roomId: String, val isVideo: Boolean) : DeepLinkAction()
    data class OpenMessages(val senderId: String) : DeepLinkAction()
    data class OpenLive(val hostId: String, val streamId: String) : DeepLinkAction()
    data class OpenPartyRoom(val roomId: String) : DeepLinkAction()
    data class OpenProfile(val userId: String) : DeepLinkAction()
    object OpenAudioPartyLobby : DeepLinkAction()
    data class DeclineCall(val roomId: String, val callerId: String) : DeepLinkAction()
}

// ─────────────────────────────────────────────────────────────────────────────
// UI STATE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Represents which tab is active in the home navigation.
 * 0=Home, 1=Live, 2=Chats, 3=Games, 4=Profile
 */
object NavTab {
    const val HOME = 0
    const val LIVE = 1
    const val CHATS = 2
    const val GAMES = 3
    const val PROFILE = 4
}

/** Sub-tab within the Live tab. */
enum class LiveSubTab { LIVE_STREAMS, PARTY_ROOMS }

// ─────────────────────────────────────────────────────────────────────────────
// GIFT HISTORY
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// TYPE ALIASES
// ─────────────────────────────────────────────────────────────────────────────

/** Alias for [DiamondPackage] used in shop UI screens. */
typealias CoinPackage = DiamondPackage

/** Alias for [ChatMessage] used in older ViewModel state maps. */
typealias Message = ChatMessage

// ─────────────────────────────────────────────────────────────────────────────
// LIVE STREAM EXTENDED TYPES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rich chat message for live streams — distinct from [LiveChatMessage] with additional
 * fields for gift overlay, PK scoring, and lucky gift support.
 */
@Keep
@IgnoreExtraProperties
data class LiveStreamChatMessage(
    val id: String = "",
    val senderId: String = "",
    val senderName: String = "",
    val senderPhotoUrl: String = "",
    val senderLevel: Int = 0,
    val type: String = "text",          // "text" | "gift" | "join" | "system"
    val text: String = "",
    val giftId: String = "",
    val giftImageUrl: String? = null,
    val giftVideoUrl: String? = null,
    val giftSoundUrl: String? = null,
    val giftDisplayDurationSeconds: Int = 0,
    val giftName: String = "",
    val giftCount: Int = 1,
    val timestamp: Long = 0L,
    val giftRecipientId: String = "",
    val giftReceiverBeansEarned: Long = 0L,
)

/** Returns true when this is a system/join notification rather than a user chat message. */
fun LiveStreamChatMessage.isLiveSystemMessage(): Boolean = type.equals("system", ignoreCase = true) || type.equals("join", ignoreCase = true)

/**
 * Snapshot of a live stream room document used for viewer counts, kick enforcement,
 * and PK scoring — returned by [com.zipper.datingapp.service.FirebaseService.observeLiveStreamRoom].
 */
data class LiveStreamRoomInfo(
    val viewerCount: Int = 0,
    val kickedUsers: Set<String> = emptySet(),
    val pkScoringOpen: Boolean = true,
    val pkHostViewerCount: Int = 0,
    val pkGuestViewerCount: Int = 0,
    val pkHostViewerUserIds: List<String> = emptyList(),
    val pkGuestViewerUserIds: List<String> = emptyList(),
    val pkResultPhaseEndsAtMillis: Long = 0L,
    val pkHostBeans: Long = 0L,
    val pkGuestBeans: Long = 0L,
    val pkBattleGuestUid: String = "",
    val pkGuestUserId: String = "",
    val pkStartedAtMillis: Long = 0L,
    val streamActive: Boolean = true,
    val hostPrivateCallBusy: Boolean = false,
    val audioPartyHandoffToUid: String = "",
    /** Uid of the host battler (mirrors `live_streams/{host}.hostId`) for PK audience perspective. */
    val pkBattleHostUid: String = "",
    /** Epoch millis when the stream (or PK round) started — for duration display. */
    val streamStartedAtMillis: Long = 0L,
    /** True when the stream is audio-only (mic broadcast, no camera). */
    val audioOnlyStream: Boolean = false,
    /** Seat capacity when [audioOnlyStream] is true (6 / 10 / 14 / 17). */
    val audioPartySeatCount: Int = 10,
    /** Display name of the PK guest battler (from `live_streams/{host}.pkGuestDisplayName`). */
    val pkGuestDisplayName: String = "",
    /** Battle duration in seconds (from `live_streams/{host}.pkDurationSeconds`). */
    val pkDurationSeconds: Int = 300,
    /** Display name of the PK host battler (from `live_streams/{host}.hostDisplayName`). */
    val pkHostDisplayName: String = "",
)

// ─────────────────────────────────────────────────────────────────────────────
// PK BATTLE SESSION STATE (client-side, not the Firestore PkBattleSession)
// ─────────────────────────────────────────────────────────────────────────────

/** Phase of a PK battle from the local perspective. */
enum class PkBattlePhase { ACTIVE, RESULT, FINISHED }

/** Outcome of a PK battle from the local perspective. */
enum class PkBattleOutcome { VICTORY, DEFEAT, DRAW,
    /** Aliases used by audience-watching path in older code. */
    HOST_WINS, GUEST_WINS }

/**
 * Local (non-Firestore) state machine for a PK battle session in [LiveStreamActivity].
 */
data class PkBattleSessionState(
    val pkStartTimeMillis: Long = 0L,
    val hostUserId: String = "",
    val guestUserId: String = "",
    val durationSeconds: Int = 300,
    val phase: PkBattlePhase = PkBattlePhase.ACTIVE,
    val battleEnded: Boolean = false,
    val outcome: PkBattleOutcome? = null,
    val resultPhaseEndsAtMillis: Long = 0L,
    val hostBeansEarned: Long = 0L,
    val guestBeansEarned: Long = 0L,
    /** Frozen tug-of-war ratio (0..1) captured at battle end. */
    val frozenTugRatio: Float = 0.5f,
)

/** How long the post-battle result overlay lingers before auto-dismissal (ms). */
const val PK_POST_RESULT_LINGER_MS: Long = 8_000L

// ─────────────────────────────────────────────────────────────────────────────
// LUCKY GIFTS OUTCOME
// ─────────────────────────────────────────────────────────────────────────────

/** Result returned from the Cloud Function `processLuckyGifts`. */
sealed class LuckyGiftsOutcome {
    data class Success(val diamondsWon: Int, val transactionId: String?) : LuckyGiftsOutcome()
    data class Failure(val reason: String) : LuckyGiftsOutcome()
}

// ─────────────────────────────────────────────────────────────────────────────
// EXTENSION FUNCTIONS — LiveStreamChatMessage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge fields from a [LiveStreamChatMessage] into an existing [Gift], overriding
 * thumbnail / video / sound / displayDuration when the gift message carries richer data.
 */
fun Gift.withMergedLiveGiftMessage(msg: LiveStreamChatMessage): Gift {
    return copy(
        id = id.ifBlank { msg.giftId },
        name = name.ifBlank { msg.giftName.ifBlank { msg.text } },
        thumbnailUrl = if (!msg.giftImageUrl.isNullOrBlank() && thumbnailUrl.isBlank()) msg.giftImageUrl else thumbnailUrl,
        videoUrl = if (!msg.giftVideoUrl.isNullOrBlank() && (videoUrl.isNullOrBlank())) msg.giftVideoUrl else videoUrl,
        soundUrl = if (!msg.giftSoundUrl.isNullOrBlank() && (soundUrl.isNullOrBlank())) msg.giftSoundUrl else soundUrl,
        displayDurationSeconds = if (displayDurationSeconds <= 0 && msg.giftDisplayDurationSeconds > 0)
            msg.giftDisplayDurationSeconds else displayDurationSeconds,
    )
}

/**
 * Merge a new gift [LiveStreamChatMessage] into a chat list, deduplicating by [LiveStreamChatMessage.id].
 */
fun List<LiveStreamChatMessage>.withMergedLiveGiftMessage(new: LiveStreamChatMessage): List<LiveStreamChatMessage> {
    if (any { it.id == new.id }) return this
    return this + new
}

// ─────────────────────────────────────────────────────────────────────────────
// EXTENSION HELPERS — UserProfile
// ─────────────────────────────────────────────────────────────────────────────

// (No extension properties needed — coins / walletBalance / likedByUserIds are real fields above)

/** One entry in a user's sent/received gift history feed. */
data class SentGiftHistoryEntry(
    val giftName: String = "",
    /** From `gift_transactions.giftId` when present; used for catalog icons. */
    val giftId: String = "",
    val totalCost: Int = 0,
    val count: Int = 1,
    val timestampMs: Long = 0L,
    /** UID of the other party (receiver when sent, sender when received). */
    val counterpartyId: String = "",
    val counterpartyName: String = "",
)

// ─────────────────────────────────────────────────────────────────────────────
// RESELL AGENT
// ─────────────────────────────────────────────────────────────────────────────

/** Diamond reseller agent shown in the shop (Firestore `diamondResellers/{id}`). */
@Keep
@IgnoreExtraProperties
data class ResellAgent(
    val id: String = "",
    val name: String = "",
    val photoUrl: String = "",
    val upiId: String = "",
    val whatsappNumber: String = "",
    val status: String = "active",
    val order: Int = 0,
    val note: String = "",
    val flag: String = "",
    val country: String = "",
    val resellerName: String = "",
    val whatsappLink: String = "",
)

// ─────────────────────────────────────────────────────────────────────────────
// LIVE DISCOVER FILTERS
// ─────────────────────────────────────────────────────────────────────────────

/** Which surface the live-discover tab is showing. */
enum class LiveDiscoverSurface { MAIN, AUDIO_PARTY_LOBBY }

/** Filter applied to live streams shown in the discover carousel. */
enum class LiveDiscoverLiveFilter { ALL, AUDIO_PARTY_ONLY }

// ─────────────────────────────────────────────────────────────────────────────
// MATCH (home-tab match / swipe result)
// ─────────────────────────────────────────────────────────────────────────────

/** A mutual match between the current user and another profile. */
data class Match(
    val id: String = "",
    val userId: String = "",
    val userName: String = "",
    val userPhotoUrl: String = "",
    val matchedAt: Long = System.currentTimeMillis(),
)

// ─────────────────────────────────────────────────────────────────────────────
// AUDIO PARTY VIDEO CALL REQUEST
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A video-call request from an audience member to an audio-party host.
 * Stored in `streams/{hostUid}/video_call_requests/{fromUserId}`.
 */
data class AudioPartyVideoCallRequest(
    val fromUserId: String = "",
    val displayName: String = "",
    val photoUrl: String = "",
    val status: String = "pending",   // "pending" | "accepted" | "dismissed"
    val requestedAt: Long = 0L,
)

// ─────────────────────────────────────────────────────────────────────────────
// BATTLE (game-center battle — broader than PkBattleSession)
// ─────────────────────────────────────────────────────────────────────────────

/** One quiz question used inside a [Battle]. */
data class QuizQuestion(
    val question: String = "",
    val options: List<String> = emptyList(),
    val correctIndex: Int = 0,
)

/** A sector on the spin wheel. */
data class SpinSector(
    val name: String = "",
    val emoji: String = "⭐",
    val value: Int = 10,
)

/** Reward type for a mystery box reveal. */
enum class MysteryRewardType { DIAMONDS, BEANS }

/** One mystery box slot inside a [Battle]. */
data class MysteryBoxContent(
    val index: Int = 0,
    // Stored as String to avoid Firestore crashing on unknown enum values.
    @PropertyName("rewardType") val rewardTypeStr: String = "DIAMONDS",
    val amount: Int = 100,
    val isOpened: Boolean = false,
) {
    @get:Exclude val rewardType: MysteryRewardType
        get() = runCatching { MysteryRewardType.valueOf(rewardTypeStr) }.getOrDefault(MysteryRewardType.DIAMONDS)
}

/** Real-time game state for a [Battle], synced via Firestore. */
@IgnoreExtraProperties
data class GameState(
    /** Current round number (1-indexed). */
    val round: Int = 0,
    /** Phase: "BETTING" | "SPINNING" | "BREAK" | "ENDED" */
    val phase: String = "BETTING",
    val currentTurnUserId: String = "",
    val lastActionType: String = "",
) {
    // updatedAt excluded: Firestore may store it as a Timestamp rather than Long,
    // which causes "Failed to convert a value of type Timestamp to long" crash.
    @get:Exclude var updatedAt: Long = 0L
}

/** Result after a [Battle] concludes. */
data class BattleResult(
    val winnerId: String = "",
    val winnerName: String = "",
    val winnerVotes: Int = 0,
    val girl1Score: Int = 0,
    val girl2Score: Int = 0,
)

/**
 * A game-center battle document — `game_battles/{id}`.
 * Covers quiz, spin wheel, mystery box, and live-PK game types.
 */
@Keep
@IgnoreExtraProperties
data class Battle(
    val id: String = "",
    // Stored as String to survive unknown Firestore values (e.g. "EMOJI", "DANCING").
    // Use the computed `gameType` property to get the safe enum value.
    @PropertyName("gameType") val gameTypeStr: String = "LIVE_PK",
    val hostId: String = "",
    /** Player 1 uid (host / creator). */
    val girl1Id: String = "",
    /** Player 2 uid (guest / challenger). Empty = open lobby. */
    val girl2Id: String = "",
    val girl1Name: String = "",
    val girl2Name: String = "",
    val girl1PhotoUrl: String = "",
    val girl2PhotoUrl: String = "",
    // Stored as String for the same reason as gameTypeStr.
    @PropertyName("status") val statusStr: String = "WAITING",
    val prizePool: Int = 1000,
    val startTime: Long = 0L,
    val endTime: Long = 0L,
    /** Viewer count for the lobby/live view. */
    val viewerCount: Int = 0,
    /** Vote / score accumulated for player 1. */
    val girl1Votes: Int = 0,
    /** Vote / score accumulated for player 2. */
    val girl2Votes: Int = 0,
    /** Computed score (gifts + votes) for player 1. */
    val girl1Score: Int = 0,
    /** Computed score for player 2. */
    val girl2Score: Int = 0,
    // Explicit winner (set by backend on end)
    val winnerId: String? = null,
    // Turn-based fields (Quiz / Emoji)
    val currentTurnUserId: String = "",
    val currentEmojiChallenge: String? = null,
    val emojiGameTurnCount: Int = 0,
    // Spin wheel fields
    val isSpinning: Boolean = false,
    val lastWinnerSectorIndex: Int? = null,
    val spinBreakTimeLeft: Int = 0,
    val spinBettingTimeLeft: Int = 0,
    val girl1HasSpun: Boolean = false,
    val girl2HasSpun: Boolean = false,
    val spinBreakStartedAtMs: Long = 0L,
    // Game content
    val spinSectors: List<SpinSector> = emptyList(),
    val mysteryBoxes: List<MysteryBoxContent> = emptyList(),
    val quizQuestions: List<QuizQuestion> = emptyList(),
) {
    // Safe enum accessors — fall back to defaults for unknown Firestore values.
    @get:Exclude val gameType: GameType
        get() = runCatching { GameType.valueOf(gameTypeStr) }.getOrDefault(GameType.LIVE_PK)
    @get:Exclude val status: BattleStatus
        get() = runCatching { BattleStatus.valueOf(statusStr) }.getOrDefault(BattleStatus.WAITING)

    // Convenience aliases matching PK battle naming conventions used by LiveBattleScreen
    @get:Exclude val hostUserId: String get() = girl1Id
    @get:Exclude val guestUserId: String get() = girl2Id
    @get:Exclude val hostUserName: String get() = girl1Name
    @get:Exclude val guestUserName: String get() = girl2Name
    @get:Exclude val hostPhotoUrl: String get() = girl1PhotoUrl
    @get:Exclude val guestPhotoUrl: String get() = girl2PhotoUrl
    @get:Exclude val hostDiamondSupport: Long get() = girl1Score.toLong()
    @get:Exclude val guestDiamondSupport: Long get() = girl2Score.toLong()
}

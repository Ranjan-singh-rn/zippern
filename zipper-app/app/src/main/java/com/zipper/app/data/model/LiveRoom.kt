package com.zipper.app.data.model

import com.google.firebase.firestore.PropertyName
import com.zipper.app.util.millis

data class LiveRoom(
    val roomId: String = "",
    val hostUid: String = "",
    val hostName: String = "",
    val hostPhotoUrl: String = "",
    val hostGender: String = "",
    val agencyId: String = "",
    val title: String = "",
    val viewerCount: Int = 0,
    val isActive: Boolean = true,
    val startedAt: Long = 0L,
    val endedAt: Long = 0L,
    val totalGiftsReceived: Long = 0L,
    val totalBeansEarned: Long = 0L,
    val category: String = "general",
    val welcomeMessage: String = "",
    val likeCount: Long = 0L,
    val kickedViewers: List<String> = emptyList(), // UIDs of kicked/blocked viewers
    // ── Staff moderation (B2) — written by backend/app/services/live.py ─────
    val endedByStaff: Boolean = false,
    val endReason: String = "",
    val hostMuted: Boolean = false,
    val hostMuteReason: String = "",

    // ── PK Battle ────────────────────────────────────────────────────────────
    val pkWaiting: Boolean = false,     // host is in the matchmaking queue
    val pkActive: Boolean = false,
    val pkPartnerId: String = "",       // partner's liveRoom doc ID
    val pkPartnerUid: String = "",
    val pkPartnerName: String = "",
    val pkPartnerPhotoUrl: String = "",
    val pkScore: Long = 0L,             // THIS host's score (gifts received during PK)
    val pkPartnerScore: Long = 0L,
    val pkEndTime: Long = 0L,           // epoch ms when PK timer ends
    val pkChannelId: String = "",       // shared Agora channel used during PK

    // ── B12 (4 Nov 2026) ─────────────────────────────────────────────────────
    /** The host paused the live: viewers see "back soon", the host's camera and mic are off. */
    val isPaused: Boolean = false,
    /** The host turned the camera off (still live, still talking): viewers see the host's photo. */
    val isCameraOff: Boolean = false,
    /** O1/O5c: the host switched incoming calls off for this broadcast (enforced by `startCall`; shown as "Calls off"). */
    val hostBlocksCalls: Boolean = false,
    /** The host's pinned announcement, shown above the chat (≤ 140 characters). */
    val pinnedMessage: String = "",
    /** Viewers the host muted in the chat (they still watch). */
    val mutedViewers: List<String> = emptyList(),
    /** The most people watching at once — counted by the server from presence rows. */
    val peakViewers: Int = 0,
    /** Streamed seconds measured by the server at the close (0 until then). */
    val serverDurationSeconds: Long = 0L,
    /** The last PK's verdict, written by the server on both rooms. */
    val lastPkWinnerUid: String = "",
    val lastPkMyScore: Long = 0L,
    val lastPkPartnerScore: Long = 0L,
    val lastPkEndedAt: Long = 0L,
) {
    companion object {
        /**
         * Explicit parse. `toObject()` throws on a Timestamp in a `Long` field,
         * and `endedAt` is written by two parties that disagree: the app writes
         * millis, and the CRM's "end this stream" writes a Python datetime,
         * which lands as a Timestamp. So the moment an operator cut a stream
         * from the CRM, the host's own room listener crashed — and the host
         * never learned the room had been ended, which is precisely the case
         * the CRM control exists for.
         */
        fun from(doc: com.google.firebase.firestore.DocumentSnapshot): LiveRoom? {
            if (!doc.exists()) return null
            @Suppress("UNCHECKED_CAST")
            val kicked = (doc.get("kickedViewers") as? List<*>)?.mapNotNull { it as? String } ?: emptyList()
            val muted = (doc.get("mutedViewers") as? List<*>)?.mapNotNull { it as? String } ?: emptyList()
            val lastPk = doc.get("lastPk") as? Map<*, *>
            return LiveRoom(
                roomId             = doc.id,
                hostUid            = doc.getString("hostUid") ?: "",
                hostName           = doc.getString("hostName") ?: "",
                hostPhotoUrl       = doc.getString("hostPhotoUrl") ?: "",
                hostGender         = doc.getString("hostGender") ?: "",
                agencyId           = doc.getString("agencyId") ?: "",
                title              = doc.getString("title") ?: "",
                viewerCount        = (doc.getLong("viewerCount") ?: 0L).toInt(),
                isActive           = doc.getBoolean("isActive") ?: true,
                startedAt          = doc.millis("startedAt"),
                endedAt            = doc.millis("endedAt"),
                totalGiftsReceived = doc.getLong("totalGiftsReceived") ?: 0L,
                totalBeansEarned   = doc.getLong("totalBeansEarned") ?: 0L,
                category           = doc.getString("category") ?: "general",
                welcomeMessage     = doc.getString("welcomeMessage") ?: "",
                likeCount          = doc.getLong("likeCount") ?: 0L,
                kickedViewers      = kicked,
                endedByStaff       = doc.getBoolean("endedByStaff") ?: false,
                endReason          = doc.getString("endReason") ?: "",
                hostMuted          = doc.getBoolean("hostMuted") ?: false,
                hostMuteReason     = doc.getString("hostMuteReason") ?: "",
                pkWaiting          = doc.getBoolean("pkWaiting") ?: false,
                pkActive           = doc.getBoolean("pkActive") ?: false,
                pkPartnerId        = doc.getString("pkPartnerId") ?: "",
                pkPartnerUid       = doc.getString("pkPartnerUid") ?: "",
                pkPartnerName      = doc.getString("pkPartnerName") ?: "",
                pkPartnerPhotoUrl  = doc.getString("pkPartnerPhotoUrl") ?: "",
                pkScore            = doc.getLong("pkScore") ?: 0L,
                pkPartnerScore     = doc.getLong("pkPartnerScore") ?: 0L,
                pkEndTime          = doc.millis("pkEndTime"),
                pkChannelId        = doc.getString("pkChannelId") ?: "",
                isPaused           = doc.getBoolean("isPaused") ?: false,
                isCameraOff        = doc.getBoolean("isCameraOff") ?: false,
                hostBlocksCalls    = doc.getBoolean("hostBlocksCalls") ?: false,
                pinnedMessage      = doc.getString("pinnedMessage") ?: "",
                mutedViewers       = muted,
                peakViewers        = (doc.getLong("peakViewers") ?: 0L).toInt(),
                serverDurationSeconds = doc.getLong("serverDurationSeconds") ?: 0L,
                lastPkWinnerUid    = lastPk?.get("winnerUid") as? String ?: "",
                lastPkMyScore      = (lastPk?.get("myScore") as? Number)?.toLong() ?: 0L,
                lastPkPartnerScore = (lastPk?.get("partnerScore") as? Number)?.toLong() ?: 0L,
                lastPkEndedAt      = (lastPk?.get("endedAtMs") as? Number)?.toLong() ?: 0L,
            )
        }
    }
}

/**
 * Created when two waiting hosts are matched.
 * Both hosts are notified via [participants] array-contains query.
 */
data class PkInvite(
    val id: String = "",
    val hostAUid: String = "",
    val hostAName: String = "",
    val hostAPhotoUrl: String = "",
    val hostARoomId: String = "",
    val hostBUid: String = "",
    val hostBName: String = "",
    val hostBPhotoUrl: String = "",
    val hostBRoomId: String = "",
    val participants: List<String> = emptyList(), // [hostAUid, hostBUid] for array-contains query
    val hostAAccepted: Boolean = false,
    val hostBAccepted: Boolean = false,
    val status: String = "pending",     // pending | started | rejected | cancelled | ended (B12: server-written)
    val createdAt: Long = 0L,
)

data class LiveComment(
    val id: String = "",
    val uid: String = "",
    val name: String = "",
    val photoUrl: String = "",
    val message: String = "",
    val timestamp: Long = 0L,
    /**
     * The document is written with the key `"isJoin"`, but Firestore's POJO
     * mapper strips the bean prefix and looks for a field called `join` — so
     * `toObject()` always produced false and the "X joined" row was dead code.
     * The annotation pins the name, and [from] reads either key regardless.
     */
    @get:PropertyName("isJoin")
    val isJoin: Boolean = false,
) {
    companion object {
        fun from(doc: com.google.firebase.firestore.DocumentSnapshot): LiveComment? {
            if (!doc.exists()) return null
            return LiveComment(
                id        = doc.id,
                uid       = doc.getString("uid") ?: "",
                name      = doc.getString("name") ?: "",
                photoUrl  = doc.getString("photoUrl") ?: "",
                message   = doc.getString("message") ?: "",
                timestamp = doc.millis("timestamp"),
                isJoin    = doc.getBoolean("isJoin") ?: doc.getBoolean("join") ?: false,
            )
        }
    }
}

data class LiveGiftEvent(
    val id: String = "",
    val uid: String = "",
    val senderName: String = "",
    val senderPhotoUrl: String = "",
    val giftName: String = "",
    val emoji: String = "",
    val imageUrl: String = "",
    val quantity: Int = 1,
    val timestamp: Long = 0L,
    /** B13: the gift's SVGA animation (tools/decor), written by settleGift on the room's gift row. */
    val svgaUrl: String = "",
    /** O2: the CRM's Lottie for the gift — a bundled `gifts/….json` or a URL — played when there is no SVGA. */
    val lottieAsset: String = "",
) {
    companion object {
        fun from(doc: com.google.firebase.firestore.DocumentSnapshot): LiveGiftEvent? {
            if (!doc.exists()) return null
            return LiveGiftEvent(
                id             = doc.id,
                uid            = doc.getString("uid") ?: "",
                senderName     = doc.getString("senderName") ?: "",
                senderPhotoUrl = doc.getString("senderPhotoUrl") ?: "",
                giftName       = doc.getString("giftName") ?: "",
                emoji          = doc.getString("emoji") ?: "",
                imageUrl       = doc.getString("imageUrl") ?: "",
                quantity       = (doc.getLong("quantity") ?: 1L).toInt(),
                timestamp      = doc.millis("timestamp"),
                svgaUrl        = doc.getString("svgaUrl") ?: "",
                lottieAsset    = doc.getString("lottieAsset") ?: "",
            )
        }
    }
}

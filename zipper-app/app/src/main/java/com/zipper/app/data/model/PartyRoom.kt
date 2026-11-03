package com.zipper.app.data.model

import com.google.firebase.firestore.DocumentSnapshot
import com.zipper.app.util.millis

/**
 * A party room — several people on "seats" talking to a room of listeners.
 *
 * ## Two modes, one collection
 *
 * An audio party and a video party are genuinely different products, not one
 * screen with a camera toggle, and the difference that matters is the device
 * budget. An audio seat is one Opus stream: a handful of kilobits, decoded on
 * a codec every phone has. A video seat is a decoded video stream, and the number
 * of those a budget phone can composite before it drops frames is small and
 * unforgiving.
 *
 * So they share a document shape and a room list — a party is a party, and
 * duplicating the seat machinery twice would mean fixing every seat bug twice —
 * but they do NOT share a seat count. See [seatChoices].
 *
 * ## Seats are documents, not an array
 *
 * `partyRooms/{id}/seats/{index}` — one document per seat, keyed by its index.
 * An array field would be read-modify-write, and two people tapping the same
 * empty seat within the same second would each write an array in which they
 * hold it. A document keyed by index turns that race into a create that the
 * second writer loses, which is exactly the semantics a seat needs.
 *
 * ## THE OWNER SITS ON AN ORDINARY SEAT
 *
 * This is the change the rebuild turned on. The owner used to be "seat 0",
 * implicit, with no document — and that single decision produced most of the
 * room's defects. Their mute and camera state had nowhere to live but their own
 * phone's memory, so a muted owner appeared muted to nobody else. They had no
 * `agoraUid`, so every other client found their video BY ELIMINATION: take the
 * first publisher whose uid is not a seat index. And they could not stand up,
 * because there was no seat to stand up from.
 *
 * Now every seat is the same kind of thing and starts empty, the owner included.
 * [hostUid] says who owns the room; a seat says who is talking. Those are
 * different questions.
 */
data class PartyRoom(
    val roomId: String = "",
    val hostUid: String = "",
    val hostName: String = "",
    val hostPhotoUrl: String = "",
    val mode: String = MODE_AUDIO,
    val title: String = "",
    /** Shown to everyone on entry. Owner-editable, server-validated. */
    val welcomeMessage: String = DEFAULT_WELCOME,
    val category: String = "general",
    val agencyId: String = "",
    val isActive: Boolean = true,
    val startedAt: Long = 0L,
    val endedAt: Long = 0L,
    /** How many seats this room has. One of [seatChoices] for its mode. */
    val seatCount: Int = AUDIO_SEAT_CHOICES.first(),
    /** [SEAT_MODE_FREE]: tap and sit. [SEAT_MODE_CONSENT]: ask first. */
    val seatMode: String = SEAT_MODE_FREE,
    /** [VISIBILITY_PUBLIC] or [VISIBILITY_PRIVATE] — private needs a 4-digit code. */
    val visibility: String = VISIBILITY_PUBLIC,
    /** Co-hosts. May mute members, remove members, invite, and vet seat requests. */
    val admins: List<String> = emptyList(),
    /** Listeners, not counting anyone on a seat. Maintained by the join/leave callables. */
    val listenerCount: Int = 0,
    /** How many seats are taken. The auto-close clock watches this reach zero. */
    val occupantCount: Int = 0,
    val totalBeansEarned: Long = 0L,
    val totalGiftsReceived: Long = 0L,
    /** Seat indices a moderator has closed. A locked seat cannot be taken. */
    val lockedSeats: List<Int> = emptyList(),
    /** Removed from the room. Refused a token, so it is a real removal and not a request. */
    val kickedUsers: List<String> = emptyList(),
    /** B7: Zipper officials who entered this private room without its PIN — shown to everyone in it. */
    val officialPresentUids: List<String> = emptyList(),
    /** B7: the room's background (one of ROOM_THEMES in functions/src/party.ts). */
    val theme: String = "classic",
    /** B7: the owner is not taking calls while in the room. */
    val ownerBlocksCalls: Boolean = false,
    /** B7: what is playing (a catalogue track), and who is playing it; null when nothing is. */
    val music: PartyMusic? = null,
) {
    val isAudio: Boolean get() = mode == MODE_AUDIO
    val isPrivate: Boolean get() = visibility == VISIBILITY_PRIVATE
    val needsSeatConsent: Boolean get() = seatMode == SEAT_MODE_CONSENT

    fun isOwner(uid: String): Boolean = uid.isNotBlank() && uid == hostUid
    fun isAdmin(uid: String): Boolean = uid.isNotBlank() && uid in admins
    fun canModerate(uid: String): Boolean = isOwner(uid) || isAdmin(uid)

    companion object {
        const val MODE_AUDIO = "audio"
        const val MODE_VIDEO = "video"

        const val SEAT_MODE_FREE = "free"
        const val SEAT_MODE_CONSENT = "consent"

        const val VISIBILITY_PUBLIC = "public"
        const val VISIBILITY_PRIVATE = "private"

        const val DEFAULT_WELCOME = "welcome to my room have fun"
        const val WELCOME_MAX_CHARS = 250

        /**
         * Ten or fifteen. Fifteen Opus streams is within what a low-end phone can
         * mix, and fifteen avatars still fit a grid that can be read at a glance.
         */
        val AUDIO_SEAT_CHOICES = listOf(10, 15)

        /**
         * Six or ten. Ten decoded video tiles is the ceiling a budget SoC will
         * composite without dropping frames, and it is a ceiling rather than a
         * default for exactly that reason.
         */
        val VIDEO_SEAT_CHOICES = listOf(6, 10)

        fun seatChoices(mode: String): List<Int> =
            if (mode == MODE_VIDEO) VIDEO_SEAT_CHOICES else AUDIO_SEAT_CHOICES

        /** Snap a requested count to an allowed one. Mirrors `seatsFor` in party.ts. */
        fun seatsFor(mode: String, requested: Int? = null): Int {
            val allowed = seatChoices(mode)
            return if (requested != null && requested in allowed) requested else allowed.first()
        }

        /**
         * Rejects what the server rejects, so the client can say so before a round
         * trip. Kept in step with `cleanWelcome` in functions/src/party.ts —
         * duplicated deliberately: the server's copy is the one that holds, this
         * one only exists so the Save button can be honest about why it is off.
         *
         * Returns null when the text is acceptable, or the reason it is not.
         */
        fun welcomeProblem(text: String): String? {
            val t = text.trim()
            if (t.isEmpty()) return "Say something to welcome people."
            if (t.length > WELCOME_MAX_CHARS) return "Keep it under $WELCOME_MAX_CHARS characters."
            // Digits are refused because this is the most-read line in the room,
            // and left free it fills with phone numbers and Telegram handles —
            // traffic leaving for somewhere with no moderation and no reporting.
            if (t.any { it.isDigit() }) return "No numbers in the welcome message."
            return null
        }

        /**
         * Explicit parse, for the reason [LiveRoom.from] documents: `toObject()`
         * throws when a Timestamp lands in a Long field, and `startedAt` is
         * written as a server Timestamp while the CRM's "end this room" writes
         * another one — so a room ended from the CRM would crash every client
         * watching it at precisely the moment they needed to be told.
         */
        fun from(doc: DocumentSnapshot): PartyRoom? {
            if (!doc.exists()) return null
            val mode = doc.getString("mode")?.takeIf { it == MODE_VIDEO } ?: MODE_AUDIO
            return PartyRoom(
                roomId        = doc.id,
                hostUid       = doc.getString("hostUid") ?: return null,
                hostName      = doc.getString("hostName") ?: "",
                hostPhotoUrl  = doc.getString("hostPhotoUrl") ?: "",
                mode          = mode,
                title         = doc.getString("title") ?: "",
                welcomeMessage = doc.getString("welcomeMessage")?.takeIf { it.isNotBlank() }
                    ?: DEFAULT_WELCOME,
                category      = doc.getString("category") ?: "general",
                agencyId      = doc.getString("agencyId") ?: "",
                isActive      = doc.getBoolean("isActive") ?: true,
                startedAt     = doc.millis("startedAt"),
                endedAt       = doc.millis("endedAt"),
                /*
                 * Read from the document now, but SNAPPED to an allowed value.
                 *
                 * This used to ignore the field entirely and re-derive the count
                 * from the mode, because the rules let the owner's client write
                 * any number here and a room claiming twenty video seats would be
                 * honoured by the grid and take the device down with it. The room
                 * document is server-only now and the seat count is selectable, so
                 * the field has to be read — and `seatsFor` is what keeps the old
                 * protection: an out-of-range number falls back to the smallest
                 * allowed count rather than being obeyed.
                 */
                seatCount     = seatsFor(mode, (doc.getLong("seatCount") ?: 0L).toInt()),
                seatMode      = doc.getString("seatMode")?.takeIf { it == SEAT_MODE_CONSENT }
                    ?: SEAT_MODE_FREE,
                visibility    = doc.getString("visibility")?.takeIf { it == VISIBILITY_PRIVATE }
                    ?: VISIBILITY_PUBLIC,
                admins        = (doc.get("admins") as? List<*>)
                    ?.mapNotNull { it as? String } ?: emptyList(),
                listenerCount = (doc.getLong("listenerCount") ?: 0L).toInt().coerceAtLeast(0),
                occupantCount = (doc.getLong("occupantCount") ?: 0L).toInt().coerceAtLeast(0),
                totalBeansEarned = doc.getLong("totalBeansEarned") ?: 0L,
                totalGiftsReceived = doc.getLong("totalGiftsReceived") ?: 0L,
                lockedSeats   = (doc.get("lockedSeats") as? List<*>)
                    ?.mapNotNull { (it as? Number)?.toInt() } ?: emptyList(),
                kickedUsers   = (doc.get("kickedUsers") as? List<*>)
                    ?.mapNotNull { it as? String } ?: emptyList(),
                officialPresentUids = (doc.get("officialPresentUids") as? List<*>)
                    ?.mapNotNull { it as? String } ?: emptyList(),
                theme = doc.getString("theme") ?: "classic",
                ownerBlocksCalls = doc.getBoolean("ownerBlocksCalls") ?: false,
                music = (doc.get("music") as? Map<*, *>)?.let { m ->
                    PartyMusic(
                        trackId = m["trackId"] as? String ?: "",
                        title = m["title"] as? String ?: "",
                        artist = m["artist"] as? String ?: "",
                        url = m["url"] as? String ?: "",
                        playing = m["playing"] as? Boolean ?: false,
                        by = m["by"] as? String ?: "",
                    )
                }?.takeIf { it.trackId.isNotBlank() },
            )
        }
    }
}

/**
 * One seat. Absent document = empty seat.
 *
 * [agoraUid] is stored because a video tile has to be bound to a specific remote
 * stream, and the mapping from "seat 3" to "the Agora uid publishing there" is
 * not something the client can infer. It equals the seat index — `takePartySeat`
 * writes it and `generateAgoraToken` signs a token for it, so the two cannot
 * disagree.
 */
data class PartySeat(
    val index: Int = 0,
    val uid: String = "",
    val name: String = "",
    val photoUrl: String = "",
    val agoraUid: Int = 0,
    /** Muted by a MODERATOR. A seat holder muting themselves is [selfMuted]. */
    val isMuted: Boolean = false,
    /**
     * Who imposed [isMuted], and in what capacity.
     *
     * Stored because "may you unmute this?" depends on who muted it: an owner's
     * mute can only be lifted by the owner, an admin's by that admin or the
     * owner. Without these two fields the hierarchy cannot be expressed at all —
     * which is why it did not exist in the first version.
     */
    val mutedBy: String = "",
    val mutedByRole: String = "",
    val selfMuted: Boolean = false,
    /** Camera off, video rooms only. */
    val cameraOff: Boolean = false,
    val joinedAt: Long = 0L,
    /** Beans this seat has been gifted this session — the per-seat leaderboard. */
    val beansReceived: Long = 0L,
) {
    val isEmpty: Boolean get() = uid.isBlank()
    /** Silent for any reason. What the UI actually wants to know. */
    val isSilent: Boolean get() = isMuted || selfMuted
    val mutedByOwner: Boolean get() = isMuted && mutedByRole == "owner"

    companion object {
        fun from(doc: DocumentSnapshot): PartySeat? {
            if (!doc.exists()) return null
            return PartySeat(
                index     = doc.id.toIntOrNull() ?: return null,
                uid       = doc.getString("uid") ?: "",
                name      = doc.getString("name") ?: "",
                photoUrl  = doc.getString("photoUrl") ?: "",
                agoraUid  = (doc.getLong("agoraUid") ?: 0L).toInt(),
                isMuted   = doc.getBoolean("isMuted") ?: false,
                mutedBy   = doc.getString("mutedBy") ?: "",
                mutedByRole = doc.getString("mutedByRole") ?: "",
                selfMuted = doc.getBoolean("selfMuted") ?: false,
                cameraOff = doc.getBoolean("cameraOff") ?: false,
                joinedAt  = doc.millis("joinedAt"),
                beansReceived = doc.getLong("beansReceived") ?: 0L,
            )
        }
    }
}

/** Somebody asking for a seat, in a room where seats need consent. */
data class PartySeatRequest(
    val uid: String = "",
    val name: String = "",
    val photoUrl: String = "",
    val seatIndex: Int = 0,
    val requestedAt: Long = 0L,
) {
    companion object {
        fun from(doc: DocumentSnapshot): PartySeatRequest? {
            if (!doc.exists()) return null
            return PartySeatRequest(
                uid         = doc.getString("uid") ?: doc.id,
                name        = doc.getString("name") ?: "Guest",
                photoUrl    = doc.getString("photoUrl") ?: "",
                seatIndex   = (doc.getLong("seatIndex") ?: 0L).toInt(),
                requestedAt = doc.millis("requestedAt"),
            )
        }
    }
}

/** An offer of a seat, shown to the invitee as a popup they accept or decline. */
data class PartySeatInvite(
    val seatIndex: Int = 0,
    val byName: String = "",
    val roomTitle: String = "",
    val invitedAt: Long = 0L,
) {
    companion object {
        fun from(doc: DocumentSnapshot): PartySeatInvite? {
            if (!doc.exists()) return null
            return PartySeatInvite(
                seatIndex = (doc.getLong("seatIndex") ?: 0L).toInt(),
                byName    = doc.getString("byName") ?: "The host",
                roomTitle = doc.getString("roomTitle") ?: "this room",
                invitedAt = doc.millis("invitedAt"),
            )
        }
    }
}


/** B7: room music — a track from Zipper's licensed catalogue (`musicTracks`), played by [by]'s phone into the room. */
data class PartyMusic(
    val trackId: String,
    val title: String,
    val artist: String,
    val url: String,
    val playing: Boolean,
    val by: String,
)

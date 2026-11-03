package com.zipper.app.data.repository

import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.FirebaseFunctionsException
import com.zipper.app.util.ServerRefusals
import com.zipper.app.data.model.PartyRoom
import com.zipper.app.data.model.PartySeat
import com.zipper.app.data.model.PartySeatInvite
import com.zipper.app.data.model.PartySeatRequest
import com.zipper.app.util.millis
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await
import javax.inject.Inject
import javax.inject.Singleton

/**
 * One line of party-room chat.
 *
 * Parsed field by field rather than with `toObject()` for the reason
 * [com.zipper.app.data.model.PartyRoom.Companion.from] documents: a room's
 * documents carry a mix of client millis and server Timestamps, and `toObject`
 * throws rather than degrades when the two meet in one Long field.
 */
data class PartyMessage(
    val id: String = "",
    val senderUid: String = "",
    val senderName: String = "",
    val senderPhotoUrl: String = "",
    val text: String = "",
    val timestamp: Long = 0L,
    /** A "someone joined" line rather than something a person typed. */
    val isJoin: Boolean = false,
) {
    companion object {
        fun from(doc: com.google.firebase.firestore.DocumentSnapshot): PartyMessage? {
            if (!doc.exists()) return null
            return PartyMessage(
                id             = doc.id,
                senderUid      = doc.getString("senderUid") ?: return null,
                senderName     = doc.getString("senderName") ?: "",
                senderPhotoUrl = doc.getString("senderPhotoUrl") ?: "",
                text           = doc.getString("text") ?: "",
                timestamp      = doc.millis("timestamp"),
                isJoin         = doc.getBoolean("isJoin") ?: false,
            )
        }
    }
}

/**
 * Somebody in the room who is not on a seat.
 *
 * The cosmetic fields are written by `joinPartyRoom`, ALREADY RESOLVED TO URLS.
 * The ids alone would not be enough — an entrance is a video clip, so playing it
 * means knowing `bagItems/{id}.videoUrl`, and looking that up per client would
 * make one arrival in a room of forty into forty reads of the same document.
 * Resolving it once on the way in is the point of denormalising it at all.
 */
data class PartyListener(
    val uid: String = "",
    val name: String = "",
    val photoUrl: String = "",
    val level: Int = 0,
    val entranceItemId: String = "",
    val entranceVideoUrl: String = "",
    val entrancePosterUrl: String = "",
    /** B13: an SVGA entrance — played with this person's photo and name in it. Preferred over the video. */
    val entranceSvgaUrl: String = "",
    val idFrameItemId: String = "",
    val idFrameUrl: String = "",
    val joinedAt: Long = 0L,
) {
    /** Whether there is actually a clip to play for this arrival. */
    val hasEntrance: Boolean get() = entranceVideoUrl.isNotBlank() || entranceSvgaUrl.isNotBlank()

    companion object {
        fun from(doc: com.google.firebase.firestore.DocumentSnapshot): PartyListener? {
            if (!doc.exists()) return null
            return PartyListener(
                uid               = doc.getString("uid") ?: doc.id,
                name              = doc.getString("name") ?: "",
                photoUrl          = doc.getString("photoUrl") ?: "",
                level             = (doc.getLong("level") ?: 0L).toInt(),
                entranceItemId    = doc.getString("entranceItemId") ?: "",
                entranceVideoUrl  = doc.getString("entranceVideoUrl") ?: "",
                entrancePosterUrl = doc.getString("entrancePosterUrl") ?: "",
                entranceSvgaUrl   = doc.getString("entranceSvgaUrl") ?: "",
                idFrameItemId     = doc.getString("idFrameItemId") ?: "",
                idFrameUrl        = doc.getString("idFrameUrl") ?: "",
                joinedAt          = doc.millis("joinedAt"),
            )
        }
    }
}

/** A gift that landed in the room, for the ticker and the animation overlay. */
data class PartyGiftEvent(
    val id: String = "",
    val senderUid: String = "",
    val senderName: String = "",
    val senderPhotoUrl: String = "",
    val giftId: String = "",
    val giftName: String = "",
    val emoji: String = "",
    val imageUrl: String = "",
    val quantity: Int = 1,
    val diamondCost: Long = 0L,
    val timestamp: Long = 0L,
    /** B7: who it was for, and the settlement it belongs to (server-written with the gift). */
    val receiverUid: String = "",
    val transactionId: String = "",
    /** B13: the gift's SVGA animation, written by settleGift. */
    val svgaUrl: String = "",
) {
    companion object {
        fun from(doc: com.google.firebase.firestore.DocumentSnapshot): PartyGiftEvent? {
            if (!doc.exists()) return null
            return PartyGiftEvent(
                id             = doc.id,
                senderUid      = doc.getString("uid") ?: doc.getString("senderUid") ?: "",
                senderName     = doc.getString("senderName") ?: "",
                senderPhotoUrl = doc.getString("senderPhotoUrl") ?: "",
                giftId         = doc.getString("giftId") ?: "",
                giftName       = doc.getString("giftName") ?: "",
                emoji          = doc.getString("emoji") ?: "",
                imageUrl       = doc.getString("imageUrl") ?: "",
                quantity       = (doc.getLong("quantity") ?: 1L).toInt(),
                diamondCost    = doc.getLong("diamondCost") ?: 0L,
                timestamp      = doc.millis("timestamp"),
                receiverUid    = doc.getString("receiverUid") ?: "",
                transactionId  = doc.getString("transactionId") ?: "",
                svgaUrl        = doc.getString("svgaUrl") ?: "",
            )
        }
    }
}

@Singleton
class PartyRepository @Inject constructor(
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
    private val functions: FirebaseFunctions,
    private val money: MoneyFunctions,
    /** Phase 1A (SESSION-001): the active session id travels with every callable. */
    private val sessionManager: com.zipper.app.util.SessionManager,
) {

    /** What a callable said. Mirrors [HostFunctions.Result] so call sites read alike. */
    sealed interface Result<out T> {
        data class Ok<T>(val value: T) : Result<T>
        /** [detail] is the server's own refusal code when it sent one: `PARTY_PIN_LOCKED`, `PRIVATE_ROOM_SUBSCRIPTION_REQUIRED` … */
        data class Failed(val code: String, val userMessage: String, val detail: String = "") : Result<Nothing>
    }

    private val partyRoomsCol get() = firestore.collection("partyRooms")

    private fun roomRef(roomId: String) = partyRoomsCol.document(roomId)

    // ── Discovery ─────────────────────────────────────────────────────────────

    /**
     * Every open PUBLIC room of one mode, busiest first.
     *
     * ── WHY THIS IS NOW A REAL QUERY ─────────────────────────────────────────
     *
     * It used to fetch every active room and filter the mode in memory, with a
     * comment explaining that a composite index did not exist and that a query
     * Firestore refuses fails at runtime with an empty list and a console link
     * nobody reads. Both true — so the index now exists
     * (`firestore.indexes.json`), and the filtering moved to the server where it
     * belongs.
     *
     * Two things made that necessary rather than merely tidy. Private rooms must
     * not appear in a browse list at all, and "busiest first" needs
     * `listenerCount` to be a real number — it now is, because the join and leave
     * callables maintain it, where before it was written once as 0 and the list
     * had to run two aggregate count queries per row to find out what it should
     * have said.
     */
    fun activeRoomsFlow(mode: String): Flow<List<PartyRoom>> = callbackFlow {
        val listener = partyRoomsCol
            .whereEqualTo("isActive", true)
            .whereEqualTo("visibility", PartyRoom.VISIBILITY_PUBLIC)
            .whereEqualTo("mode", mode)
            .orderBy("listenerCount", Query.Direction.DESCENDING)
            .limit(60)
            .addSnapshotListener { snap, err ->
                if (err != null || snap == null) {
                    trySend(emptyList())
                    return@addSnapshotListener
                }
                trySend(snap.documents.mapNotNull { doc -> PartyRoom.from(doc) })
            }
        awaitClose { listener.remove() }
    }

    /**
     * A room by id, whether or not it is public.
     *
     * How somebody reaches a private room: a friend sends the id, they have the
     * four digits. The list will never show it to them.
     */
    suspend fun fetchRoom(roomId: String): PartyRoom? = try {
        PartyRoom.from(roomRef(roomId).get().await())
    } catch (_: Exception) {
        null
    }

    // ── One room ──────────────────────────────────────────────────────────────

    fun roomFlow(roomId: String): Flow<PartyRoom?> = callbackFlow {
        val listener = roomRef(roomId).addSnapshotListener { snap, err ->
            if (err != null || snap == null) {
                trySend(null)
                return@addSnapshotListener
            }
            trySend(PartyRoom.from(snap))
        }
        awaitClose { listener.remove() }
    }

    /**
     * The occupied seats, by index.
     *
     * An absent document is an empty seat — the grid fills the gaps itself, so
     * this hands back only what is really there and never a placeholder that
     * would be indistinguishable from somebody sitting silently.
     */
    fun seatsFlow(roomId: String): Flow<List<PartySeat>> = callbackFlow {
        val listener = roomRef(roomId).collection("seats")
            .addSnapshotListener { snap, err ->
                if (err != null || snap == null) {
                    trySend(emptyList())
                    return@addSnapshotListener
                }
                val seats = snap.documents
                    .mapNotNull { doc -> PartySeat.from(doc) }
                    .filter { !it.isEmpty }
                    .sortedBy { it.index }
                trySend(seats)
            }
        awaitClose { listener.remove() }
    }

    fun listenersFlow(roomId: String): Flow<List<PartyListener>> = callbackFlow {
        val listener = roomRef(roomId).collection("listeners")
            .orderBy("joinedAt", Query.Direction.ASCENDING)
            .limit(200)
            .addSnapshotListener { snap, err ->
                if (err != null || snap == null) {
                    trySend(emptyList())
                    return@addSnapshotListener
                }
                trySend(snap.documents.mapNotNull { doc -> PartyListener.from(doc) })
            }
        awaitClose { listener.remove() }
    }

    /**
     * Chat, oldest first, capped at the last hundred lines.
     *
     * `limitToLast` keeps a room that has been running for six hours from
     * handing a phone six hours of messages the moment it opens.
     */
    fun messagesFlow(roomId: String): Flow<List<PartyMessage>> = callbackFlow {
        val listener = roomRef(roomId).collection("messages")
            .orderBy("timestamp", Query.Direction.ASCENDING)
            .limitToLast(100)
            .addSnapshotListener { snap, err ->
                if (err != null || snap == null) {
                    trySend(emptyList())
                    return@addSnapshotListener
                }
                trySend(snap.documents.mapNotNull { doc -> PartyMessage.from(doc) })
            }
        awaitClose { listener.remove() }
    }

    /**
     * Gifts landing in the room.
     *
     * Only the recent ones, because this drives an animation: a client joining an
     * hour-old room should not replay an hour of gifts on arrival. The overlay
     * keys on document id, so a re-delivered snapshot does not animate twice.
     */
    fun giftsFlow(roomId: String): Flow<List<PartyGiftEvent>> = callbackFlow {
        val listener = roomRef(roomId).collection("gifts")
            .orderBy("timestamp", Query.Direction.DESCENDING)
            .limit(12)
            .addSnapshotListener { snap, err ->
                if (err != null || snap == null) {
                    trySend(emptyList())
                    return@addSnapshotListener
                }
                trySend(snap.documents.mapNotNull { doc -> PartyGiftEvent.from(doc) })
            }
        awaitClose { listener.remove() }
    }

    /** Who is waiting for a seat. Moderators act on these; the asker watches their own. */
    fun seatRequestsFlow(roomId: String): Flow<List<PartySeatRequest>> = callbackFlow {
        val listener = roomRef(roomId).collection("seatRequests")
            .addSnapshotListener { snap, err ->
                if (err != null || snap == null) {
                    trySend(emptyList())
                    return@addSnapshotListener
                }
                trySend(
                    snap.documents.mapNotNull { doc -> PartySeatRequest.from(doc) }
                        .sortedBy { it.requestedAt },
                )
            }
        awaitClose { listener.remove() }
    }

    /**
     * An invitation addressed to me, or null.
     *
     * One document per invitee, keyed by uid, so this is a single-document
     * listener rather than a query — and the rules only let someone read their
     * own.
     */
    fun myInviteFlow(roomId: String): Flow<PartySeatInvite?> = callbackFlow {
        val uid = auth.currentUser?.uid
        if (uid == null) {
            trySend(null)
            awaitClose { }
            return@callbackFlow
        }
        val listener = roomRef(roomId).collection("seatInvites").document(uid)
            .addSnapshotListener { snap, err ->
                trySend(if (err != null || snap == null) null else PartySeatInvite.from(snap))
            }
        awaitClose { listener.remove() }
    }

    // ── Chat ──────────────────────────────────────────────────────────────────

    suspend fun sendMessage(roomId: String, text: String) {
        val uid = auth.currentUser?.uid ?: return
        val userSnap = firestore.collection("users").document(uid).get().await()
        roomRef(roomId).collection("messages").add(
            mapOf(
                // The rule compares this against the caller's uid, so it is the
                // one field here that is not cosmetic.
                "senderUid" to uid,
                "senderName" to (userSnap.getString("name") ?: ""),
                "senderPhotoUrl" to (userSnap.getString("photoUrl") ?: ""),
                "text" to text,
                "timestamp" to System.currentTimeMillis(),
                "isJoin" to false,
            )
        ).await()
    }

    suspend fun sendJoinMessage(roomId: String, name: String) {
        val uid = auth.currentUser?.uid ?: return
        roomRef(roomId).collection("messages").add(
            mapOf(
                "senderUid" to uid,
                "senderName" to name,
                "senderPhotoUrl" to "",
                "text" to "$name joined",
                "timestamp" to System.currentTimeMillis(),
                "isJoin" to true,
            )
        ).await()
    }

    // ── Seat state a client is allowed to write ───────────────────────────────
    //
    // Exactly two fields, on the occupant's own seat: `selfMuted` and
    // `cameraOff`. Both are genuinely the occupant's own business and both change
    // often enough that a round trip through a callable would be felt.
    //
    // A MODERATOR's mute is not here — it goes through `setSeatMuted` below,
    // because who may lift it depends on who placed it, and that is not a
    // question a security rule can answer. Nor is `lockedSeats`, which lives on
    // the room document; that document is server-only now.

    /**
     * My own mic, on my own seat.
     *
     * Deliberately a different field from the moderator's `isMuted`. One boolean
     * for both would mean a guest the owner had muted could unmute themselves,
     * and the mute hierarchy would not exist.
     */
    suspend fun setSelfMuted(roomId: String, seatIndex: Int, muted: Boolean) {
        roomRef(roomId).collection("seats").document(seatIndex.toString())
            .update("selfMuted", muted).await()
    }

    /** My own camera, on my own seat. Video rooms only. */
    suspend fun setCameraOff(roomId: String, seatIndex: Int, off: Boolean) {
        roomRef(roomId).collection("seats").document(seatIndex.toString())
            .update("cameraOff", off).await()
    }

    // ── Gifting ───────────────────────────────────────────────────────────────

    /**
     * Send a gift to somebody on a seat.
     *
     * The recipient is a seat holder the sender picked, not the owner: in a party
     * the owner is often not the person being listened to, and paying the room
     * owner for someone else's performance is the wrong money movement.
     *
     * @return null on success, or a message to show the sender.
     */
    suspend fun sendGiftToSeat(
        roomId: String,
        receiverUid: String,
        giftId: String,
        quantity: Int,
        idempotencyKey: String,
        /** A LUCKY gift's combo (spec §11), sent instead of `quantity`. Null for a normal gift. */
        combo: Int? = null,
    ): String? = when (val res = sendGiftToSeatDetailed(roomId, receiverUid, giftId, quantity, idempotencyKey, combo)) {
        is GiftResult.Error -> res.message
        is GiftResult.InsufficientDiamonds -> "Not enough diamonds — recharge to send this gift."
        is GiftResult.Success, is GiftResult.LuckyWin -> null
    }

    /** [sendGiftToSeat] with the server's answer in full, so a lucky roll reaches the room. */
    suspend fun sendGiftToSeatDetailed(
        roomId: String,
        receiverUid: String,
        giftId: String,
        quantity: Int,
        idempotencyKey: String,
        combo: Int? = null,
    ): GiftResult = when (
        val res = money.settleGift(
            giftId = giftId,
            receiverUid = receiverUid,
            quantity = quantity.coerceIn(1, 9999),
            context = "party",
            roomId = roomId,
            idempotencyKey = idempotencyKey,
            combo = combo,
        )
    ) {
        is MoneyFunctions.Result.Ok -> GiftRepository.resultOf(res.value)
        is MoneyFunctions.Result.Failed -> GiftRepository.failureOf(res)
    }

    // ── Callables ─────────────────────────────────────────────────────────────

    data class CreatedRoom(
        val roomId: String,
        val mode: String,
        val seatCount: Int,
        val seatMode: String,
        val visibility: String,
    )
    data class JoinedRoom(
        val role: String,
        val seatCount: Int,
        val mode: String,
        val seatMode: String,
        val welcomeMessage: String,
    )
    data class TookSeat(val seatIndex: Int, val alreadySeated: Boolean)
    data class LeftSeat(val left: Boolean, val kicked: Boolean, val roomEmpty: Boolean)

    /**
     * Open a room.
     *
     * Any signed-in account may, audio or video — deliberately a different rule
     * from going live. See the note on `createPartyRoom`.
     */
    suspend fun createRoom(
        mode: String,
        title: String,
        seatCount: Int,
        seatMode: String,
        visibility: String,
        password: String,
        welcomeMessage: String,
        category: String = "general",
    ): Result<CreatedRoom> = call("createPartyRoom", buildMap {
        put("mode", mode)
        put("title", title)
        put("category", category)
        put("seatCount", seatCount)
        put("seatMode", seatMode)
        put("visibility", visibility)
        put("welcomeMessage", welcomeMessage)
        if (visibility == PartyRoom.VISIBILITY_PRIVATE) put("password", password)
    }) { m ->
        CreatedRoom(
            roomId     = m["roomId"] as? String ?: "",
            mode       = m["mode"] as? String ?: mode,
            seatCount  = (m["seatCount"] as? Number)?.toInt() ?: PartyRoom.seatsFor(mode, seatCount),
            seatMode   = m["seatMode"] as? String ?: seatMode,
            visibility = m["visibility"] as? String ?: visibility,
        )
    }

    /**
     * Change the room's settings. Owner only.
     *
     * Every argument is optional and only the ones supplied are written, because
     * the settings sheet saves one field at a time and a full-document write
     * would make two people editing different settings clobber each other.
     */
    suspend fun updateRoom(
        roomId: String,
        title: String? = null,
        welcomeMessage: String? = null,
        seatCount: Int? = null,
        seatMode: String? = null,
        visibility: String? = null,
        password: String? = null,
        theme: String? = null,
        blockCalls: Boolean? = null,
    ): Result<Boolean> = call("updatePartyRoom", buildMap {
        put("roomId", roomId)
        title?.let { put("title", it) }
        welcomeMessage?.let { put("welcomeMessage", it) }
        seatCount?.let { put("seatCount", it) }
        seatMode?.let { put("seatMode", it) }
        visibility?.let { put("visibility", it) }
        password?.let { put("password", it) }
        theme?.let { put("theme", it) }
        blockCalls?.let { put("blockCalls", it) }
    }) { m -> m["updated"] as? Boolean ?: false }

    /**
     * Enter the room as a listener.
     *
     * Server-written presence, because it is also where a private room's password
     * is checked — a check is only a check if the thing it guards cannot be
     * written without passing it. It also maintains `listenerCount`, which for
     * most of this feature's life had no writer at all.
     */
    suspend fun joinRoom(roomId: String, password: String = ""): Result<JoinedRoom> =
        call("joinPartyRoom", buildMap {
            put("roomId", roomId)
            if (password.isNotBlank()) put("password", password)
        }) { m ->
            JoinedRoom(
                role           = m["role"] as? String ?: "member",
                seatCount      = (m["seatCount"] as? Number)?.toInt() ?: 0,
                mode           = m["mode"] as? String ?: PartyRoom.MODE_AUDIO,
                seatMode       = m["seatMode"] as? String ?: PartyRoom.SEAT_MODE_FREE,
                welcomeMessage = m["welcomeMessage"] as? String ?: PartyRoom.DEFAULT_WELCOME,
            )
        }

    /** Leave for good: vacate any seat, drop presence, clear the party flag. */
    suspend fun leaveRoom(roomId: String): Result<Boolean> =
        call("leavePartyRoom", mapOf("roomId" to roomId)) { m ->
            m["left"] as? Boolean ?: true
        }

    /**
     * Sit down. Seats are 1-based and the owner takes one like everybody else.
     *
     * In a consent-mode room this is refused with `FAILED_PRECONDITION` and the
     * caller should use [requestSeat] instead. The refusal is explicit rather than
     * silently converted so a stale client cannot seat somebody the owner meant
     * to vet.
     */
    suspend fun takeSeat(roomId: String, seatIndex: Int): Result<TookSeat> =
        call("takePartySeat", mapOf("roomId" to roomId, "seatIndex" to seatIndex)) { m ->
            TookSeat(
                seatIndex     = (m["seatIndex"] as? Number)?.toInt() ?: seatIndex,
                alreadySeated = m["alreadySeated"] as? Boolean ?: false,
            )
        }

    /** Ask for a seat, in a room where seats need consent. */
    suspend fun requestSeat(roomId: String, seatIndex: Int): Result<Int> =
        call("requestPartySeat", mapOf("roomId" to roomId, "seatIndex" to seatIndex)) { m ->
            (m["seatIndex"] as? Number)?.toInt() ?: seatIndex
        }

    /** Withdraw my own request. */
    suspend fun cancelSeatRequest(roomId: String): Result<Boolean> =
        call("cancelPartySeatRequest", mapOf("roomId" to roomId)) { m ->
            m["cancelled"] as? Boolean ?: true
        }

    /** Approve or refuse a waiting request. Owner or admin. */
    suspend fun decideSeatRequest(
        roomId: String,
        targetUid: String,
        approve: Boolean,
    ): Result<Boolean> = call("decidePartySeatRequest", mapOf(
        "roomId" to roomId,
        "targetUid" to targetUid,
        "approve" to approve,
    )) { m -> m["approved"] as? Boolean ?: false }

    /** Offer somebody a seat. They accept or decline; this does not seat them. */
    suspend fun inviteToSeat(
        roomId: String,
        targetUid: String,
        seatIndex: Int,
    ): Result<Boolean> = call("invitePartySeat", mapOf(
        "roomId" to roomId,
        "targetUid" to targetUid,
        "seatIndex" to seatIndex,
    )) { m -> m["invited"] as? Boolean ?: false }

    /** Answer an invitation. */
    suspend fun respondToInvite(roomId: String, accept: Boolean): Result<Boolean> =
        call("respondPartySeatInvite", mapOf("roomId" to roomId, "accept" to accept)) { m ->
            m["accepted"] as? Boolean ?: false
        }

    /**
     * Stand up, or take somebody off a seat, or remove them from the room.
     *
     * [kick] is the harsh one: it also adds them to `kickedUsers`, which is what
     * makes `generateAgoraToken` refuse them and turns a UI removal into a real
     * one that lasts until the room closes.
     */
    suspend fun leaveSeat(
        roomId: String,
        targetUid: String = "",
        kick: Boolean = false,
    ): Result<LeftSeat> = call("leavePartySeat", buildMap {
        put("roomId", roomId)
        if (targetUid.isNotBlank()) put("targetUid", targetUid)
        if (kick) put("kick", true)
    }) { m ->
        LeftSeat(
            left      = m["left"] as? Boolean ?: false,
            kicked    = m["kicked"] as? Boolean ?: false,
            roomEmpty = m["roomEmpty"] as? Boolean ?: false,
        )
    }

    /**
     * Mute or unmute a seat as a moderator.
     *
     * A callable rather than a field write because the unmute rule depends on who
     * placed the mute: only the owner can lift an owner's, and an admin's can be
     * lifted by the owner or by that same admin. No security rule can express
     * that, which is why the admin tier did not exist before.
     */
    suspend fun setSeatMuted(
        roomId: String,
        seatIndex: Int,
        muted: Boolean,
    ): Result<Boolean> = call("setPartySeatMute", mapOf(
        "roomId" to roomId,
        "seatIndex" to seatIndex,
        "muted" to muted,
    )) { m -> m["muted"] as? Boolean ?: muted }

    /** Close or reopen a seat. Owner or admin. */
    suspend fun setSeatLocked(
        roomId: String,
        seatIndex: Int,
        locked: Boolean,
    ): Result<Boolean> = call("setPartySeatLock", mapOf(
        "roomId" to roomId,
        "seatIndex" to seatIndex,
        "locked" to locked,
    )) { m -> m["locked"] as? Boolean ?: locked }

    /** Appoint or dismiss an admin. Owner only. */
    suspend fun setAdmin(
        roomId: String,
        targetUid: String,
        isAdmin: Boolean,
    ): Result<Boolean> = call("setPartyAdmin", mapOf(
        "roomId" to roomId,
        "targetUid" to targetUid,
        "isAdmin" to isAdmin,
    )) { m -> m["isAdmin"] as? Boolean ?: isAdmin }

    /**
     * Close the room.
     *
     * The owner may always. Anybody else only once nobody is in it — no one on a seat AND no one in the lobby
     * (B2a). The app no longer closes a room by itself: the server's sweep closes one that nobody is in.
     */
    suspend fun endRoom(roomId: String): Result<Boolean> =
        call("endPartyRoom", mapOf("roomId" to roomId)) { m ->
            m["ended"] as? Boolean ?: true
        }

    /** What `partyHeartbeat` answered: is the room open, and is my listener row still there. */
    data class Heartbeat(val active: Boolean, val present: Boolean)

    /**
     * "I am still in this room" — B2a. Sent every [PartyHeartbeatPolicy.EVERY_MS] while the room is open on this
     * phone. A listener that goes quiet for three minutes is removed by the server, so a dead phone cannot keep a
     * room alive; `present = false` means that happened and the room should be joined again.
     */
    suspend fun heartbeat(roomId: String): Result<Heartbeat> =
        call("partyHeartbeat", mapOf("roomId" to roomId)) { m ->
            Heartbeat(active = m["active"] as? Boolean ?: false, present = m["present"] as? Boolean ?: false)
        }

    // ── Plumbing ──────────────────────────────────────────────────────────────

    @Suppress("UNCHECKED_CAST")
    private suspend fun <T> call(
        name: String,
        payload: Map<String, Any>,
        parse: (Map<String, Any?>) -> T,
    ): Result<T> = try {
        val res = functions.getHttpsCallable(name).call(sessionManager.withSession(payload)).await()
        val map = res.data as? Map<String, Any?> ?: emptyMap()
        Result.Ok(parse(map))
    } catch (e: FirebaseFunctionsException) {
        // P0-1: a session refusal also signs this device out (SessionViewModel).
        ServerRefusals.report(e)
        Result.Failed(e.code.name, e.message ?: "Something went wrong.", ((e.details as? Map<*, *>)?.get("code") as? String).orEmpty())
    } catch (e: Exception) {
        Result.Failed("unavailable", "Could not reach the server. Check your connection.")
    }

    // ── Party Pro: private rooms (B7, 3 Nov 2026) ─────────────────────────────

    data class ProStatus(
        val enabled: Boolean,
        val required: Boolean,
        val minLevel: Int,
        val level: Int,
        val eligible: Boolean,
        val priceDiamonds: Long,
        val priceInr: Double,
        val days: Int,
        val active: Boolean,
        val expiresAtMs: Long,
        val autoRenew: Boolean,
        val diamonds: Long,
    )

    suspend fun proStatus(): Result<ProStatus> = call("privateRoomSubscriptionStatus", emptyMap()) { m ->
        ProStatus(
            enabled = m["enabled"] as? Boolean ?: true,
            required = m["required"] as? Boolean ?: true,
            minLevel = (m["minLevel"] as? Number)?.toInt() ?: 7,
            level = (m["level"] as? Number)?.toInt() ?: 0,
            eligible = m["eligible"] as? Boolean ?: false,
            priceDiamonds = (m["priceDiamonds"] as? Number)?.toLong() ?: 0L,
            priceInr = (m["priceInr"] as? Number)?.toDouble() ?: 200.0,
            days = (m["days"] as? Number)?.toInt() ?: 30,
            active = m["active"] as? Boolean ?: false,
            expiresAtMs = (m["expiresAtMs"] as? Number)?.toLong() ?: 0L,
            autoRenew = m["autoRenew"] as? Boolean ?: false,
            diamonds = (m["diamonds"] as? Number)?.toLong() ?: 0L,
        )
    }

    /** The server takes the diamonds and extends the subscription; [key] is made once per tap, kept for retries. */
    suspend fun subscribePro(key: String): Result<Long> =
        call("subscribePrivateRooms", mapOf("idempotencyKey" to key)) { m -> (m["expiresAtMs"] as? Number)?.toLong() ?: 0L }

    /** Renewal off; access lasts to the end of the period paid for. */
    suspend fun cancelPro(): Result<Long> =
        call("cancelPrivateRoomSubscription", emptyMap()) { m -> (m["expiresAtMs"] as? Number)?.toLong() ?: 0L }

    /** Zipper staff allowed into private rooms enter without the PIN — logged and shown in the room. */
    suspend fun joinRoomAsOfficial(roomId: String): Result<JoinedRoom> =
        call("joinPartyRoom", mapOf("roomId" to roomId, "official" to true)) { m ->
            JoinedRoom(
                role           = m["role"] as? String ?: "member",
                seatCount      = (m["seatCount"] as? Number)?.toInt() ?: 0,
                mode           = m["mode"] as? String ?: PartyRoom.MODE_AUDIO,
                seatMode       = m["seatMode"] as? String ?: PartyRoom.SEAT_MODE_FREE,
                welcomeMessage = m["welcomeMessage"] as? String ?: PartyRoom.DEFAULT_WELCOME,
            )
        }

    // ── B7: room music ────────────────────────────────────────────────────────

    data class MusicTrack(val id: String, val title: String, val artist: String, val url: String)

    /** Zipper's licensed catalogue (enabled tracks only). Empty when the Owner has added none. */
    fun musicTracksFlow(): kotlinx.coroutines.flow.Flow<List<MusicTrack>> = kotlinx.coroutines.flow.callbackFlow {
        val reg = firestore.collection("musicTracks").whereEqualTo("enabled", true).limit(100)
            .addSnapshotListener { snap, err ->
                trySend(
                    if (err != null || snap == null) emptyList()
                    else snap.documents.map { MusicTrack(it.id, it.getString("title").orEmpty(), it.getString("artist").orEmpty(), it.getString("url").orEmpty()) },
                )
            }
        awaitClose { reg.remove() }
    }

    /** Owner or admin: play a catalogue track ([trackId]) or stop ([trackId] null). The server checks both. */
    suspend fun setMusic(roomId: String, trackId: String?, playing: Boolean = true): Result<Boolean> =
        call("setPartyMusic", buildMap {
            put("roomId", roomId)
            if (trackId != null) { put("trackId", trackId); put("playing", playing) }
        }) { m -> m["playing"] as? Boolean ?: false }

    data class AccessEntry(val uid: String, val name: String, val result: String, val atMs: Long, val role: String)

    /** The room's access log, newest first — the owner's (and staff's) to read. Empty on any error. */
    fun accessLogFlow(roomId: String): kotlinx.coroutines.flow.Flow<List<AccessEntry>> = kotlinx.coroutines.flow.callbackFlow {
        val reg = firestore.collection("partyRooms").document(roomId).collection("accessLog")
            .orderBy("atMs", com.google.firebase.firestore.Query.Direction.DESCENDING).limit(100)
            .addSnapshotListener { snap, err ->
                trySend(
                    if (err != null || snap == null) emptyList()
                    else snap.documents.map {
                        AccessEntry(it.getString("uid").orEmpty(), it.getString("name").orEmpty(), it.getString("result").orEmpty(),
                            it.getLong("atMs") ?: 0L, it.getString("role").orEmpty())
                    },
                )
            }
        awaitClose { reg.remove() }
    }

    /** Whether this account may use official access — read from its own CRM record (false when it has none). */
    suspend fun officialAccessAllowed(): Boolean = try {
        val uid = com.google.firebase.auth.FirebaseAuth.getInstance().currentUser?.uid.orEmpty()
        if (uid.isBlank()) false else {
            val d = firestore.collection("crmUsers").document(uid).get().await()
            val role = d.getString("role").orEmpty()
            d.exists() && d.getBoolean("isActive") != false &&
                (role == "superadmin" || (Regex("^(app|ops|support|tech|finance|marketing)_(admin|member)$").matches(role) && d.getBoolean("privateRoomAccess") == true))
        }
    } catch (_: Exception) { false }
}

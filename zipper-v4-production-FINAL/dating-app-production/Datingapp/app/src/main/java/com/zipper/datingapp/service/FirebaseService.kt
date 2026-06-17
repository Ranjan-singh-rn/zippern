package com.zipper.datingapp.service

import android.net.Uri
import android.util.Log
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.database.ChildEventListener
import com.google.firebase.database.DataSnapshot
import com.google.firebase.database.DatabaseError
import com.google.firebase.database.DatabaseReference
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.database.ValueEventListener
import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.SetOptions
import com.google.firebase.firestore.Source
import com.zipper.datingapp.data.Agency
import com.zipper.datingapp.data.AudioPartyStreamState
import com.zipper.datingapp.data.AudioPartyVideoCallRequest
import com.zipper.datingapp.data.toAudioPartyStreamState
import com.zipper.datingapp.data.Battle
import com.zipper.datingapp.data.BattleStatus
import com.zipper.datingapp.data.CallHistoryEntry
import com.zipper.datingapp.data.CallSession
import com.zipper.datingapp.data.ChatMessage
import com.zipper.datingapp.data.ChatThread
import com.zipper.datingapp.data.CrmAnnouncement
import com.zipper.datingapp.data.GameState
import com.zipper.datingapp.data.Gift
import com.zipper.datingapp.data.LiveChatMessage
import com.zipper.datingapp.data.LiveStream
import com.zipper.datingapp.data.LiveStreamChatMessage
import com.zipper.datingapp.data.LiveStreamRoomInfo
import com.zipper.datingapp.data.Message
import com.zipper.datingapp.data.PartyRoom
import com.zipper.datingapp.data.PkBattleSession
import com.zipper.datingapp.data.ResellAgent
import com.zipper.datingapp.data.SeatRequest
import com.zipper.datingapp.data.SentGiftHistoryEntry
import com.zipper.datingapp.data.Transaction
import com.zipper.datingapp.data.UserProfile
import com.zipper.datingapp.economy.VirtualEconomyMath
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await
import org.webrtc.PeerConnection

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ZIPPER FIREBASE SERVICE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Central repository for ALL Firestore + RTDB operations.
 * The ViewModel never touches Firebase directly — everything goes through here.
 *
 * Economy-critical writes (marked ⚠️) fire a Firestore document write that
 * triggers a Cloud Function for server-side validation. The client write is
 * optimistic UI only; the Cloud Function is authoritative.
 * ─────────────────────────────────────────────────────────────────────────────
 */
class FirebaseService(
    private val firestore: FirebaseFirestore = FirebaseFirestore.getInstance(),
    private val rtdb: FirebaseDatabase = FirebaseDatabase.getInstance(),
    private val auth: FirebaseAuth = FirebaseAuth.getInstance(),
) {

    private val uid get() = auth.currentUser?.uid

    /** Alias so existing code using [db] compiles without change. */
    private val db get() = firestore

    // ─────────────────────────────────────────────────────────────────────────
    // USER PROFILES
    // ─────────────────────────────────────────────────────────────────────────

    /** Fetch a single user profile. */
    suspend fun fetchUser(userId: String): UserProfile? = try {
        firestore.collection("users").document(userId).get().await()
            .toObject(UserProfile::class.java)?.copy(id = userId)
    } catch (e: Exception) {
        Log.e(TAG, "fetchUser($userId)", e); null
    }

    /** Real-time listener on a user profile document. */
    fun observeUser(userId: String): Flow<UserProfile?> = callbackFlow {
        val reg = firestore.collection("users").document(userId)
            .addSnapshotListener { snap, err ->
                if (err != null) { Log.e(TAG, "observeUser", err); return@addSnapshotListener }
                trySend(snap?.toObject(UserProfile::class.java)?.copy(id = userId))
            }
        awaitClose { reg.remove() }
    }

    /** Fetch the currently logged-in user's profile. */
    suspend fun fetchCurrentUser(): UserProfile? = uid?.let { fetchUser(it) }

    /**
     * Fetch paginated profiles for the home discovery feed.
     * Excludes the current user. Sorted by online → lastSeen.
     */
    suspend fun fetchDiscoveryProfiles(
        limit: Long = 50,
        filterCity: String? = null,
        filterHobbies: List<String> = emptyList(),
        filterLanguage: String? = null,
    ): List<UserProfile> = try {
        var query: Query = firestore.collection("users")
            .whereEqualTo("isGuest", false)
        if (!filterCity.isNullOrBlank()) query = query.whereEqualTo("city", filterCity)
        if (!filterLanguage.isNullOrBlank()) query = query.whereEqualTo("languages", filterLanguage)
        if (filterHobbies.isNotEmpty()) {
            query = query.whereArrayContainsAny("hobbies", filterHobbies.take(10))
        }
        query = query
            .orderBy("isOnline", Query.Direction.DESCENDING)
            .orderBy("lastSeen", Query.Direction.DESCENDING)
            .limit(limit)
        query.get().await().documents
            .mapNotNull { it.toObject(UserProfile::class.java)?.copy(id = it.id) }
            .filter { it.id != uid }
    } catch (e: Exception) {
        Log.e(TAG, "fetchDiscoveryProfiles", e); emptyList()
    }

    /** Search users by name prefix (for the search bar). Excludes self. */
    suspend fun searchUsers(query: String): List<UserProfile> {
        val q = query.trim()
        if (q.isBlank()) return emptyList()
        return try {
            val end = q.dropLast(1) + (q.last() + 1)
            firestore.collection("users")
                .orderBy("name")
                .startAt(q).endBefore(end)
                .limit(20)
                .get().await().documents
                .mapNotNull { it.toObject(UserProfile::class.java)?.copy(id = it.id) }
                .filter { it.id != uid }
        } catch (e: Exception) {
            Log.e(TAG, "searchUsers", e); emptyList()
        }
    }

    /** Update the current user's online/offline presence. */
    suspend fun setOnlineStatus(isOnline: Boolean) {
        val userId = uid ?: return
        try {
            firestore.collection("users").document(userId).update(
                "isOnline", isOnline,
                "lastSeen", System.currentTimeMillis()
            ).await()
        } catch (e: Exception) {
            Log.e(TAG, "setOnlineStatus", e)
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // LIKES / FOLLOWS
    // ─────────────────────────────────────────────────────────────────────────

    suspend fun likeUser(targetUserId: String) {
        val myId = uid ?: return
        try {
            firestore.collection("likes").document("${myId}_$targetUserId")
                .set(mapOf(
                    "likerId" to myId,
                    "likedId" to targetUserId,
                    "timestamp" to System.currentTimeMillis()
                )).await()
            firestore.collection("users").document(targetUserId)
                .update("likeMeCount", FieldValue.increment(1)).await()
        } catch (e: Exception) { Log.e(TAG, "likeUser", e) }
    }

    suspend fun followUser(targetUserId: String) {
        val myId = uid ?: return
        try {
            val batch = firestore.batch()
            batch.set(
                firestore.collection("follows").document("${myId}_$targetUserId"),
                mapOf("followerId" to myId, "followingId" to targetUserId, "timestamp" to System.currentTimeMillis())
            )
            batch.update(firestore.collection("users").document(myId), "following", FieldValue.increment(1))
            batch.update(firestore.collection("users").document(targetUserId), "followers", FieldValue.increment(1))
            batch.commit().await()
        } catch (e: Exception) { Log.e(TAG, "followUser", e) }
    }

    suspend fun unfollowUser(targetUserId: String) {
        val myId = uid ?: return
        try {
            val batch = firestore.batch()
            batch.delete(firestore.collection("follows").document("${myId}_$targetUserId"))
            batch.update(firestore.collection("users").document(myId), "following", FieldValue.increment(-1))
            batch.update(firestore.collection("users").document(targetUserId), "followers", FieldValue.increment(-1))
            batch.commit().await()
        } catch (e: Exception) { Log.e(TAG, "unfollowUser", e) }
    }

    suspend fun isFollowing(targetUserId: String): Boolean {
        val myId = uid ?: return false
        return try {
            firestore.collection("follows").document("${myId}_$targetUserId").get().await().exists()
        } catch (e: Exception) { false }
    }

    suspend fun fetchLikedMeProfiles(): List<UserProfile> {
        val myId = uid ?: return emptyList()
        return try {
            val ids = firestore.collection("likes")
                .whereEqualTo("likedId", myId)
                .orderBy("timestamp", Query.Direction.DESCENDING)
                .limit(100).get().await()
                .documents.mapNotNull { it.getString("likerId") }
            ids.mapNotNull { fetchUser(it) }
        } catch (e: Exception) { Log.e(TAG, "fetchLikedMeProfiles", e); emptyList() }
    }

    suspend fun fetchFollowingProfiles(): List<UserProfile> {
        val myId = uid ?: return emptyList()
        return try {
            val ids = firestore.collection("follows")
                .whereEqualTo("followerId", myId)
                .limit(100).get().await()
                .documents.mapNotNull { it.getString("followingId") }
            ids.mapNotNull { fetchUser(it) }
        } catch (e: Exception) { Log.e(TAG, "fetchFollowingProfiles", e); emptyList() }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // LIVE STREAMS
    // ─────────────────────────────────────────────────────────────────────────

    suspend fun fetchActiveLiveStreams(
        filterCity: String? = null,
        filterLanguage: String? = null,
        filterHobbies: List<String> = emptyList(),
    ): List<LiveStream> = try {
        var query: Query = firestore.collection("live_streams").whereEqualTo("isActive", true)
        if (!filterCity.isNullOrBlank()) query = query.whereEqualTo("city", filterCity)
        if (!filterLanguage.isNullOrBlank()) query = query.whereEqualTo("language", filterLanguage)
        if (filterHobbies.isNotEmpty()) query = query.whereArrayContainsAny("hobbies", filterHobbies.take(10))
        query.orderBy("viewerCount", Query.Direction.DESCENDING).limit(50)
            .get().await().mapNotNull { it.toObject(LiveStream::class.java)?.copy(id = it.id) }
    } catch (e: Exception) { Log.e(TAG, "fetchActiveLiveStreams", e); emptyList() }

    fun observeActiveLiveStreams(): Flow<List<LiveStream>> = callbackFlow {
        val reg = firestore.collection("live_streams")
            .whereEqualTo("isActive", true)
            .orderBy("viewerCount", Query.Direction.DESCENDING)
            .limit(50)
            .addSnapshotListener { snap, err ->
                if (err != null) { return@addSnapshotListener }
                trySend(snap?.mapNotNull { it.toObject(LiveStream::class.java)?.copy(id = it.id) } ?: emptyList())
            }
        awaitClose { reg.remove() }
    }

    fun observeLiveStream(streamId: String): Flow<LiveStream?> = callbackFlow {
        val reg = firestore.collection("live_streams").document(streamId)
            .addSnapshotListener { snap, _ ->
                trySend(snap?.toObject(LiveStream::class.java)?.copy(id = streamId))
            }
        awaitClose { reg.remove() }
    }

    /** Create a live stream document. Returns the new stream ID. */
    suspend fun startLiveStream(stream: LiveStream): String? = try {
        val ref = firestore.collection("live_streams").document()
        ref.set(stream.copy(id = ref.id)).await()
        uid?.let { firestore.collection("users").document(it).update("isLive", true).await() }
        ref.id
    } catch (e: Exception) { Log.e(TAG, "startLiveStream", e); null }

    suspend fun endLiveStream(hostUid: String, streamDocId: String? = null) {
        try {
            val docId = streamDocId?.trim()?.takeIf { it.isNotEmpty() } ?: hostUid
            firestore.collection("live_streams").document(docId)
                .update("isActive", false, "endedAt", System.currentTimeMillis()).await()
            firestore.collection("users").document(hostUid)
                .update("isLive", false).await()
        } catch (e: Exception) { Log.e(TAG, "endLiveStream", e) }
    }

    suspend fun joinLiveAsViewer(streamId: String) {
        val myId = uid ?: return
        try {
            firestore.collection("live_streams").document(streamId).update(
                "viewerIds", FieldValue.arrayUnion(myId),
                "viewerCount", FieldValue.increment(1)
            ).await()
        } catch (e: Exception) { Log.e(TAG, "joinLiveAsViewer", e) }
    }

    suspend fun leaveLiveAsViewer(streamId: String) {
        val myId = uid ?: return
        try {
            firestore.collection("live_streams").document(streamId).update(
                "viewerIds", FieldValue.arrayRemove(myId),
                "viewerCount", FieldValue.increment(-1)
            ).await()
        } catch (e: Exception) { Log.e(TAG, "leaveLiveAsViewer", e) }
    }

    /** Host kicks a viewer. Adds to kickedViewerIds so they can't rejoin until stream restarts. */
    suspend fun kickViewerFromLive(streamId: String, targetUserId: String) {
        try {
            firestore.collection("live_streams").document(streamId).update(
                "kickedViewerIds", FieldValue.arrayUnion(targetUserId),
                "viewerIds", FieldValue.arrayRemove(targetUserId),
                "viewerCount", FieldValue.increment(-1)
            ).await()
        } catch (e: Exception) { Log.e(TAG, "kickViewerFromLive", e) }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // LIVE CHAT (Realtime Database — low-latency)
    // ─────────────────────────────────────────────────────────────────────────

    suspend fun sendLiveChatMessage(streamId: String, message: LiveChatMessage) {
        try {
            val ref = rtdb.getReference("live_chat/$streamId").push()
            ref.setValue(message.copy(id = ref.key ?: "")).await()
        } catch (e: Exception) { Log.e(TAG, "sendLiveChatMessage", e) }
    }

    /** Real-time stream of the last [limit] messages in a live room. */
    fun observeLiveChat(streamId: String, limit: Int = 100): Flow<List<LiveChatMessage>> = callbackFlow {
        val ref = rtdb.getReference("live_chat/$streamId").limitToLast(limit)
        val listener = object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                trySend(snapshot.children.mapNotNull { it.getValue(LiveChatMessage::class.java) })
            }
            override fun onCancelled(error: DatabaseError) {
                Log.e(TAG, "observeLiveChat", error.toException())
            }
        }
        ref.addValueEventListener(listener)
        awaitClose { ref.removeEventListener(listener) }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PARTY ROOMS
    // ─────────────────────────────────────────────────────────────────────────

    suspend fun fetchActivePartyRooms(): List<PartyRoom> = try {
        firestore.collection("party_rooms")
            .whereEqualTo("isActive", true)
            .orderBy("participantCount", Query.Direction.DESCENDING)
            .limit(30).get().await()
            .mapNotNull { it.toObject(PartyRoom::class.java)?.copy(id = it.id) }
    } catch (e: Exception) { Log.e(TAG, "fetchActivePartyRooms", e); emptyList() }

    fun observeActivePartyRooms(): Flow<List<PartyRoom>> = callbackFlow {
        val reg = firestore.collection("party_rooms")
            .whereEqualTo("isActive", true)
            .orderBy("participantCount", Query.Direction.DESCENDING)
            .limit(30)
            .addSnapshotListener { snap, _ ->
                trySend(snap?.mapNotNull { it.toObject(PartyRoom::class.java)?.copy(id = it.id) } ?: emptyList())
            }
        awaitClose { reg.remove() }
    }

    fun observePartyRoom(roomId: String): Flow<PartyRoom?> = callbackFlow {
        val reg = firestore.collection("party_rooms").document(roomId)
            .addSnapshotListener { snap, _ ->
                trySend(snap?.toObject(PartyRoom::class.java)?.copy(id = roomId))
            }
        awaitClose { reg.remove() }
    }

    suspend fun createPartyRoom(room: PartyRoom): String? = try {
        val ref = firestore.collection("party_rooms").document()
        ref.set(room.copy(id = ref.id)).await()
        uid?.let {
            firestore.collection("users").document(it).update("isInPartyRoom", true).await()
        }
        ref.id
    } catch (e: Exception) { Log.e(TAG, "createPartyRoom", e); null }

    suspend fun endPartyRoom(roomId: String) {
        try {
            firestore.collection("party_rooms").document(roomId)
                .update("isActive", false).await()
            uid?.let {
                firestore.collection("users").document(it).update("isInPartyRoom", false).await()
            }
        } catch (e: Exception) { Log.e(TAG, "endPartyRoom", e) }
    }

    suspend fun requestPartySeat(roomId: String, request: SeatRequest) {
        try {
            firestore.collection("party_rooms").document(roomId)
                .update("pendingRequests", FieldValue.arrayUnion(request)).await()
        } catch (e: Exception) { Log.e(TAG, "requestPartySeat", e) }
    }

    suspend fun acceptSeatRequest(roomId: String, request: SeatRequest) {
        try {
            firestore.collection("party_rooms").document(roomId)
                .update("pendingRequests", FieldValue.arrayRemove(request)).await()
        } catch (e: Exception) { Log.e(TAG, "acceptSeatRequest", e) }
    }

    suspend fun rejectSeatRequest(roomId: String, request: SeatRequest) {
        try {
            firestore.collection("party_rooms").document(roomId)
                .update("pendingRequests", FieldValue.arrayRemove(request)).await()
        } catch (e: Exception) { Log.e(TAG, "rejectSeatRequest", e) }
    }

    suspend fun updatePartyRoom(roomId: String, updates: Map<String, Any>) {
        try {
            firestore.collection("party_rooms").document(roomId).update(updates).await()
        } catch (e: Exception) { Log.e(TAG, "updatePartyRoom", e) }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GIFTS
    // ─────────────────────────────────────────────────────────────────────────

    suspend fun fetchGiftCatalog(): List<Gift> = try {
        firestore.collection("gifts")
            .whereEqualTo("isActive", true)
            .orderBy("sortOrder")
            .get().await()
            .mapNotNull { it.toObject(Gift::class.java)?.copy(id = it.id) }
    } catch (e: Exception) { Log.e(TAG, "fetchGiftCatalog", e); emptyList() }

    /**
     * ⚠️ ECONOMY-CRITICAL: Records a gift send intent.
     * A Cloud Function listens to `gift_sends` collection and:
     *  - Deducts diamonds from sender
     *  - Credits beans to recipient (split per GiftType)
     *  - Creates transaction records for both parties
     *  - Updates totalBeansEarned / totalDiamondsSpent for level calculation
     *
     * @param streamId If sent during a live, the stream ID (for battle support tracking)
     * @param battleId If this is PK support, the battle ID
     */
    suspend fun sendGift(
        recipientId: String,
        gift: Gift,
        quantity: Int,
        streamId: String? = null,
        battleId: String? = null,
    ): String? = try {
        val myId = uid ?: return null
        val (beansToRecipient, _) = VirtualEconomyMath.computeGiftSplit(gift, quantity)
        val ref = firestore.collection("gift_sends").document()
        ref.set(mapOf(
            "id" to ref.id,
            "senderId" to myId,
            "recipientId" to recipientId,
            "giftId" to gift.id,
            "giftName" to gift.name,
            "giftType" to gift.giftType,
            "diamondCostEach" to gift.effectivePrice(),
            "quantity" to quantity,
            "totalDiamondCost" to (gift.effectivePrice() * quantity).toLong(),
            "beansToRecipient" to beansToRecipient,
            "streamId" to streamId,
            "battleId" to battleId,
            "status" to "PENDING",   // Cloud Function processes → "COMPLETED" | "FAILED"
            "timestamp" to System.currentTimeMillis(),
        )).await()
        ref.id
    } catch (e: Exception) { Log.e(TAG, "sendGift", e); null }

    /**
     * Live-economy gift send used by [com.zipper.datingapp.LiveStreamActivity].
     * Returns [LiveEconomyGiftResult.Success] with confirmed new wallet balance on success,
     * or [LiveEconomyGiftResult.Failed] with a user-facing reason on failure.
     *
     * @param transactionId Caller-generated UUID for deduplication
     * @param senderId Firebase UID of the gift sender
     * @param hostId Firebase UID of the gift recipient (host / PK battler)
     * @param giftCost Total diamond cost (price × quantity)
     * @param gift The gift being sent (used for PK scoring split)
     * @param livePkScoreStreamDocId Firestore live_stream doc ID used for PK scoring (host uid); null for non-PK
     * @param livePkScoreDelta Beans delta to increment on the host doc for PK tug; 0 for non-PK
     */
    suspend fun sendGift(
        transactionId: String,
        senderId: String,
        hostId: String,
        giftCost: Int,
        gift: Gift,
        livePkScoreStreamDocId: String? = null,
        livePkScoreDelta: Long = 0L,
    ): LiveEconomyGiftResult {
        return try {
            if (giftCost <= 0) return LiveEconomyGiftResult.Failed("Invalid gift cost")
            // Check sender balance
            val senderDoc = firestore.collection("users").document(senderId).get().await()
            val currentBalance = (senderDoc.getLong("diamondBalance") ?: 0L).toInt()
            if (currentBalance < giftCost) {
                return LiveEconomyGiftResult.Failed("Insufficient diamonds")
            }
            val newBalance = currentBalance - giftCost
            val beansToRecipient = VirtualEconomyMath.giftReceiverBeansEarned(giftCost.toLong(), gift)

            val batch = firestore.batch()

            // Deduct sender diamonds
            batch.update(
                firestore.collection("users").document(senderId),
                "diamondBalance", FieldValue.increment(-giftCost.toLong()),
                "totalDiamondsSpent", FieldValue.increment(giftCost.toLong()),
            )
            // Credit recipient beans
            if (beansToRecipient > 0L) {
                batch.update(
                    firestore.collection("users").document(hostId),
                    "beanBalance", FieldValue.increment(beansToRecipient),
                    "totalBeansEarned", FieldValue.increment(beansToRecipient),
                )
            }
            // PK scoring: increment host-side bean total on the live_streams doc
            if (!livePkScoreStreamDocId.isNullOrBlank() && livePkScoreDelta > 0L) {
                val isForHost = hostId == livePkScoreStreamDocId
                val field = if (isForHost) "pkHostBeans" else "pkGuestBeans"
                batch.update(
                    firestore.collection("live_streams").document(livePkScoreStreamDocId),
                    field, FieldValue.increment(livePkScoreDelta),
                )
            }
            // Write gift transaction record
            val txRef = firestore.collection("gift_transactions").document(transactionId)
            batch.set(txRef, mapOf(
                "transactionId" to transactionId,
                "senderId" to senderId,
                "receiverId" to hostId,
                "giftId" to gift.id,
                "giftName" to gift.name,
                "giftType" to gift.giftType,
                "diamondCost" to giftCost,
                "beansAwarded" to beansToRecipient,
                "pkScoreDelta" to livePkScoreDelta,
                "pkStreamDoc" to (livePkScoreStreamDocId ?: ""),
                "timestamp" to System.currentTimeMillis(),
            ))

            batch.commit().await()
            LiveEconomyGiftResult.Success(newWalletBalance = newBalance)
        } catch (e: Exception) {
            Log.e(TAG, "sendGift(live)", e)
            LiveEconomyGiftResult.Failed(e.message ?: "Gift send failed")
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CALLS
    // ─────────────────────────────────────────────────────────────────────────

    suspend fun createCallSession(call: CallSession): String? = try {
        val ref = firestore.collection("calls").document()
        ref.set(call.copy(id = ref.id)).await()
        ref.id
    } catch (e: Exception) { Log.e(TAG, "createCallSession", e); null }

    fun observeCallSession(callId: String): Flow<CallSession?> = callbackFlow {
        val reg = firestore.collection("calls").document(callId)
            .addSnapshotListener { snap, _ ->
                trySend(snap?.toObject(CallSession::class.java)?.copy(id = callId))
            }
        awaitClose { reg.remove() }
    }

    suspend fun updateCallStatus(callId: String, status: String) {
        try {
            firestore.collection("calls").document(callId).update("status", status).await()
        } catch (e: Exception) { Log.e(TAG, "updateCallStatus", e) }
    }

    /**
     * ⚠️ ECONOMY-CRITICAL: End call — Cloud Function handles per-minute billing.
     * Client writes duration; Cloud Function computes diamonds/beans and updates balances.
     */
    suspend fun endCallSession(callId: String, durationSeconds: Int) {
        try {
            firestore.collection("calls").document(callId).update(
                "status", "ENDED",
                "endedAt", System.currentTimeMillis(),
                "durationSeconds", durationSeconds
            ).await()
        } catch (e: Exception) { Log.e(TAG, "endCallSession", e) }
    }

    suspend fun fetchCallHistory(): List<CallHistoryEntry> {
        val myId = uid ?: return emptyList()
        return try {
            val asCaller = firestore.collection("calls")
                .whereEqualTo("callerId", myId)
                .whereEqualTo("status", "ENDED")
                .orderBy("startedAt", Query.Direction.DESCENDING)
                .limit(50).get().await().documents
            val asCallee = firestore.collection("calls")
                .whereEqualTo("calleeId", myId)
                .whereEqualTo("status", "ENDED")
                .orderBy("startedAt", Query.Direction.DESCENDING)
                .limit(50).get().await().documents

            (asCaller + asCallee)
                .mapNotNull { doc ->
                    val call = doc.toObject(CallSession::class.java) ?: return@mapNotNull null
                    val isOutgoing = call.callerId == myId
                    CallHistoryEntry(
                        id = doc.id,
                        partnerId = if (isOutgoing) call.calleeId else call.callerId,
                        partnerName = if (isOutgoing) call.calleeName else call.callerName,
                        partnerPhotoUrl = if (isOutgoing) call.calleePhotoUrl else call.callerPhotoUrl,
                        isVideoCall = call.isVideoCall,
                        wasOutgoing = isOutgoing,
                        durationSeconds = call.durationSeconds,
                        diamondsSpent = if (isOutgoing) call.totalDiamondsCharged else 0,
                        beansEarned = if (!isOutgoing) call.totalBeansAwarded else 0,
                        timestamp = call.startedAt,
                        status = call.status,
                    )
                }
                .sortedByDescending { it.timestamp }
        } catch (e: Exception) { Log.e(TAG, "fetchCallHistory", e); emptyList() }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PK BATTLES
    // ─────────────────────────────────────────────────────────────────────────

    suspend fun createPkBattle(battle: PkBattleSession): String? = try {
        val ref = firestore.collection("battles").document()
        ref.set(battle.copy(id = ref.id)).await()
        ref.id
    } catch (e: Exception) { Log.e(TAG, "createPkBattle", e); null }

    fun observePkBattle(battleId: String): Flow<PkBattleSession?> = callbackFlow {
        val reg = firestore.collection("battles").document(battleId)
            .addSnapshotListener { snap, _ ->
                trySend(snap?.toObject(PkBattleSession::class.java)?.copy(id = battleId))
            }
        awaitClose { reg.remove() }
    }

    /**
     * Look for another live host already in SEARCHING state for PK matchmaking.
     * Sets the caller's stream as PKsearching, then checks for a waiting opponent.
     */
    suspend fun findPkPartner(myStreamId: String): PkBattleSession? {
        val myId = uid ?: return null
        return try {
            firestore.collection("live_streams").document(myStreamId)
                .update("isPkSearching", true).await()
            val existing = firestore.collection("battles")
                .whereEqualTo("status", BattleStatus.SEARCHING.name)
                .whereNotEqualTo("hostUserId", myId)
                .limit(1).get().await()
            if (!existing.isEmpty) existing.documents.first().toObject(PkBattleSession::class.java)
            else null
        } catch (e: Exception) { Log.e(TAG, "findPkPartner", e); null }
    }

    suspend fun acceptPkBattle(battleId: String, guestId: String, guestStreamId: String) {
        try {
            val now = System.currentTimeMillis()
            firestore.collection("battles").document(battleId).update(
                "guestUserId", guestId,
                "guestLiveStreamId", guestStreamId,
                "status", BattleStatus.ACTIVE.name,
                "pkStartTimeMillis", now,
                "endsAtMillis", now + 3 * 60 * 1000L   // 3-minute battle
            ).await()
        } catch (e: Exception) { Log.e(TAG, "acceptPkBattle", e) }
    }

    /** Add diamond support for one side during a PK battle. */
    suspend fun addPkSupport(battleId: String, isForHost: Boolean, diamondAmount: Long) {
        try {
            val field = if (isForHost) "hostDiamondSupport" else "guestDiamondSupport"
            firestore.collection("battles").document(battleId)
                .update(field, FieldValue.increment(diamondAmount)).await()
        } catch (e: Exception) { Log.e(TAG, "addPkSupport", e) }
    }

    suspend fun endPkBattle(battleId: String, winnerId: String?) {
        try {
            firestore.collection("battles").document(battleId).update(
                "status", BattleStatus.ENDED.name,
                "winnerId", winnerId,
                "endedAt", System.currentTimeMillis()
            ).await()
        } catch (e: Exception) { Log.e(TAG, "endPkBattle", e) }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MESSAGES / CHAT THREADS
    // ─────────────────────────────────────────────────────────────────────────

    /** Deterministic thread ID — always smaller UID first for consistency. */
    fun chatThreadId(uid1: String, uid2: String): String =
        if (uid1 < uid2) "${uid1}_${uid2}" else "${uid2}_${uid1}"

    fun observeChatThreads(): Flow<List<ChatThread>> = callbackFlow {
        val myId = uid ?: run { close(); return@callbackFlow }
        val reg = firestore.collection("messages")
            .whereArrayContains("participants", myId)
            .orderBy("lastMessageAt", Query.Direction.DESCENDING)
            .limit(50)
            .addSnapshotListener { snap, err ->
                if (err != null) { Log.e(TAG, "observeChatThreads", err); return@addSnapshotListener }
                trySend(snap?.mapNotNull { it.toObject(ChatThread::class.java)?.copy(id = it.id) } ?: emptyList())
            }
        awaitClose { reg.remove() }
    }

    fun observeChatMessages(threadId: String, limit: Int = 50): Flow<List<ChatMessage>> = callbackFlow {
        val reg = firestore.collection("messages").document(threadId)
            .collection("messages")
            .orderBy("timestamp", Query.Direction.DESCENDING)
            .limit(limit.toLong())
            .addSnapshotListener { snap, _ ->
                trySend(
                    snap?.mapNotNull { it.toObject(ChatMessage::class.java)?.copy(id = it.id) }
                        ?.reversed() ?: emptyList()
                )
            }
        awaitClose { reg.remove() }
    }

    suspend fun sendChatMessage(recipientId: String, message: ChatMessage) {
        val myId = uid ?: return
        val threadId = chatThreadId(myId, recipientId)
        try {
            val msgRef = firestore.collection("messages").document(threadId)
                .collection("messages").document()
            val batch = firestore.batch()
            batch.set(msgRef, message.copy(id = msgRef.id))
            batch.set(
                firestore.collection("messages").document(threadId),
                mapOf(
                    "participants" to listOf(myId, recipientId),
                    "lastMessage" to message.text.take(100),
                    "lastMessageAt" to message.timestamp,
                    "lastSenderId" to myId,
                    "unreadCounts.$recipientId" to FieldValue.increment(1),
                ),
                SetOptions.merge()
            )
            batch.commit().await()
        } catch (e: Exception) { Log.e(TAG, "sendChatMessage", e) }
    }

    suspend fun markThreadRead(threadId: String) {
        val myId = uid ?: return
        try {
            firestore.collection("messages").document(threadId)
                .update("unreadCounts.$myId", 0).await()
        } catch (e: Exception) { Log.e(TAG, "markThreadRead", e) }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // BALANCE / TRANSACTIONS
    // ─────────────────────────────────────────────────────────────────────────

    /** One-shot balance fetch. Returns (diamonds, beans). */
    suspend fun fetchBalance(userId: String): Pair<Long, Long> = try {
        val doc = firestore.collection("balances").document(userId).get().await()
        Pair(doc.getLong("diamonds") ?: 0L, doc.getLong("beans") ?: 0L)
    } catch (e: Exception) { Log.e(TAG, "fetchBalance", e); Pair(0L, 0L) }

    /** Real-time balance listener. Emits (diamonds, beans) on every change. */
    fun observeBalance(userId: String): Flow<Pair<Long, Long>> = callbackFlow {
        val reg = firestore.collection("balances").document(userId)
            .addSnapshotListener { snap, _ ->
                trySend(Pair(snap?.getLong("diamonds") ?: 0L, snap?.getLong("beans") ?: 0L))
            }
        awaitClose { reg.remove() }
    }

    suspend fun fetchTransactionHistory(limit: Long = 50): List<Transaction> {
        val myId = uid ?: return emptyList()
        return try {
            firestore.collection("transactions")
                .whereEqualTo("userId", myId)
                .orderBy("timestamp", Query.Direction.DESCENDING)
                .limit(limit).get().await()
                .mapNotNull { it.toObject(Transaction::class.java)?.copy(id = it.id) }
        } catch (e: Exception) { Log.e(TAG, "fetchTransactionHistory", e); emptyList() }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CRM ANNOUNCEMENTS
    // ─────────────────────────────────────────────────────────────────────────

    suspend fun fetchCrmAnnouncements(): List<CrmAnnouncement> = try {
        firestore.collection("crm_announcements")
            .orderBy("createdAtMs", Query.Direction.DESCENDING)
            .limit(20).get().await()
            .mapNotNull { it.toObject(CrmAnnouncement::class.java)?.copy(id = it.id) }
    } catch (e: Exception) { Log.e(TAG, "fetchCrmAnnouncements", e); emptyList() }

    // ─────────────────────────────────────────────────────────────────────────
    // BLOCK / REPORT
    // ─────────────────────────────────────────────────────────────────────────

    suspend fun blockUser(targetUserId: String) {
        val myId = uid ?: return
        try {
            firestore.collection("blocks").document("${myId}_$targetUserId")
                .set(mapOf("blockerId" to myId, "blockedId" to targetUserId, "timestamp" to System.currentTimeMillis()))
                .await()
        } catch (e: Exception) { Log.e(TAG, "blockUser", e) }
    }

    suspend fun unblockUser(targetUserId: String) {
        val myId = uid ?: return
        try {
            firestore.collection("blocks").document("${myId}_$targetUserId").delete().await()
        } catch (e: Exception) { Log.e(TAG, "unblockUser", e) }
    }

    suspend fun fetchBlockedUserIds(): Set<String> {
        val myId = uid ?: return emptySet()
        return try {
            firestore.collection("blocks").whereEqualTo("blockerId", myId)
                .get().await()
                .documents.mapNotNull { it.getString("blockedId") }.toSet()
        } catch (e: Exception) { emptySet() }
    }

    suspend fun reportUser(targetUserId: String, reason: String) {
        val myId = uid ?: return
        try {
            firestore.collection("reports").add(
                mapOf(
                    "reporterId" to myId,
                    "reportedId" to targetUserId,
                    "reason" to reason,
                    "timestamp" to System.currentTimeMillis(),
                )
            ).await()
        } catch (e: Exception) { Log.e(TAG, "reportUser", e) }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // LOCATION UPDATE
    // ─────────────────────────────────────────────────────────────────────────

    suspend fun updateUserLocation(city: String, country: String, lat: Double, lng: Double) {
        val myId = uid ?: return
        try {
            firestore.collection("users").document(myId).update(
                "city", city,
                "country", country,
                "latitude", lat,
                "longitude", lng
            ).await()
        } catch (e: Exception) { Log.e(TAG, "updateUserLocation", e) }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SIGNALING (Realtime Database — Agora / WebRTC call setup)
    // ─────────────────────────────────────────────────────────────────────────

    suspend fun writeSignal(channelId: String, key: String, value: Any) {
        try {
            rtdb.getReference("signaling/$channelId/$key").setValue(value).await()
        } catch (e: Exception) { Log.e(TAG, "writeSignal", e) }
    }

    fun observeSignal(channelId: String, key: String): Flow<DataSnapshot?> = callbackFlow {
        val ref = rtdb.getReference("signaling/$channelId/$key")
        val listener = object : ValueEventListener {
            override fun onDataChange(s: DataSnapshot) { trySend(s) }
            override fun onCancelled(e: DatabaseError) { Log.e(TAG, "observeSignal", e.toException()) }
        }
        ref.addValueEventListener(listener)
        awaitClose { ref.removeEventListener(listener) }
    }

    suspend fun clearSignaling(channelId: String) {
        try {
            rtdb.getReference("signaling/$channelId").removeValue().await()
        } catch (e: Exception) { Log.e(TAG, "clearSignaling", e) }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FACE VERIFICATION
    // ─────────────────────────────────────────────────────────────────────────

    /** Submit a face verification result for admin review or auto-approval. */
    suspend fun submitFaceVerification(userId: String, selfieUrl: String, detectedGender: String) {
        try {
            firestore.collection("verifications").document(userId).set(
                mapOf(
                    "userId" to userId,
                    "selfieUrl" to selfieUrl,
                    "detectedGender" to detectedGender,
                    "status" to "PENDING",
                    "submittedAt" to System.currentTimeMillis(),
                ),
                SetOptions.merge()
            ).await()
            // Update user's verification status
            firestore.collection("users").document(userId)
                .update("verificationStatus", "PENDING").await()
        } catch (e: Exception) { Log.e(TAG, "submitFaceVerification", e) }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // AGENCY
    // ─────────────────────────────────────────────────────────────────────────

    suspend fun fetchAgency(agencyId: String): Agency? = try {
        firestore.collection("agencies").document(agencyId).get().await()
            .toObject(Agency::class.java)
    } catch (e: Exception) { Log.e(TAG, "fetchAgency", e); null }

    // ─────────────────────────────────────────────────────────────────────────
    // DIAMOND PACKAGES (for DiamondShop screen)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Returns the hardcoded diamond packages from [VirtualEconomyMath].
     * If packages are ever stored in Firestore (for dynamic pricing), fetch here.
     */
    fun getDiamondPackages() = VirtualEconomyMath.DIAMOND_PACKAGES

    // ─────────────────────────────────────────────────────────────────────────
    // GIFT HISTORY
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Fetch gift transactions sent by [me].
     * If [receiverId] is non-null, filters to gifts sent to that specific user.
     * Pass null to get all gifts this user has sent (My Profile → Gifts Sent tab).
     */
    suspend fun fetchSentGiftsToUser(
        me: UserProfile,
        receiverId: String?,
        limit: Int = 20,
    ): List<SentGiftHistoryEntry> = try {
        var query = db.collection("gift_transactions")
            .whereEqualTo("senderId", me.id)
            .orderBy("timestamp", Query.Direction.DESCENDING)
            .limit(limit.toLong())
        if (receiverId != null) {
            query = query.whereEqualTo("receiverId", receiverId)
        }
        val snap = query.get().await()
        snap.documents.mapNotNull { doc ->
            SentGiftHistoryEntry(
                giftName      = doc.getString("giftName") ?: "",
                giftId        = doc.getString("giftId") ?: "",
                totalCost     = (doc.getLong("diamondCost") ?: 0L).toInt(),
                count         = (doc.getLong("quantity") ?: 1L).toInt(),
                timestampMs   = (doc.getLong("timestamp") ?: 0L),
                counterpartyId   = doc.getString("receiverId") ?: "",
                counterpartyName = doc.getString("receiverName") ?: "",
            )
        }
    } catch (e: Exception) {
        Log.w(TAG, "fetchSentGiftsToUser", e)
        emptyList()
    }

    /**
     * Fetch gift transactions received by [userId].
     */
    suspend fun fetchReceivedGiftsForUser(
        userId: String,
        limit: Int = 20,
    ): List<SentGiftHistoryEntry> = try {
        val snap = db.collection("gift_transactions")
            .whereEqualTo("receiverId", userId)
            .orderBy("timestamp", Query.Direction.DESCENDING)
            .limit(limit.toLong())
            .get().await()
        snap.documents.mapNotNull { doc ->
            SentGiftHistoryEntry(
                giftName      = doc.getString("giftName") ?: "",
                giftId        = doc.getString("giftId") ?: "",
                totalCost     = (doc.getLong("diamondCost") ?: 0L).toInt(),
                count         = (doc.getLong("quantity") ?: 1L).toInt(),
                timestampMs   = (doc.getLong("timestamp") ?: 0L),
                counterpartyId   = doc.getString("senderId") ?: "",
                counterpartyName = doc.getString("senderName") ?: "",
            )
        }
    } catch (e: Exception) {
        Log.w(TAG, "fetchReceivedGiftsForUser", e)
        emptyList()
    }

    // ─────────────────────────────────────────────────────────────────────────
    // BATCH PROFILE FETCH
    // ─────────────────────────────────────────────────────────────────────────

    /** Fetch up to 10 profiles by ID list (Firestore `whereIn` limit = 10). */
    suspend fun fetchProfilesByIds(ids: List<String>): List<UserProfile> {
        if (ids.isEmpty()) return emptyList()
        return try {
            val snap = db.collection("users")
                .whereIn("uid", ids.take(10))
                .get().await()
            snap.documents.mapNotNull { it.toObject(UserProfile::class.java) }
        } catch (e: Exception) {
            Log.w(TAG, "fetchProfilesByIds", e)
            emptyList()
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // BEAN CONVERSION (host cash-out request)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Records a bean-to-withdrawal request in Firestore for admin review.
     * Does NOT directly alter bean balance — the Cloud Function / admin approves.
     */
    suspend fun convertBeansToDiamonds(userId: String, beans: Long) {
        try {
            db.collection("bean_withdrawal_requests").add(
                mapOf(
                    "userId"        to userId,
                    "beansRequested" to beans,
                    "status"        to "PENDING",
                    "createdAt"     to com.google.firebase.Timestamp.now(),
                )
            ).await()
        } catch (e: Exception) {
            Log.w(TAG, "convertBeansToDiamonds", e)
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // LIVE STREAM — EXTENDED OPERATIONS
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Ensure the `live_streams/{streamId}` document exists so audience operations do not fail.
     * Creates a minimal document if one doesn't exist yet.
     */
    suspend fun ensureLiveStreamDocument(
        streamId: String,
        hostUid: String,
        resetStreamSessionStart: Boolean = false,
        audioOnlyStream: Boolean = false,
        audioPartySeatCount: Int? = null,
    ) {
        try {
            val ref = firestore.collection("live_streams").document(streamId)
            val data = mutableMapOf<String, Any>(
                "id" to streamId,
                "hostId" to hostUid,
                "isActive" to true,
                "viewerCount" to 0,
                "audioOnlyStream" to audioOnlyStream,
            )
            if (resetStreamSessionStart) data["streamStartedAtMillis"] = System.currentTimeMillis()
            if (audioPartySeatCount != null) data["audioPartySeatCount"] = audioPartySeatCount
            ref.set(data, SetOptions.merge()).await()
        } catch (e: Exception) { Log.w(TAG, "ensureLiveStreamDocument", e) }
    }

    /** Increment or decrement the viewer count for a live stream. */
    suspend fun incrementLiveStreamViewers(streamId: String, delta: Int) {
        try {
            // Use set(merge=true) so this works even if the document doesn't exist yet.
            // update() throws "NOT_FOUND" on missing documents, which shows a Firebase error to the viewer.
            firestore.collection("live_streams").document(streamId)
                .set(mapOf("viewerCount" to FieldValue.increment(delta.toLong())), SetOptions.merge())
                .await()
        } catch (e: Exception) { Log.w(TAG, "incrementLiveStreamViewers", e) }
    }

    /** Send a system join message when a viewer enters the live stream. */
    suspend fun sendLiveStreamJoinSystemMessage(streamId: String, userId: String, userName: String) {
        try {
            val ref = rtdb.getReference("live_chat/$streamId").push()
            ref.setValue(
                mapOf(
                    "id" to (ref.key ?: ""),
                    "senderId" to userId,
                    "senderName" to userName,
                    "text" to "$userName joined",
                    "type" to "join",
                    "timestamp" to System.currentTimeMillis(),
                )
            ).await()
        } catch (e: Exception) { Log.w(TAG, "sendLiveStreamJoinSystemMessage", e) }
    }

    /** Send a text chat message to a live stream room. */
    suspend fun sendLiveStreamChatMessage(
        streamId: String,
        senderId: String,
        senderName: String,
        text: String,
    ): Result<Unit> = try {
        val ref = rtdb.getReference("live_chat/$streamId").push()
        ref.setValue(
            mapOf(
                "id" to (ref.key ?: ""),
                "senderId" to senderId,
                "senderName" to senderName,
                "text" to text,
                "type" to "text",
                "timestamp" to System.currentTimeMillis(),
            )
        ).await()
        Result.success(Unit)
    } catch (e: Exception) {
        Log.w(TAG, "sendLiveStreamChatMessage", e)
        Result.failure(e)
    }

    /** Send a gift message to a live stream room. */
    suspend fun sendLiveStreamGiftMessage(
        streamId: String,
        messageDocId: String,
        senderId: String,
        senderName: String,
        gift: Gift,
        count: Int,
        giftRecipientUserId: String,
    ): Result<Unit> = try {
        val ref = rtdb.getReference("live_chat/$streamId").child(messageDocId)
        ref.setValue(
            mapOf(
                "id" to messageDocId,
                "senderId" to senderId,
                "senderName" to senderName,
                "type" to "gift",
                "text" to "",
                "giftId" to gift.id,
                "giftName" to gift.name,
                "giftImageUrl" to gift.thumbnailUrl,
                "giftVideoUrl" to (gift.videoUrl ?: ""),
                "giftSoundUrl" to (gift.soundUrl ?: ""),
                "giftDisplayDurationSeconds" to gift.displayDurationSeconds,
                "giftCount" to count,
                "giftRecipientId" to giftRecipientUserId,
                "timestamp" to System.currentTimeMillis(),
            )
        ).await()
        Result.success(Unit)
    } catch (e: Exception) {
        Log.w(TAG, "sendLiveStreamGiftMessage", e)
        Result.failure(e)
    }

    /**
     * Observe live stream messages as [LiveStreamChatMessage] list.
     * Filters to messages with timestamp >= [minTimestampMs].
     */
    fun observeLiveStreamMessages(streamId: String, minTimestampMs: Long = 0L): Flow<List<LiveStreamChatMessage>> =
        callbackFlow {
            val ref = rtdb.getReference("live_chat/$streamId").limitToLast(200)
            val listener = object : ValueEventListener {
                override fun onDataChange(snapshot: DataSnapshot) {
                    val list = snapshot.children.mapNotNull { snap ->
                        try {
                            val m = snap.value as? Map<*, *> ?: return@mapNotNull null
                            val ts = (m["timestamp"] as? Number)?.toLong() ?: 0L
                            if (ts > 0L && ts < minTimestampMs) return@mapNotNull null
                            LiveStreamChatMessage(
                                id = snap.key ?: (m["id"] as? String ?: ""),
                                senderId = m["senderId"] as? String ?: "",
                                senderName = m["senderName"] as? String ?: "",
                                senderPhotoUrl = m["senderPhotoUrl"] as? String ?: "",
                                senderLevel = (m["senderLevel"] as? Number)?.toInt() ?: 0,
                                type = m["type"] as? String ?: "text",
                                text = m["text"] as? String ?: "",
                                giftId = m["giftId"] as? String ?: "",
                                giftImageUrl = m["giftImageUrl"] as? String,
                                giftVideoUrl = m["giftVideoUrl"] as? String,
                                giftSoundUrl = m["giftSoundUrl"] as? String,
                                giftDisplayDurationSeconds = (m["giftDisplayDurationSeconds"] as? Number)?.toInt() ?: 0,
                                giftName = m["giftName"] as? String ?: "",
                                giftCount = (m["giftCount"] as? Number)?.toInt() ?: 1,
                                timestamp = ts,
                                giftRecipientId = m["giftRecipientId"] as? String ?: "",
                                giftReceiverBeansEarned = (m["giftReceiverBeansEarned"] as? Number)?.toLong() ?: 0L,
                            )
                        } catch (_: Exception) { null }
                    }
                    trySend(list)
                }
                override fun onCancelled(error: DatabaseError) {
                    Log.e(TAG, "observeLiveStreamMessages", error.toException())
                }
            }
            ref.addValueEventListener(listener)
            awaitClose { ref.removeEventListener(listener) }
        }

    /**
     * Observe the `live_streams/{streamId}` Firestore document as [LiveStreamRoomInfo].
     */
    fun observeLiveStreamRoom(streamId: String): Flow<LiveStreamRoomInfo> = callbackFlow {
        val reg = firestore.collection("live_streams").document(streamId)
            .addSnapshotListener { snap, err ->
                if (err != null) { Log.e(TAG, "observeLiveStreamRoom", err); return@addSnapshotListener }
                if (snap == null || !snap.exists()) {
                    trySend(LiveStreamRoomInfo(streamActive = false))
                    return@addSnapshotListener
                }
                val d = snap.data ?: emptyMap<String, Any>()
                @Suppress("UNCHECKED_CAST")
                val kickedList = (d["kickedUsers"] as? List<*>)?.filterIsInstance<String>()?.toSet()
                    ?: (d["kickedViewerIds"] as? List<*>)?.filterIsInstance<String>()?.toSet()
                    ?: emptySet()
                @Suppress("UNCHECKED_CAST")
                val pkHostUids = (d["pkHostViewerIds"] as? List<*>)?.filterIsInstance<String>() ?: emptyList()
                @Suppress("UNCHECKED_CAST")
                val pkGuestUids = (d["pkGuestViewerIds"] as? List<*>)?.filterIsInstance<String>() ?: emptyList()
                trySend(
                    LiveStreamRoomInfo(
                        viewerCount = (d["viewerCount"] as? Number)?.toInt() ?: 0,
                        kickedUsers = kickedList,
                        pkScoringOpen = d["pkScoringOpen"] as? Boolean ?: true,
                        pkHostViewerCount = pkHostUids.size.coerceAtLeast(
                            (d["pkHostViewerCount"] as? Number)?.toInt() ?: 0),
                        pkGuestViewerCount = pkGuestUids.size.coerceAtLeast(
                            (d["pkGuestViewerCount"] as? Number)?.toInt() ?: 0),
                        pkHostViewerUserIds = pkHostUids,
                        pkGuestViewerUserIds = pkGuestUids,
                        pkResultPhaseEndsAtMillis = (d["pkResultPhaseEndsAtMillis"] as? Number)?.toLong() ?: 0L,
                        pkHostBeans = (d["pkHostBeans"] as? Number)?.toLong() ?: 0L,
                        pkGuestBeans = (d["pkGuestBeans"] as? Number)?.toLong() ?: 0L,
                        pkBattleGuestUid = d["pkBattleGuestUid"] as? String ?: "",
                        pkGuestUserId = d["pkGuestUserId"] as? String ?: "",
                        pkStartedAtMillis = (d["pkStartedAtMillis"] as? Number)?.toLong() ?: 0L,
                        streamActive = d["isActive"] as? Boolean ?: true,
                        hostPrivateCallBusy = d["hostPrivateCallBusy"] as? Boolean ?: false,
                        audioPartyHandoffToUid = d["audioPartyHandoffToUid"] as? String ?: "",
                    )
                )
            }
        awaitClose { reg.remove() }
    }

    /** Real-time profile listener — emits updated [UserProfile] on every document change. */
    fun observeUserProfile(uid: String): Flow<UserProfile?> = callbackFlow {
        val reg = firestore.collection("users").document(uid)
            .addSnapshotListener { snap, err ->
                if (err != null) { Log.e(TAG, "observeUserProfile", err); return@addSnapshotListener }
                trySend(snap?.toObject(UserProfile::class.java)?.copy(id = uid))
            }
        awaitClose { reg.remove() }
    }

    /** One-shot fetch of a user profile, optionally from a specific [Source]. */
    suspend fun getUserProfile(userId: String, source: Source = Source.DEFAULT): UserProfile? = try {
        firestore.collection("users").document(userId).get(source).await()
            .toObject(UserProfile::class.java)?.copy(id = userId)
    } catch (e: Exception) { Log.e(TAG, "getUserProfile($userId)", e); null }

    /** Toggle a like on target user's profile by current user. Returns new liked state. */
    suspend fun toggleDiscoveryProfileLike(myUid: String, targetUid: String): Result<Boolean> = try {
        val targetRef = firestore.collection("users").document(targetUid)
        val existing = targetRef.get().await()
        @Suppress("UNCHECKED_CAST")
        val likedByList = (existing.get("likedByUserIds") as? List<*>)?.filterIsInstance<String>() ?: emptyList()
        val alreadyLiked = likedByList.contains(myUid)
        if (alreadyLiked) {
            targetRef.update(
                "likedByUserIds", FieldValue.arrayRemove(myUid),
                "likeMeCount", FieldValue.increment(-1L)
            ).await()
            Result.success(false)
        } else {
            targetRef.update(
                "likedByUserIds", FieldValue.arrayUnion(myUid),
                "likeMeCount", FieldValue.increment(1L)
            ).await()
            Result.success(true)
        }
    } catch (e: Exception) {
        Log.e(TAG, "toggleDiscoveryProfileLike", e)
        Result.failure(e)
    }

    /** Add a user to the kicked list of a live stream (host moderation). */
    suspend fun addUserToLiveStreamKickedList(streamId: String, userId: String) {
        try {
            firestore.collection("live_streams").document(streamId)
                .update(
                    "kickedUsers", FieldValue.arrayUnion(userId),
                    "kickedViewerIds", FieldValue.arrayUnion(userId),
                ).await()
        } catch (e: Exception) { Log.w(TAG, "addUserToLiveStreamKickedList", e) }
    }

    /** Add a blocked user for a host (prevents future interactions). */
    suspend fun addBlockedUserForHost(hostId: String, blockedUserId: String) {
        try {
            firestore.collection("blocks").document("${hostId}_$blockedUserId")
                .set(mapOf(
                    "blockerId" to hostId,
                    "blockedId" to blockedUserId,
                    "timestamp" to System.currentTimeMillis(),
                )).await()
        } catch (e: Exception) { Log.w(TAG, "addBlockedUserForHost", e) }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1:1 CALL — LIVE BILLING / TEARDOWN
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Observe the status field of a call session document.
     * Emits the raw status string (e.g. "ENDED", "DECLINED") on change.
     */
    fun observeCallSessionStatus(roomId: String): Flow<String?> = callbackFlow {
        val reg = firestore.collection("calls").document(roomId)
            .addSnapshotListener { snap, err ->
                if (err != null) { Log.e(TAG, "observeCallSessionStatus", err); return@addSnapshotListener }
                trySend(snap?.getString("status"))
            }
        awaitClose { reg.remove() }
    }

    /** Read the `createdAt` field of a call document. Returns null on failure. */
    suspend fun getCallDocumentCreatedAtMs(roomId: String): Long? = try {
        val doc = firestore.collection("calls").document(roomId).get().await()
        doc.getLong("createdAt") ?: doc.getLong("startedAt")
    } catch (e: Exception) { Log.w(TAG, "getCallDocumentCreatedAtMs", e); null }

    /**
     * Charge one minute of a 1:1 call to the payer.
     * Returns the new wallet balance, or -1 if the balance was already below [diamondsPerMin].
     */
    suspend fun chargeOneCallMinute(
        payerUid: String,
        hostUid: String,
        diamondsPerMin: Int,
    ): Result<Int> = try {
        val payerDoc = firestore.collection("users").document(payerUid).get().await()
        val balance = (payerDoc.getLong("diamondBalance") ?: 0L).toInt()
        if (balance < diamondsPerMin) {
            Result.success(-1)
        } else {
            val beansForHost = (diamondsPerMin * VirtualEconomyMath.RATIO_MALE_TO_FEMALE).toLong()
            val batch = firestore.batch()
            batch.update(
                firestore.collection("users").document(payerUid),
                "diamondBalance", FieldValue.increment(-diamondsPerMin.toLong()),
                "totalDiamondsSpent", FieldValue.increment(diamondsPerMin.toLong()),
            )
            if (beansForHost > 0L && hostUid.isNotBlank()) {
                batch.update(
                    firestore.collection("users").document(hostUid),
                    "beanBalance", FieldValue.increment(beansForHost),
                    "totalBeansEarned", FieldValue.increment(beansForHost),
                )
            }
            batch.commit().await()
            Result.success(balance - diamondsPerMin)
        }
    } catch (e: Exception) {
        Log.e(TAG, "chargeOneCallMinute", e)
        Result.failure(e)
    }

    /**
     * Legacy bulk post-call billing (fallback when [chargeOneCallMinute] did not run).
     * Computes charges based on elapsed seconds and rate; creates transaction records.
     */
    suspend fun chargeCallDiamondSessionWithAgentSplit(
        payerUid: String,
        hostUid: String,
        elapsedSeconds: Int,
        diamondRatePerMin: Int,
    ) {
        if (elapsedSeconds <= 0 || diamondRatePerMin <= 0) return
        val minutes = elapsedSeconds / 60.0
        val totalDiamonds = (diamondRatePerMin * minutes).toLong().coerceAtLeast(diamondRatePerMin.toLong())
        try {
            val batch = firestore.batch()
            batch.update(
                firestore.collection("users").document(payerUid),
                "diamondBalance", FieldValue.increment(-totalDiamonds),
                "totalDiamondsSpent", FieldValue.increment(totalDiamonds),
            )
            val beans = (totalDiamonds * VirtualEconomyMath.RATIO_MALE_TO_FEMALE).toLong()
            if (beans > 0L && hostUid.isNotBlank()) {
                batch.update(
                    firestore.collection("users").document(hostUid),
                    "beanBalance", FieldValue.increment(beans),
                    "totalBeansEarned", FieldValue.increment(beans),
                )
            }
            batch.commit().await()
        } catch (e: Exception) { Log.e(TAG, "chargeCallDiamondSessionWithAgentSplit", e) }
    }

    /** Update the `status` field on a call document (e.g., "ENDED"). */
    suspend fun setCallSessionStatus(roomId: String, status: String) {
        try {
            firestore.collection("calls").document(roomId)
                .update("status", status, "endedAt", System.currentTimeMillis()).await()
        } catch (e: Exception) { Log.w(TAG, "setCallSessionStatus", e) }
    }

    /** Remove the RTDB WebRTC signaling room for a call. */
    suspend fun clearCallRoom(roomId: String) {
        try {
            rtdb.getReference("rooms/$roomId").removeValue().await()
        } catch (e: Exception) { Log.w(TAG, "clearCallRoom", e) }
    }

    /** Clean up Firestore signaling subcollections for a call (ICE candidates, offers, etc.). */
    suspend fun cleanupCallFirestoreSignalingCollections(roomId: String) {
        try {
            val callRef = firestore.collection("calls").document(roomId)
            for (col in listOf("iceCandidates", "offers", "answers")) {
                val docs = callRef.collection(col).limit(200).get().await()
                if (!docs.isEmpty) {
                    val batch = firestore.batch()
                    docs.documents.forEach { batch.delete(it.reference) }
                    batch.commit().await()
                }
            }
        } catch (e: Exception) { Log.w(TAG, "cleanupCallFirestoreSignalingCollections", e) }
    }

    /** Increment host streaming minutes stat. */
    suspend fun addHostStreamingMinutes(hostUid: String, minutes: Int) {
        try {
            firestore.collection("users").document(hostUid)
                .update("streamingMinutesTotal", FieldValue.increment(minutes.toLong())).await()
        } catch (e: Exception) { Log.w(TAG, "addHostStreamingMinutes", e) }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PK BATTLE — RTDB SIGNALING
    // ─────────────────────────────────────────────────────────────────────────

    /** Build a deterministic PK room ID from two Firebase UIDs. */
    fun buildPkRoomId(hostUid: String, guestUid: String): String {
        return "pk_room_${minOf(hostUid, guestUid)}_${maxOf(hostUid, guestUid)}"
    }

    /** Clear a PK match signal node from RTDB. */
    suspend fun clearPkMatchSignal(uid: String) {
        try {
            rtdb.getReference("pk_match_signals/$uid").removeValue().await()
        } catch (e: Exception) { Log.w(TAG, "clearPkMatchSignal", e) }
    }

    /**
     * Write a PK rematch invite for the guest at `pk_match_signals/{guestUid}`.
     */
    suspend fun postPkRematchInvite(
        guestUid: String,
        roomId: String,
        hostUid: String,
        hostStreamId: String,
        durationSeconds: Int,
    ) {
        try {
            rtdb.getReference("pk_match_signals/$guestUid").setValue(
                mapOf(
                    "isRematch" to true,
                    "partnerUserId" to hostUid,
                    "hostStreamId" to hostStreamId,
                    "roomId" to roomId,
                    "durationSeconds" to durationSeconds,
                    "timestamp" to System.currentTimeMillis(),
                )
            ).await()
        } catch (e: Exception) { Log.w(TAG, "postPkRematchInvite", e) }
    }

    /** Write a PK rematch ack from guest to host at `pk_match_signals/{hostUid}`. */
    suspend fun postPkRematchAck(
        hostUid: String,
        roomId: String,
        guestUid: String,
        guestStreamId: String,
        durationSeconds: Int,
    ) {
        try {
            rtdb.getReference("pk_match_signals/$hostUid").setValue(
                mapOf(
                    "rematchAck" to true,
                    "partnerUserId" to guestUid,
                    "guestStreamId" to guestStreamId,
                    "roomId" to roomId,
                    "durationSeconds" to durationSeconds,
                    "timestamp" to System.currentTimeMillis(),
                )
            ).await()
        } catch (e: Exception) { Log.w(TAG, "postPkRematchAck", e) }
    }

    /**
     * Attach a [ValueEventListener] to a user's PK match signal node.
     * The caller is responsible for removing it with [removePkMatchListener].
     */
    fun addPkMatchListener(uid: String, listener: ValueEventListener) {
        rtdb.getReference("pk_match_signals/$uid").addValueEventListener(listener)
    }

    /** Remove a previously added PK match listener. */
    fun removePkMatchListener(uid: String, listener: ValueEventListener) {
        rtdb.getReference("pk_match_signals/$uid").removeEventListener(listener)
    }

    /** Publish PK battle state onto the host's live_streams doc. */
    suspend fun publishLiveStreamPkBattle(
        hostUid: String,
        guestUid: String,
        hostDisplayName: String,
        guestDisplayName: String,
        durationSeconds: Int,
        resetBeanTotals: Boolean = false,
    ) {
        try {
            val updates = mutableMapOf<String, Any>(
                "isPkActive" to true,
                "pkPartnerId" to guestUid,
                "pkGuestUserId" to guestUid,
                "pkBattleGuestUid" to guestUid,
                "pkScoringOpen" to true,
                "pkDurationSeconds" to durationSeconds,
                "pkStartedAtMillis" to System.currentTimeMillis(),
                "pkGuestDisplayName" to guestDisplayName,
                "hostDisplayName" to hostDisplayName,
            )
            if (resetBeanTotals) {
                updates["pkHostBeans"] = 0L
                updates["pkGuestBeans"] = 0L
            }
            firestore.collection("live_streams").document(hostUid).update(updates).await()
        } catch (e: Exception) { Log.w(TAG, "publishLiveStreamPkBattle", e) }
    }

    /** Fetch the PK started-at timestamp from a live stream doc. */
    suspend fun fetchLiveStreamPkStartedAtMillis(streamId: String): Long = try {
        val doc = firestore.collection("live_streams").document(streamId).get().await()
        doc.getLong("pkStartedAtMillis") ?: 0L
    } catch (e: Exception) { Log.w(TAG, "fetchLiveStreamPkStartedAtMillis", e); 0L }

    /**
     * Close PK battle scoring on the host live_streams doc.
     * Records the result phase end time for audience display.
     */
    suspend fun closePkBattleScoringForBattle(streamDocId: String, guestUid: String) {
        try {
            firestore.collection("live_streams").document(streamDocId).update(
                "pkScoringOpen", false,
                "isPkActive", false,
                "pkBattleEnded", true,
                "pkResultPhaseEndsAtMillis",
                System.currentTimeMillis() + com.zipper.datingapp.data.PK_POST_RESULT_LINGER_MS,
            ).await()
        } catch (e: Exception) { Log.w(TAG, "closePkBattleScoringForBattle", e) }
    }

    /** Emit a signal that the PK challenger is ending and continuing as solo live. */
    suspend fun emitEndPkStayLiveSignal(guestRoomId: String, hostStreamDoc: String) {
        try {
            rtdb.getReference("pk_end_signals/$guestRoomId").setValue(
                mapOf(
                    "stayLive" to true,
                    "hostStreamDoc" to hostStreamDoc,
                    "timestamp" to System.currentTimeMillis(),
                )
            ).await()
        } catch (e: Exception) { Log.w(TAG, "emitEndPkStayLiveSignal", e) }
    }

    /** Clear PK battle mirror fields from both battlers' live stream docs. */
    suspend fun clearLiveStreamPkBattleMirrors(hostUid: String, guestUid: String) {
        try {
            val updates = mapOf(
                "isPkActive" to false,
                "pkPartnerId" to "",
                "pkScoringOpen" to false,
            )
            val batch = firestore.batch()
            if (hostUid.isNotBlank()) {
                batch.update(firestore.collection("live_streams").document(hostUid), updates)
            }
            if (guestUid.isNotBlank() && guestUid != hostUid) {
                batch.update(firestore.collection("live_streams").document(guestUid), updates)
            }
            batch.commit().await()
        } catch (e: Exception) { Log.w(TAG, "clearLiveStreamPkBattleMirrors", e) }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STUB METHODS — added to satisfy DatingViewModel compilation
    // ─────────────────────────────────────────────────────────────────────────

    // Presence
    suspend fun setUserPresence(userId: String, online: Boolean) {
        try {
            rtdb.getReference("presence/$userId").setValue(mapOf("online" to online, "lastSeen" to System.currentTimeMillis())).await()
        } catch (e: Exception) { Log.e(TAG, "setUserPresence", e) }
    }

    // Discovery feed observers
    fun observeProfiles(): Flow<List<UserProfile>> = callbackFlow {
        val reg = firestore.collection("users").addSnapshotListener { snap, err ->
            if (err != null) { Log.e(TAG, "observeProfiles", err); return@addSnapshotListener }
            val list = snap?.documents?.mapNotNull { it.toObject(UserProfile::class.java)?.copy(id = it.id) } ?: emptyList()
            trySend(list)
        }
        awaitClose { reg.remove() }
    }

    fun observeLiveUserIds(): Flow<Set<String>> = callbackFlow {
        val ref = rtdb.getReference("live_user_ids")
        val listener = object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                val ids = snapshot.children.mapNotNull { it.key }.toSet()
                trySend(ids)
            }
            override fun onCancelled(error: DatabaseError) { Log.e(TAG, "observeLiveUserIds", error.toException()) }
        }
        ref.addValueEventListener(listener)
        awaitClose { ref.removeEventListener(listener) }
    }

    fun observeGlobalPresenceRtdb(): Flow<Map<String, Boolean>> = callbackFlow {
        val ref = rtdb.getReference("presence")
        val listener = object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                val map = mutableMapOf<String, Boolean>()
                snapshot.children.forEach { child ->
                    val online = child.child("online").getValue(Boolean::class.java) ?: false
                    child.key?.let { map[it] = online }
                }
                trySend(map)
            }
            override fun onCancelled(error: DatabaseError) { Log.e(TAG, "observeGlobalPresenceRtdb", error.toException()) }
        }
        ref.addValueEventListener(listener)
        awaitClose { ref.removeEventListener(listener) }
    }

    fun observeActiveLivePkBanners(): Flow<Map<String, String>> = callbackFlow {
        val reg = firestore.collection("live_pk_banners").addSnapshotListener { snap, err ->
            if (err != null) { Log.e(TAG, "observeActiveLivePkBanners", err); return@addSnapshotListener }
            val map = snap?.documents?.associate { it.id to (it.getString("banner") ?: "") } ?: emptyMap()
            trySend(map)
        }
        awaitClose { reg.remove() }
    }

    suspend fun fetchLiveStreamAudioOnlyFlags(uids: List<String>): Map<String, Boolean> {
        if (uids.isEmpty()) return emptyMap()
        return try {
            val result = mutableMapOf<String, Boolean>()
            uids.chunked(10).forEach { chunk ->
                firestore.collection("live_streams").whereIn("hostId", chunk).get().await()
                    .documents.forEach { doc ->
                        result[doc.id] = doc.getBoolean("audioOnlyStream") ?: false
                    }
            }
            result
        } catch (e: Exception) { Log.e(TAG, "fetchLiveStreamAudioOnlyFlags", e); emptyMap() }
    }

    // Profile save
    suspend fun saveUserProfile(profile: UserProfile) {
        try {
            firestore.collection("users").document(profile.id).set(profile, SetOptions.merge()).await()
        } catch (e: Exception) { Log.e(TAG, "saveUserProfile", e) }
    }

    // Live status
    suspend fun updateUserLiveStatus(userId: String, isLive: Boolean, roomId: String?) {
        try {
            val data = mutableMapOf<String, Any>("isLive" to isLive)
            if (roomId != null) data["liveRoomId"] = roomId else data["liveRoomId"] = ""
            firestore.collection("users").document(userId).update(data).await()
        } catch (e: Exception) { Log.e(TAG, "updateUserLiveStatus", e) }
    }

    // Messages
    fun observeMessages(userId: String): Flow<List<Message>> = callbackFlow {
        val reg = firestore.collection("chat_threads")
            .whereArrayContains("participantIds", userId)
            .addSnapshotListener { snap, err ->
                if (err != null) { Log.e(TAG, "observeMessages", err); return@addSnapshotListener }
                val list = snap?.documents?.mapNotNull { it.toObject(ChatMessage::class.java)?.copy(id = it.id) } ?: emptyList()
                trySend(list)
            }
        awaitClose { reg.remove() }
    }

    // Battles
    fun observeBattles(): Flow<List<Battle>> = callbackFlow {
        val reg = firestore.collection("battles").addSnapshotListener { snap, err ->
            if (err != null) { Log.e(TAG, "observeBattles", err); return@addSnapshotListener }
            val list = snap?.documents?.mapNotNull { it.toObject(Battle::class.java)?.copy(id = it.id) } ?: emptyList()
            trySend(list)
        }
        awaitClose { reg.remove() }
    }

    // DM send
    suspend fun sendMessage(message: Message): Result<Unit> = try {
        firestore.collection("messages").add(message).await()
        Result.success(Unit)
    } catch (e: Exception) { Log.e(TAG, "sendMessage", e); Result.failure(e) }

    // Calls
    suspend fun sendCallInvite(callerId: String, callerName: String, receiverId: String, roomId: String, isVideoCall: Boolean) {
        try {
            val data = mapOf(
                "callerId" to callerId,
                "callerName" to callerName,
                "receiverId" to receiverId,
                "roomId" to roomId,
                "isVideoCall" to isVideoCall,
                "timestamp" to System.currentTimeMillis(),
            )
            firestore.collection("call_invites").document(roomId).set(data).await()
        } catch (e: Exception) { Log.e(TAG, "sendCallInvite", e) }
    }

    suspend fun setLiveStreamHostPrivateCallBusy(streamId: String, busy: Boolean): Result<Unit> = try {
        firestore.collection("live_streams").document(streamId).update("hostPrivateCallBusy", busy).await()
        Result.success(Unit)
    } catch (e: Exception) { Log.e(TAG, "setLiveStreamHostPrivateCallBusy", e); Result.failure(e) }

    suspend fun sendLiveStreamHostBusySystemMessage(streamId: String, hostId: String, message: String): Result<Unit> = try {
        val data = mapOf("type" to "system", "text" to message, "hostId" to hostId, "timestamp" to System.currentTimeMillis())
        firestore.collection("live_streams").document(streamId).collection("messages").add(data).await()
        Result.success(Unit)
    } catch (e: Exception) { Log.e(TAG, "sendLiveStreamHostBusySystemMessage", e); Result.failure(e) }

    suspend fun sendCallResponse(callerId: String, roomId: String, status: String, reason: String = "") {
        try {
            val data = mapOf("status" to status, "reason" to reason, "timestamp" to System.currentTimeMillis())
            firestore.collection("call_responses").document(roomId).set(data).await()
        } catch (e: Exception) { Log.e(TAG, "sendCallResponse", e) }
    }

    suspend fun clearIncomingCallRtdb(userId: String) {
        try {
            rtdb.getReference("incoming_calls/$userId").removeValue().await()
        } catch (e: Exception) { Log.e(TAG, "clearIncomingCallRtdb", e) }
    }

    suspend fun clearIncomingCall(userId: String) {
        try {
            firestore.collection("incoming_calls").document(userId).delete().await()
        } catch (e: Exception) { Log.e(TAG, "clearIncomingCall", e) }
    }

    // Social
    suspend fun setFollowRelationship(followerId: String, followedId: String, follow: Boolean) {
        try {
            val ref = firestore.collection("follows").document("${followerId}_${followedId}")
            if (follow) {
                ref.set(mapOf("followerId" to followerId, "followedId" to followedId, "timestamp" to System.currentTimeMillis())).await()
            } else {
                ref.delete().await()
            }
        } catch (e: Exception) { Log.e(TAG, "setFollowRelationship", e) }
    }

    suspend fun likeHostLiveStream(viewerUid: String, hostUid: String) {
        try {
            firestore.collection("live_streams").document(hostUid)
                .update("likeCount", FieldValue.increment(1)).await()
        } catch (e: Exception) { Log.e(TAG, "likeHostLiveStream", e) }
    }

    suspend fun sendLiveStreamLikeSystemMessage(streamId: String, likerUid: String, likerName: String) {
        try {
            val data = mapOf("type" to "like_system", "likerUid" to likerUid, "likerName" to likerName, "timestamp" to System.currentTimeMillis())
            firestore.collection("live_streams").document(streamId).collection("messages").add(data).await()
        } catch (e: Exception) { Log.e(TAG, "sendLiveStreamLikeSystemMessage", e) }
    }

    suspend fun sendLiveStreamHostBackSystemMessage(streamId: String, hostId: String, message: String): Result<Unit> = try {
        val data = mapOf("type" to "system", "text" to message, "hostId" to hostId, "timestamp" to System.currentTimeMillis())
        firestore.collection("live_streams").document(streamId).collection("messages").add(data).await()
        Result.success(Unit)
    } catch (e: Exception) { Log.e(TAG, "sendLiveStreamHostBackSystemMessage", e); Result.failure(e) }

    // Economy
    suspend fun chargeCallDiamondSession(payerUid: String, hostUid: String, durationSeconds: Int, ratePerMin: Int, isVideo: Boolean = false) {
        try {
            val data = mapOf(
                "payerUid" to payerUid,
                "hostUid" to hostUid,
                "durationSeconds" to durationSeconds,
                "ratePerMin" to ratePerMin,
                "isVideo" to isVideo,
                "timestamp" to System.currentTimeMillis(),
            )
            firestore.collection("call_charges").add(data).await()
        } catch (e: Exception) { Log.e(TAG, "chargeCallDiamondSession", e) }
    }

    suspend fun processGiftTransfer(transactionId: String, senderId: String, receiverId: String, gift: Gift, count: Int): GiftTransferResult = try {
        val data = mapOf(
            "transactionId" to transactionId,
            "senderId" to senderId,
            "receiverId" to receiverId,
            "giftId" to gift.id,
            "count" to count,
            "timestamp" to System.currentTimeMillis(),
        )
        firestore.collection("gift_transfers").document(transactionId).set(data).await()
        GiftTransferResult.Success(senderBalance = 0)
    } catch (e: Exception) { Log.e(TAG, "processGiftTransfer", e); GiftTransferResult.Failed(e.message ?: "Unknown error") }

    // PK matchmaking
    suspend fun removeFromPkQueue(userId: String) {
        try {
            firestore.collection("pk_queue").document(userId).delete().await()
        } catch (e: Exception) { Log.e(TAG, "removeFromPkQueue", e) }
    }

    suspend fun findOrCreatePkMatch(userId: String, liveRoomId: String, durationSeconds: Int): PkMatchResult = try {
        val data = mapOf("userId" to userId, "liveRoomId" to liveRoomId, "durationSeconds" to durationSeconds, "timestamp" to System.currentTimeMillis())
        firestore.collection("pk_queue").document(userId).set(data).await()
        PkMatchResult.Waiting
    } catch (e: Exception) { Log.e(TAG, "findOrCreatePkMatch", e); PkMatchResult.Error(e.message ?: "Unknown error") }

    suspend fun waitForPkClaim(userId: String): PkMatchResult = try {
        val snap = firestore.collection("pk_queue").document(userId).get().await()
        if (snap.exists()) PkMatchResult.Waiting else PkMatchResult.Error("No match")
    } catch (e: Exception) { Log.e(TAG, "waitForPkClaim", e); PkMatchResult.Error(e.message ?: "Unknown error") }

    suspend fun adjustPkBattlerAudienceCounts(streamHostId: String, hostDelta: Long, guestDelta: Long, spectatorUid: String? = null) {
        try {
            val updates = mutableMapOf<String, Any>()
            if (hostDelta != 0L) updates["pkHostAudienceCount"] = FieldValue.increment(hostDelta)
            if (guestDelta != 0L) updates["pkGuestAudienceCount"] = FieldValue.increment(guestDelta)
            if (updates.isNotEmpty()) {
                firestore.collection("live_streams").document(streamHostId).update(updates).await()
            }
        } catch (e: Exception) { Log.e(TAG, "adjustPkBattlerAudienceCounts", e) }
    }

    // Audio party - live streams
    suspend fun mergeLiveStreamAudioPartySeatCount(hostUid: String, count: Int) {
        try {
            firestore.collection("live_streams").document(hostUid)
                .set(mapOf("audioPartySeatCount" to count), SetOptions.merge()).await()
        } catch (e: Exception) { Log.e(TAG, "mergeLiveStreamAudioPartySeatCount", e) }
    }

    // Audio party - streams collection
    suspend fun ensureAudioPartyStreamDocument(hostUid: String, seatCount: Int) {
        try {
            val data = mapOf("hostUid" to hostUid, "seatCount" to seatCount, "active" to true)
            firestore.collection("streams").document(hostUid).set(data, SetOptions.merge()).await()
        } catch (e: Exception) { Log.e(TAG, "ensureAudioPartyStreamDocument", e) }
    }

    suspend fun mergeAudioPartyStreamSeatCount(hostUid: String, count: Int) {
        try {
            firestore.collection("streams").document(hostUid)
                .set(mapOf("seatCount" to count), SetOptions.merge()).await()
        } catch (e: Exception) { Log.e(TAG, "mergeAudioPartyStreamSeatCount", e) }
    }

    suspend fun mergeAudioPartyRoomBackground(hostUid: String, url: String) {
        try {
            firestore.collection("streams").document(hostUid)
                .set(mapOf("roomBackgroundKey" to url), SetOptions.merge()).await()
        } catch (e: Exception) { Log.e(TAG, "mergeAudioPartyRoomBackground", e) }
    }

    suspend fun claimAudioPartySeat(hostId: String, seatIndex: Int, userId: String, userName: String, userPhotoUrl: String): Result<Unit> = try {
        val seatData = mapOf("userId" to userId, "displayName" to userName, "photoUrl" to userPhotoUrl, "publishingAudio" to false)
        firestore.collection("streams").document(hostId)
            .set(mapOf("seats" to mapOf("$seatIndex" to seatData)), SetOptions.merge()).await()
        Result.success(Unit)
    } catch (e: Exception) { Log.e(TAG, "claimAudioPartySeat", e); Result.failure(e) }

    suspend fun leaveAudioPartySeat(hostId: String, seatIndex: Int, userId: String) {
        try {
            firestore.collection("streams").document(hostId)
                .update("seats.$seatIndex.userId", "", "seats.$seatIndex.displayName", "", "seats.$seatIndex.photoUrl", "").await()
        } catch (e: Exception) { Log.e(TAG, "leaveAudioPartySeat", e) }
    }

    /**
     * Scan all seats in an audio party stream and clear any seat whose userId matches [userId].
     * Called on party join to evict stale seat data left by crashes / force-closes.
     */
    suspend fun clearUserFromAllAudioPartySeats(hostId: String, userId: String) {
        if (hostId.isBlank() || userId.isBlank()) return
        try {
            val snap = firestore.collection("streams").document(hostId).get().await()
            if (!snap.exists()) return
            @Suppress("UNCHECKED_CAST")
            val rawSeats = snap.get("seats") as? Map<String, *> ?: return
            val updates = mutableMapOf<String, Any>()
            for ((key, v) in rawSeats) {
                @Suppress("UNCHECKED_CAST")
                val seatMap = v as? Map<String, *> ?: continue
                val seated = (seatMap["userId"] as? String).orEmpty().trim()
                if (seated == userId) {
                    updates["seats.$key.userId"] = ""
                    updates["seats.$key.displayName"] = ""
                    updates["seats.$key.photoUrl"] = ""
                }
            }
            if (updates.isNotEmpty()) {
                firestore.collection("streams").document(hostId).update(updates).await()
            }
        } catch (e: Exception) { Log.w(TAG, "clearUserFromAllAudioPartySeats", e) }
    }

    suspend fun handoffAudioPartyHost(hostId: String, newHostUid: String): Result<Unit> = try {
        firestore.collection("streams").document(hostId)
            .set(mapOf("hostUid" to newHostUid), SetOptions.merge()).await()
        Result.success(Unit)
    } catch (e: Exception) { Log.e(TAG, "handoffAudioPartyHost", e); Result.failure(e) }

    suspend fun hostSetAudioPartySeatLocked(hostId: String, seatIndex: Int, locked: Boolean) {
        try {
            firestore.collection("streams").document(hostId)
                .update("seats.$seatIndex.locked", locked).await()
        } catch (e: Exception) { Log.e(TAG, "hostSetAudioPartySeatLocked", e) }
    }

    suspend fun hostSetAudioPartySeatMuted(hostId: String, seatIndex: Int, muted: Boolean) {
        try {
            firestore.collection("streams").document(hostId)
                .update("seats.$seatIndex.mutedByHost", muted).await()
        } catch (e: Exception) { Log.e(TAG, "hostSetAudioPartySeatMuted", e) }
    }

    suspend fun clearAudioPartySeat(hostId: String, seatIndex: Int, preserveLocked: Boolean = false) {
        try {
            val updates = mutableMapOf<String, Any>(
                "seats.$seatIndex.userId" to "",
                "seats.$seatIndex.displayName" to "",
                "seats.$seatIndex.photoUrl" to "",
                "seats.$seatIndex.publishingAudio" to false,
            )
            if (!preserveLocked) updates["seats.$seatIndex.locked"] = false
            firestore.collection("streams").document(hostId).update(updates).await()
        } catch (e: Exception) { Log.e(TAG, "clearAudioPartySeat", e) }
    }

    suspend fun hostSetAudioPartySeatPrice(hostId: String, seatIndex: Int, priceCoins: Int) {
        try {
            firestore.collection("streams").document(hostId)
                .update("seats.$seatIndex.priceCoins", priceCoins).await()
        } catch (e: Exception) { Log.e(TAG, "hostSetAudioPartySeatPrice", e) }
    }

    suspend fun setAudioPartyCoHostFromSeat(hostId: String, seatIndex: Int) {
        try {
            val snap = firestore.collection("streams").document(hostId).get().await()
            @Suppress("UNCHECKED_CAST")
            val seats = snap.get("seats") as? Map<String, Map<String, Any?>> ?: emptyMap()
            val seatData = seats["$seatIndex"]
            val coHostUid = seatData?.get("userId") as? String ?: ""
            if (coHostUid.isNotBlank()) {
                firestore.collection("streams").document(hostId)
                    .update("coHostUserId", coHostUid).await()
            }
        } catch (e: Exception) { Log.e(TAG, "setAudioPartyCoHostFromSeat", e) }
    }

    suspend fun mergeAudioPartyCoHost(hostId: String, userId: String?) {
        try {
            firestore.collection("streams").document(hostId)
                .set(mapOf("coHostUserId" to (userId ?: "")), SetOptions.merge()).await()
        } catch (e: Exception) { Log.e(TAG, "mergeAudioPartyCoHost", e) }
    }

    suspend fun setAudioPartySeatPublishing(hostId: String, seatIndex: Int, userId: String, publishing: Boolean) {
        try {
            firestore.collection("streams").document(hostId)
                .update("seats.$seatIndex.publishingAudio", publishing).await()
        } catch (e: Exception) { Log.e(TAG, "setAudioPartySeatPublishing", e) }
    }

    suspend fun mergeAudioPartyNowPlaying(hostId: String, title: String, artist: String) {
        try {
            firestore.collection("streams").document(hostId)
                .set(mapOf("nowPlayingTitle" to title, "nowPlayingArtist" to artist), SetOptions.merge()).await()
        } catch (e: Exception) { Log.e(TAG, "mergeAudioPartyNowPlaying", e) }
    }

    suspend fun mergeAudioPartyStageEmoji(hostId: String, emoji: String) {
        try {
            firestore.collection("streams").document(hostId)
                .set(mapOf("stageEmoji" to emoji, "stageEmojiAtMs" to System.currentTimeMillis()), SetOptions.merge()).await()
        } catch (e: Exception) { Log.e(TAG, "mergeAudioPartyStageEmoji", e) }
    }

    // PK banner cleanup
    suspend fun clearLiveStreamPkBannerIfDocumentExists(hostUid: String) {
        try {
            val ref = firestore.collection("live_pk_banners").document(hostUid)
            val snap = ref.get().await()
            if (snap.exists()) ref.delete().await()
        } catch (e: Exception) { Log.e(TAG, "clearLiveStreamPkBannerIfDocumentExists", e) }
    }

    // Moderation
    suspend fun removeBlockedUserForHost(hostId: String, blockedUserId: String) {
        try {
            firestore.collection("live_streams").document(hostId)
                .update("kickedUserIds", FieldValue.arrayRemove(blockedUserId)).await()
        } catch (e: Exception) { Log.e(TAG, "removeBlockedUserForHost", e) }
    }

    suspend fun submitUserProfileReport(reporterId: String, reportedId: String, reason: String) {
        try {
            val data = mapOf("reporterId" to reporterId, "reportedId" to reportedId, "reason" to reason, "timestamp" to System.currentTimeMillis())
            firestore.collection("user_reports").add(data).await()
        } catch (e: Exception) { Log.e(TAG, "submitUserProfileReport", e) }
    }

    // Battle game
    suspend fun applyBattleGameInput(battleId: String, actorId: String, action: String, data: Map<String, Any>): Result<Unit> = try {
        val payload = mapOf("actorId" to actorId, "action" to action, "data" to data, "timestamp" to System.currentTimeMillis())
        firestore.collection("battles").document(battleId).collection("inputs").add(payload).await()
        Result.success(Unit)
    } catch (e: Exception) { Log.e(TAG, "applyBattleGameInput", e); Result.failure(e) }

    suspend fun publishBattle(battle: Battle) {
        try {
            firestore.collection("battles").document(battle.id).set(battle).await()
        } catch (e: Exception) { Log.e(TAG, "publishBattle", e) }
    }

    fun observeBattleDocument(battleId: String): Flow<Battle?> = callbackFlow {
        val reg = firestore.collection("battles").document(battleId).addSnapshotListener { snap, err ->
            if (err != null) { Log.e(TAG, "observeBattleDocument", err); return@addSnapshotListener }
            trySend(snap?.toObject(Battle::class.java)?.copy(id = battleId))
        }
        awaitClose { reg.remove() }
    }

    fun observeBattleGameState(battleId: String): Flow<GameState?> = callbackFlow {
        val reg = firestore.collection("battles").document(battleId).collection("game_state").document("current")
            .addSnapshotListener { snap, err ->
                if (err != null) { Log.e(TAG, "observeBattleGameState", err); return@addSnapshotListener }
                trySend(snap?.toObject(GameState::class.java))
            }
        awaitClose { reg.remove() }
    }

    // Audience
    fun observeRoomActiveViewerUids(hostUid: String): Flow<List<String>> = callbackFlow {
        val reg = firestore.collection("live_streams").document(hostUid).collection("viewers")
            .addSnapshotListener { snap, err ->
                if (err != null) { Log.e(TAG, "observeRoomActiveViewerUids", err); return@addSnapshotListener }
                trySend(snap?.documents?.map { it.id } ?: emptyList())
            }
        awaitClose { reg.remove() }
    }

    fun observeAudioPartyStream(hostUid: String): Flow<AudioPartyStreamState> = callbackFlow {
        val reg = firestore.collection("streams").document(hostUid)
            .addSnapshotListener { snap, err ->
                if (err != null) { Log.e(TAG, "observeAudioPartyStream", err); return@addSnapshotListener }
                val state = snap?.toAudioPartyStreamState() ?: AudioPartyStreamState()
                trySend(state)
            }
        awaitClose { reg.remove() }
    }

    fun observeAudioPartyVideoCallRequests(hostUid: String): Flow<List<AudioPartyVideoCallRequest>> = callbackFlow {
        val reg = firestore.collection("streams").document(hostUid).collection("video_call_requests")
            .addSnapshotListener { snap, err ->
                if (err != null) { Log.e(TAG, "observeAudioPartyVideoCallRequests", err); return@addSnapshotListener }
                val list = snap?.documents?.mapNotNull { it.toObject(AudioPartyVideoCallRequest::class.java) } ?: emptyList()
                trySend(list)
            }
        awaitClose { reg.remove() }
    }

    // Live signals (RTDB)
    fun removeLiveSignalsListener(ref: DatabaseReference, listener: ChildEventListener) {
        ref.removeEventListener(listener)
    }

    fun listenForLiveSignals(streamId: String, onSignal: () -> Unit): Pair<DatabaseReference, ChildEventListener> {
        val ref = rtdb.getReference("live_signals/$streamId")
        val listener = object : ChildEventListener {
            override fun onChildAdded(snapshot: DataSnapshot, previousChildName: String?) { onSignal() }
            override fun onChildChanged(snapshot: DataSnapshot, previousChildName: String?) {}
            override fun onChildRemoved(snapshot: DataSnapshot) {}
            override fun onChildMoved(snapshot: DataSnapshot, previousChildName: String?) {}
            override fun onCancelled(error: DatabaseError) { Log.e(TAG, "listenForLiveSignals", error.toException()) }
        }
        ref.addChildEventListener(listener)
        return Pair(ref, listener)
    }

    suspend fun resolveLiveStreamChatMinTimestampForAudience(streamId: String, joinWallMs: Long = 0L): Long = try {
        val snap = firestore.collection("live_streams").document(streamId).get().await()
        val streamStart = snap.getLong("streamStartedAtMillis") ?: 0L
        maxOf(streamStart, joinWallMs)
    } catch (e: Exception) { Log.e(TAG, "resolveLiveStreamChatMinTimestampForAudience", e); 0L }

    // User management
    suspend fun deleteUserProfile(userId: String) {
        try {
            firestore.collection("users").document(userId).delete().await()
        } catch (e: Exception) { Log.e(TAG, "deleteUserProfile", e) }
    }

    // Incoming call observers
    fun observeIncomingCallFirestore(userId: String): Flow<IncomingCallInvite?> = callbackFlow {
        val reg = firestore.collection("incoming_calls").document(userId)
            .addSnapshotListener { snap, err ->
                if (err != null) { Log.e(TAG, "observeIncomingCallFirestore", err); return@addSnapshotListener }
                if (snap == null || !snap.exists()) { trySend(null); return@addSnapshotListener }
                val invite = IncomingCallInvite(
                    roomId = snap.getString("roomId") ?: "",
                    callerId = snap.getString("callerId") ?: "",
                    callerName = snap.getString("callerName") ?: "",
                    callerPhotoUrl = snap.getString("callerPhotoUrl") ?: "",
                    isVideoCall = snap.getBoolean("isVideoCall") ?: true,
                )
                trySend(invite)
            }
        awaitClose { reg.remove() }
    }

    fun observeIncomingCall(userId: String): Flow<IncomingCallInvite?> = callbackFlow {
        val ref = rtdb.getReference("incoming_calls/$userId")
        val listener = object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                if (!snapshot.exists()) { trySend(null); return }
                @Suppress("UNCHECKED_CAST")
                val map = snapshot.value as? Map<String, Any> ?: run { trySend(null); return }
                val invite = IncomingCallInvite(
                    roomId = map["roomId"] as? String ?: "",
                    callerId = map["callerId"] as? String ?: "",
                    callerName = map["callerName"] as? String ?: "",
                    callerPhotoUrl = map["callerPhotoUrl"] as? String ?: "",
                    isVideoCall = map["isVideoCall"] as? Boolean ?: true,
                )
                trySend(invite)
            }
            override fun onCancelled(error: DatabaseError) { Log.e(TAG, "observeIncomingCall", error.toException()) }
        }
        ref.addValueEventListener(listener)
        awaitClose { ref.removeEventListener(listener) }
    }

    // Document parsing
    fun userProfileFromDocument(doc: DocumentSnapshot?): UserProfile? = try {
        doc?.toObject(UserProfile::class.java)?.copy(id = doc.id)
    } catch (e: Exception) { Log.e(TAG, "userProfileFromDocument", e); null }

    // Call response
    suspend fun waitForCallResponse(callerId: String, roomId: String, timeoutMs: Long = 20_000): String? = try {
        val snap = firestore.collection("call_responses").document(roomId).get().await()
        if (!snap.exists()) null else snap.getString("status")
    } catch (e: Exception) { Log.e(TAG, "waitForCallResponse", e); null }

    // RTDB connected
    fun observeRtdbConnected(): Flow<Boolean> = callbackFlow {
        val ref = rtdb.getReference(".info/connected")
        val listener = object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                trySend(snapshot.getValue(Boolean::class.java) ?: false)
            }
            override fun onCancelled(error: DatabaseError) { Log.e(TAG, "observeRtdbConnected", error.toException()) }
        }
        ref.addValueEventListener(listener)
        awaitClose { ref.removeEventListener(listener) }
    }

    // Batch profile fetch
    suspend fun getProfiles(): List<UserProfile> = try {
        firestore.collection("users").get().await()
            .documents.mapNotNull { it.toObject(UserProfile::class.java)?.copy(id = it.id) }
    } catch (e: Exception) { Log.e(TAG, "getProfiles", e); emptyList() }

    // Catalog observers
    fun observeGifts(): Flow<List<Gift>> = callbackFlow {
        val reg = firestore.collection("gifts").addSnapshotListener { snap, err ->
            if (err != null) { Log.e(TAG, "observeGifts", err); return@addSnapshotListener }
            val list = snap?.documents?.mapNotNull { it.toObject(Gift::class.java)?.copy(id = it.id) } ?: emptyList()
            trySend(list)
        }
        awaitClose { reg.remove() }
    }

    fun observeResellers(): Flow<List<ResellAgent>> = callbackFlow {
        val reg = firestore.collection("resellers").addSnapshotListener { snap, err ->
            if (err != null) { Log.e(TAG, "observeResellers", err); return@addSnapshotListener }
            val list = snap?.documents?.mapNotNull { it.toObject(ResellAgent::class.java) } ?: emptyList()
            trySend(list)
        }
        awaitClose { reg.remove() }
    }

    // Audio party video call requests
    suspend fun submitAudioPartyVideoCallRequest(hostId: String, fromUserId: String, displayName: String, photoUrl: String) {
        try {
            val data = mapOf("fromUserId" to fromUserId, "displayName" to displayName, "photoUrl" to photoUrl, "status" to "PENDING", "timestamp" to System.currentTimeMillis())
            firestore.collection("streams").document(hostId).collection("video_call_requests")
                .document(fromUserId).set(data).await()
        } catch (e: Exception) { Log.e(TAG, "submitAudioPartyVideoCallRequest", e) }
    }

    suspend fun resolveAudioPartyVideoCallRequest(hostId: String, fromUserId: String, newStatus: String) {
        try {
            firestore.collection("streams").document(hostId).collection("video_call_requests")
                .document(fromUserId).update("status", newStatus).await()
        } catch (e: Exception) { Log.e(TAG, "resolveAudioPartyVideoCallRequest", e) }
    }

    // Auth
    suspend fun signInAnonymously(): String? = try {
        auth.signInAnonymously().await().user?.uid
    } catch (e: Exception) { Log.e(TAG, "signInAnonymously", e); null }

    // Inbox
    suspend fun fetchRecentMessagesInvolvingUser(userId: String, perQuery: Int = 100): List<Message> = try {
        firestore.collection("messages")
            .whereEqualTo("senderId", userId)
            .limit(perQuery.toLong())
            .get().await()
            .documents.mapNotNull { it.toObject(ChatMessage::class.java)?.copy(id = it.id) }
    } catch (e: Exception) { Log.e(TAG, "fetchRecentMessagesInvolvingUser", e); emptyList() }

    // Storage uploads (stub — real impl uses Firebase Storage)
    suspend fun uploadProfilePhoto(uri: Uri): String {
        Log.w(TAG, "uploadProfilePhoto: stub — real impl requires Firebase Storage")
        return ""
    }

    suspend fun uploadGalleryImage(uri: Uri): String {
        Log.w(TAG, "uploadGalleryImage: stub — real impl requires Firebase Storage")
        return ""
    }

    suspend fun uploadVideo(uri: Uri): String {
        Log.w(TAG, "uploadVideo: stub — real impl requires Firebase Storage")
        return ""
    }

    suspend fun uploadFaceVerificationImage(uri: Uri): String {
        Log.w(TAG, "uploadFaceVerificationImage: stub — real impl requires Firebase Storage")
        return ""
    }

    // Verification
    suspend fun writeVerificationApproved(userId: String, imageUrl: String?) {
        try {
            val data = mutableMapOf<String, Any>(
                "faceVerificationStatus" to "APPROVED",
                "isVerified" to true,
                "isFaceVerified" to true,
                "isCallVerificationApproved" to true,
                "hasStarBadge" to true,
            )
            if (imageUrl != null) data["faceVerificationImageUrl"] = imageUrl
            firestore.collection("users").document(userId).update(data).await()
        } catch (e: Exception) { Log.e(TAG, "writeVerificationApproved", e) }
    }

    // CRM
    fun observeCrmAnnouncements(): Flow<List<CrmAnnouncement>> = callbackFlow {
        val reg = firestore.collection("crm_announcements")
            .orderBy("createdAt", Query.Direction.DESCENDING)
            .addSnapshotListener { snap, err ->
                if (err != null) { Log.e(TAG, "observeCrmAnnouncements", err); return@addSnapshotListener }
                val list = snap?.documents?.mapNotNull { it.toObject(CrmAnnouncement::class.java) } ?: emptyList()
                trySend(list)
            }
        awaitClose { reg.remove() }
    }

    // Image normalization
    fun normalizeImageReference(ref: String): String = ref.trim()

    // ─────────────────────────────────────────────────────────────────────────
    // FIRESTORE WEBRTC SIGNALING (one-to-one calls)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Write (merge) the caller's SDP offer into `calls/{roomId}`.
     * Returns true on success.
     */
    suspend fun mergeCallWebRtcOffer(
        roomId: String,
        callerUid: String,
        sdpType: String,
        sdpDescription: String,
    ): Boolean = try {
        firestore.collection("calls").document(roomId)
            .set(
                mapOf(
                    "offer" to mapOf("type" to sdpType, "sdp" to sdpDescription),
                    "callerUid" to callerUid,
                    "updatedAt" to System.currentTimeMillis(),
                ),
                SetOptions.merge(),
            ).await()
        true
    } catch (e: Exception) {
        Log.e(TAG, "mergeCallWebRtcOffer room=$roomId", e)
        false
    }

    /**
     * Mark the call document with a no-answer / SDP timeout flag so the callee knows
     * the call was abandoned before an answer was exchanged.
     */
    suspend fun markCallNoAnswerSdpTimeout(roomId: String) {
        try {
            firestore.collection("calls").document(roomId)
                .set(
                    mapOf("noAnswerTimeout" to true, "updatedAt" to System.currentTimeMillis()),
                    SetOptions.merge(),
                ).await()
        } catch (e: Exception) {
            Log.e(TAG, "markCallNoAnswerSdpTimeout room=$roomId", e)
        }
    }

    /**
     * Write (merge) the callee's SDP answer into `calls/{roomId}`.
     * Returns true on success.
     */
    suspend fun mergeCallWebRtcAnswer(
        roomId: String,
        sdpType: String,
        sdpDescription: String,
    ): Boolean = try {
        firestore.collection("calls").document(roomId)
            .set(
                mapOf(
                    "answer" to mapOf("type" to sdpType, "sdp" to sdpDescription),
                    "updatedAt" to System.currentTimeMillis(),
                ),
                SetOptions.merge(),
            ).await()
        true
    } catch (e: Exception) {
        Log.e(TAG, "mergeCallWebRtcAnswer room=$roomId", e)
        false
    }

    /**
     * Fetch TURN server credentials from `turn_credentials` Firestore collection.
     * Returns an empty list if unavailable (caller falls back to STUN).
     */
    suspend fun getTurnCredentials(): List<PeerConnection.IceServer> {
        return try {
            val doc = firestore.collection("turn_credentials").document("config").get().await()
            if (!doc.exists()) return emptyList()
            @Suppress("UNCHECKED_CAST")
            val servers = doc.get("servers") as? List<Map<String, Any>> ?: return emptyList()
            servers.mapNotNull { s ->
                val url = s["url"] as? String ?: return@mapNotNull null
                val username = s["username"] as? String
                val credential = s["credential"] as? String
                if (username != null && credential != null) {
                    PeerConnection.IceServer.builder(url)
                        .setUsername(username)
                        .setPassword(credential)
                        .createIceServer()
                } else {
                    PeerConnection.IceServer.builder(url).createIceServer()
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "getTurnCredentials", e)
            emptyList()
        }
    }

    /**
     * Add an ICE candidate to `calls/{roomId}/{collection}`.
     * [collection] is "offerCandidates" (caller) or "answerCandidates" (callee).
     * Returns true on success.
     */
    suspend fun addCallWebRtcIceCandidate(
        roomId: String,
        collection: String,
        sdp: String,
        sdpMid: String?,
        sdpMLineIndex: Int,
    ): Boolean = try {
        val data = mapOf(
            "sdp" to sdp,
            "sdpMid" to (sdpMid ?: ""),
            "sdpMLineIndex" to sdpMLineIndex,
            "timestamp" to System.currentTimeMillis(),
        )
        firestore.collection("calls").document(roomId)
            .collection(collection).add(data).await()
        true
    } catch (e: Exception) {
        Log.e(TAG, "addCallWebRtcIceCandidate room=$roomId coll=$collection", e)
        false
    }

    companion object {
        private const val TAG = "FirebaseService"
    }
}

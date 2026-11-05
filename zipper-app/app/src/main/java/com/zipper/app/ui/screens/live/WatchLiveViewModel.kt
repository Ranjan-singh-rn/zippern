package com.zipper.app.ui.screens.live

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.FirebaseAuth
import com.zipper.app.data.model.GiftLeaderboardEntry
import com.zipper.app.data.model.LiveComment
import com.zipper.app.data.model.LiveGiftEvent
import com.zipper.app.data.model.LiveRoom
import com.zipper.app.data.model.ViewerPresence
import com.zipper.app.data.repository.AgoraTokenRepository
import com.zipper.app.data.repository.GiftItem
import com.zipper.app.data.repository.GiftRepository
import com.zipper.app.data.repository.LiveRepository
import com.zipper.app.data.repository.PKRepository
import com.zipper.app.data.repository.ProfileRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class WatchLiveUiState(
    val room: LiveRoom? = null,
    /** O5c (5 Nov 2026): what a minute with the host would cost this viewer (0 = they would not pay, or unknown). */
    val callPerMinDiamonds: Long = 0L,
    /** The call the server just started with the host — the screen opens it. */
    val navigateToCall: String? = null,
    val callStarting: Boolean = false,
    val comments: List<LiveComment> = emptyList(),
    val recentGifts: List<LiveGiftEvent> = emptyList(),
    val viewers: List<ViewerPresence> = emptyList(),
    val giftLeaderboard: List<GiftLeaderboardEntry> = emptyList(),
    val isConnected: Boolean = false,
    val isHostOffline: Boolean = false,
    val isLiveEnded: Boolean = false,
    /** The host removed me from this room. Terminal: never auto-reconnect. */
    val wasKicked: Boolean = false,
    val error: String? = null,
    /**
     * A one-off acknowledgement for something the viewer just did — a filed
     * report, today.
     *
     * Separate from [error] because it is not one: [error] is what went wrong,
     * and a report that WORKED needs saying out loud just as much. Reporting
     * abuse and seeing the sheet close on silence reads as the app ignoring you,
     * which is the reading least likely to be true and most likely to stop
     * somebody reporting the next thing.
     */
    val toastMessage: String? = null,
    val commentInput: String = "",
    val remoteUid: Int = 0,
    val isFollowing: Boolean = false,
    val showComments: Boolean = true,
    val likeCount: Long = 0L,
    val isRejoining: Boolean = false,
    val joinedAt: Long = 0L,
    val streamQuality: String = "Auto",
    /** The real gift catalogue from Firestore. Empty until it loads. */
    val gifts: List<GiftItem> = emptyList(),
    val myDiamonds: Long = 0L,
    val giftSending: Boolean = false,
    /** Spec §11: the server's roll on the last lucky gift this viewer sent, for the celebration. */
    val luckyWin: com.zipper.app.data.repository.GiftResult.LuckyWin? = null,
    // PK Battle
    val pkActive: Boolean = false,
    val pkScore: Long = 0L,
    val pkPartnerScore: Long = 0L,
    val pkPartnerName: String = "",
    val pkPartnerPhotoUrl: String = "",
    val pkPartnerId: String = "",
    val pkPartnerUid: String = "",
    val pkEndTime: Long = 0L,
    val pkPartnerRemoteUid: Int = 0,
    // ── B12 (4 Nov 2026) ─────────────────────────────────────────────────────
    /** The host paused the live ("back soon"). */
    val isPaused: Boolean = false,
    /** The host's camera is off — show their photo, not a black frame. */
    val isCameraOff: Boolean = false,
    /** The host's pinned announcement. */
    val pinnedMessage: String = "",
    /** The host muted ME in the chat: the box says so instead of failing silently. */
    val isMutedInChat: Boolean = false,
    /** The host's level, from their public profile. */
    val hostLevel: Int = 0,
    /** The host's video left the channel (their network dropped) — waiting for it to come back. */
    val hostVideoLost: Boolean = false,
    /** This phone's own connection to the stream. */
    val link: AgoraManager.Link = AgoraManager.Link.Idle,
    /** I blocked the host: leave the screen. */
    val blockedHost: Boolean = false,
    /** The last PK's verdict, shown for a moment after it ends. */
    val pkVerdict: String? = null,
)

@HiltViewModel
class WatchLiveViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val repo: LiveRepository,
    private val pkRepo: PKRepository,
    private val profileRepo: ProfileRepository,
    private val agoraTokenRepo: AgoraTokenRepository,
    private val giftRepo: GiftRepository,
    private val auth: FirebaseAuth,
    /** O5c: calling the host from the room — the same paid call the profile and the chat start. */
    private val callStarter: com.zipper.app.data.repository.CallStarter,
) : ViewModel() {

    private val roomId: String = savedStateHandle.get<String>("roomId") ?: ""

    private val _state = MutableStateFlow(WatchLiveUiState())
    val state: StateFlow<WatchLiveUiState> = _state.asStateFlow()

    private var currentUser: com.zipper.app.data.model.User? = null

    /**
     * One `joinRoom` per session must be answered by exactly one `leaveRoom`.
     * The screen's onDispose, the More sheet, the live-ended exit and
     * `onCleared` all used to fire, so a single visit could decrement the
     * viewer count three times and push it negative.
     */
    @Volatile private var hasLeft = false

    private var commentsJob: kotlinx.coroutines.Job? = null

    /** Guards the gift overlay against replaying the last 20 gifts on join. */
    private var giftsJob: kotlinx.coroutines.Job? = null
    @Volatile private var giftCursor: Long = 0L
    private var lastShownGiftId: String? = null
    private val shownGiftIds = LinkedHashSet<String>()

    /** B12: "still watching", every minute while connected. */
    private var heartbeatJob: kotlinx.coroutines.Job? = null
    private var hostLevelLoaded = false
    private var lastPkSeen = 0L

    init {
        viewModelScope.launch { com.zipper.app.util.SafetyWords.ensureLoaded(com.google.firebase.firestore.FirebaseFirestore.getInstance()) }
        collectRoomData()
        loadCurrentUser()
        loadGiftCatalogue()
        viewModelScope.launch { AgoraManager.link.collect { l -> _state.update { it.copy(link = l) } } }
    }

    private fun startHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = viewModelScope.launch {
            while (true) {
                kotlinx.coroutines.delay(LiveRepository.LIVE_HEARTBEAT_MS)
                if (hasLeft) break
                try { repo.viewerHeartbeat(roomId) } catch (_: Exception) {}
            }
        }
    }

    /**
     * The gift sheet used to render a hardcoded list in the Compose file, with
     * prices written in Kotlin and no ids at all. Those gifts did not exist in
     * Firestore, so the server cannot price them — and the prices in the file
     * had drifted from the CRM regardless.
     */
    private fun loadGiftCatalogue() {
        viewModelScope.launch {
            val gifts = giftRepo.fetchGifts()
            _state.update { it.copy(gifts = gifts) }
        }
    }

    private fun loadCurrentUser() {
        viewModelScope.launch {
            profileRepo.currentUserFlow().collect { user ->
                currentUser = user
                _state.update { it.copy(myDiamonds = user?.diamonds ?: 0L) }
                // Check if we're already following the host
                if (user != null && _state.value.room?.hostUid?.isNotBlank() == true) {
                    val following = try { profileRepo.isFollowing(_state.value.room!!.hostUid) } catch (_: Exception) { false }
                    _state.update { it.copy(isFollowing = following) }
                }
            }
        }
    }

    private fun collectRoomData() {
        if (roomId.isBlank()) return

        viewModelScope.launch {
            repo.roomFlow(roomId).collect { room ->
                if (room == null) return@collect
                val isOffline = !room.isActive
                val myUid = auth.currentUser?.uid.orEmpty()
                // B12: a PK that ended while I watched — the server's verdict, said once.
                val verdict = if (room.lastPkEndedAt > lastPkSeen && room.lastPkEndedAt > _state.value.joinedAt && _state.value.joinedAt > 0) {
                    lastPkSeen = room.lastPkEndedAt
                    LiveRoomUi.pkVerdict(room.hostName, room.hostUid, room.lastPkWinnerUid, room.lastPkMyScore, room.lastPkPartnerScore)
                } else null
                _state.update {
                    it.copy(
                        room = room,
                        isHostOffline = isOffline,
                        isLiveEnded = isOffline,
                        likeCount = room.likeCount,
                        pkActive = room.pkActive,
                        pkScore = room.pkScore,
                        pkPartnerScore = room.pkPartnerScore,
                        pkPartnerName = room.pkPartnerName,
                        pkPartnerPhotoUrl = room.pkPartnerPhotoUrl,
                        pkPartnerId = room.pkPartnerId,
                        pkPartnerUid = room.pkPartnerUid,
                        pkEndTime = room.pkEndTime,
                        isPaused = room.isPaused,
                        isCameraOff = room.isCameraOff,
                        pinnedMessage = room.pinnedMessage,
                        isMutedInChat = myUid.isNotBlank() && myUid in room.mutedViewers,
                        pkVerdict = verdict ?: it.pkVerdict,
                    )
                }
                if (!hostLevelLoaded && room.hostUid.isNotBlank()) {
                    hostLevelLoaded = true
                    val level = try { repo.hostLevel(room.hostUid) } catch (_: Exception) { 0 }
                    _state.update { it.copy(hostLevel = level) }
                }
                // Kicked? Read the uid from auth, not from the profile flow —
                // on a cold open `currentUser` is still null and the old
                // `?: return@collect` skipped the check entirely.
                if (myUid.isNotBlank() && room.kickedViewers.contains(myUid)) onKicked()
            }
        }
        viewModelScope.launch {
            repo.viewersFlow(roomId).collect { viewers ->
                _state.update { it.copy(viewers = viewers) }
            }
        }
        viewModelScope.launch {
            repo.giftLeaderboardFlow(roomId).collect { gifters ->
                _state.update { it.copy(giftLeaderboard = gifters.top) }
            }
        }
    }

    private fun startCommentCollection(fromTimestamp: Long) {
        commentsJob?.cancel()
        commentsJob = viewModelScope.launch {
            repo.commentsFromFlow(roomId, fromTimestamp).collect { comments ->
                _state.update { it.copy(comments = comments) }
            }
        }
        if (giftsJob == null) startGiftCollection(fromTimestamp)
    }

    /**
     * `liveGiftsFlow` hands back the last 20 gifts, newest first. Queueing all
     * of them meant walking into a busy room replayed twenty old animations one
     * after another. Only gifts that landed after we joined are shown, oldest
     * first, and each id is shown at most once.
     */
    private fun startGiftCollection(since: Long) {
        giftCursor = since
        giftsJob = viewModelScope.launch {
            repo.liveGiftsFlow(roomId).collect { gifts ->
                val fresh = gifts
                    .filter { it.timestamp > giftCursor && it.id.isNotBlank() && it.id != lastShownGiftId && it.id !in shownGiftIds }
                    .sortedBy { it.timestamp }
                if (fresh.isEmpty()) return@collect
                fresh.forEach { shownGiftIds.add(it.id) }
                lastShownGiftId = fresh.last().id
                while (shownGiftIds.size > 200) shownGiftIds.remove(shownGiftIds.first())
                _state.update { st -> st.copy(recentGifts = (st.recentGifts + fresh).takeLast(10)) }
            }
        }
    }

    /**
     * Initialize Agora, fetch a server-generated token, and join the channel as audience.
     * Call this from the screen instead of calling AgoraManager directly.
     */
    fun initAndJoinAgora(context: android.content.Context) {
        if (roomId.isBlank()) return
        AgoraManager.init(context)
        AgoraManager.onUserJoined = { uid -> onRemoteUserJoined(uid) }
        // B12: the host's video left the channel — their network, not the live, most of the time. Said on screen
        // until it comes back or the room ends.
        AgoraManager.onUserOffline = { uid ->
            if (uid != 0 && uid == _state.value.remoteUid) _state.update { it.copy(hostVideoLost = true) }
        }
        // A-6: the hour-long token is renewed in place by AgoraManager through
        // the same repository call that issued it.
        AgoraManager.tokenRenewer = { channel -> agoraTokenRepo.renewToken(channel) }
        viewModelScope.launch {
            // The server refuses a token to a viewer the host has kicked. That
            // refusal is authoritative — the room document may not have reached
            // this device yet, and on a fresh open it never will, because the
            // kicked user is opening the room for the first time.
            when (val r = agoraTokenRepo.requestToken(roomId)) {
                // A-7: joined with the uid the token was signed for, never 0.
                is com.zipper.app.data.repository.AgoraTokenResult.Granted ->
                    AgoraManager.joinAsAudience(roomId, r.token, r.uid)
                com.zipper.app.data.repository.AgoraTokenResult.Denied -> onKicked()
                com.zipper.app.data.repository.AgoraTokenResult.Ended ->
                    _state.update { it.copy(isLiveEnded = true, isConnected = false) }
                is com.zipper.app.data.repository.AgoraTokenResult.Failed ->
                    _state.update { it.copy(error = r.message ?: "Could not join this live.") }
            }
        }
    }

    fun join() {
        if (roomId.isBlank()) return
        val joinedAt = System.currentTimeMillis()
        _state.update { it.copy(joinedAt = joinedAt) }
        viewModelScope.launch {
            try {
                // B12: no counter to bump — the presence row below is what the server counts.
                // currentUserFlow may not have emitted yet on a cold open.
                val user = currentUser ?: try { profileRepo.fetchCurrentUser() } catch (_: Exception) { null }
                if (user != null) {
                    currentUser = user
                    repo.addViewerPresence(roomId, user)
                    repo.sendJoinEvent(roomId, user.name.ifBlank { "Someone" }, user.photoUrl)
                }
                _state.update { it.copy(isConnected = true, isRejoining = false) }
                startCommentCollection(joinedAt)
                startHeartbeat()
                // Check follow status
                if (user != null) {
                    val following = try { profileRepo.isFollowing(_state.value.room?.hostUid ?: "") } catch (_: Exception) { false }
                    _state.update { it.copy(isFollowing = following) }
                }
            } catch (e: Exception) {
                _state.update { it.copy(error = e.localizedMessage) }
            }
        }
    }

    /**
     * The one real leave path. Runs at most once per session so the `+1` from
     * [join] is answered by exactly one `-1`, whichever of onCleared / an
     * explicit leave gets there first.
     */
    fun leave() {
        if (roomId.isBlank() || hasLeft) return
        hasLeft = true
        AgoraManager.leaveChannel()
        _state.update { it.copy(isConnected = false) }
        // viewModelScope may already be cancelled by the time the screen pops.
        heartbeatJob?.cancel()
        teardownScope.launch {
            // B12: removing the presence row is the leave — the server recounts from the rows.
            try { repo.removeViewerPresence(roomId) } catch (_: Exception) {}
        }
    }

    /**
     * The host removed us. The kick batch already deleted our presence doc (the
     * server recounts from it), so we only tear down locally — and we mark the
     * session left so nothing runs a second leave.
     */
    private fun onKicked() {
        if (_state.value.wasKicked) return
        hasLeft = true
        heartbeatJob?.cancel()
        giftsJob?.cancel()
        AgoraManager.leaveChannel()
        _state.update { it.copy(wasKicked = true, isConnected = false, isRejoining = false) }
    }

    fun rejoin() {
        if (roomId.isBlank() || hasLeft || _state.value.wasKicked) return
        _state.update { it.copy(isRejoining = true) }
        viewModelScope.launch {
            try {
                // A reconnect is the other way a kicked viewer gets back in, so
                // it asks the same question and honours the same answer.
                val r = agoraTokenRepo.requestToken(roomId)
                if (r is com.zipper.app.data.repository.AgoraTokenResult.Denied) {
                    onKicked(); return@launch
                }
                if (r is com.zipper.app.data.repository.AgoraTokenResult.Ended) {
                    _state.update { it.copy(isLiveEnded = true, isRejoining = false) }; return@launch
                }
                val grant = r as? com.zipper.app.data.repository.AgoraTokenResult.Granted
                AgoraManager.joinAsAudience(roomId, grant?.token, grant?.uid ?: 0)
                // Presence is a document, not a counter: re-joining Agora
                // without re-writing it left us invisible in the host's viewer
                // list for the rest of the session.
                val user = currentUser ?: try { profileRepo.fetchCurrentUser() } catch (_: Exception) { null }
                if (user != null) {
                    currentUser = user
                    repo.addViewerPresence(roomId, user)
                }
                val joinedAt = System.currentTimeMillis()
                _state.update { it.copy(joinedAt = joinedAt, isRejoining = false, isConnected = true, hostVideoLost = false) }
                startCommentCollection(joinedAt)
                startHeartbeat()
            } catch (e: Exception) {
                _state.update { it.copy(error = e.localizedMessage, isRejoining = false) }
            }
        }
    }

    // ── O5c: call the host ────────────────────────────────────────────────────

    private var priceFor: String = ""

    /** The price a minute, estimated once per host the same way the profile does (util/CallPrice). */
    fun prepareCallPrice() {
        val hostUid = _state.value.room?.hostUid.orEmpty()
        if (hostUid.isBlank() || hostUid == priceFor) return
        priceFor = hostUid
        viewModelScope.launch {
            val q = callStarter.quote(hostUid)
            if (q == null) priceFor = "" else _state.update { it.copy(callPerMinDiamonds = q.perMinDiamonds, myDiamonds = q.myDiamonds) }
        }
    }

    /**
     * Ring the host. The server decides everything — the price, the balance, the host's "calls off" switch for this
     * broadcast, blocks — and its refusal is said on screen in its own words.
     */
    fun callHost() {
        val hostUid = _state.value.room?.hostUid.orEmpty()
        if (hostUid.isBlank() || hostUid == auth.currentUser?.uid || _state.value.callStarting) return
        _state.update { it.copy(callStarting = true) }
        viewModelScope.launch {
            when (val res = callStarter.start(hostUid)) {
                is com.zipper.app.data.repository.CallRepository.CallStart.Ok ->
                    _state.update { it.copy(callStarting = false, navigateToCall = res.callId) }
                is com.zipper.app.data.repository.CallRepository.CallStart.Failed ->
                    _state.update { it.copy(callStarting = false, toastMessage = res.message) }
            }
        }
    }

    fun consumeCallNavigation() { _state.update { it.copy(navigateToCall = null) } }

    fun onCommentInput(v: String) { _state.update { it.copy(commentInput = v) } }

    fun sendComment() {
        val message = _state.value.commentInput.trim()
        if (message.isBlank() || roomId.isBlank()) return
        // B12: muted by the host — the rules would refuse it; say why instead.
        if (_state.value.isMutedInChat) {
            _state.update { it.copy(toastMessage = LiveRoomUi.MUTED_NOTICE) }
            return
        }
        // O13: held back here, with the text left in the box to fix — the server would mask it and count a strike.
        if (!com.zipper.app.util.SafetyWords.allowed(message)) {
            _state.update { it.copy(toastMessage = com.zipper.app.util.SafetyWords.HELD_NOTICE) }
            return
        }
        _state.update { it.copy(commentInput = "") }
        viewModelScope.launch {
            try { repo.sendComment(roomId, message) }
            catch (e: Exception) { _state.update { it.copy(error = e.localizedMessage) } }
        }
    }

    fun sendGift(
        gift: GiftItem,
        qty: Int = 1,
        targetRoomId: String = roomId,
        targetHostUid: String = _state.value.room?.hostUid ?: "",
    ) {
        if (targetRoomId.isBlank() || targetHostUid.isBlank()) return
        // One key for this tap. If the send is retried, it must be this key —
        // a new one would read as a second gift and charge twice.
        val key = idempotencyKeyFor(gift.id, targetHostUid, qty)
        // Spec §11: a lucky gift travels as `combo`, a normal one as `quantity`.
        val shape = com.zipper.app.util.LuckyCombos.sendShape(gift.isLucky, qty)
        _state.update { it.copy(giftSending = true) }
        viewModelScope.launch {
            val result = repo.sendGiftInLiveDetailed(
                roomId = targetRoomId,
                hostUid = targetHostUid,
                giftId = gift.id,
                quantity = shape.quantity ?: 1,
                idempotencyKey = key,
                combo = shape.combo,
            )
            _state.update { it.copy(giftSending = false) }
            when (result) {
                is com.zipper.app.data.repository.GiftResult.Error -> {
                    _state.update { it.copy(error = result.message) }
                    return@launch
                }
                is com.zipper.app.data.repository.GiftResult.InsufficientDiamonds -> {
                    _state.update { it.copy(error = "Not enough diamonds — recharge to send this gift.") }
                    return@launch
                }
                // The SERVER's roll, shown as it came back; never computed here.
                is com.zipper.app.data.repository.GiftResult.LuckyWin ->
                    _state.update { it.copy(luckyWin = result) }
                is com.zipper.app.data.repository.GiftResult.Success -> Unit
            }
            // B12: the PK score is added by the server in the gift's own settlement — nothing to write here.
        }
    }

    /** The celebration has been shown. */
    fun clearLuckyWin() { _state.update { it.copy(luckyWin = null) } }

    /**
     * A key per send, stable only for the coroutine that owns it. Two taps a
     * second apart are two gifts and must not collapse into one, so the key
     * carries a fresh uuid rather than being derived from the arguments alone.
     */
    private fun idempotencyKeyFor(giftId: String, hostUid: String, qty: Int): String =
        "live_${giftId}_${hostUid}_${qty}_" + java.util.UUID.randomUUID()

    /**
     * Bump the room's like counter.
     *
     * The failure is swallowed on purpose, and this is the one place in this
     * screen where that is the right answer: a like is a tap somebody makes
     * twenty times in a row, it buys them nothing, and the counter is a shared
     * field that any viewer may be incrementing in the same instant. Telling
     * somebody a heart did not land would be noise about something they have
     * already forgotten — and they can simply tap again.
     */
    fun addLike() {
        viewModelScope.launch {
            try { repo.addLike(roomId) } catch (_: Exception) {}
        }
    }

    fun followHost() {
        val hostUid = _state.value.room?.hostUid ?: return
        viewModelScope.launch {
            try {
                profileRepo.followUser(hostUid)
                _state.update { it.copy(isFollowing = true) }
            } catch (e: Exception) {
                _state.update { it.copy(error = e.localizedMessage) }
            }
        }
    }

    /**
     * File a report against the host.
     *
     * Both outcomes are said out loud. This used to swallow the failure AND say
     * nothing on success, while the sheet dismissed itself the moment the reason
     * was tapped — so a viewer reporting something that frightened them got a
     * closing sheet and no word either way, which is indistinguishable from the
     * app having thrown the report away. An acknowledgement is the whole of what
     * a reporter gets in return; there is no queue for them to check.
     *
     * Matches OtherUserViewModel.report, which is the same action from a profile.
     */
    fun reportHost(reason: String) {
        val hostUid = _state.value.room?.hostUid?.takeIf { it.isNotBlank() }
        if (hostUid == null) {
            // The room document has not arrived yet, so there is nobody named to
            // report. Saying so beats a dismissed sheet and no report.
            _state.update { it.copy(toastMessage = "Still connecting — try reporting again in a moment.") }
            return
        }
        viewModelScope.launch {
            try {
                repo.reportUser(hostUid, reason)
                _state.update { it.copy(toastMessage = "Thanks — our team will review this live") }
            } catch (_: Exception) {
                _state.update { it.copy(toastMessage = "Couldn't send the report. Try again.") }
            }
        }
    }

    fun toggleShowComments() {
        _state.update { it.copy(showComments = !it.showComments) }
    }

    fun setStreamQuality(quality: String) {
        _state.update { it.copy(streamQuality = quality) }
        // Mobile parity: applied to the engine, not just highlighted in the sheet.
        AgoraManager.setRemoteQuality(_state.value.remoteUid, quality)
    }

    fun onRemoteUserJoined(uid: Int) {
        val s = _state.value
        if (uid == s.remoteUid) {
            // B12: the host's video is back.
            _state.update { it.copy(hostVideoLost = false) }
            return
        }
        if (s.remoteUid == 0) {
            _state.update { it.copy(remoteUid = uid, hostVideoLost = false) }
            if (s.streamQuality != "Auto") AgoraManager.setRemoteQuality(uid, s.streamQuality)
        } else if (s.pkActive && s.pkPartnerRemoteUid == 0) {
            _state.update { it.copy(pkPartnerRemoteUid = uid) }
        }
    }

    /** Pops the gift that just finished playing. The queue only ever holds
     *  gifts that arrived after we joined, so nothing is replayed. */
    fun dismissGift() {
        val done = _state.value.recentGifts.firstOrNull()
        if (done != null && done.timestamp > giftCursor) giftCursor = done.timestamp
        _state.update { it.copy(recentGifts = it.recentGifts.drop(1)) }
    }

    fun onPKEnd() {
        _state.update {
            it.copy(pkActive = false, pkScore = 0, pkPartnerScore = 0,
                pkPartnerId = "", pkEndTime = 0L, pkPartnerRemoteUid = 0)
        }
    }

    /**
     * B12: block the host from the live screen — the same block as a profile's, so they cannot call or message
     * either — and leave.
     */
    fun blockHost() {
        val room = _state.value.room ?: return
        viewModelScope.launch {
            when (val r = profileRepo.blockUser(room.hostUid, room.hostName, room.hostPhotoUrl)) {
                is com.zipper.app.data.repository.ProfileResult.Error ->
                    _state.update { it.copy(toastMessage = r.message) }
                else -> {
                    leave()
                    _state.update { it.copy(blockedHost = true) }
                }
            }
        }
    }

    fun clearPkVerdict() { _state.update { it.copy(pkVerdict = null) } }

    fun clearError() { _state.update { it.copy(error = null) } }

    fun clearToast() { _state.update { it.copy(toastMessage = null) } }

    override fun onCleared() {
        super.onCleared()
        // viewModelScope is already cancelled here — a launch on it never runs.
        // `leave()` does the work on a scope that outlives the ViewModel, and
        // no-ops if the session was already closed (kick, explicit leave).
        leave()
    }

    private companion object {
        val teardownScope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.IO)
    }
}

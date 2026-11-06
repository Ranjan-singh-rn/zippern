package com.zipper.app.ui.screens.live

import com.zipper.app.util.LiveModeration
import com.zipper.app.util.HostSuspension
import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.app.data.model.GiftLeaderboardEntry
import com.zipper.app.data.model.LiveComment
import com.zipper.app.data.model.LiveGiftEvent
import com.zipper.app.data.model.PkInvite
import com.zipper.app.data.model.User
import com.zipper.app.data.model.ViewerPresence
import com.zipper.app.data.repository.DiscoverRepository
import com.zipper.app.data.repository.AgoraTokenRepository
import com.zipper.app.data.repository.ChatRepository
import com.zipper.app.data.repository.LiveRepository
import com.zipper.app.data.repository.PKRepository
import com.zipper.app.data.repository.ProfileRepository
import kotlinx.coroutines.tasks.await
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

enum class PKState { IDLE, WAITING, INVITED, ACTIVE }

data class GoLiveUiState(
    /** Back from a call while live: paused and off air until the host chooses (Owner, 6 Nov). */
    val returnFromCallPrompt: Boolean = false,
    // Pre-live
    val title: String = "",
    val category: String = "general",
    val welcomeMessage: String = "",
    // Live state
    val isLive: Boolean = false,
    val roomId: String = "",
    val liveDurationSeconds: Long = 0L,
    val viewerCount: Int = 0,
    /**
     * The most people watching at once this session.
     *
     * [viewerCount] is a CONCURRENT count: it falls as people drift away, so
     * whatever it holds when the host presses End is just whoever happened to
     * still be there — a stream 400 people passed through can end with 12
     * watching. The post-live card used to print that under "Viewers", which
     * reads as a session total.
     *
     * A genuine cumulative figure does not exist to print: neither the room
     * document, the repository nor any Cloud Function tracks a peak or a
     * running total of unique viewers, and the `viewers` subcollection holds
     * only who is present right now. So this is the highest concurrent count
     * this session was seen to reach, and the card labels it as such.
     *
     * Measured off the presence list rather than `room.viewerCount`, because
     * the presence list is what the "N watching" chip showed the host all
     * stream (GoLiveScreen) and the counter is a field any viewer may write
     * that is documented to drift.
     */
    val peakViewers: Int = 0,
    val totalGiftsReceived: Long = 0L,
    /**
     * The host's own earnings this session, in BEANS.
     *
     * Was named totalDiamondsSession and rendered with a diamond glyph while
     * being assigned room.totalBeansEarned — so a host who earned 1,000 beans
     * watched a counter reading 1,000 diamonds, a 20x overstatement they would
     * only discover on payout day.
     */
    val totalBeansSession: Long = 0L,
    val isMicOn: Boolean = true,
    /**
     * B2: the live ended without the host pressing End — a staff End, the
     * server closing the room, or the 2-minute no-face rule. The broadcast has already been stopped; the screen
     * shows [remoteEndMessage] and then leaves to the summary.
     */
    val endedRemotely: Boolean = false,
    val remoteEndMessage: String = "",
    /** B2: a staff mute is in force; the mic is held off until it is lifted. */
    val mutedByStaff: Boolean = false,
    val staffMuteMessage: String = "",
    /**
     * Bumped whenever the ViewModel has moved the engine between channels — at
     * the moment a PK battle ends, today.
     *
     * `AgoraManager.leaveChannel` puts the camera down with the channel, so the
     * screen has to bind its SurfaceView and start the preview again afterwards,
     * and it needs something it can key an effect on. `pkState` will not do: it
     * flips the instant the room says the battle is over, which is before the
     * engine has gone anywhere.
     */
    val cameraEpoch: Int = 0,
    val isLoading: Boolean = false,
    val error: String? = null,
    val recentGifts: List<LiveGiftEvent> = emptyList(),
    val comments: List<LiveComment> = emptyList(),
    val commentInput: String = "",
    // Face detection
    val faceDetected: Boolean = true,
    val faceAbsenceCountdown: Int = LiveModeration.FACE_TIMEOUT_SECONDS, // seconds remaining before auto-end
    // Viewers + leaderboard
    val viewers: List<ViewerPresence> = emptyList(),
    val giftLeaderboard: List<GiftLeaderboardEntry> = emptyList(),
    /**
     * How many distinct people gifted this session. Deliberately not
     * `giftLeaderboard.size`, which stops counting at 20 — see RoomGifters.
     */
    val gifterCount: Int = 0,
    /**
     * Viewers whose removal is in flight, by uid.
     *
     * A kick's only visible effect was the row vanishing when the viewers
     * snapshot landed, so a kick that failed looked exactly like a kick that
     * was merely slow: nothing moves, and the host taps Remove again.
     */
    val kickPending: Set<String> = emptySet(),
    // Toggles
    val callProtectionEnabled: Boolean = false,
    // PK Battle
    val pkState: PKState = PKState.IDLE,
    val pkInvite: PkInvite? = null,
    val pkScore: Long = 0L,
    val pkPartnerScore: Long = 0L,
    val pkPartnerName: String = "",
    val pkPartnerPhotoUrl: String = "",
    val pkPartnerId: String = "",
    val pkEndTime: Long = 0L,
    // My info
    val myUid: String = "",
    val myName: String = "",
    val myPhotoUrl: String = "",
    // ── B12 (4 Nov 2026) ─────────────────────────────────────────────────────
    /** Paused: camera and mic off, viewers see "back soon"; the server ends a pause past 15 minutes. */
    val isPaused: Boolean = false,
    /** The camera is on (the host may talk with it off; viewers see the host's photo). */
    val isCameraOn: Boolean = true,
    /** The pinned announcement above the chat. */
    val pinnedMessage: String = "",
    /** Viewers muted in the chat. */
    val mutedViewers: Set<String> = emptySet(),
    /** The engine's connection — the host's own "Reconnecting…" chip. */
    val link: AgoraManager.Link = AgoraManager.Link.Idle,
    /** A one-off line for the snackbar that is not an error — the PK verdict. */
    val notice: String? = null,
)

@HiltViewModel
class GoLiveViewModel @Inject constructor(
    private val repo: LiveRepository,
    private val profileRepo: ProfileRepository,
    private val pkRepo: PKRepository,
    private val chatRepo: ChatRepository,
    private val agoraTokenRepo: AgoraTokenRepository,
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
    private val discover: DiscoverRepository,
    /** O13: the live wall's stills. */
    private val safety: com.zipper.app.data.repository.SafetyRepository,
    @dagger.hilt.android.qualifiers.ApplicationContext private val appContext: android.content.Context,
) : ViewModel() {

    private val _state = MutableStateFlow(GoLiveUiState())
    val state: StateFlow<GoLiveUiState> = _state.asStateFlow()

    /**
     * O10 (5 Nov 2026), speed: the on-air clock ticks in its own flow. It used to be a field of [state], so the whole
     * Go Live screen — camera surface, chat, gifts — recomposed once a second for one small "12:34" label.
     */
    private val _duration = MutableStateFlow(0L)
    val duration: StateFlow<Long> = _duration.asStateFlow()

    private var durationJob: Job? = null
    private var faceCountdownJob: Job? = null

    /**
     * The PK channel this battle committed to, and the coroutine moving the
     * engine into or out of it.
     *
     * ── THE PK RE-JOIN STORM ─────────────────────────────────────────────────
     *
     * The join used to live inside the room-document collector, which fires on
     * EVERY field change. During a battle the scores are incremented per gift
     * and `viewerCount` / `likeCount` are writable by any viewer, so a busy PK
     * produced several emissions a second — and each one bought a billed
     * `generateAgoraToken` invocation (several Firestore reads, including a
     * `pkRooms` query) plus a full `joinChannel` renegotiation that both hosts
     * and every viewer saw as a stutter. The awaited token fetch also stalled
     * the room-state pipeline: comments, scores and the PK timer all waited
     * behind a network round trip nobody needed.
     *
     * [pkChannel] is the channel this battle has already dealt with — joined,
     * joining, or tried and failed — which is what makes the join happen once
     * per battle instead of once per snapshot. It is only cleared when the
     * battle ends, so a failure does not turn into a retry per emission.
     */
    private var pkChannelJob: Job? = null
    @Volatile private var pkChannel: String = ""

    /**
     * `liveGiftsFlow` replays the last 20 gifts of the room. Only gifts that
     * land after the collector starts are animated, and each id plays once —
     * otherwise reattaching the listener replayed twenty gifts in a row.
     */
    @Volatile private var giftCursor: Long = 0L
    private var lastShownGiftId: String? = null
    private val shownGiftIds = LinkedHashSet<String>()

    fun onTitleChange(v: String) { _state.update { it.copy(title = v) } }
    fun onCategoryChange(v: String) { _state.update { it.copy(category = v) } }
    fun onWelcomeMessageChange(v: String) { _state.update { it.copy(welcomeMessage = v) } }
    fun onCommentInput(v: String) { _state.update { it.copy(commentInput = v) } }
    fun clearError() { _state.update { it.copy(error = null) } }

    // ── Go Live ───────────────────────────────────────────────────────────────

    fun startLive(context: Context) {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            try {
                val user = profileRepo.fetchCurrentUser()
                    ?: auth.currentUser?.let { fireUser ->
                        User(
                            uid = fireUser.uid,
                            name = fireUser.displayName?.takeIf { it.isNotBlank() } ?: "Host",
                            photoUrl = fireUser.photoUrl?.toString() ?: "",
                            email = fireUser.email ?: "",
                        )
                    }
                if (user == null) {
                    _state.update { it.copy(isLoading = false, error = "Please sign in to go live") }
                    return@launch
                }
                /*
                 * Going live is for verified hosts.
                 *
                 * The rules enforce this — `liveRooms` create now reads the
                 * user document rather than taking the client's word that it
                 * is the host — but a rule refusal arrives as a bare
                 * PERMISSION_DENIED, which tells someone who has not finished
                 * verification nothing at all. Checking here is about saying
                 * why; the rule is what makes it true.
                 */
                if (!user.isHost) {
                    _state.update {
                        it.copy(
                            isLoading = false,
                            error = "Going live is for hosts. Apply with an agency referral code to become one.",
                        )
                    }
                    return@launch
                }
                /*
                 * §5: a SUSPENDED Host role does not go live. The rules refuse
                 * the room (`mayGoLive`) with a bare PERMISSION_DENIED, so the
                 * server's own sentence — until when, and why — is said here
                 * first. Only the Host role is paused; the account is not
                 * restricted, so watching and joining parties still work.
                 */
                val suspended = HostSuspension.messageFor(
                    user.isHost, user.hostSuspended, user.hostSuspendedUntil, user.hostSuspendedReason,
                )
                if (suspended != null) {
                    _state.update { it.copy(isLoading = false, error = suspended) }
                    return@launch
                }
                if (!user.isVerifiedHost) {
                    _state.update {
                        it.copy(
                            isLoading = false,
                            error = "Finish face verification to go live. You can still open a party room in the meantime.",
                        )
                    }
                    return@launch
                }
                AgoraManager.init(context)
                // A-6: renew the hour-long token in place, through the one
                // repository that mints it.
                AgoraManager.tokenRenewer = { channel -> agoraTokenRepo.renewToken(channel) }
                FaceDetectionManager.init()
                val roomId = repo.startLive(
                    title = _state.value.title.ifBlank { "${user.name}'s Live" },
                    category = _state.value.category,
                    hostUser = user,
                )
                // A-7: the uid the token was signed for, never 0.
                val liveGrant = agoraTokenRepo.fetchGrant(roomId)
                AgoraManager.joinAsBroadcaster(roomId, liveGrant?.token, liveGrant?.uid ?: 0)
                _state.update {
                    it.copy(
                        isLive = true, roomId = roomId, isLoading = false,
                        myUid = user.uid, myName = user.name, myPhotoUrl = user.photoUrl,
                    )
                }
                // O1: a "Calls off" chosen before the room existed is saved on it now.
                if (_state.value.callProtectionEnabled) {
                    try { repo.setCallsBlocked(roomId, true) } catch (_: Exception) {
                        _state.update { it.copy(callProtectionEnabled = false, error = "Calls are on — turning them off failed. Try again.") }
                    }
                }
                startDurationTimer()
                collectRoomStreams(roomId)
                startHeartbeat(roomId)
                startStills(roomId)
                listenForPKInvites(user.uid)
                sendAutoInvitesToLikedOnlineUsers(
                    myUid = user.uid,
                    myName = user.name,
                    myPhotoUrl = user.photoUrl,
                    roomId = roomId,
                )
            } catch (e: Exception) {
                _state.update { it.copy(isLoading = false, error = e.localizedMessage ?: "Failed to go live") }
            }
        }
    }

    // ── Auto-invite liked+online users when going live ────────────────────────

    private fun sendAutoInvitesToLikedOnlineUsers(
        myUid: String,
        myName: String,
        myPhotoUrl: String,
        roomId: String,
    ) {
        viewModelScope.launch {
            try {
                // Fetch all UIDs that this user has liked
                val likedSnap = firestore
                    .collection("users").document(myUid)
                    .collection("liked")
                    .get().await()
                val likedUids = likedSnap.documents.map { it.id }
                if (likedUids.isEmpty()) return@launch

                // Check each liked user's online status and send invite if online
                for (likedUid in likedUids) {
                    try {
                        // Name, photo and online — all public. Was reading the
                        // whole user document for each person who liked you.
                        val liked = discover.findByUid(likedUid) ?: continue
                        if (!liked.isOnline || liked.name.isBlank()) continue
                        val likedName = liked.name
                        val likedPhotoUrl = liked.photoUrl
                        chatRepo.sendInvite(
                            myUid = myUid,
                            myName = myName,
                            myPhotoUrl = myPhotoUrl,
                            otherUid = likedUid,
                            otherName = likedName,
                            otherPhotoUrl = likedPhotoUrl,
                            roomId = roomId,
                            hostName = myName,
                        )
                    } catch (_: Exception) {
                        // Skip individual failures — one bad doc shouldn't abort the rest
                    }
                }
            } catch (_: Exception) {
                // Non-critical: auto-invite failure should never surface to the user
            }
        }
    }

    /**
     * B12: "still broadcasting", every minute — the server's sweep closes a room whose host has been silent for
     * three. The first beat goes at once, so the sweep never mistakes a new room for an old build's.
     */
    private var heartbeatJob: kotlinx.coroutines.Job? = null
    private var lastPkSeenAt = 0L
    private var liveStartedAtMs = 0L
    fun clearNotice() { _state.update { it.copy(notice = null) } }
    private fun startHeartbeat(roomId: String) {
        liveStartedAtMs = System.currentTimeMillis()
        heartbeatJob?.cancel()
        heartbeatJob = viewModelScope.launch {
            while (true) {
                try { repo.hostHeartbeat(roomId) } catch (_: Exception) {}
                delay(com.zipper.app.data.repository.LiveRepository.LIVE_HEARTBEAT_MS)
            }
        }
        viewModelScope.launch { AgoraManager.link.collect { l -> _state.update { it.copy(link = l) } } }
    }

    /**
     * O13 (Owner, 5 Nov 2026): "keep nudity and vulgarity out of the rooms". A still of what this phone publishes,
     * every minute or so (the Owner sets how often), for the CRM's live wall — and for the AI check when the Owner has
     * turned it on. Quiet: a still that fails is skipped, never retried in a loop, and never interrupts the live. When
     * the server has closed the room on an explicit-content check, the room's own `isActive` flag ends the screen.
     */
    private var stillsJob: kotlinx.coroutines.Job? = null
    private fun startStills(roomId: String) {
        stillsJob?.cancel()
        stillsJob = viewModelScope.launch(kotlinx.coroutines.Dispatchers.IO) {
            delay(com.zipper.app.data.repository.SafetyRepository.FIRST_STILL_AFTER_MS)
            var every = com.zipper.app.data.repository.SafetyRepository.DEFAULT_EVERY_SECONDS
            while (true) {
                val file = java.io.File(appContext.cacheDir, "live_still_$roomId.jpg")
                try {
                    file.delete()
                    if (!_state.value.isPaused && AgoraManager.takeLocalSnapshot(file.absolutePath)) {
                        safety.reportStill(roomId, file)?.let { answer -> every = answer.nextSeconds }
                    }
                } catch (_: Exception) {
                    // Offline, refused, or the camera is off: the next one is a minute away.
                } finally {
                    file.delete()
                }
                delay(every * 1000)
            }
        }
    }

    private fun startDurationTimer() {
        durationJob = viewModelScope.launch {
            while (true) {
                delay(1000)
                _duration.update { it + 1 }
            }
        }
    }

    private fun collectRoomStreams(roomId: String) {
        viewModelScope.launch {
            repo.roomFlow(roomId).collect { room ->
                if (room != null) {
                    val newPkState = when {
                        room.pkActive -> PKState.ACTIVE
                        room.pkWaiting -> PKState.WAITING
                        else -> {
                            if (_state.value.pkState == PKState.ACTIVE || _state.value.pkState == PKState.WAITING)
                                PKState.IDLE
                            else _state.value.pkState
                        }
                    }
                    // B2: honour a staff End / Mute written to this room.
                    if (LiveModeration.closedRemotely(_state.value.isLive, _state.value.endedRemotely, room.isActive)) {
                        _state.update {
                            it.copy(
                                endedRemotely = true,
                                remoteEndMessage = LiveModeration.endedMessage(room.endedByStaff, room.endReason),
                            )
                        }
                        // The room is already closed: stop publishing, but do
                        // not write the room again — that would overwrite the
                        // staff `endedAt` with this phone's clock.
                        endLive(roomAlreadyClosed = true)
                        return@collect
                    }
                    if (LiveModeration.mustForceMicOff(room.hostMuted, _state.value.isMicOn)) {
                        AgoraManager.muteLocalAudio(true)
                        _state.update { it.copy(isMicOn = false) }
                    }
                    _state.update {
                        it.copy(
                            mutedByStaff = room.hostMuted,
                            staffMuteMessage = if (room.hostMuted) LiveModeration.mutedMessage(room.hostMuteReason) else "",
                            // B12: the server's count and peak (recounted from presence rows).
                            viewerCount = room.viewerCount,
                            peakViewers = maxOf(it.peakViewers, room.peakViewers),
                            isPaused = room.isPaused,
                            pinnedMessage = room.pinnedMessage,
                            mutedViewers = room.mutedViewers.toSet(),
                            totalGiftsReceived = room.totalGiftsReceived,
                            totalBeansSession = room.totalBeansEarned,
                            pkState = newPkState,
                            pkScore = room.pkScore,
                            pkPartnerScore = room.pkPartnerScore,
                            pkPartnerName = room.pkPartnerName,
                            pkPartnerPhotoUrl = room.pkPartnerPhotoUrl,
                            pkPartnerId = room.pkPartnerId,
                            pkEndTime = room.pkEndTime,
                        )
                    }
                    // Both of these return immediately — the media work they
                    // may start runs on its own coroutine, so nothing in this
                    // collector waits on a network call. See [pkChannel].
                    if (room.pkActive && room.pkChannelId.isNotBlank()) joinPKChannel(room.pkChannelId)
                    else if (!room.pkActive) leavePKChannel()
                    // B12: the PK's verdict, as the server recorded it on this room — said once.
                    if (room.lastPkEndedAt > lastPkSeenAt) {
                        val first = lastPkSeenAt == 0L
                        lastPkSeenAt = room.lastPkEndedAt
                        if (!first || room.lastPkEndedAt > liveStartedAtMs) {
                            _state.update {
                                it.copy(notice = LiveRoomUi.pkVerdict(it.myName, it.myUid, room.lastPkWinnerUid, room.lastPkMyScore, room.lastPkPartnerScore))
                            }
                        }
                    }
                }
            }
        }
        viewModelScope.launch {
            repo.commentsFlow(roomId).collect { comments ->
                _state.update { it.copy(comments = comments) }
            }
        }
        giftCursor = System.currentTimeMillis()
        viewModelScope.launch {
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
        viewModelScope.launch {
            repo.viewersFlow(roomId).collect { viewers ->
                // The peak is watched for here because there is nowhere to read
                // it from later: presence documents are deleted as people
                // leave, so by the time the stream ends the high-water mark has
                // been thrown away. See GoLiveUiState.peakViewers.
                _state.update {
                    it.copy(viewers = viewers, peakViewers = maxOf(it.peakViewers, viewers.size))
                }
            }
        }
        viewModelScope.launch {
            repo.giftLeaderboardFlow(roomId).collect { gifters ->
                _state.update { it.copy(giftLeaderboard = gifters.top, gifterCount = gifters.count) }
            }
        }
    }

    // ── Face detection ────────────────────────────────────────────────────────

    fun reportFaceDetected(detected: Boolean) {
        val prev = _state.value.faceDetected
        _state.update { it.copy(faceDetected = detected) }

        // Paused (or waiting to come back from a call) is not "left the camera": no countdown.
        if (_state.value.isPaused || _state.value.returnFromCallPrompt) { faceCountdownJob?.cancel(); return }
        if (!detected && prev) {
            // Face just disappeared — start countdown
            startFaceCountdown()
        } else if (detected) {
            // Face returned — cancel countdown
            faceCountdownJob?.cancel()
            _state.update { it.copy(faceAbsenceCountdown = LiveModeration.FACE_TIMEOUT_SECONDS) }
        }
    }

    private fun startFaceCountdown() {
        faceCountdownJob?.cancel()
        faceCountdownJob = viewModelScope.launch {
            var seconds = LiveModeration.FACE_TIMEOUT_SECONDS
            while (seconds > 0) {
                _state.update { it.copy(faceAbsenceCountdown = seconds) }
                delay(1000)
                seconds--
                // Check if face came back
                if (_state.value.faceDetected) return@launch
            }
            // 10 minutes elapsed with no face — auto end.
            // B2: and say so. The screen used to drop the host back on the
            // pre-live setup form with no explanation and no summary.
            _state.update { it.copy(endedRemotely = true, remoteEndMessage = LiveModeration.FACE_TIMEOUT_MESSAGE) }
            endLive()
        }
    }

    // ── Comments ──────────────────────────────────────────────────────────────

    fun sendComment() {
        val msg = _state.value.commentInput.trim()
        if (msg.isBlank()) return
        // O13: the host is held to the same words as everyone else.
        if (!com.zipper.app.util.SafetyWords.allowed(msg)) {
            _state.update { it.copy(notice = com.zipper.app.util.SafetyWords.HELD_NOTICE) }
            return
        }
        _state.update { it.copy(commentInput = "") }
        viewModelScope.launch {
            try { repo.sendComment(_state.value.roomId, msg) }
            catch (e: Exception) { _state.update { it.copy(error = e.localizedMessage) } }
        }
    }

    // ── End live ──────────────────────────────────────────────────────────────

    /**
     * The figures the post-live card shows, taken from the live state.
     *
     * Read this BEFORE [endLive]: the screen pops the moment the host confirms
     * and the ViewModel is cleared with it, so the numbers have to be lifted out
     * while they still exist. The card used to be handed a literal 0 for
     * viewers and an empty gifter list, and reported both as fact.
     */
    fun sessionSummary(): LiveSessionSummary = with(_state.value) {
        LiveSessionSummary(
            roomId = roomId,
            durationSeconds = _duration.value,
            totalBeans = totalBeansSession,
            peakViewers = peakViewers,
            gifterCount = gifterCount,
            topGifters = giftLeaderboard,
        )
    }

    /**
     * Ends the room. Runs on a scope that survives the ViewModel, because the
     * screen pops (and the ViewModel is cleared) the moment the host confirms —
     * a viewModelScope job here died with the PK end still in flight and left
     * the room active.
     */
    fun endLive(roomAlreadyClosed: Boolean = false) {
        val s = _state.value
        if (s.roomId.isBlank()) return
        durationJob?.cancel()
        val durationAtEnd = _duration.value
        faceCountdownJob?.cancel()
        heartbeatJob?.cancel()
        stillsJob?.cancel()
        _state.update { it.copy(isLive = false, pkState = PKState.IDLE) }
        // Drop any PK join still in flight before leaving. A token fetch that
        // lands after the leave would put the engine straight back into
        // pk_<a>_<b> — an open channel and a running camera belonging to a
        // broadcast that is over. The leave itself covers the PK channel too:
        // the engine holds one channel at a time, and this is the end of the
        // stream whichever one that is.
        pkChannelJob?.cancel()
        pkChannelJob = null
        pkChannel = ""
        AgoraManager.leaveChannel()
        FaceDetectionManager.release()
        teardownScope.launch {
            try {
                if (s.pkState == PKState.ACTIVE) pkRepo.endPK(s.roomId, s.pkPartnerId)
                if (s.pkState == PKState.WAITING) pkRepo.cancelPKQueue(s.roomId)
            } catch (_: Exception) {}
            if (!roomAlreadyClosed) {
                try { repo.endLive(s.roomId, durationAtEnd) } catch (_: Exception) {}
            }
        }
    }

    private companion object {
        val teardownScope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.IO)
    }

    // ── Mic toggle ────────────────────────────────────────────────────────────

    fun toggleMic() {
        // B2: a staff mute holds the mic off; say why instead of reopening it.
        if (!_state.value.isMicOn && !LiveModeration.mayUnmute(_state.value.mutedByStaff)) {
            _state.update { it.copy(error = it.staffMuteMessage.ifBlank { LiveModeration.mutedMessage(null) }) }
            return
        }
        val new = !_state.value.isMicOn
        _state.update { it.copy(isMicOn = new) }
        // B12: a paused live stays silent until it is resumed.
        AgoraManager.muteLocalAudio(!new || _state.value.isPaused)
    }

    // ── B12: pause, camera, pinned message ───────────────────────────────────

    /*
     * 6 Nov 2026 — PRIVACY AFTER A CALL. Taking a call leaves this live's channel (one engine). When the host comes
     * back the live is PAUSED and stays off air — no camera, no mic, viewers see "back soon" — until the host answers
     * "Return to your live?". A private call must never turn into a public broadcast on its own.
     */
    fun onScreenResumed() {
        val s = _state.value
        if (!s.isLive || s.roomId.isBlank() || s.returnFromCallPrompt) return
        if (pkChannelJob?.isActive == true || AgoraManager.currentChannel.isNotEmpty()) return
        AgoraManager.muteLocalVideo(true)
        AgoraManager.muteLocalAudio(true)
        _state.update { it.copy(isPaused = true, returnFromCallPrompt = true) }
        viewModelScope.launch { try { repo.setPaused(s.roomId, true) } catch (_: Exception) {} }
    }

    fun returnToLiveAfterCall() {
        val roomId = _state.value.roomId
        if (roomId.isBlank()) return
        _state.update { it.copy(returnFromCallPrompt = false) }
        viewModelScope.launch {
            val grant = agoraTokenRepo.fetchGrant(roomId)
            AgoraManager.joinAsBroadcaster(roomId, grant?.token, grant?.uid ?: 0)
            _state.update { it.copy(cameraEpoch = it.cameraEpoch + 1) }
            if (_state.value.isPaused) togglePause()
        }
    }

    /** Pause (camera and mic off, viewers see "back soon") or resume (back as they were). */
    fun togglePause() {
        val s = _state.value
        if (s.roomId.isBlank()) return
        val paused = !s.isPaused
        AgoraManager.muteLocalVideo(paused || !s.isCameraOn)
        AgoraManager.muteLocalAudio(paused || !s.isMicOn)
        _state.update { it.copy(isPaused = paused) }
        viewModelScope.launch {
            try { repo.setPaused(s.roomId, paused) } catch (e: Exception) {
                _state.update { it.copy(error = "Couldn't ${if (paused) "pause" else "resume"}. ${e.localizedMessage ?: ""}".trim()) }
            }
        }
    }

    /** Camera off (still live and talking) or back on. */
    fun toggleCamera() {
        val s = _state.value
        if (s.roomId.isBlank()) return
        val on = !s.isCameraOn
        if (!s.isPaused) AgoraManager.muteLocalVideo(!on)
        _state.update { it.copy(isCameraOn = on) }
        viewModelScope.launch { try { repo.setCameraOff(s.roomId, !on) } catch (_: Exception) {} }
    }

    /** Pin an announcement above the chat (blank removes it). */
    fun setPinnedMessage(text: String) {
        val s = _state.value
        if (s.roomId.isBlank()) return
        val pinned = LiveRoomUi.pinned(text)
        viewModelScope.launch {
            try { repo.setPinnedMessage(s.roomId, pinned) } catch (e: Exception) {
                _state.update { it.copy(error = "Couldn't pin that. ${e.localizedMessage ?: ""}".trim()) }
            }
        }
    }

    // ── B12: chat moderation ─────────────────────────────────────────────────

    /** Mute a viewer in the chat (they keep watching), or unmute them. */
    fun toggleMuteViewer(targetUid: String) {
        val s = _state.value
        if (s.roomId.isBlank() || targetUid.isBlank()) return
        val mute = targetUid !in s.mutedViewers
        viewModelScope.launch {
            try { repo.setViewerMuted(s.roomId, targetUid, mute) } catch (e: Exception) {
                _state.update { it.copy(error = "Couldn't ${if (mute) "mute" else "unmute"} them. ${e.localizedMessage ?: ""}".trim()) }
            }
        }
    }

    /**
     * Block a viewer: the ordinary block (no calls, messages — or, B12, watching any of this host's lives: the
     * server refuses them a token) and removed from this one now.
     */
    fun blockViewer(targetUid: String) {
        val s = _state.value
        if (s.roomId.isBlank() || targetUid.isBlank()) return
        val v = s.viewers.firstOrNull { it.uid == targetUid }
        viewModelScope.launch {
            when (val r = profileRepo.blockUser(targetUid, v?.name.orEmpty(), v?.photoUrl.orEmpty())) {
                is com.zipper.app.data.repository.ProfileResult.Error -> _state.update { it.copy(error = r.message) }
                else -> kickViewer(targetUid)
            }
        }
    }

    /** The host removes a comment from their room. */
    fun deleteComment(commentId: String) {
        val s = _state.value
        if (s.roomId.isBlank() || commentId.isBlank()) return
        viewModelScope.launch {
            try { repo.deleteComment(s.roomId, commentId) } catch (e: Exception) {
                _state.update { it.copy(error = "Couldn't delete that comment. ${e.localizedMessage ?: ""}".trim()) }
            }
        }
    }

    // ── Call protection ───────────────────────────────────────────────────────

    /**
     * O1: "Calls off" while live — saved on the room, where `startCall` reads it, so nobody's call rings while it is on.
     * Shown at once; put back (with the reason) if the write fails, so the screen never claims a protection the server
     * does not have.
     */
    fun toggleCallProtection() {
        val s = _state.value
        val blocked = !s.callProtectionEnabled
        _state.update { it.copy(callProtectionEnabled = blocked) }
        if (s.roomId.isBlank()) return
        viewModelScope.launch {
            try { repo.setCallsBlocked(s.roomId, blocked) } catch (e: Exception) {
                _state.update {
                    it.copy(
                        callProtectionEnabled = !blocked,
                        error = "Couldn't turn calls ${if (blocked) "off" else "on"}. ${e.localizedMessage ?: ""}".trim(),
                    )
                }
            }
        }
    }

    // ── Viewer management ─────────────────────────────────────────────────────

    /**
     * Remove a viewer for the rest of the broadcast.
     *
     * The failure used to be swallowed whole. A kick can fail for reasons the
     * host can act on — no network, or the rules refusing a write on a room
     * that has just ended — and the sheet showed the same nothing either way,
     * so the host's only reading of it was "the button does not work". The
     * error goes to the snackbar the screen already renders, and [targetUid]
     * is held in `kickPending` while the batch is in flight so the row can say
     * it is working rather than leaving the host to guess.
     *
     * The name is looked up here because the sheet has already dismissed by the
     * time the message shows, and "Couldn't remove Priya" is a sentence a host
     * can act on where a bare PERMISSION_DENIED is not.
     */
    fun kickViewer(targetUid: String) {
        val roomId = _state.value.roomId
        if (roomId.isBlank() || targetUid.isBlank()) return
        // A second tap while the first batch is in flight would kick twice.
        if (targetUid in _state.value.kickPending) return
        val name = _state.value.viewers.firstOrNull { it.uid == targetUid }
            ?.name?.takeIf { it.isNotBlank() } ?: "that viewer"
        _state.update { it.copy(kickPending = it.kickPending + targetUid) }
        viewModelScope.launch {
            try {
                repo.kickViewer(roomId, targetUid)
                // No success message: the row leaving the list — and the count
                // on the tab with it — is the confirmation, and it arrives from
                // the same snapshot that makes it true.
            } catch (e: Exception) {
                _state.update { it.copy(error = "Couldn't remove $name. ${e.localizedMessage ?: "Try again."}") }
            } finally {
                _state.update { it.copy(kickPending = it.kickPending - targetUid) }
            }
        }
    }

    // ── Gift ──────────────────────────────────────────────────────────────────

    fun dismissGift() {
        val done = _state.value.recentGifts.firstOrNull()
        if (done != null && done.timestamp > giftCursor) giftCursor = done.timestamp
        _state.update { it.copy(recentGifts = it.recentGifts.drop(1)) }
    }

    // ── PK ────────────────────────────────────────────────────────────────────

    fun findPKMatch() {
        val s = _state.value
        if (s.roomId.isBlank() || s.pkState != PKState.IDLE) return
        _state.update { it.copy(pkState = PKState.WAITING) }
        viewModelScope.launch {
            try {
                val user = profileRepo.fetchCurrentUser() ?: return@launch
                pkRepo.enterPKQueue(s.roomId, user)
            } catch (e: Exception) {
                _state.update { it.copy(pkState = PKState.IDLE, error = e.localizedMessage) }
            }
        }
    }

    fun cancelPKSearch() {
        _state.update { it.copy(pkState = PKState.IDLE) }
        viewModelScope.launch { try { pkRepo.cancelPKQueue(_state.value.roomId) } catch (_: Exception) {} }
    }

    private fun listenForPKInvites(myUid: String) {
        viewModelScope.launch {
            pkRepo.pkInviteFlow(myUid).collect { invite ->
                when {
                    invite == null -> {
                        if (_state.value.pkState == PKState.INVITED)
                            _state.update { it.copy(pkState = PKState.IDLE, pkInvite = null) }
                    }
                    invite.status == "rejected" ->
                        _state.update { it.copy(pkState = PKState.IDLE, pkInvite = null) }
                    invite.status == "started" ->
                        _state.update { it.copy(pkState = PKState.ACTIVE, pkInvite = null) }
                    else ->
                        _state.update { it.copy(pkState = PKState.INVITED, pkInvite = invite) }
                }
            }
        }
    }

    fun acceptPKInvite() {
        val invite = _state.value.pkInvite ?: return
        val myUid = _state.value.myUid
        viewModelScope.launch {
            try {
                val started = pkRepo.acceptInvite(invite, myUid)
                if (started) {
                    _state.update { it.copy(pkState = PKState.ACTIVE, pkInvite = null) }
                } else {
                    _state.update {
                        it.copy(pkInvite = invite.copy(
                            hostAAccepted = if (invite.hostAUid == myUid) true else invite.hostAAccepted,
                            hostBAccepted = if (invite.hostBUid == myUid) true else invite.hostBAccepted,
                        ))
                    }
                }
            } catch (e: Exception) {
                _state.update { it.copy(error = e.localizedMessage, pkState = PKState.IDLE, pkInvite = null) }
            }
        }
    }

    fun rejectPKInvite() {
        val invite = _state.value.pkInvite ?: return
        _state.update { it.copy(pkState = PKState.IDLE, pkInvite = null) }
        viewModelScope.launch { try { pkRepo.rejectInvite(invite.id) } catch (_: Exception) {} }
    }

    fun onPKEnd() {
        val s = _state.value
        _state.update { it.copy(pkState = PKState.IDLE, pkScore = 0, pkPartnerScore = 0, pkPartnerId = "", pkEndTime = 0L) }
        leavePKChannel()
        viewModelScope.launch { try { pkRepo.endPK(s.roomId, s.pkPartnerId) } catch (_: Exception) {} }
    }

    // ── PK media ──────────────────────────────────────────────────────────────

    /**
     * Join the battle channel — once for the whole battle.
     *
     * The membership check comes BEFORE the token fetch on purpose: the fetch is
     * a Cloud Function call that runs several Firestore reads, so it is the half
     * that costs money, and a guard placed after it would have saved the
     * renegotiation while still paying for every redundant snapshot.
     *
     * A token the server refuses comes back as null rather than as an exception
     * (see AgoraTokenRepository.fetchGrant), so a refusal cannot be told apart
     * from an unconfigured server here and the join is attempted either way.
     * Committing [pkChannel] before the fetch is what stops a battle that
     * cannot be joined from asking again on each of the several room snapshots
     * this second: one battle, one attempt.
     */
    private fun joinPKChannel(channelId: String) {
        if (channelId == pkChannel) return
        if (AgoraManager.isInChannel(channelId)) { pkChannel = channelId; return }
        pkChannel = channelId
        pkChannelJob?.cancel()
        pkChannelJob = viewModelScope.launch {
            try {
                val grant = agoraTokenRepo.fetchGrant(channelId)
                // The battle can end while the callable is in flight, and
                // joining then would open a channel that nothing is left to
                // close — [leavePKChannel] has already cleared the field.
                if (pkChannel != channelId) return@launch
                AgoraManager.joinAsBroadcaster(channelId, grant?.token, grant?.uid ?: 0)
                // A previous unwind may have stopped the capture on its way out
                // of the last channel; see cameraEpoch. Re-binding a preview
                // that is already running costs nothing.
                _state.update { it.copy(cameraEpoch = it.cameraEpoch + 1) }
            } catch (e: Exception) {
                _state.update {
                    it.copy(error = "Couldn't connect to the PK battle. ${e.localizedMessage ?: "Try again."}")
                }
            }
        }
    }

    /**
     * Leave the battle channel and go back to our own room.
     *
     * Nothing used to leave it at all. `endPK` clears the room's PK fields and
     * the client stayed in `pk_<a>_<b>`: the host went on publishing into a
     * channel for a battle that was over, and the next `pkActive` burst joined
     * on top of a session that had never been closed.
     *
     * Rejoining the room channel is not an extra — it is the other half of the
     * same fix. The engine holds one channel at a time, so a bare leave would
     * take the host off the air in their own live room. Both hosts reach this
     * through the room collector when `pkActive` goes false, so the host who
     * did not press anything is restored too.
     */
    private fun leavePKChannel() {
        val channelId = pkChannel
        /*
         * Nothing to unwind — and this has to be decided BEFORE anything is
         * cancelled.
         *
         * `endPK` writes ten fields and the room goes on emitting while it
         * does, so this is reached several times for one battle ending, on top
         * of the PK overlay's own timer calling it. By the second call
         * pkChannelJob is the REJOIN below, still waiting on its token, and
         * cancelling that would leave the host in no channel at all with the
         * camera down — off the air in their own room, worse than the bug this
         * function exists to fix.
         */
        if (channelId.isBlank()) return
        pkChannel = ""
        pkChannelJob?.cancel()
        pkChannelJob = null
        // The join never reached the engine: its token fetch was still in
        // flight, and the cancel above was the whole of the work. We never left
        // the room channel, so there is nothing to put back.
        if (!AgoraManager.isInChannel(channelId)) return
        val roomId = _state.value.roomId
        if (roomId.isBlank() || !_state.value.isLive) return
        pkChannelJob = viewModelScope.launch {
            AgoraManager.leaveChannel()
            val grant = agoraTokenRepo.fetchGrant(roomId)
            AgoraManager.joinAsBroadcaster(roomId, grant?.token, grant?.uid ?: 0)
            // leaveChannel puts the camera down with the channel — it treats the
            // capture as belonging to the broadcast — so the preview has to be
            // started again now that we are back on air. Bumped last, once the
            // engine really is in the room channel: see cameraEpoch.
            _state.update { it.copy(cameraEpoch = it.cameraEpoch + 1) }
        }
    }

    override fun onCleared() {
        super.onCleared()
        val s = _state.value
        if (s.isLive && s.roomId.isNotBlank()) endLive()
    }
}

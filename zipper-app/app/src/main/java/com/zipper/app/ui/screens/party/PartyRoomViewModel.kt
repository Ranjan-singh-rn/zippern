package com.zipper.app.ui.screens.party

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.FirebaseAuth
import com.zipper.app.data.model.PartyRoom
import com.zipper.app.data.model.PartySeat
import com.zipper.app.data.model.PartySeatInvite
import com.zipper.app.data.model.PartySeatRequest
import com.zipper.app.data.model.User
import com.zipper.app.data.repository.AgoraTokenRepository
import com.zipper.app.data.repository.AgoraTokenResult
import com.zipper.app.data.repository.GiftItem
import com.zipper.app.data.repository.GiftRepository
import com.zipper.app.data.repository.PartyGiftEvent
import com.zipper.app.data.repository.PartyListener
import com.zipper.app.data.repository.PartyMessage
import com.zipper.app.data.repository.PartyRepository
import com.zipper.app.data.repository.ProfileRepository
import com.zipper.app.ui.screens.live.AgoraManager
import dagger.hilt.android.lifecycle.HiltViewModel
import io.agora.rtc2.IRtcEngineEventHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID
import javax.inject.Inject

/** Why the room will not let this person in yet. */
enum class PartyGate {
    /** Nothing in the way — the normal case. */
    None,

    /** A private room, waiting for four digits. */
    Password,

    /** Removed by a moderator. Terminal for the life of the room. */
    Kicked,

    /** The room has closed. */
    Ended,
}

data class PartyRoomUiState(
    val room: PartyRoom? = null,
    /** Occupied seats only. An absent index is an empty seat. */
    val seats: List<PartySeat> = emptyList(),
    val listeners: List<PartyListener> = emptyList(),
    val messages: List<PartyMessage> = emptyList(),
    /** Recent gifts, newest first — drives the animation overlay and the ticker. */
    val recentGifts: List<PartyGiftEvent> = emptyList(),
    /** Who is waiting for a seat. Only populated in a consent-mode room. */
    val seatRequests: List<PartySeatRequest> = emptyList(),
    /** An offer of a seat addressed to me, awaiting an answer. */
    val myInvite: PartySeatInvite? = null,
    /** My own pending request, if I have asked for a seat. */
    val myRequestedSeat: Int = 0,

    val myUid: String = "",
    val myName: String = "",
    val gate: PartyGate = PartyGate.None,
    /** Wrong password, or "this room needs a password" on first sight. */
    val passwordError: String? = null,
    val joining: Boolean = false,
    val isConnected: Boolean = false,

    /** Agora uids heard speaking right now. A uid IS a seat index. */
    val speakingUids: Set<Int> = emptySet(),
    /** Me, heard speaking. Agora reports the local speaker separately, as uid 0. */
    val localSpeaking: Boolean = false,

    val messageInput: String = "",
    val gifts: List<GiftItem> = emptyList(),
    val myDiamonds: Long = 0L,
    val giftSending: Boolean = false,
    /**
     * The nonce of the last gift tap that fully settled, and how it went.
     *
     * ── WHY THIS IS AN EXPLICIT FIELD ────────────────────────────────────────
     *
     * The screen has to know when a tap is FINISHED, so it can retire that tap's
     * nonce and mint a fresh one for the next gift. It used to infer that from
     * the `giftSending` true→false edge plus `error == null` — which worked only
     * because [sendGift] happens to clear `error` on success. Change that one
     * line and the inference silently inverts: the nonce is never retired, the
     * next identical gift reuses it, and `settleGift` recognises it as a replay
     * and charges nothing while delivering nothing. A held-back charge that
     * looks like a successful send is the worst failure this screen has.
     *
     * So the signal is stated rather than deduced.
     */
    val lastGiftResult: GiftTapResult? = null,
    /** A seat tap in flight, so the same seat is not requested twice. */
    val busySeat: Int = -1,
    /** A moderator action in flight against this uid. */
    val busyUid: String = "",
    val inPip: Boolean = false,
    val savingSettings: Boolean = false,
    val notice: String? = null,
    val error: String? = null,
) {
    val isVideo: Boolean get() = room?.isAudio == false
    val seatCount: Int get() = room?.seatCount ?: PartyRoom.AUDIO_SEAT_CHOICES.first()
    val seatByIndex: Map<Int, PartySeat> get() = seats.associateBy { it.index }
    val mySeat: PartySeat? get() = seats.firstOrNull { it.uid == myUid }
    val mySeatIndex: Int get() = mySeat?.index ?: 0
    val amSeated: Boolean get() = mySeat != null

    val isOwner: Boolean get() = room?.isOwner(myUid) == true
    val isAdmin: Boolean get() = room?.isAdmin(myUid) == true
    val canModerate: Boolean get() = room?.canModerate(myUid) == true

    val isEnded: Boolean get() = gate == PartyGate.Ended
    val wasKicked: Boolean get() = gate == PartyGate.Kicked

    /**
     * Everybody who could receive a gift: whoever is on a seat, except me.
     *
     * The owner is not listed separately any more. They sit on an ordinary seat
     * like everyone else, so if they are talking they are in this list and if
     * they are not, gifting them would be paying somebody who is not performing.
     */
    val giftableSeatHolders: List<PartySeat> get() = seats.filter { it.uid != myUid }

    /** Members a moderator can act on: seated and unseated alike. */
    val memberList: List<PartyMember>
        get() {
            val seated = seats.map {
                PartyMember(it.uid, it.name, it.photoUrl, seatIndex = it.index)
            }
            val seatedUids = seated.map { it.uid }.toSet()
            val rest = listeners
                .filter { it.uid !in seatedUids }
                .map { PartyMember(it.uid, it.name, it.photoUrl, seatIndex = 0) }
            return seated + rest
        }

    /** Whether I may unmute this seat, given who muted it. Mirrors `setPartySeatMute`. */
    fun canUnmute(seat: PartySeat): Boolean = when {
        !seat.isMuted -> false
        isOwner -> true
        !isAdmin -> false
        seat.mutedByRole == "owner" -> false
        seat.mutedByRole == "admin" -> seat.mutedBy == myUid
        else -> true
    }

    /** Whether I may mute this seat. Moderation points downwards only. */
    fun canMute(seat: PartySeat): Boolean = when {
        seat.uid == myUid -> false
        isOwner -> true
        !isAdmin -> false
        // An admin may not mute the owner or another admin.
        else -> room?.canModerate(seat.uid) != true
    }
}

/**
 * How one gift tap ended.
 *
 * [delivered] and [failed] are counts rather than a boolean, because a gift to
 * four people can partly succeed: `sendGift` sends one settlement per recipient
 * and deliberately does not abort the rest when one fails. "Three of four" is the
 * truth in that case, and a screen that reported it as either success or failure
 * would be wrong either way.
 */
data class GiftTapResult(
    val nonce: String,
    val delivered: Int,
    val failed: Int,
    /** The first failure's message, for the one shown to the sender. */
    val firstError: String? = null,
) {
    val allDelivered: Boolean get() = failed == 0 && delivered > 0
    val partial: Boolean get() = delivered > 0 && failed > 0
}

/** A person in the room, seated or not. [seatIndex] is 0 for a listener. */
data class PartyMember(
    val uid: String,
    val name: String,
    val photoUrl: String,
    val seatIndex: Int,
)

@HiltViewModel
class PartyRoomViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val repo: PartyRepository,
    private val profileRepo: ProfileRepository,
    private val giftRepo: GiftRepository,
    private val agoraTokenRepo: AgoraTokenRepository,
    private val auth: FirebaseAuth,
) : ViewModel() {

    private val roomId: String = savedStateHandle.get<String>("roomId") ?: ""

    /** `party_<roomId>`, which is the shape `generateAgoraToken` switches on. */
    private val channelName: String = "party_$roomId"

    private val _state = MutableStateFlow(PartyRoomUiState(myUid = auth.currentUser?.uid.orEmpty()))
    val state: StateFlow<PartyRoomUiState> = _state.asStateFlow()

    private var currentUser: User? = null

    /**
     * One join per session answered by exactly one leave.
     *
     * Watch Live learned this the expensive way: the screen's onDispose, the exit
     * button and `onCleared` each ran the teardown, so a single visit decremented
     * the viewer count three times and pushed it negative. Here the same triple
     * fire would call `leavePartySeat` three times, and the third could land after
     * the user sat down again in a new session and knock them off.
     */
    @Volatile private var hasLeft = false

    /** The Agora uid we joined on. A seat holder's is their seat index. */
    @Volatile private var myAgoraUid = 0

    /** Last role we asked the engine for, so a snapshot storm is not a role storm. */
    @Volatile private var publishing = false

    /**
     * A uid-changing rejoin is in flight.
     *
     * Seat snapshots arrive faster than a token request completes, and every one of
     * them calls `reconcileRole`. Without this, a single seat change could start
     * several rejoins, each leaving the channel the previous one had just joined —
     * and the user would hear the room cut in and out for as long as the snapshots
     * kept coming.
     */
    @Volatile private var rejoining = false

    /** The screen's LaunchedEffect can re-run; the channel may only be joined once. */
    @Volatile private var joinStarted = false

    /** Whether `joinPartyRoom` has succeeded, so presence exists on the server. */
    @Volatile private var admitted = false

    /**
     * Whether anybody has occupied a seat while this client has been watching.
     *
     * Load-bearing for the auto-close. A room opens with every seat empty — the
     * owner's included, which is the point of the rebuild — so "no seats taken"
     * is also the state of a brand-new room whose owner is still reading the
     * settings sheet. Arming the close timer on that would have the owner's own
     * client destroy the room two seconds after creating it. Only the transition
     * from occupied to empty counts, and this is what distinguishes them.
     */
    @Volatile private var everHadOccupants = false

    private var emptyRoomJob: Job? = null

    init {
        if (roomId.isNotBlank()) {
            collectRoom()
            collectSeats()
            collectListeners()
            collectMessages()
            collectGifts()
            collectSeatRequests()
            collectMyInvite()
        }
        loadCurrentUser()
        loadGiftCatalogue()
    }

    // ── Firestore ─────────────────────────────────────────────────────────────

    private fun collectRoom() {
        viewModelScope.launch {
            repo.roomFlow(roomId).collect { room ->
                if (room == null) return@collect
                // Read the uid from auth rather than the profile flow: on a cold
                // open the profile has not arrived yet, and a kicked user opening
                // the room for the first time is exactly when this must fire.
                val myUid = auth.currentUser?.uid.orEmpty()
                _state.update { it.copy(room = room, myUid = myUid) }
                if (myUid.isNotBlank() && room.kickedUsers.contains(myUid)) onKicked()
                if (!room.isActive) onRoomEnded()
            }
        }
    }

    private fun collectSeats() {
        viewModelScope.launch {
            repo.seatsFlow(roomId).collect { seats ->
                val myUid = auth.currentUser?.uid.orEmpty()
                val mine = seats.firstOrNull { it.uid == myUid }
                _state.update { it.copy(seats = seats) }
                reconcileRole(mine)
                watchForEmptyRoom(seats.isEmpty())
            }
        }
    }

    private fun collectListeners() {
        viewModelScope.launch {
            repo.listenersFlow(roomId).collect { list ->
                _state.update { it.copy(listeners = list) }
            }
        }
    }

    private fun collectMessages() {
        viewModelScope.launch {
            repo.messagesFlow(roomId).collect { msgs ->
                _state.update { it.copy(messages = msgs) }
            }
        }
    }

    private fun collectGifts() {
        viewModelScope.launch {
            repo.giftsFlow(roomId).collect { gifts ->
                _state.update { it.copy(recentGifts = gifts) }
            }
        }
    }

    private fun collectSeatRequests() {
        viewModelScope.launch {
            repo.seatRequestsFlow(roomId).collect { requests ->
                val myUid = auth.currentUser?.uid.orEmpty()
                _state.update {
                    it.copy(
                        seatRequests = requests,
                        myRequestedSeat = requests.firstOrNull { r -> r.uid == myUid }?.seatIndex ?: 0,
                    )
                }
            }
        }
    }

    private fun collectMyInvite() {
        viewModelScope.launch {
            repo.myInviteFlow(roomId).collect { invite ->
                _state.update { it.copy(myInvite = invite) }
            }
        }
    }

    private fun loadCurrentUser() {
        viewModelScope.launch {
            profileRepo.currentUserFlow().collect { user ->
                currentUser = user
                _state.update {
                    it.copy(myDiamonds = user?.diamonds ?: 0L, myName = user?.name ?: it.myName)
                }
            }
        }
    }

    private fun loadGiftCatalogue() {
        viewModelScope.launch {
            val gifts = giftRepo.fetchGifts()
            _state.update { it.copy(gifts = gifts) }
        }
    }

    // ── Entering the room ────────────────────────────────────────────────────

    /**
     * Ask the server to admit us, then join the Agora channel.
     *
     * ── WHY THIS IS TWO STEPS AND NOT ONE ────────────────────────────────────
     *
     * `joinPartyRoom` is the gate: it refuses a kicked user, checks the password
     * on a private room, writes the listener row, and maintains `listenerCount`.
     * Only once it has said yes is there any point asking for a token — and for a
     * private room a token would be refused anyway, because
     * `generateAgoraToken` now requires the listener row that only this call can
     * write.
     *
     * The password arrives from the screen on a retry. A room that needs one is
     * discovered by being refused, rather than by trusting the `visibility` field
     * we can read for ourselves: the refusal is the server's answer and the field
     * is only a hint about what to render.
     */
    fun enterRoom(context: android.content.Context, password: String = "") {
        if (roomId.isBlank() || hasLeft) return
        if (_state.value.joining) return
        _state.update { it.copy(joining = true, passwordError = null) }

        viewModelScope.launch {
            when (val res = repo.joinRoom(roomId, password)) {
                is PartyRepository.Result.Ok -> {
                    admitted = true
                    _state.update { it.copy(joining = false, gate = PartyGate.None) }
                    announceArrival()
                    connectAgora(context)
                }
                is PartyRepository.Result.Failed -> {
                    /*
                     * Classify FIRST, then write, then act.
                     *
                     * `onKicked()` and `onRoomEnded()` used to be called from inside
                     * the `_state.update` lambda, and both call `_state.update`
                     * themselves. `update` is a compare-and-set retry loop, so a
                     * nested write makes the outer CAS fail and the lambda RUN
                     * AGAIN — side effects included. It happened to be survivable
                     * because both handlers are idempotent, which is not a property
                     * to rely on: the next handler added there would fire twice for
                     * no visible reason.
                     */
                    val message = res.userMessage
                    val kicked = message.contains("removed", ignoreCase = true)
                    val ended = message.contains("closed", ignoreCase = true)
                    val needsPassword = message.contains("password", ignoreCase = true)

                    _state.update { st ->
                        when {
                            needsPassword -> st.copy(
                                joining = false,
                                gate = PartyGate.Password,
                                // "This room needs a password" is not an error on
                                // the first sight of the field — only a wrong
                                // answer is.
                                passwordError = if (password.isBlank()) null else message,
                            )
                            kicked || ended -> st.copy(joining = false)
                            else -> st.copy(joining = false, error = message)
                        }
                    }

                    if (kicked) onKicked() else if (ended) onRoomEnded()
                }
            }
        }
    }

    private suspend fun announceArrival() {
        val user = currentUser ?: try { profileRepo.fetchCurrentUser() } catch (_: Exception) { null }
        if (user != null) currentUser = user
        val name = user?.name?.ifBlank { null } ?: "Someone"
        try { repo.sendJoinMessage(roomId, name) } catch (_: Exception) {}
    }

    private fun connectAgora(context: android.content.Context) {
        if (joinStarted || hasLeft) return
        joinStarted = true
        AgoraManager.init(context)
        AgoraManager.onUserJoined = { }
        AgoraManager.onUserOffline = { uid -> onRemoteGone(uid) }
        AgoraManager.onAudioVolume = { speakers -> onVolumes(speakers) }

        viewModelScope.launch {
            // Wait for the room document before joining. The mode decides whether
            // the camera subsystem comes up at all, and guessing wrong costs
            // either a renegotiation or — worse on a budget phone — an encoder and
            // a capture pipeline running for a room that will never use them.
            val room = state.first { it.room != null }.room ?: return@launch
            if (hasLeft) return@launch
            val video = !room.isAudio
            /*
             * A seat holder publishes on their seat index, because that is what
             * the seat document says and what every other client binds that
             * seat's tile to. Everyone else joins on 0 and subscribes.
             *
             * This no longer has a special case for the owner. They used to join
             * on 0 as a publisher with no seat document, which is why every other
             * client had to find their stream by elimination.
             */
            val mySeat = _state.value.mySeat
            myAgoraUid = mySeat?.index ?: 0

            when (val r = agoraTokenRepo.requestToken(channelName, myAgoraUid)) {
                is AgoraTokenResult.Granted -> {
                    val publisher = mySeat != null
                    AgoraManager.joinPartyChannel(
                        channelId = channelName,
                        token = r.token,
                        uid = myAgoraUid,
                        asBroadcaster = publisher,
                        video = video,
                    )
                    publishing = publisher
                    AgoraManager.enableSpeakingIndicator(true)
                    _state.update { it.copy(isConnected = true) }
                    // Seats may have moved while the token was in flight.
                    reconcileRole(_state.value.mySeat)
                }
                AgoraTokenResult.Denied -> onKicked()
                AgoraTokenResult.Ended -> onRoomEnded()
                is AgoraTokenResult.Failed ->
                    _state.update { it.copy(error = r.message ?: "Could not join this room.") }
            }
        }
    }

    // ── Agora role ───────────────────────────────────────────────────────────

    /**
     * Make the engine agree with the seat documents.
     *
     * Every seat change — mine or anybody's — comes through here, so there is one
     * place that decides whether this device is publishing, and it is driven by
     * the server's own record rather than by what a button did optimistically.
     */
    private fun reconcileRole(mySeat: PartySeat?) {
        val s = _state.value
        if (!s.isConnected) return
        val video = s.isVideo

        /*
         * THE UID CHECK COMES FIRST, AND NOT INSIDE THE ROLE CHECK.
         *
         * It used to be nested inside `if (shouldPublish != publishing)`, which
         * missed the case that matters most in a video room: somebody moving from
         * seat 3 to seat 7. They are publishing before and after, so the role has
         * not changed and the branch was never entered — but the server wrote
         * `agoraUid = 7` on the new seat, every other client binds that tile to uid
         * 7, and this device is still publishing on 3. Everyone else sees a black
         * rectangle where the person moved to, and nothing on either screen
         * suggests why. `takePartySeat` allows the move with no "already seated"
         * guard, so it is an ordinary tap away.
         */
        if (mySeat != null && myAgoraUid != mySeat.index) {
            /*
             * A client cannot change its Agora uid without rejoining, which is why
             * this is the one path that leaves and comes back.
             *
             * Both modes, not video only. The uid is also what the speaking
             * indicator matches on, so an audio seat holder publishing on uid 0
             * would light nobody's ring — audible with no visible source, which
             * reads as the indicator being broken.
             */
            val seatUid = mySeat.index
            if (rejoining) return
            rejoining = true
            viewModelScope.launch {
                try {
                    /*
                     * Only rejoin with a token in hand.
                     *
                     * `rejoinPartyAs` leaves the channel before it joins, so a
                     * failed token request used to drop the user out of the room
                     * entirely — a null token cannot authenticate against a project
                     * with an App Certificate — and nothing on screen said so. They
                     * would sit in a silent room looking at everybody else talking.
                     */
                    when (val r = agoraTokenRepo.requestToken(channelName, seatUid)) {
                        is AgoraTokenResult.Granted -> {
                            myAgoraUid = seatUid
                            AgoraManager.rejoinPartyAs(channelName, r.token, seatUid, video)
                            AgoraManager.enableSpeakingIndicator(true)
                            publishing = true
                            applyLocalMediaState(mySeat)
                        }
                        AgoraTokenResult.Denied -> onKicked()
                        AgoraTokenResult.Ended -> onRoomEnded()
                        is AgoraTokenResult.Failed -> _state.update {
                            it.copy(error = r.message ?: "Could not take that seat on the call.")
                        }
                    }
                } finally {
                    rejoining = false
                }
            }
            return
        }

        val shouldPublish = mySeat != null
        if (shouldPublish != publishing) {
            AgoraManager.setPartyRole(shouldPublish, video)
            publishing = shouldPublish
            if (!shouldPublish) myAgoraUid = 0
        }
        applyLocalMediaState(mySeat)
    }

    /**
     * Mic and camera follow the seat document, not the button.
     *
     * Muting is `muteLocalAudioStream` rather than a media-options change: it
     * takes effect immediately and does not renegotiate, which matters when a
     * moderator is muting somebody mid-sentence.
     */
    private fun applyLocalMediaState(mySeat: PartySeat?) {
        if (mySeat == null) return
        AgoraManager.muteLocalAudio(mySeat.isSilent)
        if (_state.value.isVideo) AgoraManager.muteLocalVideo(mySeat.cameraOff)
    }

    private fun onRemoteGone(uid: Int) {
        _state.update { st ->
            if (uid in st.speakingUids) st.copy(speakingUids = st.speakingUids - uid) else st
        }
    }

    /**
     * Agora's volume report, two and a half times a second.
     *
     * It arrives on an engine thread and drives a ring on up to fifteen avatars,
     * so every update that does not change anything is fifteen recompositions
     * bought for nothing. The equality checks below are the difference between a
     * room that idles and one that repaints continuously.
     *
     * The local speaker is reported in a callback of its own, as uid 0, hence the
     * separate flag rather than one merged set.
     */
    private fun onVolumes(speakers: Array<out IRtcEngineEventHandler.AudioVolumeInfo>) {
        val local = speakers.size == 1 && speakers[0].uid == 0
        if (local) {
            val speaking = speakers[0].volume > SPEAKING_VOLUME
            _state.update { if (it.localSpeaking == speaking) it else it.copy(localSpeaking = speaking) }
            return
        }
        val loud = speakers.filter { it.volume > SPEAKING_VOLUME }.map { it.uid }.toSet()
        _state.update { if (it.speakingUids == loud) it else it.copy(speakingUids = loud) }
    }

    // ── Seats ────────────────────────────────────────────────────────────────

    /**
     * Take a seat, or ask for one.
     *
     * Which of the two depends on `seatMode`, and the decision is made here rather
     * than in the screen so a consent-mode room cannot be bypassed by a stale UI.
     * The server refuses `takePartySeat` in a consent room anyway; this is so the
     * user gets the right outcome rather than an error.
     *
     * THE CALLER MUST ALREADY HOLD THE MICROPHONE PERMISSION. The screen asks
     * before calling this — see `PartyRoomScreen`. A seat taken without it
     * publishes silence, which is the worst available failure: everybody can see
     * you sitting there and nobody can hear you, and nothing on screen says why.
     */
    fun takeSeat(index: Int) {
        val s = _state.value
        if (roomId.isBlank() || s.busySeat >= 0 || s.wasKicked || s.isEnded) return
        if (s.room?.lockedSeats?.contains(index) == true) {
            _state.update { it.copy(error = "This seat is locked.") }
            return
        }
        val needsConsent = s.room?.needsSeatConsent == true && !s.canModerate
        _state.update { it.copy(busySeat = index) }
        viewModelScope.launch {
            if (needsConsent) {
                when (val res = repo.requestSeat(roomId, index)) {
                    is PartyRepository.Result.Ok ->
                        _state.update { it.copy(notice = "Asked the host for seat $index.") }
                    is PartyRepository.Result.Failed ->
                        _state.update { it.copy(error = res.userMessage) }
                }
            } else {
                when (val res = repo.takeSeat(roomId, index)) {
                    is PartyRepository.Result.Ok -> Unit // the seats snapshot does the rest
                    is PartyRepository.Result.Failed ->
                        _state.update { it.copy(error = res.userMessage) }
                }
            }
            _state.update { it.copy(busySeat = -1) }
        }
    }

    fun cancelMySeatRequest() {
        if (roomId.isBlank() || _state.value.myRequestedSeat == 0) return
        viewModelScope.launch {
            when (val res = repo.cancelSeatRequest(roomId)) {
                is PartyRepository.Result.Ok -> Unit
                is PartyRepository.Result.Failed -> _state.update { it.copy(error = res.userMessage) }
            }
        }
    }

    fun leaveMySeat() {
        if (roomId.isBlank() || !_state.value.amSeated) return
        viewModelScope.launch {
            when (val res = repo.leaveSeat(roomId)) {
                is PartyRepository.Result.Ok -> Unit
                is PartyRepository.Result.Failed -> _state.update { it.copy(error = res.userMessage) }
            }
        }
    }

    /**
     * My own mic.
     *
     * Refused outright while a moderator has muted this seat, rather than
     * attempted and rejected by the rules. `selfMuted` and `isMuted` are separate
     * fields precisely so that clearing one cannot clear the other, and a button
     * that appeared to work and did nothing would be worse than one that explains
     * itself.
     */
    fun toggleMyMic() {
        val seat = _state.value.mySeat ?: return
        if (seat.isMuted) {
            _state.update {
                it.copy(
                    notice = if (seat.mutedByOwner) "The host muted you."
                    else "A moderator muted you.",
                )
            }
            return
        }
        viewModelScope.launch {
            try { repo.setSelfMuted(roomId, seat.index, !seat.selfMuted) }
            catch (e: Exception) { _state.update { it.copy(error = e.localizedMessage) } }
        }
    }

    fun toggleMyCamera() {
        val seat = _state.value.mySeat ?: return
        if (!_state.value.isVideo) return
        viewModelScope.launch {
            try { repo.setCameraOff(roomId, seat.index, !seat.cameraOff) }
            catch (e: Exception) { _state.update { it.copy(error = e.localizedMessage) } }
        }
    }

    // ── Invitations ──────────────────────────────────────────────────────────

    /**
     * Answer an invitation to a seat.
     *
     * Accepting needs the microphone, so the screen asks first, exactly as it does
     * for taking a seat directly.
     */
    fun respondToInvite(accept: Boolean) {
        if (roomId.isBlank() || _state.value.myInvite == null) return
        viewModelScope.launch {
            when (val res = repo.respondToInvite(roomId, accept)) {
                is PartyRepository.Result.Ok -> Unit
                is PartyRepository.Result.Failed -> _state.update { it.copy(error = res.userMessage) }
            }
        }
    }

    fun inviteToSeat(targetUid: String, seatIndex: Int) {
        if (!_state.value.canModerate || targetUid.isBlank()) return
        _state.update { it.copy(busyUid = targetUid) }
        viewModelScope.launch {
            when (val res = repo.inviteToSeat(roomId, targetUid, seatIndex)) {
                is PartyRepository.Result.Ok ->
                    _state.update { it.copy(notice = "Invitation sent.") }
                is PartyRepository.Result.Failed ->
                    _state.update { it.copy(error = res.userMessage) }
            }
            _state.update { it.copy(busyUid = "") }
        }
    }

    // ── Moderation ───────────────────────────────────────────────────────────

    fun decideSeatRequest(targetUid: String, approve: Boolean) {
        if (!_state.value.canModerate) return
        _state.update { it.copy(busyUid = targetUid) }
        viewModelScope.launch {
            when (val res = repo.decideSeatRequest(roomId, targetUid, approve)) {
                is PartyRepository.Result.Ok -> Unit
                is PartyRepository.Result.Failed ->
                    _state.update { it.copy(error = res.userMessage) }
            }
            _state.update { it.copy(busyUid = "") }
        }
    }

    /**
     * Mute or unmute a seat as a moderator.
     *
     * The permission question is asked here as well as on the server, because the
     * answer decides whether the button is even offered — and the two copies of
     * the rule live next to each other in [PartyRoomUiState.canMute] and
     * [PartyRoomUiState.canUnmute] so they can be read together.
     */
    fun toggleSeatMute(seat: PartySeat) {
        val s = _state.value
        val next = !seat.isMuted
        if (next && !s.canMute(seat)) {
            _state.update { it.copy(error = "You cannot mute them.") }
            return
        }
        if (!next && !s.canUnmute(seat)) {
            _state.update {
                it.copy(
                    error = if (seat.mutedByRole == "owner") "Only the host can unmute this seat."
                    else "Another admin muted this seat.",
                )
            }
            return
        }
        _state.update { it.copy(busyUid = seat.uid) }
        viewModelScope.launch {
            when (val res = repo.setSeatMuted(roomId, seat.index, next)) {
                is PartyRepository.Result.Ok -> Unit
                is PartyRepository.Result.Failed ->
                    _state.update { it.copy(error = res.userMessage) }
            }
            _state.update { it.copy(busyUid = "") }
        }
    }

    /** Take somebody off a seat, leaving them in the room. */
    fun removeFromSeat(seat: PartySeat) {
        if (!_state.value.canModerate) return
        _state.update { it.copy(busyUid = seat.uid) }
        viewModelScope.launch {
            when (val res = repo.leaveSeat(roomId, targetUid = seat.uid)) {
                is PartyRepository.Result.Ok -> Unit
                is PartyRepository.Result.Failed ->
                    _state.update { it.copy(error = res.userMessage) }
            }
            _state.update { it.copy(busyUid = "") }
        }
    }

    /**
     * Removal that sticks: they are refused a token and cannot come back until the
     * room closes.
     */
    fun removeFromRoom(targetUid: String) {
        if (!_state.value.canModerate || targetUid.isBlank()) return
        _state.update { it.copy(busyUid = targetUid) }
        viewModelScope.launch {
            when (val res = repo.leaveSeat(roomId, targetUid = targetUid, kick = true)) {
                is PartyRepository.Result.Ok ->
                    _state.update { it.copy(notice = "Removed from the room.") }
                is PartyRepository.Result.Failed ->
                    _state.update { it.copy(error = res.userMessage) }
            }
            _state.update { it.copy(busyUid = "") }
        }
    }

    fun toggleSeatLock(index: Int) {
        val s = _state.value
        if (!s.canModerate) return
        val locked = s.room?.lockedSeats?.contains(index) == true
        viewModelScope.launch {
            when (val res = repo.setSeatLocked(roomId, index, !locked)) {
                is PartyRepository.Result.Ok -> Unit
                is PartyRepository.Result.Failed ->
                    _state.update { it.copy(error = res.userMessage) }
            }
        }
    }

    fun setAdmin(targetUid: String, isAdmin: Boolean) {
        if (!_state.value.isOwner || targetUid.isBlank()) return
        _state.update { it.copy(busyUid = targetUid) }
        viewModelScope.launch {
            when (val res = repo.setAdmin(roomId, targetUid, isAdmin)) {
                is PartyRepository.Result.Ok ->
                    _state.update {
                        it.copy(notice = if (isAdmin) "Made an admin." else "Admin removed.")
                    }
                is PartyRepository.Result.Failed ->
                    _state.update { it.copy(error = res.userMessage) }
            }
            _state.update { it.copy(busyUid = "") }
        }
    }

    // ── Settings ─────────────────────────────────────────────────────────────

    /**
     * Save a change from the settings sheet.
     *
     * Every argument is optional and only what is supplied is written, so two
     * settings edited in sequence do not clobber each other — the sheet saves one
     * row at a time.
     */
    fun saveSettings(
        title: String? = null,
        welcomeMessage: String? = null,
        seatCount: Int? = null,
        seatMode: String? = null,
        visibility: String? = null,
        password: String? = null,
    ) {
        if (!_state.value.isOwner) return
        welcomeMessage?.let { text ->
            PartyRoom.welcomeProblem(text)?.let { problem ->
                _state.update { it.copy(error = problem) }
                return
            }
        }
        _state.update { it.copy(savingSettings = true) }
        viewModelScope.launch {
            when (val res = repo.updateRoom(
                roomId = roomId,
                title = title,
                welcomeMessage = welcomeMessage,
                seatCount = seatCount,
                seatMode = seatMode,
                visibility = visibility,
                password = password,
            )) {
                is PartyRepository.Result.Ok ->
                    _state.update { it.copy(savingSettings = false, notice = "Saved.") }
                is PartyRepository.Result.Failed ->
                    _state.update { it.copy(savingSettings = false, error = res.userMessage) }
            }
        }
    }

    // ── Chat and gifts ───────────────────────────────────────────────────────

    fun onMessageInput(v: String) { _state.update { it.copy(messageInput = v) } }

    fun sendMessage() {
        val text = _state.value.messageInput.trim()
        if (text.isBlank() || roomId.isBlank()) return
        _state.update { it.copy(messageInput = "") }
        viewModelScope.launch {
            try { repo.sendMessage(roomId, text) }
            catch (e: Exception) { _state.update { it.copy(error = e.localizedMessage) } }
        }
    }

    /**
     * Gift one or more seat holders.
     *
     * ── THE IDEMPOTENCY KEY, WHICH USED TO BE WRONG ──────────────────────────
     *
     * The old version minted `UUID.randomUUID()` INSIDE this function, under a
     * comment saying "one key per tap, carried through any retry". It was not: a
     * fresh key on every call is a fresh key on every retry, and a retry is
     * exactly what happens when a gift button has visibly done nothing. A dropped
     * response on a committed transaction looked identical to a failure, the user
     * tapped again, and the second tap was a second charge for one intent.
     *
     * The base key is derived from the tap — the gift, the quantity, the recipient
     * set and a per-tap nonce the SCREEN holds — so the same tap retried is the
     * same key, and the server returns the original result instead of charging.
     * Each recipient gets `base_<uid>`, which keeps them distinct without needing
     * a nonce each.
     *
     * Sent one call per recipient rather than as one batch: `settleGift` moves
     * money across seven documents in a transaction, and it is thoroughly tested
     * for one recipient. A fan-out inside it would be a new transaction shape for
     * the sake of saving round trips on an action that happens a few times a
     * minute. Failures are collected rather than aborting the rest — a gift to
     * four people that stops at the second has charged for two and told the sender
     * nothing.
     */
    fun sendGift(gift: GiftItem, quantity: Int, recipientUids: List<String>, tapNonce: String) {
        if (roomId.isBlank()) return
        val recipients = recipientUids.filter { it.isNotBlank() && it != _state.value.myUid }.distinct()
        if (recipients.isEmpty()) {
            _state.update { it.copy(error = "Pick who this is for.") }
            return
        }
        val base = "party_${gift.id}_${quantity}_$tapNonce"
        _state.update { it.copy(giftSending = true, lastGiftResult = null) }
        viewModelScope.launch {
            val failures = mutableListOf<String>()
            var delivered = 0
            recipients.forEach { uid ->
                val err = repo.sendGiftToSeat(
                    roomId = roomId,
                    receiverUid = uid,
                    giftId = gift.id,
                    quantity = quantity,
                    idempotencyKey = "${base}_$uid",
                )
                if (err != null) failures += err else delivered++
            }
            val result = GiftTapResult(
                nonce = tapNonce,
                delivered = delivered,
                failed = failures.size,
                firstError = failures.firstOrNull(),
            )
            _state.update {
                it.copy(
                    giftSending = false,
                    lastGiftResult = result,
                    /*
                     * A partial send reports as a NOTICE naming both numbers, not
                     * as an error. Showing only the failure would tell somebody who
                     * successfully gifted three of four people that nothing worked,
                     * and their next move would be to send the whole thing again.
                     */
                    error = if (result.partial) null else failures.firstOrNull(),
                    notice = when {
                        result.allDelivered && recipients.size == 1 -> "Gift sent."
                        result.allDelivered -> "Gift sent to $delivered people."
                        result.partial -> "Sent to $delivered of ${recipients.size}. " +
                            "${failures.size} did not go through."
                        else -> null
                    },
                )
            }
        }
    }

    /** The screen has consumed [PartyRoomUiState.lastGiftResult] and retired its nonce. */
    fun clearGiftResult() { _state.update { it.copy(lastGiftResult = null) } }

    /** A nonce for one gift tap. Held by the screen so a retry reuses it. */
    fun newGiftTapNonce(): String = UUID.randomUUID().toString()

    fun clearError() { _state.update { it.copy(error = null) } }
    fun clearNotice() { _state.update { it.copy(notice = null) } }
    fun setPip(inPip: Boolean) { _state.update { it.copy(inPip = inPip) } }

    // ── Closing the room ─────────────────────────────────────────────────────

    /**
     * The two-second auto-close.
     *
     * ── WHY IT IS HERE AND NOT ON A SERVER TIMER ─────────────────────────────
     *
     * Two seconds is far below what a cron can do — the fastest useful schedule is
     * one a minute, and a room lingering in the list for up to sixty seconds with
     * nobody in it is the ghost-room defect this is meant to fix. So the last
     * client still watching closes the door, and `sweepEmptyPartyRooms` is the
     * backstop for when there is no last client: a crash, a killed process, a dead
     * network.
     *
     * `endPartyRoom` lets a non-owner do this only when the server's own
     * `emptySince` is more than two seconds old, so this cannot be used to close a
     * room out from under anybody — and a brand-new room has `emptySince: null`,
     * which is why [everHadOccupants] gates the timer at all. Without that gate
     * the owner's own client would destroy the room two seconds after creating it,
     * since a new room's seats are all empty by design.
     */
    private fun watchForEmptyRoom(empty: Boolean) {
        if (!empty) {
            everHadOccupants = true
            emptyRoomJob?.cancel()
            emptyRoomJob = null
            return
        }
        if (!everHadOccupants || hasLeft || emptyRoomJob != null) return
        emptyRoomJob = viewModelScope.launch {
            delay(EMPTY_ROOM_GRACE_MS)
            // Re-check: somebody may have sat down during the grace period, and
            // the cancel above races with this coroutine being resumed.
            if (_state.value.seats.isNotEmpty() || hasLeft) return@launch
            repo.endRoom(roomId)
        }
    }

    /** The owner closing the room deliberately. */
    fun endRoom() {
        if (!_state.value.isOwner) return
        viewModelScope.launch {
            when (val res = repo.endRoom(roomId)) {
                is PartyRepository.Result.Ok -> onRoomEnded()
                is PartyRepository.Result.Failed -> _state.update { it.copy(error = res.userMessage) }
            }
        }
    }

    // ── Leaving ──────────────────────────────────────────────────────────────

    /**
     * The one real leave path. Runs at most once per session.
     *
     * `leavePartyRoom` vacates the seat, drops the listener row and decrements the
     * count in a single call, which is why this is one line where it used to be
     * two racing ones. Standing up on the way out matters here more than in a live
     * room: a seat left occupied by somebody who closed the app is a seat nobody
     * else can take.
     *
     * The owner is deliberately NOT ended here. A back press is not a decision to
     * close a room with ten people in it — that is the explicit End room control,
     * and if they were the last one on a seat the auto-close handles it.
     */
    fun leave() {
        if (roomId.isBlank() || hasLeft) return
        hasLeft = true
        emptyRoomJob?.cancel()
        val wasAdmitted = admitted
        admitted = false
        releaseAgora()
        // viewModelScope is already cancelled when this runs from onCleared.
        teardownScope.launch {
            if (wasAdmitted) {
                try { repo.leaveRoom(roomId) } catch (_: Exception) {}
            }
        }
    }

    /**
     * A moderator removed us. The kick already deleted our seat and our listener
     * row, so there is nothing left to clean up — and marking the session left
     * keeps [leave] from calling `leavePartyRoom` for a seat somebody else may
     * already be sitting in.
     */
    private fun onKicked() {
        if (_state.value.wasKicked) return
        _state.update { it.copy(gate = PartyGate.Kicked) }
        if (hasLeft) return
        hasLeft = true
        admitted = false
        emptyRoomJob?.cancel()
        releaseAgora()
    }

    /** The room closed. `closeRoom` cleared every seat and every presence flag. */
    private fun onRoomEnded() {
        if (_state.value.gate == PartyGate.Kicked) return
        _state.update { it.copy(gate = PartyGate.Ended) }
        if (hasLeft) return
        hasLeft = true
        admitted = false
        emptyRoomJob?.cancel()
        releaseAgora()
    }

    /**
     * Detach from the shared engine.
     *
     * The callbacks and the volume indication are global: left attached, this
     * screen's handlers would keep firing into a dead ViewModel from the live room
     * the user opens next. Video goes back on for the same reason — an audio party
     * turned it off on an engine the call screen also owns.
     */
    private fun releaseAgora() {
        AgoraManager.onUserJoined = null
        AgoraManager.onUserOffline = null
        AgoraManager.onAudioVolume = null
        AgoraManager.enableSpeakingIndicator(false)
        AgoraManager.leaveChannel()
        AgoraManager.useVideo()
        publishing = false
        _state.update { it.copy(isConnected = false) }
    }

    override fun onCleared() {
        super.onCleared()
        leave()
    }

    private companion object {
        /**
         * Agora reports 0-255. Below this is breathing, typing and the room's own
         * echo; a ring that lights for those is noise rather than signal.
         */
        const val SPEAKING_VOLUME = 20

        /** Matches EMPTY_GRACE_MS in functions/src/party.ts. Both must agree. */
        const val EMPTY_ROOM_GRACE_MS = 2_000L

        val teardownScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    }
}

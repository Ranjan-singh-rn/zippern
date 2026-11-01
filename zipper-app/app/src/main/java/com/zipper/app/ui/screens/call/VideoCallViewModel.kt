package com.zipper.app.ui.screens.call

import android.content.Context
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.app.data.model.ActiveCall
import com.zipper.app.data.model.CallChatMessage
import com.zipper.app.data.repository.AgoraTokenRepository
import com.zipper.app.data.repository.CallRepository
import com.zipper.app.data.repository.GiftItem
import com.zipper.app.data.repository.GiftRepository
import com.zipper.app.data.repository.ProfileRepository
import com.zipper.app.data.repository.ProfileResult
import com.zipper.app.ui.screens.live.AgoraManager
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import javax.inject.Inject

enum class CallStatus { RINGING, CONNECTING, CONNECTED, ENDED, DECLINED, MISSED }

data class VideoCallUiState(
    val callId: String = "",
    val isOutgoing: Boolean = false,            // true = I placed the call
    /** True when I am the side being billed. Decided by the server's `earner`, not by who dialled. */
    val isPayer: Boolean = true,
    val otherPartyName: String = "",
    val otherPartyPhotoUrl: String = "",
    val otherPartyUid: String = "",
    val isOtherPartyLiked: Boolean = false,
    val status: CallStatus = CallStatus.RINGING,
    val durationSeconds: Long = 0L,
    val myDiamonds: Long = 0L,                  // caller's live diamond balance
    val beansEarned: Long = 0L,                 // receiver's beans earned this session
    val perMinRateDiamonds: Long = 0L,
    val remoteUid: Int = 0,
    val isMicOn: Boolean = true,
    val isCameraFront: Boolean = true,
    val messages: List<CallChatMessage> = emptyList(),
    val messageInput: String = "",
    val endReason: String? = null,              // non-null = call over
    val error: String? = null,
    val lowBalanceWarning: Boolean = false,     // < 1 min remaining
    /** A hang-up is in flight. Stops a second tap re-entering endCall. */
    val ending: Boolean = false,
    val gifts: List<GiftItem> = emptyList(),    // CRM catalogue for the in-call drawer
    val giftSending: Boolean = false,
    val lastGiftEvent: GiftEvent? = null,       // floats over video for a few seconds
)

data class GiftEvent(val senderName: String, val senderPhotoUrl: String?, val giftName: String, val quantity: Int, val at: Long = System.currentTimeMillis())

@HiltViewModel
class VideoCallViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val callRepo: CallRepository,
    private val profileRepo: ProfileRepository,
    private val giftRepo: GiftRepository,
    private val agoraTokenRepo: AgoraTokenRepository,
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
) : ViewModel() {

    private val _state = MutableStateFlow(VideoCallUiState())
    val state: StateFlow<VideoCallUiState> = _state.asStateFlow()

    private val callId: String = checkNotNull(savedStateHandle["callId"])
    private val isOutgoing: Boolean = savedStateHandle["isOutgoing"] ?: false

    private var durationJob: Job? = null
    private var tickJob: Job? = null
    private var ringTimeoutJob: Job? = null
    private var callDoc: ActiveCall? = null

    private var callerUid: String = ""
    private var receiverUid: String = ""
    private var beansEarnedThisCall: Long = 0L

    private companion object {
        /**
         * How long an outgoing call rings before it is a missed call.
         *
         * Matches `RING_TIMEOUT_SECONDS` in functions/src/calls.ts. The server
         * sweep is the backstop when this app is gone; this is what the caller
         * actually experiences, so it should fire first.
         */
        const val RING_TIMEOUT_MS = 45_000L
    }

    init {
        _state.update { it.copy(callId = callId, isOutgoing = isOutgoing) }
        observeCall()
        observeChat()
        startRingTimeout()
        viewModelScope.launch { _state.update { it.copy(gifts = giftRepo.fetchGifts()) } }
    }

    /**
     * A phone rings, and then it stops.
     *
     * Nothing used to end an unanswered call. `markMissed` sat in the
     * repository with no caller, and neither call screen had a timer — so the
     * call document stayed `ringing` indefinitely, as a live row that would
     * ring the callee again the next time they opened the app, days later. They
     * would answer, the caller would be long gone, and the watchdog would bill
     * the caller for roughly twelve ticks of nothing.
     *
     * The server expires these too, on a sweep. This is the caller's own timer,
     * and it exists so the person staring at the screen gets "No answer" at the
     * moment a phone would have stopped ringing rather than whenever the next
     * cron happens to run.
     */
    private fun startRingTimeout() {
        if (!isOutgoing) return
        ringTimeoutJob = viewModelScope.launch {
            delay(RING_TIMEOUT_MS)
            if (_state.value.status != CallStatus.RINGING) return@launch
            callRepo.markMissed(callId)
            // The document listener turns this into MISSED and tears down the
            // screen; setting it here as well means the caller sees it even if
            // the write is what failed.
            _state.update {
                it.copy(status = CallStatus.MISSED, endReason = "no_answer")
            }
        }
    }

    // ── Call document listener ────────────────────────────────────────────────

    private fun observeCall() {
        viewModelScope.launch {
            callRepo.callFlow(callId).collect { call ->
                if (call == null) return@collect
                callDoc = call
                callerUid   = call.callerId
                receiverUid = call.receiverId

                val myUid    = auth.currentUser?.uid ?: ""
                val otherUid = if (myUid == call.callerId) call.receiverId else call.callerId
                val otherName= if (myUid == call.callerId) call.receiverName else call.callerName
                val otherPhoto= if (myUid == call.callerId) call.receiverPhotoUrl else call.callerPhotoUrl

                val newStatus = when (call.status) {
                    "ringing"   -> CallStatus.RINGING
                    "connected" -> CallStatus.CONNECTED
                    // The server marks a call `ending` while it settles the
                    // final tick. Unmapped, it fell through to RINGING — so a
                    // call that was finishing said "Ringing…" to the person who
                    // did not hang up, with the cost bar gone, until the other
                    // side's endCall landed. It is still connected until the
                    // settlement completes, and that is what it should say.
                    "ending"    -> CallStatus.CONNECTED
                    "ended"     -> CallStatus.ENDED
                    "declined"  -> CallStatus.DECLINED
                    "missed"    -> CallStatus.MISSED
                    else        -> CallStatus.RINGING
                }

                val iPay = myUid == call.payerId
                _state.update {
                    it.copy(
                        isPayer             = iPay,
                        otherPartyUid       = otherUid,
                        otherPartyName      = otherName,
                        otherPartyPhotoUrl  = otherPhoto,
                        status              = newStatus,
                        perMinRateDiamonds  = call.perMinRateDiamonds,
                        endReason           = if (call.status in listOf("ended","declined","missed")) call.endReason else null,
                    )
                }

                when (call.status) {
                    "connected" -> onCallConnected()
                    "ended", "declined", "missed" -> onCallTerminated(call.endReason)
                }

                // Load like status once
                if (otherUid.isNotBlank() && !_state.value.isOtherPartyLiked) {
                    checkLiked(otherUid)
                }

                // Load my current diamond balance (caller only)
                if (iPay && _state.value.myDiamonds == 0L) {
                    loadMyDiamonds()
                }
            }
        }
    }

    private fun observeChat() {
        viewModelScope.launch {
            callRepo.chatMessagesFlow(callId).collect { msgs ->
                _state.update { it.copy(messages = msgs) }
            }
        }
    }

    // ── Connected ─────────────────────────────────────────────────────────────

    private fun onCallConnected() {
        if (durationJob != null) return   // already running
        durationJob = viewModelScope.launch {
            while (true) {
                delay(1000)
                _state.update { it.copy(durationSeconds = it.durationSeconds + 1) }
            }
        }
        // The paying side drives the tick (either party may; one is enough).
        if (_state.value.isPayer) {
            startEconomyTick()
        }
    }

    private fun startEconomyTick() {
        tickJob = viewModelScope.launch {
            while (true) {
                delay(CallRepository.TICK_SECONDS * 1000L)

                // A call id, and nothing else. The server computes elapsed time
                // from its own `startedAt`, so a paused app, a changed device
                // clock, or a skipped tick all settle correctly — the next tick
                // bills everything outstanding rather than only ten seconds.
                val tick = callRepo.tickCall(callId)
                if (tick == null) {
                    // Transient: a dropped request must not end a live call.
                    // The server's watchdog closes a call that really has gone
                    // quiet, two minutes past the last successful tick.
                    continue
                }

                _state.update {
                    it.copy(
                        beansEarned = it.beansEarned + tick.beans,
                        lowBalanceWarning = tick.endNow,
                    )
                }
                loadMyDiamonds()

                if (tick.endNow) {
                    // The server has already stopped the call — out of
                    // diamonds. Hanging up here just tidies up the UI and Agora.
                    endCall("diamonds_exhausted")
                    return@launch
                }
            }
        }
    }

    // ── Call end ──────────────────────────────────────────────────────────────

    /**
     * Hang up.
     *
     * ── THE TICK KEEPS RUNNING UNTIL THE SERVER AGREES ──────────────────────
     *
     * `tickJob` used to be cancelled on the first line, before the request was
     * even sent, and a failed request was then treated as a successful end: the
     * screen said ENDED and navigated away. If the hang-up did not reach the
     * server — which is most likely precisely when the signal has just gone —
     * the call stayed `connected`, nothing ticked, and the watchdog settled the
     * whole silent gap at full rate two minutes later. The user hung up and paid
     * for two more minutes.
     *
     * So the ticks keep going while we try. That is not a cost: each one bills
     * ten seconds the call is genuinely still open on the server, which is the
     * honest answer. They are cancelled once it is actually closed.
     */
    fun endCall(reason: String = if (isOutgoing) "caller_ended" else "receiver_ended") {
        if (_state.value.ending) return
        ringTimeoutJob?.cancel()
        _state.update { it.copy(ending = true) }
        durationJob?.cancel()
        viewModelScope.launch {
            when (val res = callRepo.endCall(callId, reason)) {
                is CallRepository.CallEndResult.Settled -> {
                    tickJob?.cancel()
                    AgoraManager.leaveChannel()
                    _state.update {
                        it.copy(
                            ending = false,
                            endReason = reason,
                            status = CallStatus.ENDED,
                            // Server figures, including the part-tick that had
                            // not been billed when the user hung up.
                            durationSeconds = res.end.durationSeconds,
                            beansEarned = res.end.beansCredited,
                        )
                    }
                }
                is CallRepository.CallEndResult.Failed -> {
                    /*
                     * Do NOT navigate away. The call is still live and still
                     * billing, and saying otherwise is the lie that costs the
                     * user money. Media is left up for the same reason: this is
                     * a call that is still running.
                     */
                    _state.update {
                        it.copy(
                            ending = false,
                            error = res.message + " You are still connected and " +
                                "still being charged — try End again.",
                        )
                    }
                }
            }
        }
    }

    private fun onCallTerminated(reason: String) {
        durationJob?.cancel()
        tickJob?.cancel()
        AgoraManager.leaveChannel()
        _state.update { it.copy(status = CallStatus.ENDED, endReason = reason) }
    }

    // ── Agora ─────────────────────────────────────────────────────────────────

    fun initAgora(context: Context) {
        AgoraManager.init(context)
        AgoraManager.onUserJoined  = { uid -> _state.update { it.copy(remoteUid = uid) } }
        AgoraManager.onUserOffline = { _ ->
            // Remote party disconnected — end call
            endCall("network")
        }
        // Fetch a server-generated RTC token before joining — production safe.
        // Falls back to null if the Cloud Function is not yet deployed (App Certificate must be OFF in that case).
        viewModelScope.launch {
            val token = agoraTokenRepo.fetchToken(callId)
            AgoraManager.joinAsBroadcaster(callId, token)
        }
    }

    fun onRemoteUidAvailable(uid: Int) {
        _state.update { it.copy(remoteUid = uid) }
    }

    // ── Controls ──────────────────────────────────────────────────────────────

    fun toggleMic() {
        val newMic = !_state.value.isMicOn
        AgoraManager.muteLocalAudio(!newMic)
        _state.update { it.copy(isMicOn = newMic) }
    }

    fun flipCamera() {
        AgoraManager.switchCamera()
        _state.update { it.copy(isCameraFront = !it.isCameraFront) }
    }

    // ── Chat ──────────────────────────────────────────────────────────────────

    fun onMessageInput(v: String) { _state.update { it.copy(messageInput = v) } }

    fun sendMessage() {
        val msg = _state.value.messageInput.trim()
        if (msg.isBlank()) return
        _state.update { it.copy(messageInput = "") }
        viewModelScope.launch {
            try { callRepo.sendChatMessage(callId, msg) }
            catch (_: Exception) {}
        }
    }

    // ── Like ──────────────────────────────────────────────────────────────────

    fun toggleLike() {
        val otherUid = _state.value.otherPartyUid
        if (otherUid.isBlank()) return
        val liked = _state.value.isOtherPartyLiked
        viewModelScope.launch {
            // A second copy of the like logic used to live here, writing the
            // edges and the counter by hand — and getting it subtly wrong: on
            // failure the three writes were not atomic, so a dropped connection
            // left an edge without a count or a count without an edge.
            when (val res = profileRepo.setLikeFromCall(otherUid, !liked)) {
                is ProfileResult.Success -> _state.update { it.copy(isOtherPartyLiked = !liked) }
                else -> Unit
            }
        }
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private fun checkLiked(otherUid: String) {
        val myUid = auth.currentUser?.uid ?: return
        viewModelScope.launch {
            val snap = firestore.collection("users").document(myUid)
                .collection("liked").document(otherUid).get().await()
            _state.update { it.copy(isOtherPartyLiked = snap.exists()) }
        }
    }

    private fun loadMyDiamonds() {
        val uid = auth.currentUser?.uid ?: return
        viewModelScope.launch {
            val snap = firestore.collection("users").document(uid).get().await()
            _state.update { it.copy(myDiamonds = snap.getLong("diamonds") ?: 0L) }
        }
    }

    fun clearError() { _state.update { it.copy(error = null) } }

    // ── In-call gifts ─────────────────────────────────────────────────────────

    fun sendGiftInCall(targetUid: String, gift: GiftItem, quantity: Int = 1) {
        if (_state.value.giftSending) return
        _state.update { it.copy(giftSending = true) }
        viewModelScope.launch {
            val res = try {
                giftRepo.sendGift(targetUid, gift, quantity = quantity, roomId = null)
            } catch (e: Exception) { com.zipper.app.data.repository.GiftResult.Error(e.localizedMessage ?: "Could not send gift") }
            when (res) {
                is com.zipper.app.data.repository.GiftResult.Success,
                is com.zipper.app.data.repository.GiftResult.LuckyWin -> {
                    val me = auth.currentUser
                    _state.update {
                        it.copy(
                            giftSending = false,
                            lastGiftEvent = GiftEvent(me?.displayName ?: "You", me?.photoUrl?.toString(), gift.name, quantity),
                        )
                    }
                    notifyGiftSent(gift, quantity)
                    loadMyDiamonds()
                }
                is com.zipper.app.data.repository.GiftResult.InsufficientDiamonds ->
                    _state.update { it.copy(giftSending = false, error = "Not enough diamonds — recharge to send this gift") }
                is com.zipper.app.data.repository.GiftResult.Error ->
                    _state.update { it.copy(giftSending = false, error = res.message) }
            }
        }
    }

    fun notifyGiftSent(gift: GiftItem, quantity: Int = 1) {
        viewModelScope.launch {
            try {
                val myName = auth.currentUser?.displayName ?: "You"
                val qty = if (quantity > 1) " ×$quantity" else ""
                callRepo.sendChatMessage(callId, "${gift.emoji} $myName sent ${gift.name}$qty")
            } catch (_: Exception) {}
        }
    }

    fun clearGiftEvent() { _state.update { it.copy(lastGiftEvent = null) } }

    override fun onCleared() {
        /*
         * P0-6: a call screen that goes away without hanging up still closes the
         * call on the server. It used to leave it `connected` until the watchdog
         * found it two minutes later. `viewModelScope` is already cancelled here,
         * so this runs on its own scope; `endCall` is idempotent — the server
         * ignores a call that has already ended.
         */
        if (_state.value.endReason == null && !_state.value.ending) {
            val id = callId
            CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
                try { callRepo.endCall(id, "teardown") } catch (_: Exception) {}
            }
        }
        super.onCleared()
        durationJob?.cancel()
        tickJob?.cancel()
        ringTimeoutJob?.cancel()
        // These are global on AgoraManager; left set, a later live room's
        // user-offline event would call endCall on this dead ViewModel.
        AgoraManager.onUserJoined = null
        AgoraManager.onUserOffline = null
        AgoraManager.leaveChannel()
    }
}

// `perMinRateToDiamonds` and `tickBeansFrom` are gone. They existed so the
// caller's device could work out what to charge and what to credit — the second
// one was a hardcoded 50% with a comment admitting it was a guess. The server
// returns both numbers per tick now, from the rate and split it actually used.

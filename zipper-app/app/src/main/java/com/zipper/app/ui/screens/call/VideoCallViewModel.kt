package com.zipper.app.ui.screens.call

import android.content.Context
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.ListenerRegistration
import com.zipper.app.data.model.ActiveCall
import com.zipper.app.data.model.CallChatMessage
import com.zipper.app.data.repository.AgoraTokenRepository
import com.zipper.app.data.repository.CallRepository
import com.zipper.app.data.repository.ChatRepository
import com.zipper.app.data.repository.GiftItem
import com.zipper.app.data.repository.GiftRepository
import com.zipper.app.data.repository.LiveRepository
import com.zipper.app.data.repository.MoneyFunctions
import com.zipper.app.data.repository.ProfileRepository
import com.zipper.app.data.repository.ProfileResult
import com.zipper.app.ui.screens.live.AgoraManager
import com.zipper.app.util.CallBilling
import com.zipper.app.util.SafetyWords
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
    /** Seconds since the call connected, BY THE SERVER'S CLOCK (see CallBilling). */
    val durationSeconds: Long = 0L,
    val myDiamonds: Long = 0L,                  // caller's live diamond balance
    /** Beans credited to the earner so far, as the server wrote them on the call. */
    val beansEarned: Long = 0L,
    val perMinRateDiamonds: Long = 0L,
    // ── Per-minute billing (APK 20 / spec §11) — every figure from the server ──
    /** Whole minutes charged so far. The first is charged on connect. */
    val minutesBilled: Long = 0L,
    /** What the payer has spent on this call so far. */
    val diamondsSpent: Long = 0L,
    /** Seconds until the next whole minute is charged; null before the call connected. */
    val secondsToNextCharge: Long? = null,
    /** Minutes the payer's balance still covers; null on a free call. */
    val minutesLeft: Long? = null,
    /**
     * The server ended the call (out of diamonds, a restriction, a displaced
     * session). Shown as a dialog before the screen closes, because a call
     * that just vanished with no word is the thing people report as a bug.
     */
    val serverEndMessage: String? = null,
    val remoteUid: Int = 0,
    val isMicOn: Boolean = true,
    val isCameraFront: Boolean = true,
    val messages: List<CallChatMessage> = emptyList(),
    val messageInput: String = "",
    val endReason: String? = null,              // non-null = call over
    val error: String? = null,
    val lowBalanceWarning: Boolean = false,     // < 2 min affordable
    /** A hang-up is in flight. Stops a second tap re-entering endCall. */
    val ending: Boolean = false,
    val gifts: List<GiftItem> = emptyList(),    // CRM catalogue for the in-call drawer
    val giftSending: Boolean = false,
    val lastGiftEvent: GiftEvent? = null,       // floats over video for a few seconds
    /** The sender's lucky reward on the last in-call lucky gift, for the celebration. */
    val lastLuckyWin: com.zipper.app.data.repository.GiftResult.LuckyWin? = null,
    // ── WP2 (Owner, 5 Nov 2026): the call screen's buttons by side, the menu, buying diamonds during the call ──
    /** The call document has been read: who pays is known, so the paying side's buttons may show. */
    val callLoaded: Boolean = false,
    val myUid: String = "",
    val callerUid: String = "",
    val receiverUid: String = "",
    /** "caller" | "receiver" — who earns, as the server wrote it on the call (`rateFor`). */
    val earner: String = "receiver",
    val isSpeakerOn: Boolean = true,
    val isCameraOn: Boolean = true,
    /** A recharge request is on its way to a reseller (the in-call Buy diamonds sheet). */
    val buySending: Boolean = false,
    /** What became of the last recharge request — shown in the sheet. */
    val buyNotice: String? = null,
    /** The reseller the last request went to, so the sheet can offer their chat. */
    val buySellerUid: String? = null,
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
    private val liveRepo: LiveRepository,
    private val chatRepo: ChatRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(VideoCallUiState())
    val state: StateFlow<VideoCallUiState> = _state.asStateFlow()

    private val callId: String = checkNotNull(savedStateHandle["callId"])
    private val isOutgoing: Boolean = savedStateHandle["isOutgoing"] ?: false

    private var displayJob: Job? = null
    private var tickJob: Job? = null
    private var ringTimeoutJob: Job? = null
    private var callDoc: ActiveCall? = null

    private var callerUid: String = ""
    private var receiverUid: String = ""

    /** WP2: the payer's balance, live (see [observeMyDiamonds]). */
    private var meListener: ListenerRegistration? = null

    /** WP2: the channel is joined once per call — coming back from the Diamond Shop or a chat must not join again. */
    private var joinRequested = false

    /**
     * What the server last said about the billing, and how far this device's
     * clock is from the server's. Every number on screen is derived from these
     * two by `CallBilling`; nothing here counts seconds or minutes itself.
     */
    private var billing = CallBilling.Snapshot()
    private var clockOffsetMs = 0L

    private companion object {
        /**
         * How long an outgoing call rings before it is a missed call.
         *
         * Matches `RING_TIMEOUT_SECONDS` in functions/src/calls.ts. The server
         * sweep is the backstop when this app is gone; this is what the caller
         * actually experiences, so it should fire first.
         */
        const val RING_TIMEOUT_MS = 45_000L

        /** The in-call chat's longest message — the same limit firestore.rules enforces on `calls/{id}/messages`. */
        const val CALL_CHAT_MAX = 300
    }

    init {
        _state.update { it.copy(callId = callId, isOutgoing = isOutgoing, myUid = auth.currentUser?.uid ?: "") }
        // O13: the in-call chat is checked against the same word list as every other chat.
        viewModelScope.launch { SafetyWords.ensureLoaded(firestore) }
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
                    // final minute. Unmapped, it fell through to RINGING — so a
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

                /*
                 * THE DOCUMENT IS THE SERVER'S LEDGER FOR THIS CALL. `tickIndex`
                 * (minutes), `billedThroughMs`, `diamondsCharged` and
                 * `beansCredited` are written by the same transaction that moves
                 * the money, and both parties can read them — so the earner's
                 * "Earned" and the payer's "Spent" come from here, not from
                 * adding up tick responses that a dropped network would miss.
                 */
                billing = billing.copy(
                    startedAtMs = call.startedAt.takeIf { it > 0L } ?: billing.startedAtMs,
                    minutesBilled = maxOf(billing.minutesBilled, call.minutesBilled),
                    billedThroughMs = call.billedThroughMs.takeIf { it > 0L } ?: billing.billedThroughMs,
                    perMinRateDiamonds = call.perMinRateDiamonds,
                )

                _state.update {
                    it.copy(
                        isPayer             = iPay,
                        callLoaded          = true,
                        callerUid           = call.callerId,
                        receiverUid         = call.receiverId,
                        earner              = call.earner,
                        otherPartyUid       = otherUid,
                        otherPartyName      = otherName,
                        otherPartyPhotoUrl  = otherPhoto,
                        status              = newStatus,
                        perMinRateDiamonds  = call.perMinRateDiamonds,
                        beansEarned         = maxOf(it.beansEarned, call.beansCredited),
                        diamondsSpent       = maxOf(it.diamondsSpent, call.diamondsCharged),
                        minutesBilled       = billing.minutesBilled,
                        endReason           = if (call.status in listOf("ended","declined","missed")) call.endReason else null,
                    )
                }
                refreshDisplay()

                when (call.status) {
                    "connected" -> onCallConnected()
                    "ended", "declined", "missed" -> onCallTerminated(call.endReason)
                }

                // Load like status once
                if (otherUid.isNotBlank() && !_state.value.isOtherPartyLiked) {
                    checkLiked(otherUid)
                }

                // The payer's balance, live (WP2): a recharge confirmed during the call shows at once.
                if (iPay) observeMyDiamonds()
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
        if (displayJob != null) return   // already running
        // The timer: every second, re-derive the figures from the server's
        // snapshot and the corrected clock. Nothing is incremented locally.
        displayJob = viewModelScope.launch {
            while (true) {
                refreshDisplay()
                delay(1000)
            }
        }
        /*
         * BOTH SIDES TICK. The payer's tick used to be the charge; the server
         * now charges whole minutes from its own clock, so a tick is a
         * liveness ping and the way the figures on screen stay true. The
         * earner's tick is never charged — the server answers it with
         * `role: 'earner'` and `charged: 0` — but it keeps the watchdog away
         * when the payer's device goes quiet, and it brings back the same
         * `minutesBilled` the payer sees.
         */
        startLivenessTick()
    }

    /** The figures on screen, from the last server snapshot and the corrected clock. */
    private fun refreshDisplay() {
        // Once the server has settled the call its figures are final; the
        // clock must not keep running underneath them.
        if (_state.value.endReason != null || _state.value.status == CallStatus.ENDED) return
        val serverNow = CallBilling.serverNowMs(System.currentTimeMillis(), clockOffsetMs)
        val d = CallBilling.display(billing, serverNow, _state.value.myDiamonds.takeIf { _state.value.isPayer })
        _state.update {
            it.copy(
                durationSeconds = d.elapsedSeconds,
                minutesBilled = d.minutesBilled,
                diamondsSpent = maxOf(it.diamondsSpent, d.diamondsSpent),
                secondsToNextCharge = d.secondsToNextCharge,
                minutesLeft = d.minutesLeft,
                lowBalanceWarning = it.isPayer && d.lowBalance,
            )
        }
    }

    private fun startLivenessTick() {
        if (tickJob != null) return
        tickJob = viewModelScope.launch {
            while (true) {
                delay(CallBilling.LIVENESS_TICK_SECONDS * 1000L)

                // A call id, and nothing else. The server computes elapsed time
                // from its own `startedAt` and charges whole minutes from its
                // own clock, so a paused app, a changed device clock, or a
                // skipped tick changes nothing about what is owed.
                val tick = callRepo.tickCall(callId)
                if (tick == null) {
                    // Transient: a dropped request must not end a live call.
                    // The server's watchdog closes a call that really has gone
                    // quiet, two minutes past the last successful tick.
                    continue
                }
                applyTick(tick)

                if (tick.endNow) {
                    // The server has already stopped the call — out of
                    // diamonds, a restriction, a displaced session. Hanging up
                    // here just tidies up the UI and Agora; the server's reason
                    // stands over whatever is sent.
                    val reason = tick.endReason ?: CallBilling.END_INSUFFICIENT_DIAMONDS
                    _state.update { it.copy(serverEndMessage = CallBilling.endMessage(reason, it.isPayer)) }
                    endCall(reason)
                    return@launch
                }
            }
        }
    }

    /** Fold a tick's answer into the snapshot and the clock offset. */
    private fun applyTick(tick: MoneyFunctions.CallTick) {
        val startedAt = tick.startedAtMs ?: billing.startedAtMs
        if (tick.startedAtMs != null && tick.startedAtMs > 0L) {
            clockOffsetMs = CallBilling.clockOffsetMs(tick.startedAtMs, tick.elapsedSeconds, System.currentTimeMillis())
        }
        billing = billing.copy(
            startedAtMs = startedAt,
            minutesBilled = maxOf(billing.minutesBilled, tick.minutesBilled),
            billedThroughMs = tick.billedThroughMs ?: tick.nextChargeAtMs ?: billing.billedThroughMs,
            perMinRateDiamonds = if (tick.perMinRateDiamonds > 0L) tick.perMinRateDiamonds else billing.perMinRateDiamonds,
            affordableMinutes = tick.affordableMinutes ?: billing.affordableMinutes,
        )
        if (tick.beans > 0L) _state.update { it.copy(beansEarned = it.beansEarned + tick.beans) }
        refreshDisplay()
        // A minute fell due on this tick: the balance moved.
        if (_state.value.isPayer && tick.charged > 0L) loadMyDiamonds()
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
     * whole silent gap two minutes later. The user hung up and paid for two
     * more minutes.
     *
     * So the ticks keep going while we try. That is not a cost: a tick charges
     * nothing by itself, it only tells the server the call is genuinely still
     * open on this side, which is the honest answer. They are cancelled once it
     * is actually closed.
     */
    fun endCall(reason: String = if (isOutgoing) "caller_ended" else "receiver_ended") {
        if (_state.value.ending) return
        ringTimeoutJob?.cancel()
        _state.update { it.copy(ending = true) }
        displayJob?.cancel()
        viewModelScope.launch {
            when (val res = callRepo.endCall(callId, reason)) {
                is CallRepository.CallEndResult.Settled -> {
                    tickJob?.cancel()
                    AgoraManager.leaveChannel()
                    val serverReason = res.end.endReason?.takeIf { it.isNotBlank() } ?: reason
                    _state.update {
                        it.copy(
                            ending = false,
                            endReason = serverReason,
                            status = CallStatus.ENDED,
                            // Server figures, including the minute in progress
                            // when the user hung up — a started minute is owed.
                            durationSeconds = res.end.durationSeconds,
                            beansEarned = res.end.beansCredited,
                            diamondsSpent = res.end.diamondsCharged,
                            minutesBilled = maxOf(it.minutesBilled, res.end.minutesBilled),
                            serverEndMessage = it.serverEndMessage
                                ?: CallBilling.endMessage(serverReason, it.isPayer),
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
        displayJob?.cancel()
        tickJob?.cancel()
        AgoraManager.leaveChannel()
        _state.update {
            it.copy(
                status = CallStatus.ENDED,
                endReason = reason,
                serverEndMessage = it.serverEndMessage ?: CallBilling.endMessage(reason, it.isPayer),
            )
        }
    }

    // ── Agora ─────────────────────────────────────────────────────────────────

    fun initAgora(context: Context) {
        AgoraManager.init(context)
        AgoraManager.onUserJoined  = { uid -> _state.update { it.copy(remoteUid = uid) } }
        AgoraManager.onUserOffline = { _ ->
            // Remote party disconnected — end call
            endCall("network")
        }
        // A-6: a call over an hour used to die at the token's expiry. The
        // engine warns ahead and AgoraManager renews through the one
        // repository that mints tokens.
        AgoraManager.tokenRenewer = { channel -> agoraTokenRepo.renewToken(channel) }
        /*
         * WP2: this screen can be left and come back to while the call runs — the Diamond Shop or a reseller's chat
         * opened from the call. The call never left the channel, so coming back re-binds the video and nothing else:
         * a second join would cost a token and, worse, a dropped connection the other side reads as a hang-up.
         */
        if (joinRequested || AgoraManager.isInChannel(callId)) return
        joinRequested = true
        // Fetch a server-generated RTC token before joining — production safe.
        // A-7: joined with the uid the token was signed for, never 0.
        viewModelScope.launch {
            val grant = agoraTokenRepo.fetchGrant(callId)
            AgoraManager.joinAsBroadcaster(callId, grant?.token, grant?.uid ?: 0)
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

    /** WP2 menu: the call through the loudspeaker or the earpiece. */
    fun toggleSpeaker() {
        val on = !_state.value.isSpeakerOn
        AgoraManager.setSpeakerphone(on)
        _state.update { it.copy(isSpeakerOn = on) }
    }

    /** WP2 menu: stop / start sending my camera. The call (and its billing) carries on either way. */
    fun toggleCamera() {
        val on = !_state.value.isCameraOn
        AgoraManager.muteLocalVideo(!on)
        _state.update { it.copy(isCameraOn = on) }
    }

    /** WP2 menu: report the other person — the same report the profile and the chat send. */
    fun reportOtherParty(reason: String) {
        val other = _state.value.otherPartyUid
        if (other.isBlank()) return
        viewModelScope.launch {
            try {
                liveRepo.reportUser(other, reason)
                _state.update { it.copy(error = "Thanks — our team will review this.") }
            } catch (_: Exception) {
                _state.update { it.copy(error = "Couldn't send the report. Try again.") }
            }
        }
    }

    /**
     * WP2 menu: block the other person and hang up. Blocking is the same as from their profile (they can no longer
     * call or message); the call is then ended the ordinary way, so it is settled to the minute like any other.
     */
    fun blockOtherPartyAndEnd() {
        val other = _state.value.otherPartyUid
        if (other.isBlank()) return
        viewModelScope.launch {
            profileRepo.blockUser(other, _state.value.otherPartyName, _state.value.otherPartyPhotoUrl)
            endCall()
        }
    }

    /**
     * WP2 — "buy diamonds while the call is ongoing". Diamonds are bought from a verified reseller (payment is off the
     * platform; the reseller confirms and the diamonds are credited by the server), so the request goes to the reseller
     * as a chat message from this screen, without leaving the call. The balance on the call screen is live, so the
     * diamonds show the moment they are added.
     */
    fun requestDiamonds(sellerUid: String, sellerName: String, sellerPhotoUrl: String, message: String) {
        val me = auth.currentUser ?: return
        if (_state.value.buySending || sellerUid.isBlank() || message.isBlank()) return
        _state.update { it.copy(buySending = true, buyNotice = null) }
        viewModelScope.launch {
            try {
                val snap = firestore.collection("users").document(me.uid).get().await()
                chatRepo.sendMessage(
                    myUid = me.uid,
                    myName = snap.getString("name") ?: me.displayName ?: "",
                    myPhotoUrl = snap.getString("photoUrl") ?: "",
                    otherUid = sellerUid, otherName = sellerName, otherPhotoUrl = sellerPhotoUrl,
                    text = message,
                )
                _state.update {
                    it.copy(
                        buySending = false, buySellerUid = sellerUid,
                        buyNotice = "Sent to ${sellerName.ifBlank { "the reseller" }}. They will reply in Messages with how " +
                            "to pay; your diamonds show here as soon as they add them. Your call keeps running.",
                    )
                }
            } catch (e: Exception) {
                _state.update { it.copy(buySending = false, buyNotice = "Couldn't send that — check your connection and try again.") }
            }
        }
    }

    fun clearBuyNotice() { _state.update { it.copy(buyNotice = null, buySellerUid = null) } }

    // ── Chat ──────────────────────────────────────────────────────────────────

    fun onMessageInput(v: String) { _state.update { it.copy(messageInput = v) } }

    fun sendMessage() {
        val msg = _state.value.messageInput.trim()
        if (msg.isBlank()) return
        // O13 / WP2: the in-call chat keeps to the same word list as every other chat, and to the rules' 300 characters.
        if (!SafetyWords.allowed(msg)) {
            _state.update { it.copy(error = SafetyWords.HELD_NOTICE) }
            return
        }
        if (msg.length > CALL_CHAT_MAX) {
            _state.update { it.copy(error = "Keep a message under $CALL_CHAT_MAX characters.") }
            return
        }
        _state.update { it.copy(messageInput = "") }
        viewModelScope.launch {
            try { callRepo.sendChatMessage(callId, msg) }
            catch (_: Exception) {
                // Put it back so nothing typed is lost (the call may just have ended, or the network dropped).
                _state.update { it.copy(messageInput = if (it.messageInput.isEmpty()) msg else it.messageInput, error = "Message not sent.") }
            }
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

    // A-12: guarded. An unguarded `await` in viewModelScope on a dropped
    // connection took the whole process down mid-call.
    private fun checkLiked(otherUid: String) {
        val myUid = auth.currentUser?.uid ?: return
        viewModelScope.launch {
            try {
                val snap = firestore.collection("users").document(myUid)
                    .collection("liked").document(otherUid).get().await()
                _state.update { it.copy(isOtherPartyLiked = snap.exists()) }
            } catch (_: Exception) {}
        }
    }

    /**
     * WP2: the payer's balance, live — a recharge a reseller confirms while the call runs shows at once, and "minutes
     * left" follows it. One listener for the life of the call screen.
     */
    private fun observeMyDiamonds() {
        if (meListener != null) return
        val uid = auth.currentUser?.uid ?: return
        meListener = firestore.collection("users").document(uid).addSnapshotListener { snap, _ ->
            val diamonds = snap?.getLong("diamonds") ?: return@addSnapshotListener
            _state.update { it.copy(myDiamonds = diamonds) }
            refreshDisplay()
        }
    }

    private fun loadMyDiamonds() {
        val uid = auth.currentUser?.uid ?: return
        viewModelScope.launch {
            try {
                val snap = firestore.collection("users").document(uid).get().await()
                _state.update { it.copy(myDiamonds = snap.getLong("diamonds") ?: 0L) }
                refreshDisplay()
            } catch (_: Exception) {}
        }
    }

    fun clearError() { _state.update { it.copy(error = null) } }

    // ── In-call gifts ─────────────────────────────────────────────────────────

    /**
     * [quantity] is the combo for a lucky gift (`gift.isLucky`) and the count
     * for a normal one; the repository sends the right field.
     */
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
                            lastLuckyWin = res as? com.zipper.app.data.repository.GiftResult.LuckyWin,
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
    fun clearLuckyWin() { _state.update { it.copy(lastLuckyWin = null) } }

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
        meListener?.remove()
        meListener = null
        displayJob?.cancel()
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
// returns both numbers per minute now, from the rate and split it actually used,
// and `CallBilling` is the only arithmetic left on this side.

package com.zipper.datingapp

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.drawable.GradientDrawable
import android.media.AudioManager
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.TextureView
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.widget.LinearLayout
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import kotlin.math.roundToInt
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.cardview.widget.CardView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.displayCutoutPadding
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Button
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import androidx.compose.ui.res.stringResource
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.core.content.ContextCompat
import androidx.core.view.setPadding
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.database.DataSnapshot
import com.google.firebase.database.DatabaseError
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.database.ValueEventListener
import com.zipper.datingapp.call.CallSoundManager
import com.zipper.datingapp.call.CallStatus
import com.zipper.datingapp.call.CallStatusChipSpec
import com.zipper.datingapp.data.LiveStreamChatMessage
import com.zipper.datingapp.data.PkBattleOutcome
import com.zipper.datingapp.data.PkBattlePhase
import com.zipper.datingapp.data.PkBattleSessionState
import com.zipper.datingapp.data.PK_POST_RESULT_LINGER_MS
import com.zipper.datingapp.data.UserProfile
import com.zipper.datingapp.economy.VirtualEconomyMath
import com.zipper.datingapp.service.CallFirebaseMessagingService
import com.zipper.datingapp.service.FirebaseService
import com.zipper.datingapp.service.LiveEconomyGiftResult
import com.zipper.datingapp.data.Gift
import com.zipper.datingapp.data.LuckyGiftsOutcome
import com.zipper.datingapp.data.availableGifts
import com.zipper.datingapp.data.callableFailureMessage
import com.zipper.datingapp.data.callablePayloadDiamondsWon
import com.zipper.datingapp.data.callablePayloadErrorMessage
import com.zipper.datingapp.data.callablePayloadSuccess
import com.zipper.datingapp.data.callablePayloadTransactionId
import com.zipper.datingapp.data.withMergedLiveGiftMessage
import com.zipper.datingapp.data.zipperFirebaseFunctions
import com.zipper.datingapp.data.preferences.AppPreferencesRepository
import com.zipper.datingapp.data.preferences.ThemeModePreference
import com.zipper.datingapp.ui.components.FuturisticConfirmCloseDialog
import com.zipper.datingapp.ui.components.GiftOverlay
import com.zipper.datingapp.ui.components.GiftSelectionSheet
import com.zipper.datingapp.ui.DatingUiState
import com.zipper.datingapp.ui.screens.ArFilterBottomSheet
import com.zipper.datingapp.ui.screens.PkToolsMenuSheet
import com.zipper.datingapp.databinding.ActivityLiveStreamBinding
import com.zipper.datingapp.R
import com.zipper.datingapp.ui.screens.DiamondShopPopup
import com.zipper.datingapp.ui.screens.LiveWatchingViewersSheet
import com.zipper.datingapp.ui.theme.DatingAppTheme
import com.zipper.datingapp.ui.theme.LocalWindowWidthClass
import com.zipper.datingapp.ui.theme.toWindowWidthClass
import com.zipper.datingapp.ui.webrtc.PkArenaEndCard
import com.zipper.datingapp.ui.webrtc.PkArenaHud
import com.zipper.datingapp.ui.webrtc.pkMvpSupporterPhotoUrls
import com.zipper.datingapp.ui.webrtc.WebRtcOverlayBottomChat
import com.zipper.datingapp.ui.webrtc.WebRtcOverlayTopBar
import com.snap.camerakit.lenses.LensesComponent
import com.zipper.datingapp.webrtc.FilterType
import com.zipper.datingapp.webrtc.PkGuestSpectatorFanout
import com.zipper.datingapp.webrtc.PkHostSpectatorFanout
import com.zipper.datingapp.webrtc.WebRTCManager
import com.zipper.datingapp.agora.AgoraManager
import io.agora.rtc2.Constants
import io.agora.rtc2.video.VideoCanvas
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import java.util.Locale
import org.webrtc.PeerConnection
import org.webrtc.SurfaceViewRenderer
import java.util.UUID
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * 1:1 and PK WebRTC calls. Video modes require [CAMERA] and [RECORD_AUDIO]; audio-only 1:1 requires
 * [RECORD_AUDIO] only. Audio-only 1:1 uses [WebRTCManager] with `audioOnly = true` (no local video track).
 * Teardown: [onDestroy] / [endRegularCallAndReturn] call [WebRTCManager.onDestroy] (peer dispose, capturer stop,
 * tracks released) — equivalent to Agora leaveChannel + destroy for this stack.
 * Private `call_*` sessions also register [bindPrivateCallForProcessTeardown] so Firestore/RTDB signaling can be
 * closed from [onDestroy] or [ProcessLifecycleOwner] when the user kills the process without End call.
 *
 * Compose overlays sit above [R.id.standard_call_container] (remote + PiP [CardView]); top uses a fixed XML margin.
 * Bottom chat uses min/max height in XML; [resizeStandardCallBottomOverlayHeightForVideoCall] sets ~45% for 1:1 video
 * so the message list stays visible above the control strip. PiP margins use measured bottom overlay height when known.
 */
@OptIn(ExperimentalMaterial3Api::class)
class LiveStreamActivity : ComponentActivity() {

    private val webrtcPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { result ->
        val mic = result[Manifest.permission.RECORD_AUDIO] == true
        val needsCamera = isPkSession || isVideoCall
        val cam = if (needsCamera) result[Manifest.permission.CAMERA] == true else true
        android.util.Log.d(
            "WebRTC_SIGNAL",
            "LiveStreamActivity permissions needsCamera=$needsCamera camera=$cam mic=$mic map=$result"
        )
        if (mic && cam) {
            startLiveStream()
        } else {
            runOnUiThread {
                Toast.makeText(this@LiveStreamActivity, getString(R.string.call_permissions_required), Toast.LENGTH_LONG).show()
                finish()
            }
        }
    }

    private var rtcManager: WebRTCManager? = null
    private val firebaseService = FirebaseService()
    private val appPrefs by lazy { AppPreferencesRepository(this) }
    /** Wall clock when 1:1/PK video connected as streamer (host). */
    private var streamSessionStartWallMs: Long = 0L
    private var streamingMetricsReported: Boolean = false

    private lateinit var localView: SurfaceViewRenderer
    private lateinit var remoteView: SurfaceViewRenderer
    /** PK Battle left tile — host's own camera feed. `null` until [onCreate]. */
    private var pkHostView: SurfaceViewRenderer? = null
    /** PK Battle right tile — challenger's incoming video. `null` until [onCreate]. */
    private var pkChallengerView: SurfaceViewRenderer? = null
    /** PK host: fan-out to `live_publishers/{hostStream}/{hostUid}` so solo viewers keep host video during PK. */
    private var pkHostSpectatorFanout: PkHostSpectatorFanout? = null
    /** PK guest: second RTDB fan-out to `live_publishers` so Live-tab viewers see both cameras. */
    private var pkSpectatorFanout: PkGuestSpectatorFanout? = null

    /** 1:1 video with [BuildConfig.AGORA_APP_ID]: media over Agora RTC, not WebRTC. */
    private var privateVideoUsesAgora: Boolean = false
    private var agoraManager: AgoraManager? = null
    private var agoraObserveJob: Job? = null
    private var agoraTextureFull: TextureView? = null
    private var agoraTexturePip: TextureView? = null
    private var privateAgoraPipShowsLocal: Boolean = true
    private var agoraBoundRemoteUid: Int? = null
    private var agoraStreamerJoinRequested: Boolean = false

    /** PK (battler): split tiles use Agora co-host instead of WebRTC. */
    private var pkVideoUsesAgora: Boolean = false
    private var pkAgoraLeftTexture: TextureView? = null
    private var pkAgoraRightTexture: TextureView? = null
    private var pkAgoraRemoteBindJob: Job? = null

    private var isStreamer = false
    private var roomId: String? = null
    private var isPkSession = false
    /** 1:1 call video; PK always treated as video regardless of this flag. */
    private var isVideoCall = true
    private var teardownHandled = false
    private var callStatus: CallStatus = CallStatus.TIMEOUT
    private lateinit var statusChip: TextView
    private var statusAnimJob: Job? = null
    private var ringTimeoutJob: Job? = null
    private var terminalStatusJob: Job? = null
    private var callResponseListener: ValueEventListener? = null
    /** 1:1 (non-PK): ICE reached connected at least once — used to bill the payer on hang-up. */
    private var oneOnOneCallReachedConnected: Boolean = false
    private var statusPulseDirection = 1
    private var currentPulseAlpha = CallStatusChipSpec.PULSE_MIN_ALPHA
    private val callResponsesRef = FirebaseDatabase.getInstance().reference.child("call_responses")

    private var overlayPeerId: String = ""
    private var overlayPeerName: String = ""
    private var overlayPeerPhoto: String = ""

    private val liveChatMessages = MutableStateFlow<List<LiveStreamChatMessage>>(emptyList())
    private val liveViewerCount = MutableStateFlow(0)
    private val pkHostViewerCountState = MutableStateFlow(0)
    private val pkGuestViewerCountState = MutableStateFlow(0)
    private val pkHostViewerUserIdsState = MutableStateFlow<List<String>>(emptyList())
    private val pkGuestViewerUserIdsState = MutableStateFlow<List<String>>(emptyList())
    private val liveHostProfile = MutableStateFlow<UserProfile?>(null)
    /** PK HUD: current user's profile (challenger name/level on guest device). */
    private val livePkSelfProfileHud = MutableStateFlow<UserProfile?>(null)
    /** PK HUD: opponent battler profile (name/level from Firestore). */
    private val livePkOpponentProfile = MutableStateFlow<UserProfile?>(null)
    private var liveFirestoreOverlayJob: Job? = null
    /** 1:1 `call_*`: remote party ended session in Firestore `calls/{roomId}`. */
    private var callSessionRemoteEndJob: Job? = null
    private var didIncrementViewerAsGuest: Boolean = false
    /** One-shot: audience leaves as soon as Firestore lists us under `kickedUsers`. */
    private var audienceKickEnforcementHandled: Boolean = false
    private val playingGiftOverlay = MutableStateFlow<Gift?>(null)
    private var lastGiftOverlayMessageId: String? = null
    /** Ignore chat gifts older than this so the sender's full-bleed animation is not replaced by a prior gift row. */
    private var lastGiftOverlaySeenTimestampMs: Long = 0L
    /** While set, ignore listener-driven overlay updates (sender just played their own gift locally). */
    private var skipListenerGiftOverlayUntilMs: Long = 0L
    private val pkArenaSession = MutableStateFlow<PkBattleSessionState?>(null)
    /** Firestore `live_streams` doc for PK scoring (host uid). */
    private var pkFirestoreHostDocId: String = ""
    private var pkRoundDurationSeconds: Int = 300
    private val pkFirestoreScoringOpen = MutableStateFlow(true)
    private val pkRematchPending = MutableStateFlow(false)
    private var pkRematchHostListener: ValueEventListener? = null
    private var pkRematchGuestListener: ValueEventListener? = null
    private var pkRematchHostListenerUid: String? = null
    private var pkRematchGuestListenerUid: String? = null
    private val processedPkArenaGiftIds = mutableSetOf<String>()
    /** Only show live chat from this session onward (`timestamp` on message docs). PK / broadcast: wall clock when overlays start. Private `call_*`: [FirebaseService.getCallDocumentCreatedAtMs] from `calls/{roomId}`. */
    private var liveChatSessionCutoffMs: Long = 0L

    /** Mic mute state; true = mic enabled (unmuted). Driven by the overlay Mute button. */
    private val isMicOnFlow = MutableStateFlow(true)
    /** Speaker state; initialised in [startLiveStream] once we know the call type. */
    private val isSpeakerOnFlow = MutableStateFlow(true)

    /** Standard 1:1 call: seconds since [CallStatus.CONNECTED] (Firestore overlay strip). */
    private val callElapsedSeconds = MutableStateFlow(0)
    private var callElapsedTickJob: Job? = null
    private val walletDiamondBalance = MutableStateFlow(0)
    private val callDiamondRatePerMinute = MutableStateFlow(VirtualEconomyMath.DEFAULT_CALL_VIDEO_DIAMONDS_PER_MIN)
    /** Chamet-style real-time billing: charges one minute immediately on connect, then every 60 s. */
    private var realtimeBillingJob: Job? = null
    /** Set to true once [startRealtimeCallBilling] runs so [endRegularCallAndReturn] skips the legacy bulk charge. */
    private var realtimeBillingRan = false
    private val callStatusForUi = MutableStateFlow(CallStatus.CONNECTING)
    private val showGiftPickerSheet = MutableStateFlow(false)
    /** PK session: audience / battlers pick host vs guest before sending (gifts drive PK score). */
    private val pkGiftSheetVisible = MutableStateFlow(false)
    private val giftSendInProgress = MutableStateFlow(false)
    /** Challenger: show post-PK interstitial to continue in solo without finishing the activity. */
    private val showPkEndedContinueInterstitial = MutableStateFlow(false)
    /** After challenger taps Continue: use non-PK glass bottom chat and expanded local video. */
    private val pkSoloAfterBattleChrome = MutableStateFlow(false)
    @Volatile
    private var ignoreNextPeerDisconnectForPkSolo = false

    /** Compose-driven full-screen close confirm ([FuturisticConfirmCloseDialog]); replaces legacy Material alert. */
    private val showCloseConfirmDialog = MutableStateFlow(false)
    private var pendingCloseConfirmAction: (() -> Unit)? = null

    private lateinit var liveStreamBinding: ActivityLiveStreamBinding

    private sealed class CallUIState {
        data object Hidden : CallUIState()
        data object Connecting : CallUIState()
        data class Reconnecting(val attempt: Int, val maxAttempts: Int = WebRTCManager.SESSION_FULL_RENEG_MAX_ATTEMPTS) :
            CallUIState()
        data object PeerDisconnected : CallUIState()
        data object CameraUnavailable : CallUIState()
        data object CallFailed : CallUIState()
    }

    private var callUiOverlay: FrameLayout? = null
    private var callUiSpinner: ProgressBar? = null
    private var callUiMessage: TextView? = null
    private var callUiButtonRow: LinearLayout? = null
    private var callUiBtnPrimary: Button? = null
    private var callUiBtnSecondary: Button? = null
    private var currentCallUiState: CallUIState = CallUIState.Hidden

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        // Prevent OS-level screenshots and screen recording; keep display awake during calls / live.
        window.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE or WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
            WindowManager.LayoutParams.FLAG_SECURE or WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
        )

        isStreamer = intent.getBooleanExtra("is_streamer", false)
        roomId = intent.getStringExtra("room_id")?.trim()?.takeIf { it.isNotEmpty() }
        isPkSession = intent.getBooleanExtra(EXTRA_IS_PK_SESSION, false)
        isVideoCall = if (isPkSession) {
            true
        } else {
            intent.getBooleanExtra(EXTRA_IS_VIDEO_CALL, true)
        }
        overlayPeerId = intent.getStringExtra(EXTRA_OVERLAY_PEER_ID)?.trim().orEmpty()
        overlayPeerName = intent.getStringExtra(EXTRA_OVERLAY_PEER_NAME)?.trim().orEmpty()
        overlayPeerPhoto = intent.getStringExtra(EXTRA_OVERLAY_PEER_PHOTO)?.trim().orEmpty()

        if (isPkSession) {
            val myUid = FirebaseAuth.getInstance().currentUser?.uid.orEmpty()
            val hostTeamUid = if (isStreamer) myUid else overlayPeerId
            val guestTeamUid = if (isStreamer) overlayPeerId else myUid
            val battleStart = intent.getLongExtra(EXTRA_PK_BATTLE_START_MS, System.currentTimeMillis())
            pkRoundDurationSeconds = intent.getIntExtra(EXTRA_PK_DURATION_SECONDS, 300).coerceIn(60, 3600)
            pkFirestoreHostDocId = intent.getStringExtra(EXTRA_PK_LIVE_STREAM_DOC_ID)?.trim().orEmpty()
                .ifBlank { hostTeamUid }
            pkArenaSession.value = PkBattleSessionState(
                pkStartTimeMillis = battleStart,
                hostUserId = hostTeamUid,
                guestUserId = guestTeamUid,
                durationSeconds = pkRoundDurationSeconds,
                phase = PkBattlePhase.ACTIVE
            )
        }

        if (roomId.isNullOrBlank()) {
            android.util.Log.e("LiveStreamActivity", "Invalid room_id extra (null or blank), isPk=$isPkSession")
            Toast.makeText(this, getString(R.string.call_room_missing), Toast.LENGTH_SHORT).show()
            finish()
            return
        }

        android.util.Log.i(
            "CALL_CHAT_UI",
            "surface=LiveStreamActivity room=${roomId!!} isPk=$isPkSession isVideoCall=$isVideoCall isStreamer=$isStreamer version=${BuildConfig.VERSION_NAME}(${BuildConfig.VERSION_CODE})"
        )

        // Dismiss the incoming call notification (ID 2001) the moment the call activity opens,
        // whether the user tapped Accept in-app or from the notification action.
        androidx.core.app.NotificationManagerCompat.from(this)
            .cancel(CallFirebaseMessagingService.NOTIF_INCOMING_CALL)

        bindPrivateCallForProcessTeardown(roomId!!, isPkSession)

        liveStreamBinding = ActivityLiveStreamBinding.inflate(layoutInflater)
        setContentView(liveStreamBinding.root)

        localView = liveStreamBinding.localView
        remoteView = liveStreamBinding.remoteView
        pkHostView = liveStreamBinding.pkHostView
        pkChallengerView = liveStreamBinding.pkChallengerView

        val standardContainer = liveStreamBinding.standardCallContainer
        val pkSplitRoot = liveStreamBinding.pkSplitRoot
        val composeTop = liveStreamBinding.composeOverlayTop
        val composeBottom = liveStreamBinding.composeOverlayBottom

        // ── PK: vertical 50% arena (host | guest) + 50% audience (Compose). ───────
        // Standard 1:1: full-screen remote + PIP local; top/bottom compose bands.
        if (isPkSession) {
            pkSplitRoot.visibility = View.VISIBLE
            standardContainer.visibility = View.GONE
            composeTop.visibility = View.GONE
            composeBottom.visibility = View.GONE
            pkHostView?.let { localView = it }
            pkChallengerView?.let { remoteView = it }
            android.util.Log.d("WebRTC_SIGNAL", "PK mode: vertical split arena + audience panel")
        } else {
            pkSplitRoot.visibility = View.GONE
            standardContainer.visibility = View.VISIBLE
            composeTop.visibility = View.VISIBLE
            composeBottom.visibility = View.VISIBLE
        }
        // ─────────────────────────────────────────────────────────────────────────
        setupStatusChip()
        bindComposeOverlays()
        bindGiftOverlay()
        if (isPkSession) {
            bindPkArenaHud()
        }
        window.decorView.post {
            resizeStandardCallBottomOverlayHeightForVideoCall()
            window.decorView.post {
                setupDraggableLocalPreview()
            }
        }

        if (hasWebrtcPermissionsForCallMode()) {
            startLiveStream()
        } else {
            val perms = if (isPkSession || isVideoCall) {
                arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
            } else {
                arrayOf(Manifest.permission.RECORD_AUDIO)
            }
            webrtcPermissionLauncher.launch(perms)
        }
    }

    /**
     * Standard 1:1 video: bottom Compose slot ~**45%** of root height (min **260dp**) so docked chat + messages
     * are not squeezed under the fixed **205dp** cap. No-op for PK or audio-only.
     */
    private fun resizeStandardCallBottomOverlayHeightForVideoCall() {
        if (isPkSession || !isVideoCall) return
        val bottom = liveStreamBinding.composeOverlayBottom
        val frame = bottom.parent as? FrameLayout ?: return
        val parentH = frame.height
        if (parentH <= 0) return
        val minPx = TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            260f,
            resources.displayMetrics,
        ).roundToInt()
        val targetPx = (parentH * 0.45f).roundToInt().coerceAtLeast(minPx)
        val lp = bottom.layoutParams as FrameLayout.LayoutParams
        lp.height = targetPx
        lp.gravity = Gravity.BOTTOM
        bottom.layoutParams = lp
    }

    /**
     * Standard 1:1 layout: draggable PiP; tap PiP or full-screen video swaps feeds
     * ([WebRTCManager.swapCallVideoPipLayout]).
     *
     * PiP stays inside [R.id.standard_call_container] with [CardView] elevation so it composites above the
     * Compose overlays; bottom clearance follows measured [R.id.compose_overlay_bottom] after resize.
     */
    private fun setupDraggableLocalPreview() {
        if (isPkSession) return
        val card = liveStreamBinding.localViewCard
        val parent = card.parent as? FrameLayout ?: return
        val lp = card.layoutParams as FrameLayout.LayoutParams
        lp.gravity = Gravity.TOP or Gravity.START
        fun dp(v: Int) = (v * resources.displayMetrics.density).roundToInt().coerceAtLeast(1)
        val edgeMargin = dp(12)
        /** Top of PIP below [WebRtcOverlayTopBar] + [R.id.compose_overlay_top] margin (~40dp). */
        val minTopMargin = if (isVideoCall) dp(188) else dp(56)
        var bottomClearancePx = dp(300)
        val pipW = dp(120)
        val pipH = dp(160)
        var startRawX = 0f
        var startRawY = 0f
        var startLeft = 0
        var startTop = 0
        val touchSlop = ViewConfiguration.get(this).scaledTouchSlop
        parent.post {
            lp.width = pipW
            lp.height = pipH
            val botH = liveStreamBinding.composeOverlayBottom.let { v ->
                if (v.visibility == View.VISIBLE) v.height.coerceAtLeast(0) else 0
            }
            bottomClearancePx = when {
                botH > 0 -> botH + dp(24)
                else -> dp(300)
            }
            val maxTInit = (parent.height - pipH - bottomClearancePx).coerceAtLeast(minTopMargin)
            lp.leftMargin = (parent.width - pipW - edgeMargin).coerceAtLeast(edgeMargin)
            lp.topMargin = minTopMargin.coerceAtMost(maxTInit)
            card.layoutParams = lp
        }
        fun requestSwap() {
            swapAgoraOrWebRtcPip()
        }
        remoteView.isClickable = true
        remoteView.setOnClickListener { requestSwap() }
        card.setOnTouchListener { v, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    startRawX = e.rawX
                    startRawY = e.rawY
                    startLeft = lp.leftMargin
                    startTop = lp.topMargin
                    v.alpha = 0.94f
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = (e.rawX - startRawX).toInt()
                    val dy = (e.rawY - startRawY).toInt()
                    val maxL = (parent.width - pipW - edgeMargin).coerceAtLeast(edgeMargin)
                    val maxT =
                        (parent.height - pipH - bottomClearancePx).coerceAtLeast(minTopMargin)
                    lp.leftMargin = (startLeft + dx).coerceIn(edgeMargin, maxL)
                    lp.topMargin = (startTop + dy).coerceIn(minTopMargin, maxT)
                    card.layoutParams = lp
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    v.alpha = 1f
                    val dx = abs(e.rawX - startRawX)
                    val dy = abs(e.rawY - startRawY)
                    if (dx < touchSlop && dy < touchSlop) {
                        requestSwap()
                    }
                    true
                }
                else -> false
            }
        }
    }

    private fun bindComposeOverlays() {
        if (isPkSession) {
            val audience = liveStreamBinding.composePkAudience
            audience.setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed)
            audience.setContent {
                LiveStreamComposeTheme(appPrefs) {
                    val showPkGift by pkGiftSheetVisible.collectAsStateWithLifecycle()
                    val walletPk by walletDiamondBalance.collectAsStateWithLifecycle()
                    val giftBusyPk by giftSendInProgress.collectAsStateWithLifecycle()
                    val pkSessionSnap by pkArenaSession.collectAsStateWithLifecycle()
                    val profile by liveHostProfile.collectAsStateWithLifecycle()
                    val myUidPk = FirebaseAuth.getInstance().currentUser?.uid.orEmpty()
                    val hostFallback = stringResource(R.string.live_pk_battler_host_fallback)
                    val guestFallback = stringResource(R.string.live_pk_battler_guest_fallback)
                    val youLabel = stringResource(R.string.live_pk_battler_you)
                    val pkHint = stringResource(R.string.live_pk_gift_counts_for_score)
                    var pkViewerSheet by remember { mutableStateOf<Pair<List<String>, String>?>(null) }
                    val pkHostVc by pkHostViewerCountState.collectAsStateWithLifecycle()
                    val pkGuestVc by pkGuestViewerCountState.collectAsStateWithLifecycle()
                    val pkHostUids by pkHostViewerUserIdsState.collectAsStateWithLifecycle()
                    val pkGuestUids by pkGuestViewerUserIdsState.collectAsStateWithLifecycle()
                    val pkHostChipLabel = stringResource(R.string.live_pk_spectators_chip_host, pkHostVc)
                    val pkGuestChipLabel = stringResource(R.string.live_pk_spectators_chip_challenger, pkGuestVc)
                    val pkSoloAfter by pkSoloAfterBattleChrome.collectAsStateWithLifecycle()
                    val showPkEndOverlay by showPkEndedContinueInterstitial.collectAsStateWithLifecycle()
                    var showArFiltersSheet by remember { mutableStateOf(false) }
                    var showPkToolsSheet by remember { mutableStateOf(false) }
                    var showPkDiamondShopOverlay by remember { mutableStateOf(false) }
                    var selectedArFilter by remember { mutableStateOf(FilterType.NONE) }
                    var snapLenses by remember { mutableStateOf<List<LensesComponent.Lens>>(emptyList()) }
                    var selectedSnapLensId by remember { mutableStateOf<String?>(null) }
                    val pkLensContext = LocalContext.current
                    DisposableEffect(showArFiltersSheet) {
                        if (!showArFiltersSheet) {
                            snapLenses = emptyList()
                            return@DisposableEffect onDispose { }
                        }
                        val gid = BuildConfig.SNAP_LENS_GROUP_ID.trim()
                        if (!BuildConfig.SNAP_CAMERA_KIT_CONFIGURED || gid.isEmpty()) {
                            return@DisposableEffect onDispose { }
                        }
                        val rm = rtcManager ?: return@DisposableEffect onDispose { }
                        val sub = rm.observeSnapLenses(gid) { snapLenses = it }
                        onDispose { sub?.close() }
                    }
                    LaunchedEffect(selectedArFilter, selectedSnapLensId) {
                        val rm = rtcManager ?: return@LaunchedEffect
                        val gid = BuildConfig.SNAP_LENS_GROUP_ID.trim()
                        if (BuildConfig.SNAP_CAMERA_KIT_CONFIGURED && selectedSnapLensId != null && gid.isNotEmpty()) {
                            rm.applySnapLensFromPortal(
                                groupId = gid,
                                lensId = selectedSnapLensId!!,
                                onLoading = {
                                    runOnUiThread {
                                        Toast.makeText(
                                            pkLensContext,
                                            pkLensContext.getString(R.string.snap_lens_downloading_filter),
                                            Toast.LENGTH_SHORT,
                                        ).show()
                                    }
                                },
                                onError = {
                                    runOnUiThread {
                                        Toast.makeText(
                                            pkLensContext,
                                            pkLensContext.getString(R.string.snap_lens_failed_filter),
                                            Toast.LENGTH_SHORT,
                                        ).show()
                                    }
                                },
                            )
                        } else {
                            rm.setFilterType(selectedArFilter)
                        }
                    }
                    Box(Modifier.fillMaxSize().imePadding()) {
                        val overlayChatMessages by liveChatMessages.collectAsStateWithLifecycle()
                        val rematchWaitOverlay by pkRematchPending.collectAsStateWithLifecycle()
                        LaunchedEffect(showPkEndOverlay, pkSessionSnap?.resultPhaseEndsAtMillis) {
                            if (!showPkEndOverlay) return@LaunchedEffect
                            val ends = pkSessionSnap?.resultPhaseEndsAtMillis ?: return@LaunchedEffect
                            if (ends <= 0L) return@LaunchedEffect
                            delay((ends - System.currentTimeMillis()).coerceAtLeast(0L))
                            endPkAndReturn()
                        }
                        Surface(
                            modifier = Modifier.fillMaxSize(),
                            color = MaterialTheme.colorScheme.background
                        ) {
                        Column(Modifier.fillMaxSize()) {
                            val messages = overlayChatMessages
                            val isMicOn by isMicOnFlow.collectAsStateWithLifecycle()
                            val isSpeakerOn by isSpeakerOnFlow.collectAsStateWithLifecycle()
                            val streamDocMod = firestoreLiveStreamAudienceDocId().takeIf { it.isNotEmpty() }
                            val modHostUid = FirebaseAuth.getInstance().currentUser?.uid?.takeIf { it.isNotEmpty() }
                            val pkNeonChrome = pkSessionSnap != null && !pkSoloAfter
                            /** Both battlers use the same right-hand rail (gift / mic / speaker / flip / tools). */
                            val pkNeonBattlerSide = pkNeonChrome || isStreamer || pkSoloAfter
                            WebRtcOverlayBottomChat(
                                messages = messages,
                                onSendMessage = { text -> sendOverlayChatMessage(text) },
                                endCallLabel = getString(R.string.call_end_stream),
                                onEndCall = null,
                                modifier = Modifier
                                    .weight(1f)
                                    .fillMaxWidth(),
                                isMicOn = isMicOn,
                                isSpeakerOn = isSpeakerOn,
                                audiencePanelFillHeight = pkNeonChrome || !isStreamer,
                                pkNeonBattleChrome = pkNeonChrome,
                                pkNeonStreamerSide = pkNeonBattlerSide,
                                floatingLiveChatOverlay = isStreamer && !pkNeonChrome,
                                isVideoCall = true,
                                pkStreamerPanelViewersLabel = null,
                                onPkStreamerPanelClose = null,
                                pkBottomViewerChipLabel = null,
                                onPkBottomViewerChipClick = null,
                                pkHostSpectatorsLabel = if (pkNeonChrome) pkHostChipLabel else null,
                                pkGuestSpectatorsLabel = if (pkNeonChrome) pkGuestChipLabel else null,
                                onPkHostSpectatorsClick = if (pkNeonChrome) {
                                    { pkViewerSheet = pkHostUids to pkHostChipLabel }
                                } else null,
                                onPkGuestSpectatorsClick = if (pkNeonChrome) {
                                    { pkViewerSheet = pkGuestUids to pkGuestChipLabel }
                                } else null,
                                pkAllSpectatorsSummaryLine = null,
                                onPkAllSpectatorsClick = null,
                                onFlipCamera = {
                                    val am = agoraManager
                                    if (pkVideoUsesAgora && am != null) {
                                        runCatching { am.switchCamera() }
                                            .onFailure { e ->
                                                android.util.Log.w("LiveStreamActivity", "switchCamera PK Agora", e)
                                            }
                                    } else {
                                        val rm = rtcManager
                                        if (rm != null) {
                                            runCatching { rm.switchCamera() }
                                                .onFailure { e ->
                                                    android.util.Log.w("LiveStreamActivity", "switchCamera PK", e)
                                                }
                                        }
                                    }
                                },
                                flipCameraEnabled = true,
                                onToggleMic = { enabled ->
                                    isMicOnFlow.value = enabled
                                    val am = agoraManager
                                    if (pkVideoUsesAgora && am != null) {
                                        am.muteLocalAudioStream(!enabled)
                                    } else {
                                        rtcManager?.setAudioEnabled(enabled)
                                    }
                                },
                                onToggleSpeaker = { speakerOn ->
                                    isSpeakerOnFlow.value = speakerOn
                                    WebRTCManager.applyLivePlaybackSpeakerMode(
                                        getSystemService(AUDIO_SERVICE) as AudioManager,
                                        preferLoudSpeaker = speakerOn,
                                    )
                                },
                                onOpenGiftSheet = { pkGiftSheetVisible.value = true },
                                onOpenDiamondShop = null,
                                onOpenArFilters = if (!pkNeonChrome && !isStreamer) {
                                    { showArFiltersSheet = true }
                                } else null,
                                onOpenPkToolsMenu = if (pkNeonChrome) { { showPkToolsSheet = true } } else null,
                                giftActionInProgress = giftBusyPk,
                                liveStreamDocIdForModeration = if (isStreamer) streamDocMod else null,
                                streamHostUserIdForModeration = if (isStreamer) modHostUid else null,
                                currentUserIdForModeration = modHostUid,
                                onKickLiveChatter = if (isStreamer && streamDocMod != null) {
                                    { tid ->
                                        lifecycleScope.launch {
                                            runCatching { firebaseService.addUserToLiveStreamKickedList(streamDocMod, tid) }
                                                .onFailure { e ->
                                                    android.util.Log.w("LiveStreamActivity", "kick from overlay", e)
                                                }
                                        }
                                    }
                                } else null,
                                onBlockLiveChatter = if (isStreamer && streamDocMod != null && modHostUid != null) {
                                    { tid ->
                                        lifecycleScope.launch {
                                            runCatching {
                                                firebaseService.addUserToLiveStreamKickedList(streamDocMod, tid)
                                                firebaseService.addBlockedUserForHost(modHostUid, tid)
                                            }.onFailure { e ->
                                                android.util.Log.w("LiveStreamActivity", "block from overlay", e)
                                            }
                                        }
                                    }
                                } else null,
                                onLikeLiveChatter = if (isStreamer && streamDocMod != null) {
                                    { tid, _ ->
                                        val liker = FirebaseAuth.getInstance().currentUser?.uid
                                        if (liker != null) {
                                            lifecycleScope.launch {
                                                runCatching { firebaseService.toggleDiscoveryProfileLike(liker, tid.trim()) }
                                                    .onFailure { e ->
                                                        android.util.Log.w("LiveStreamActivity", "like from overlay", e)
                                                    }
                                            }
                                        }
                                    }
                                } else null,
                                showComplianceBanner = true,
                                bottomSheetComposer = !pkNeonChrome,
                            )
                        }
                        }
                        if (showPkEndOverlay && !isStreamer) {
                            pkSessionSnap?.takeIf { it.battleEnded && it.outcome != null }?.let { snap ->
                                Box(
                                    modifier = Modifier
                                        .fillMaxSize()
                                        .zIndex(80f)
                                ) {
                                    PkArenaEndCard(
                                        session = snap,
                                        modifier = Modifier.fillMaxSize(),
                                        showChallengerPostPkActions = true,
                                        challengerContinueLabel = stringResource(R.string.pk_ended_host_continue),
                                        challengerFindAnotherLabel = stringResource(R.string.pk_find_another_opponent),
                                        onChallengerContinueSolo = { dismissChallengerPkContinueSolo() },
                                        onChallengerFindAnother = { challengerFindAnotherOpponent() },
                                        mvpViewerPhotoUrls = pkMvpSupporterPhotoUrls(
                                            messages = overlayChatMessages,
                                            hostUserId = snap.hostUserId,
                                            senderPhotoLookup = { uid ->
                                                when {
                                                    uid == overlayPeerId.trim() ->
                                                        overlayPeerPhoto.takeIf { it.isNotBlank() }
                                                    uid == myUidPk ->
                                                        profile?.photoUrl?.takeIf { it.isNotBlank() }
                                                    else -> null
                                                }
                                            },
                                            giftPriceLookup = { id ->
                                                availableGifts.find { it.id == id }?.price?.coerceAtLeast(0)
                                                    ?: 0
                                            },
                                        ),
                                    )
                                }
                            }
                        }
                        if (showPkEndOverlay && isStreamer && isPkSession) {
                            pkSessionSnap?.takeIf { it.battleEnded && it.outcome != null }?.let { snap ->
                                val peerTrim = overlayPeerId.trim()
                                Box(
                                    modifier = Modifier
                                        .fillMaxSize()
                                        .zIndex(80f),
                                ) {
                                    PkArenaEndCard(
                                        session = snap,
                                        modifier = Modifier.fillMaxSize(),
                                        showRematchForHost = true,
                                        showFindAnotherForHost = true,
                                        rematchPending = rematchWaitOverlay,
                                        rematchWaitingLabel = stringResource(R.string.pk_rematch_waiting_guest),
                                        onRematchChallenge = { challengePkRematchFromActivity() },
                                        onFindAnotherOpponent = { hostFindAnotherRandomPkOpponent() },
                                        mvpViewerPhotoUrls = pkMvpSupporterPhotoUrls(
                                            messages = overlayChatMessages,
                                            hostUserId = snap.hostUserId,
                                            senderPhotoLookup = { uid ->
                                                when {
                                                    uid == peerTrim ->
                                                        overlayPeerPhoto.takeIf { it.isNotBlank() }
                                                    uid == myUidPk ->
                                                        profile?.photoUrl?.takeIf { it.isNotBlank() }
                                                    else -> null
                                                }
                                            },
                                            giftPriceLookup = { id ->
                                                availableGifts.find { it.id == id }?.price?.coerceAtLeast(0)
                                                    ?: 0
                                            },
                                        ),
                                    )
                                }
                            }
                        }
                        if (showArFiltersSheet) {
                            ArFilterBottomSheet(
                                snapLenses = snapLenses,
                                selectedSnapLensId = selectedSnapLensId,
                                onDismiss = { showArFiltersSheet = false },
                                onFilterSelected = { filterType ->
                                    // Dismiss sheet first so its gradient circle swatches
                                    // are removed from the Compose layer before the filter
                                    // is applied to the video frame.
                                    showArFiltersSheet = false
                                    selectedSnapLensId = null
                                    selectedArFilter = filterType
                                },
                                onSnapLensSelected = { lens ->
                                    showArFiltersSheet = false
                                    if (lens != null) {
                                        selectedSnapLensId = lens.id
                                        selectedArFilter = FilterType.NONE
                                    } else {
                                        selectedSnapLensId = null
                                    }
                                },
                            )
                        }
                        if (showPkToolsSheet) {
                            PkToolsMenuSheet(
                                onDismiss = { showPkToolsSheet = false },
                                onDiamondStore = { showPkDiamondShopOverlay = true },
                                onFaceFilters = null,
                            )
                        }
                        if (showPkDiamondShopOverlay) {
                            DiamondShopPopup(
                                uiState = DatingUiState(coinBalance = walletPk),
                                onDismiss = { showPkDiamondShopOverlay = false },
                                onBuyDiamonds = {
                                    runOnUiThread {
                                        Toast.makeText(
                                            this@LiveStreamActivity,
                                            getString(R.string.teaser_paywall_contact_reseller),
                                            Toast.LENGTH_LONG
                                        ).show()
                                    }
                                }
                            )
                        }
                        pkViewerSheet?.let { (uids, title) ->
                            LiveWatchingViewersSheet(
                                viewerUids = uids,
                                uiState = DatingUiState(),
                                currentUserId = myUidPk,
                                sheetTitle = title,
                                onDismiss = { pkViewerSheet = null },
                                onOpenViewerProfile = {
                                    pkViewerSheet = null
                                    runOnUiThread {
                                        Toast.makeText(
                                            this@LiveStreamActivity,
                                            it.name.ifBlank { getString(R.string.live_pk_battler_guest_fallback) },
                                            Toast.LENGTH_SHORT
                                        ).show()
                                    }
                                },
                                onFollowViewer = { },
                            )
                        }
                        if (showPkGift && pkSessionSnap != null) {
                            val s = pkSessionSnap!!
                            val hostUid = s.hostUserId.trim()
                            val guestUid = s.guestUserId.trim()
                            val hostName = profile?.takeIf { it.id == hostUid }?.name?.trim().orEmpty()
                                .ifBlank {
                                    when {
                                        hostUid == myUidPk -> FirebaseAuth.getInstance().currentUser?.displayName?.trim().orEmpty()
                                        hostUid == overlayPeerId.trim() -> overlayPeerName.trim()
                                        else -> ""
                                    }
                                }
                                .ifBlank { hostFallback }
                            val guestName = when {
                                guestUid == myUidPk ->
                                    FirebaseAuth.getInstance().currentUser?.displayName?.trim().orEmpty().ifBlank { youLabel }
                                guestUid == overlayPeerId.trim() -> overlayPeerName.trim()
                                else -> ""
                            }.ifBlank { guestFallback }
                            val pkRecipients = listOf(hostUid to hostName, guestUid to guestName)
                                .filter { it.first.isNotBlank() }
                                .distinctBy { it.first }
                            LaunchedEffect(showPkGift, hostUid, guestUid) {
                                if (showPkGift && hostUid.isBlank() && guestUid.isBlank()) {
                                    pkGiftSheetVisible.value = false
                                }
                            }
                            if (pkRecipients.isNotEmpty()) {
                                GiftSelectionSheet(
                                    gifts = availableGifts,
                                    coinBalance = walletPk,
                                    isProcessing = giftBusyPk,
                                    pkGiftScoreHint = pkHint,
                                    onTopUpCoins = {
                                        runOnUiThread {
                                            Toast.makeText(
                                                this@LiveStreamActivity,
                                                getString(R.string.teaser_paywall_contact_reseller),
                                                Toast.LENGTH_LONG
                                            ).show()
                                        }
                                    },
                                    onDismiss = { pkGiftSheetVisible.value = false },
                                    onSend = { _, _ -> },
                                    pkBattlerRecipients = pkRecipients,
                                    onSendGiftToPkBattler = { uid, g, c -> sendPkBattleAudienceGift(uid, g, c) },
                                    onLuckySend = { a, b, c -> processLuckyGiftsCloud(a, b, c) },
                                    onLuckyGiftVisual = { g, rid, qty, tx ->
                                        postLuckyGiftVisualAfterLucky(g, rid, qty, tx)
                                    },
                                )
                            }
                        }
                    }
                }
            }
            return
        }
        val top = liveStreamBinding.composeOverlayTop
        val bottom = liveStreamBinding.composeOverlayBottom
        top.setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed)
        bottom.setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed)
        top.setContent {
            LiveStreamComposeTheme(appPrefs) {
                val profile by liveHostProfile.collectAsStateWithLifecycle()
                val viewers by liveViewerCount.collectAsStateWithLifecycle()
                val elapsedTop by callElapsedSeconds.collectAsStateWithLifecycle()
                val walletTop by walletDiamondBalance.collectAsStateWithLifecycle()
                val rateTop by callDiamondRatePerMinute.collectAsStateWithLifecycle()
                val displayName = profile?.name?.takeIf { it.isNotBlank() } ?: overlayPeerName
                val avatar = profile?.photoUrl?.takeIf { it.isNotBlank() } ?: overlayPeerPhoto
                val followers = (profile?.likeMeCount ?: 0L).toInt()
                val itzoStandardVideoCall = !isPkSession && isVideoCall
                val currentUidForLike = remember {
                    com.google.firebase.auth.FirebaseAuth.getInstance().currentUser?.uid.orEmpty()
                }
                // Like state — seeded from PARTNER's profile (not liveHostProfile, which can be the
                // caller's own doc when isStreamer=true). Updated from the Firestore return value
                // after every tap so UI and database always agree.
                var partnerIsLiked by remember { mutableStateOf(false) }
                // One-time read: fetch partner's likedByUserIds to show correct heart on call open.
                LaunchedEffect(overlayPeerId, currentUidForLike) {
                    if (!itzoStandardVideoCall) return@LaunchedEffect
                    if (overlayPeerId.isBlank() || currentUidForLike.isBlank()) return@LaunchedEffect
                    runCatching {
                        firebaseService.getUserProfile(overlayPeerId.trim())
                    }.onSuccess { partnerProfile ->
                        partnerIsLiked = partnerProfile?.likedByUserIds
                            ?.contains(currentUidForLike) == true
                    }.onFailure { e ->
                        android.util.Log.w("LiveStreamActivity", "like init read failed", e)
                    }
                }
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .statusBarsPadding()
                        .displayCutoutPadding()
                        .padding(top = if (itzoStandardVideoCall) 0.dp else 4.dp),
                ) {
                    WebRtcOverlayTopBar(
                        displayName = displayName,
                        avatarUrl = avatar,
                        likeCount = followers,
                        viewerCount = viewers,
                        showBroadcastMetrics = isPkSession,
                        sessionElapsedSeconds = elapsedTop,
                        onLeaveStream = { confirmUserCloseThen { endRegularCallAndReturn() } },
                        itzoVideoCallBar = itzoStandardVideoCall,
                        onMinimizeCall = if (itzoStandardVideoCall) {
                            { moveTaskToBack(true) }
                        } else {
                            null
                        },
                        // Like button: optimistic flip → Firestore write → confirmed state from return value.
                        onLikePartner = if (itzoStandardVideoCall && overlayPeerId.isNotBlank() && currentUidForLike.isNotBlank()) {
                            {
                                val before = partnerIsLiked
                                partnerIsLiked = !before          // optimistic flip
                                lifecycleScope.launch {
                                    firebaseService.toggleDiscoveryProfileLike(
                                        currentUidForLike,
                                        overlayPeerId.trim(),
                                    ).onSuccess { nowLiked ->
                                        partnerIsLiked = nowLiked // truth from Firestore
                                        android.util.Log.d("LiveStreamActivity", "like partner nowLiked=$nowLiked")
                                    }.onFailure { e ->
                                        partnerIsLiked = before   // revert on error
                                        android.util.Log.w("LiveStreamActivity", "like partner failed", e)
                                    }
                                }
                            }
                        } else null,
                        partnerIsLiked = partnerIsLiked,
                        // Show live diamond balance chip on payer side only
                        payerDiamondBalance = if (itzoStandardVideoCall && isStreamer) walletTop else -1,
                        payerDiamondRatePerMinute = if (itzoStandardVideoCall && isStreamer) rateTop else 0,
                    )
                }
            }
        }
        bottom.setContent {
            LiveStreamComposeTheme(appPrefs) {
                val messages by liveChatMessages.collectAsStateWithLifecycle()
                val isMicOn by isMicOnFlow.collectAsStateWithLifecycle()
                val isSpeakerOn by isSpeakerOnFlow.collectAsStateWithLifecycle()
                val wallet by walletDiamondBalance.collectAsStateWithLifecycle()
                val uiCallStatus by callStatusForUi.collectAsStateWithLifecycle()
                val showGiftPicker by showGiftPickerSheet.collectAsStateWithLifecycle()
                val giftBusy by giftSendInProgress.collectAsStateWithLifecycle()
                val streamDocMod = roomId?.trim()?.takeIf { it.isNotEmpty() }
                val modHostUid = FirebaseAuth.getInstance().currentUser?.uid?.takeIf { it.isNotEmpty() }
                var showDiamondShopOverlay by remember { mutableStateOf(false) }
                LaunchedEffect(Unit) {
                    if (eligibleForAgoraOneToOneVideo()) return@LaunchedEffect
                    var wait = 0
                    while (rtcManager == null && wait < 80) {
                        delay(20)
                        wait++
                    }
                    rtcManager?.setFilterType(FilterType.NONE)
                }
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .navigationBarsPadding()
                        .imePadding()
                ) {
                    WebRtcOverlayBottomChat(
                        messages = messages,
                        onSendMessage = { text -> sendOverlayChatMessage(text) },
                        endCallLabel = getString(R.string.call_end_stream),
                        onEndCall = { confirmUserCloseThen { endRegularCallAndReturn() } },
                        floatingLiveChatOverlay = false,
                        transparentDockPanel = true,
                        itzoStandardCallDock = !isPkSession && isVideoCall,
                        bottomSheetComposer = false,
                        // Bottom overlay resized for video (~45% screen); chat fills the band above controls.
                        audiencePanelFillHeight = isVideoCall,
                        isMicOn = isMicOn,
                        isSpeakerOn = isSpeakerOn,
                        onToggleMic = { enabled ->
                            isMicOnFlow.value = enabled
                            if (privateVideoUsesAgora) {
                                agoraManager?.muteLocalAudioStream(!enabled)
                            } else {
                                rtcManager?.setAudioEnabled(enabled)
                            }
                        },
                        onToggleSpeaker = { speakerOn ->
                            isSpeakerOnFlow.value = speakerOn
                            WebRTCManager.applyLivePlaybackSpeakerMode(
                                getSystemService(AUDIO_SERVICE) as AudioManager,
                                preferLoudSpeaker = speakerOn,
                            )
                        },
                        isVideoCall = isVideoCall,
                        onFlipCamera = if (isVideoCall) {
                            {
                                if (privateVideoUsesAgora) {
                                    runCatching { agoraManager?.switchCamera() }
                                        .onFailure { e ->
                                            android.util.Log.w("LiveStreamActivity", "switchCamera agora", e)
                                        }
                                } else {
                                    runCatching { rtcManager?.switchCamera() }
                                        .onFailure { e ->
                                            android.util.Log.w("LiveStreamActivity", "switchCamera", e)
                                        }
                                }
                            }
                        } else null,
                        flipCameraEnabled = isVideoCall && uiCallStatus == CallStatus.CONNECTED,
                        onOpenGiftSheet = { showGiftPickerSheet.value = true },
                        onOpenDiamondShop = { showDiamondShopOverlay = true },
                        onOpenArFilters = null,
                        giftActionInProgress = giftBusy,
                        liveStreamDocIdForModeration = if (isStreamer) streamDocMod else null,
                        streamHostUserIdForModeration = if (isStreamer) modHostUid else null,
                        currentUserIdForModeration = modHostUid,
                        onKickLiveChatter = if (isStreamer && streamDocMod != null) {
                            { tid ->
                                lifecycleScope.launch {
                                    runCatching { firebaseService.addUserToLiveStreamKickedList(streamDocMod, tid) }
                                        .onFailure { e ->
                                            android.util.Log.w("LiveStreamActivity", "kick from overlay", e)
                                        }
                                }
                            }
                        } else null,
                        onBlockLiveChatter = if (isStreamer && streamDocMod != null && modHostUid != null) {
                            { tid ->
                                lifecycleScope.launch {
                                    runCatching {
                                        firebaseService.addUserToLiveStreamKickedList(streamDocMod, tid)
                                        firebaseService.addBlockedUserForHost(modHostUid, tid)
                                    }.onFailure { e ->
                                        android.util.Log.w("LiveStreamActivity", "block from overlay", e)
                                    }
                                }
                            }
                        } else null,
                        onLikeLiveChatter = if (isStreamer && streamDocMod != null) {
                            { tid, _ ->
                                val liker = FirebaseAuth.getInstance().currentUser?.uid
                                if (liker != null) {
                                    lifecycleScope.launch {
                                        runCatching { firebaseService.toggleDiscoveryProfileLike(liker, tid.trim()) }
                                            .onFailure { e ->
                                                android.util.Log.w("LiveStreamActivity", "like from overlay", e)
                                            }
                                    }
                                }
                            }
                        } else null,
                        showComplianceBanner = true,
                    )
                    if (showDiamondShopOverlay) {
                        DiamondShopPopup(
                            uiState = DatingUiState(coinBalance = wallet),
                            onDismiss = { showDiamondShopOverlay = false },
                            onBuyDiamonds = {
                                runOnUiThread {
                                    Toast.makeText(
                                        this@LiveStreamActivity,
                                        getString(R.string.teaser_paywall_contact_reseller),
                                        Toast.LENGTH_LONG
                                    ).show()
                                }
                            }
                        )
                    }
                    if (showGiftPicker) {
                        GiftSelectionSheet(
                            gifts = availableGifts,
                            coinBalance = wallet,
                            isProcessing = giftBusy,
                            onTopUpCoins = {
                                runOnUiThread {
                                    Toast.makeText(
                                        this@LiveStreamActivity,
                                        getString(R.string.teaser_paywall_contact_reseller),
                                        Toast.LENGTH_LONG
                                    ).show()
                                }
                            },
                            onDismiss = { showGiftPickerSheet.value = false },
                            onSend = { g, c -> sendLiveCallGift(g, c) },
                            luckyGiftReceiverId = overlayPeerId.trim().takeIf { it.isNotBlank() },
                            onLuckySend = { a, b, c -> processLuckyGiftsCloud(a, b, c) },
                            onLuckyGiftVisual = { g, rid, qty, tx ->
                                postLuckyGiftVisualAfterLucky(g, rid, qty, tx)
                            },
                        )
                    }
                    val showCloseConfirm by showCloseConfirmDialog.collectAsStateWithLifecycle()
                    if (showCloseConfirm) {
                        FuturisticConfirmCloseDialog(
                            onDismissRequest = {
                                showCloseConfirmDialog.value = false
                                pendingCloseConfirmAction = null
                            },
                            onConfirm = {
                                val act = pendingCloseConfirmAction
                                pendingCloseConfirmAction = null
                                showCloseConfirmDialog.value = false
                                act?.invoke()
                            },
                        )
                    }
                }
            }
        }
    }

    private fun bindGiftOverlay() {
        val giftCompose = liveStreamBinding.composeGiftOverlay
        giftCompose.setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed)
        giftCompose.setContent {
            LiveStreamComposeTheme(appPrefs) {
                val playing by playingGiftOverlay.collectAsStateWithLifecycle()
                GiftOverlay(
                    gift = playing,
                    onComplete = { playingGiftOverlay.value = null }
                )
            }
        }
    }

    private fun bindPkArenaHud() {
        val hud = liveStreamBinding.composePkArenaHud
        hud.setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed)
        hud.setContent {
            LiveStreamComposeTheme(appPrefs) {
                val session by pkArenaSession.collectAsStateWithLifecycle()
                val chat by liveChatMessages.collectAsStateWithLifecycle()
                val hostProf by liveHostProfile.collectAsStateWithLifecycle()
                val oppProf by livePkOpponentProfile.collectAsStateWithLifecycle()
                val selfHud by livePkSelfProfileHud.collectAsStateWithLifecycle()
                val rematchWait by pkRematchPending.collectAsStateWithLifecycle()
                val showPkEndHudOverlay by showPkEndedContinueInterstitial.collectAsStateWithLifecycle()
                val myUid = FirebaseAuth.getInstance().currentUser?.uid.orEmpty()
                Box(Modifier.fillMaxSize()) {
                session?.let { s ->
                    val hostFallback = stringResource(R.string.live_pk_battler_host_fallback)
                    val guestFallback = stringResource(R.string.live_pk_battler_guest_fallback)
                    val youLabel = stringResource(R.string.live_pk_battler_you)
                    val authName = FirebaseAuth.getInstance().currentUser?.displayName?.trim().orEmpty()
                    val hostUid = s.hostUserId.trim()
                    val guestUid = s.guestUserId.trim()
                    val peerTrim = overlayPeerId.trim()
                    fun nameForSessionUid(uid: String, isHostSlot: Boolean): String {
                        if (uid.isBlank()) return if (isHostSlot) hostFallback else guestFallback
                        val fromHostProf = hostProf?.takeIf { it.id == uid }?.name?.trim().orEmpty()
                        val fromOpp = oppProf?.takeIf { it.id == uid }?.name?.trim().orEmpty()
                        val fromSelf = selfHud?.takeIf { it.id == uid }?.name?.trim().orEmpty()
                        return fromHostProf.ifBlank {
                            fromOpp.ifBlank {
                                fromSelf.ifBlank {
                                    when {
                                        uid == myUid -> authName
                                        uid == peerTrim -> overlayPeerName.trim()
                                        else -> ""
                                    }
                                }
                            }
                        }.ifBlank {
                            if (isHostSlot) hostFallback else guestFallback
                        }
                    }
                    fun levelForSessionUid(uid: String): Int {
                        val lp = listOfNotNull(
                            hostProf?.takeIf { it.id == uid },
                            oppProf?.takeIf { it.id == uid },
                            selfHud?.takeIf { it.id == uid }
                        ).firstOrNull()
                        return lp?.level?.coerceAtLeast(1) ?: 1
                    }
                    var hostBattlerName = nameForSessionUid(hostUid, isHostSlot = true)
                    var guestBattlerName = nameForSessionUid(guestUid, isHostSlot = false)
                    if (guestUid != hostUid &&
                        hostBattlerName.isNotBlank() &&
                        guestBattlerName == hostBattlerName
                    ) {
                        guestBattlerName = selfHud?.name?.trim().orEmpty()
                            .ifBlank { authName }
                            .ifBlank { youLabel }
                    }
                    val hostLvl = levelForSessionUid(hostUid)
                    val guestLvl = levelForSessionUid(guestUid)
                    PkArenaHud(
                        session = s,
                        modifier = Modifier.zIndex(0f),
                        onTimerFinished = { finalizePkArenaTimer() },
                        liveChatMessages = chat,
                        liveChatSenderPhotoLookup = { uid ->
                            when {
                                uid == overlayPeerId -> overlayPeerPhoto.takeIf { it.isNotBlank() }
                                uid == myUid -> {
                                    val iAmHost = myUid == s.hostUserId
                                    (if (iAmHost) hostProf?.photoUrl else selfHud?.photoUrl)
                                        ?.takeIf { it.isNotBlank() }
                                }
                                else -> null
                            }
                        },
                        showRematchForHost = isPkSession && isStreamer,
                        showFindAnotherForHost = isPkSession && isStreamer,
                        rematchPending = rematchWait,
                        rematchWaitingLabel = stringResource(R.string.pk_rematch_waiting_guest),
                        onRematchChallenge = { challengePkRematchFromActivity() },
                        onFindAnotherOpponent = { hostFindAnotherRandomPkOpponent() },
                        suppressPostPkEndCard = isStreamer &&
                            showPkEndHudOverlay &&
                            s.battleEnded &&
                            s.outcome != null,
                        hostDisplayName = hostBattlerName,
                        guestDisplayName = guestBattlerName,
                        hostLevel = hostLvl,
                        guestLevel = guestLvl,
                        hostOnLeft = myUid == hostUid,
                        giftPriceLookup = { id ->
                            availableGifts.find { it.id == id }?.price?.coerceAtLeast(0) ?: 0
                        },
                    )
                }
                if (isPkSession) {
                    IconButton(
                        onClick = { confirmUserCloseThen { endPkAndReturn() } },
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .zIndex(4f)
                            .statusBarsPadding()
                            .padding(8.dp)
                            .clip(CircleShape)
                            .background(Color.Black.copy(alpha = 0.45f))
                    ) {
                        Icon(
                            imageVector = Icons.Default.Close,
                            contentDescription = getString(R.string.live_leave_stream_cd),
                            tint = Color.White
                        )
                    }
                    val showCloseConfirmPk by showCloseConfirmDialog.collectAsStateWithLifecycle()
                    if (showCloseConfirmPk) {
                        FuturisticConfirmCloseDialog(
                            onDismissRequest = {
                                showCloseConfirmDialog.value = false
                                pendingCloseConfirmAction = null
                            },
                            onConfirm = {
                                val act = pendingCloseConfirmAction
                                pendingCloseConfirmAction = null
                                showCloseConfirmDialog.value = false
                                act?.invoke()
                            },
                        )
                    }
                }
                }
            }
        }
    }

    private fun detachPkRematchHostOnly() {
        pkRematchHostListenerUid?.let { uid ->
            pkRematchHostListener?.let { firebaseService.removePkMatchListener(uid, it) }
        }
        pkRematchHostListener = null
        pkRematchHostListenerUid = null
    }

    private fun detachPkRematchGuestOnly() {
        pkRematchGuestListenerUid?.let { uid ->
            pkRematchGuestListener?.let { firebaseService.removePkMatchListener(uid, it) }
        }
        pkRematchGuestListener = null
        pkRematchGuestListenerUid = null
    }

    private fun detachPkRematchListenersActivity() {
        detachPkRematchHostOnly()
        detachPkRematchGuestOnly()
    }

    private fun challengePkRematchFromActivity() {
        val s = pkArenaSession.value ?: return
        if (!s.battleEnded || s.outcome == null || !isStreamer || !isPkSession) return
        val my = FirebaseAuth.getInstance().currentUser?.uid ?: return
        val hostUid = s.hostUserId
        val guestUid = s.guestUserId
        if (my != hostUid || guestUid.isBlank()) return
        val room = firebaseService.buildPkRoomId(hostUid, guestUid)
        val dur = s.durationSeconds.coerceIn(60, 3600)
        if (pkRematchPending.value) return
        pkRematchPending.value = true
        lifecycleScope.launch {
            runCatching { firebaseService.clearPkMatchSignal(hostUid) }
            runCatching { firebaseService.clearPkMatchSignal(guestUid) }
            val ok = runCatching {
                firebaseService.postPkRematchInvite(
                    guestUid = guestUid,
                    roomId = room,
                    hostUid = hostUid,
                    hostStreamId = hostUid,
                    durationSeconds = dur
                )
            }.isSuccess
            if (!ok) {
                pkRematchPending.value = false
                return@launch
            }
            attachPkRematchHostListenerActivity(hostUid, guestUid, room, dur)
            delay(60_000)
            if (pkRematchPending.value) {
                detachPkRematchHostOnly()
                pkRematchPending.value = false
            }
        }
    }

    private fun attachPkRematchHostListenerActivity(
        hostUid: String,
        guestUid: String,
        roomId: String,
        durationSeconds: Int
    ) {
        detachPkRematchHostOnly()
        val listener = object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                val v = snapshot.value as? Map<*, *> ?: return
                if (v["rematchAck"] != true) return
                if (v["partnerUserId"]?.toString()?.trim() != guestUid) return
                val ackRoom = v["roomId"]?.toString()?.trim().orEmpty().ifBlank { roomId }
                val dur = (v["durationSeconds"] as? Number)?.toInt()?.coerceIn(60, 3600) ?: durationSeconds
                detachPkRematchHostOnly()
                lifecycleScope.launch {
                    runCatching { firebaseService.clearPkMatchSignal(hostUid) }
                }
                pkRematchPending.value = false
                pkRoundDurationSeconds = dur
                val battleStart = System.currentTimeMillis()
                processedPkArenaGiftIds.clear()
                pkFirestoreScoringOpen.value = true
                pkArenaSession.value = PkBattleSessionState(
                    pkStartTimeMillis = battleStart,
                    hostUserId = hostUid,
                    guestUserId = guestUid,
                    durationSeconds = dur,
                    phase = PkBattlePhase.ACTIVE
                )
                runOnUiThread { restorePkSplitArenaLayout() }
                lifecycleScope.launch {
                    runCatching {
                        firebaseService.publishLiveStreamPkBattle(
                            hostUid = hostUid,
                            guestUid = guestUid,
                            hostDisplayName = liveHostProfile.value?.name?.trim().orEmpty()
                                .ifBlank { getString(R.string.live_pk_battler_host_fallback) },
                            guestDisplayName = overlayPeerName.trim().ifBlank { getString(R.string.live_pk_battler_guest_fallback) },
                            durationSeconds = dur,
                            resetBeanTotals = true
                        )
                    }
                }
            }

            override fun onCancelled(error: DatabaseError) {}
        }
        pkRematchHostListener = listener
        pkRematchHostListenerUid = hostUid
        firebaseService.addPkMatchListener(hostUid, listener)
    }

    private fun maybeAttachPkRematchGuestListenerActivity() {
        if (!isPkSession) return
        val s = pkArenaSession.value ?: return
        if (!s.battleEnded || s.phase != PkBattlePhase.FINISHED || s.outcome == null) return
        val my = FirebaseAuth.getInstance().currentUser?.uid ?: return
        if (my != s.guestUserId) return
        attachPkRematchGuestListenerActivity(s.hostUserId)
    }

    private fun attachPkRematchGuestListenerActivity(expectedHostUid: String) {
        val guestUid = FirebaseAuth.getInstance().currentUser?.uid ?: return
        detachPkRematchGuestOnly()
        val listener = object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                val v = snapshot.value as? Map<*, *> ?: return
                if (v["isRematch"] != true) return
                val host = v["partnerUserId"]?.toString()?.trim().orEmpty()
                if (host != expectedHostUid) return
                val rid = v["roomId"]?.toString()?.trim().orEmpty()
                if (rid.isBlank()) return
                val dur = (v["durationSeconds"] as? Number)?.toInt()?.coerceIn(60, 3600) ?: 300
                detachPkRematchGuestOnly()
                lifecycleScope.launch {
                    runCatching {
                        firebaseService.postPkRematchAck(
                            hostUid = host,
                            roomId = rid,
                            guestUid = guestUid,
                            guestStreamId = guestUid,
                            durationSeconds = dur
                        )
                    }
                    runCatching { firebaseService.clearPkMatchSignal(guestUid) }
                }
                pkRoundDurationSeconds = dur
                processedPkArenaGiftIds.clear()
                pkFirestoreScoringOpen.value = true
                pkArenaSession.value = PkBattleSessionState(
                    pkStartTimeMillis = System.currentTimeMillis(),
                    hostUserId = host,
                    guestUserId = guestUid,
                    durationSeconds = dur,
                    phase = PkBattlePhase.ACTIVE
                )
                runOnUiThread { restorePkSplitArenaLayout() }
            }

            override fun onCancelled(error: DatabaseError) {}
        }
        pkRematchGuestListener = listener
        pkRematchGuestListenerUid = guestUid
        firebaseService.addPkMatchListener(guestUid, listener)
    }

    private fun finalizePkArenaTimer() {
        val cur = pkArenaSession.value ?: return
        if (cur.battleEnded || cur.phase != PkBattlePhase.ACTIVE) return
        val total = cur.hostBeansEarned + cur.guestBeansEarned
        val ratio =
            if (total <= 0L) 0.5f else cur.hostBeansEarned.toFloat() / total.toFloat()
        val my = FirebaseAuth.getInstance().currentUser?.uid.orEmpty()
        val mine = if (my == cur.hostUserId) cur.hostBeansEarned else cur.guestBeansEarned
        val theirs = if (my == cur.hostUserId) cur.guestBeansEarned else cur.hostBeansEarned
        val outcome = when {
            mine > theirs -> PkBattleOutcome.VICTORY
            mine < theirs -> PkBattleOutcome.DEFEAT
            else -> PkBattleOutcome.DRAW
        }
        val lingerEnds = System.currentTimeMillis() + PK_POST_RESULT_LINGER_MS
        pkArenaSession.value = cur.copy(
            battleEnded = true,
            frozenTugRatio = ratio,
            outcome = outcome,
            phase = PkBattlePhase.FINISHED,
            resultPhaseEndsAtMillis = lingerEnds
        )
        val streamDoc = pkFirestoreHostDocId.ifBlank { cur.hostUserId }
        val guestUidClose = cur.guestUserId.trim()
        if (streamDoc.isNotBlank()) {
            lifecycleScope.launch {
                runCatching { firebaseService.closePkBattleScoringForBattle(streamDoc, guestUidClose) }
            }
        }
        maybeAttachPkRematchGuestListenerActivity()
        showPkEndedContinueInterstitial.value = true
        if (isPkSession && isStreamer) {
            runOnUiThread {
                applyPkArenaSingleTileLayout()
                applyPkSoloFullScreenArenaLayout()
                // Match challenger post-PK: solo glass chat + full-width arena (pkNeonChrome uses !pkSoloAfter).
                pkSoloAfterBattleChrome.value = true
            }
            lifecycleScope.launch {
                delay(320)
                if (rtcManager != null) {
                    runCatching { rtcManager!!.refreshVideoSinkAttachments("pk_host_finalize_timer_solo") }
                }
            }
        }
    }

    private fun processPkArenaGiftsIfNeeded(list: List<LiveStreamChatMessage>) {
        if (!isPkSession) return
        val pk0 = pkArenaSession.value ?: return
        if (pk0.battleEnded || pk0.phase != PkBattlePhase.ACTIVE) return
        if (!pkFirestoreScoringOpen.value) return
        var h = pk0.hostBeansEarned
        var g = pk0.guestBeansEarned
        var touched = false
        for (m in list) {
            if (m.type != "gift" || m.id.isBlank()) continue
            if (!processedPkArenaGiftIds.add(m.id)) continue
            val recip = m.giftRecipientId.trim()
            if (recip.isBlank()) continue
            val fromCatalog = availableGifts.firstOrNull { gift ->
                gift.id == m.giftId ||
                    (
                        !m.giftImageUrl.isNullOrBlank() &&
                            (gift.thumbnailUrl == m.giftImageUrl || gift.videoUrl == m.giftImageUrl)
                        ) ||
                    (!m.giftVideoUrl.isNullOrBlank() && gift.videoUrl == m.giftVideoUrl)
            }
            val resolved = (fromCatalog ?: Gift(
                id = m.giftId,
                name = m.giftName.ifBlank { m.text },
                price = 0,
                thumbnailUrl = m.giftImageUrl.orEmpty(),
                videoUrl = m.giftVideoUrl.orEmpty(),
                soundUrl = m.giftSoundUrl.orEmpty(),
                category = if (!m.giftVideoUrl.isNullOrBlank() || !m.giftSoundUrl.isNullOrBlank()) "CRM_PREMIUM" else "STANDARD",
                isCrmGift = !m.giftVideoUrl.isNullOrBlank() || !m.giftSoundUrl.isNullOrBlank(),
                displayDurationSeconds = m.giftDisplayDurationSeconds.coerceIn(0, 12)
            )).withMergedLiveGiftMessage(m)
            val count = m.giftCount.coerceAtLeast(1)
            val totalCost = (resolved.price.toLong() * count).coerceAtLeast(0L)
            if (totalCost <= 0L) continue
            val beans = VirtualEconomyMath.giftReceiverBeansEarned(totalCost, resolved)
            if (beans <= 0L) continue
            when (recip) {
                pk0.hostUserId -> {
                    h += beans
                    touched = true
                }
                pk0.guestUserId -> {
                    g += beans
                    touched = true
                }
            }
        }
        if (touched) {
            pkArenaSession.value = pk0.copy(hostBeansEarned = h, guestBeansEarned = g)
        }
    }

    private fun hostUserIdForProfile(): String {
        val my = FirebaseAuth.getInstance().currentUser?.uid.orEmpty()
        if (isStreamer) return my
        val peer = overlayPeerId.trim()
        if (peer.isNotEmpty()) return peer
        // PK guest: stream + chat doc belong to the live host; never fall back to "my" or we load the
        // challenger into liveHostProfile and duplicate names on both tiles.
        if (isPkSession) {
            val hostFromSession = pkArenaSession.value?.hostUserId?.trim().orEmpty()
            if (hostFromSession.isNotEmpty() && hostFromSession != my) return hostFromSession
        }
        return my
    }

    /**
     * Firestore `live_streams/{id}` used for chat, viewer counts, gifts, moderation.
     * PK signaling uses `pk_room_*` on RTDB; audience chat always lives on the host's stream doc.
     */
    private fun firestoreLiveStreamAudienceDocId(): String {
        if (isPkSession && pkFirestoreHostDocId.isNotBlank()) return pkFirestoreHostDocId
        return roomId?.trim().orEmpty()
    }

    private fun startLiveFirestoreOverlays() {
        val streamDocId = firestoreLiveStreamAudienceDocId().takeIf { it.isNotBlank() } ?: return
        val hostId = hostUserIdForProfile().ifBlank {
            FirebaseAuth.getInstance().currentUser?.uid.orEmpty()
        }
        audienceKickEnforcementHandled = false
        liveChatSessionCutoffMs = System.currentTimeMillis()
        liveChatMessages.value = emptyList()
        lastGiftOverlayMessageId = null
        lastGiftOverlaySeenTimestampMs = 0L
        skipListenerGiftOverlayUntilMs = 0L
        if (isPkSession) {
            processedPkArenaGiftIds.clear()
            livePkOpponentProfile.value = null
        }
        liveFirestoreOverlayJob?.cancel()
        liveFirestoreOverlayJob = lifecycleScope.launch {
            val chatQueryMinTs = when {
                isPkSession -> {
                    val sessionStart = pkArenaSession.value?.pkStartTimeMillis ?: 0L
                    val pkStart =
                        if (sessionStart > 0L) sessionStart
                        else runCatching { firebaseService.fetchLiveStreamPkStartedAtMillis(streamDocId) }.getOrDefault(0L)
                    if (pkStart > 0L) pkStart else liveChatSessionCutoffMs
                }
                streamDocId.startsWith("call_") -> {
                    firebaseService.getCallDocumentCreatedAtMs(streamDocId) ?: liveChatSessionCutoffMs
                }
                else -> liveChatSessionCutoffMs
            }
            android.util.Log.i(
                "CALL_CHAT",
                "listenLiveOverlay streamDocId=$streamDocId minTimestampMs=$chatQueryMinTs " +
                    "callScoped=${streamDocId.startsWith("call_") && !isPkSession}",
            )
            launch {
                firebaseService.observeLiveStreamMessages(streamDocId, chatQueryMinTs).collect { list ->
                    liveChatMessages.value = list
                    processPkArenaGiftsIfNeeded(list)
                    val uid = FirebaseAuth.getInstance().currentUser?.uid
                    val giftMsg = list.lastOrNull { m ->
                        m.type == "gift" &&
                            m.id.isNotBlank() &&
                            m.id != lastGiftOverlayMessageId &&
                            m.senderId != uid
                    }
                    if (giftMsg != null &&
                        giftMsg.timestamp > lastGiftOverlaySeenTimestampMs &&
                        System.currentTimeMillis() >= skipListenerGiftOverlayUntilMs
                    ) {
                        lastGiftOverlayMessageId = giftMsg.id
                        lastGiftOverlaySeenTimestampMs = giftMsg.timestamp
                        val fromCatalog = availableGifts.firstOrNull { g ->
                            g.id == giftMsg.giftId ||
                                (
                                    !giftMsg.giftImageUrl.isNullOrBlank() &&
                                        (g.thumbnailUrl == giftMsg.giftImageUrl || g.videoUrl == giftMsg.giftImageUrl)
                                    ) ||
                                (!giftMsg.giftVideoUrl.isNullOrBlank() && g.videoUrl == giftMsg.giftVideoUrl)
                        }
                        val baseline = fromCatalog ?: Gift(
                            id = giftMsg.giftId,
                            name = giftMsg.giftName.ifBlank { giftMsg.text },
                            price = 0,
                            thumbnailUrl = giftMsg.giftImageUrl.orEmpty(),
                            videoUrl = giftMsg.giftVideoUrl.orEmpty(),
                            soundUrl = giftMsg.giftSoundUrl.orEmpty(),
                            category = if (!giftMsg.giftVideoUrl.isNullOrBlank() || !giftMsg.giftSoundUrl.isNullOrBlank()) "CRM_PREMIUM" else "STANDARD",
                            isCrmGift = !giftMsg.giftVideoUrl.isNullOrBlank() || !giftMsg.giftSoundUrl.isNullOrBlank(),
                            displayDurationSeconds = giftMsg.giftDisplayDurationSeconds.coerceIn(0, 12)
                        )
                        val resolved = baseline.withMergedLiveGiftMessage(giftMsg)
                        playingGiftOverlay.value = resolved
                    }
                }
            }
            launch {
                firebaseService.observeLiveStreamRoom(streamDocId).collect { info ->
                    liveViewerCount.value = info.viewerCount
                    if (isPkSession) {
                        val wasScoringOpen = pkFirestoreScoringOpen.value
                        pkFirestoreScoringOpen.value = info.pkScoringOpen
                        if (wasScoringOpen && !info.pkScoringOpen) {
                            liveChatMessages.value = emptyList()
                        }
                        pkHostViewerCountState.value = info.pkHostViewerCount
                        pkGuestViewerCountState.value = info.pkGuestViewerCount
                        pkHostViewerUserIdsState.value = info.pkHostViewerUserIds
                        pkGuestViewerUserIdsState.value = info.pkGuestViewerUserIds
                        if (!info.pkScoringOpen && info.pkResultPhaseEndsAtMillis > 0L) {
                            pkArenaSession.value = pkArenaSession.value?.let { cur ->
                                if (!cur.battleEnded || cur.phase != PkBattlePhase.FINISHED) {
                                    cur
                                } else {
                                    val fs = info.pkResultPhaseEndsAtMillis
                                    when {
                                        cur.resultPhaseEndsAtMillis <= 0L ->
                                            cur.copy(resultPhaseEndsAtMillis = fs)
                                        else ->
                                            cur.copy(
                                                resultPhaseEndsAtMillis = maxOf(
                                                    cur.resultPhaseEndsAtMillis,
                                                    fs,
                                                ),
                                            )
                                    }
                                }
                            }
                        }
                    }
                    if (!isStreamer && !audienceKickEnforcementHandled && !teardownHandled) {
                        val my = FirebaseAuth.getInstance().currentUser?.uid
                        if (my != null && info.kickedUsers.contains(my)) {
                            audienceKickEnforcementHandled = true
                            runOnUiThread {
                                Toast.makeText(
                                    this@LiveStreamActivity,
                                    getString(R.string.live_kicked_by_host_toast),
                                    Toast.LENGTH_LONG
                                ).show()
                                if (isPkSession) endPkAndReturn() else endRegularCallAndReturn()
                            }
                        }
                    }
                }
            }
            launch {
                firebaseService.observeUserProfile(hostId).collect { liveHostProfile.value = it }
            }
            if (isPkSession) {
                val myPk = FirebaseAuth.getInstance().currentUser?.uid.orEmpty()
                val hPk = pkArenaSession.value?.hostUserId?.trim().orEmpty()
                val gPk = pkArenaSession.value?.guestUserId?.trim().orEmpty()
                val oppUid = when {
                    myPk.isNotEmpty() && hPk == myPk -> gPk.takeIf { it.isNotBlank() }
                    myPk.isNotEmpty() && gPk == myPk -> hPk.takeIf { it.isNotBlank() }
                    else -> overlayPeerId.trim().takeIf { it.isNotEmpty() && it != myPk }
                }
                if (oppUid != null && oppUid != hostId) {
                    launch {
                        firebaseService.observeUserProfile(oppUid).collect { livePkOpponentProfile.value = it }
                    }
                } else {
                    livePkOpponentProfile.value = null
                }
            }
        }
        lifecycleScope.launch {
            runCatching { firebaseService.ensureLiveStreamDocument(streamDocId, hostId) }
                .onFailure { android.util.Log.w("LiveStreamActivity", "ensureLiveStreamDocument", it) }
        }
        if (!isStreamer) {
            lifecycleScope.launch {
                runCatching { firebaseService.incrementLiveStreamViewers(streamDocId, 1) }
                    .onSuccess {
                        didIncrementViewerAsGuest = true
                        val joinerId = FirebaseAuth.getInstance().currentUser?.uid ?: return@onSuccess
                        val joinerName = FirebaseAuth.getInstance().currentUser?.displayName?.takeIf { !it.isNullOrBlank() }
                            ?: getString(R.string.live_chat_sender_default)
                        runCatching { firebaseService.sendLiveStreamJoinSystemMessage(streamDocId, joinerId, joinerName) }
                            .onFailure { e ->
                                android.util.Log.w("LiveStreamActivity", "sendLiveStreamJoinSystemMessage", e)
                            }
                    }
                    .onFailure { android.util.Log.w("LiveStreamActivity", "incrementLiveStreamViewers +1", it) }
            }
        }
        startCallSessionRemoteEndObserverIfNeeded()
    }

    private fun startCallSessionRemoteEndObserverIfNeeded() {
        callSessionRemoteEndJob?.cancel()
        callSessionRemoteEndJob = null
        val rid = roomId?.trim().orEmpty()
        if (isPkSession || !rid.startsWith("call_")) return
        callSessionRemoteEndJob = lifecycleScope.launch {
            firebaseService.observeCallSessionStatus(rid).collect { raw ->
                if (teardownHandled) return@collect
                val status = raw?.trim()?.uppercase(Locale.US).orEmpty()
                val terminal =
                    status == "ENDED" || status == "DECLINED" || status == "MISSED" || status == "CANCELLED"
                if (!terminal) return@collect
                runOnUiThread {
                    if (teardownHandled) return@runOnUiThread
                    Toast.makeText(
                        this@LiveStreamActivity,
                        getString(R.string.call_remote_ended_toast),
                        Toast.LENGTH_LONG
                    ).show()
                    endRegularCallAndReturn()
                }
            }
        }
    }

    private fun startCallElapsedTicker() {
        callElapsedTickJob?.cancel()
        callElapsedSeconds.value = 0
        callElapsedTickJob = lifecycleScope.launch {
            while (isActive) {
                delay(1000)
                callElapsedSeconds.value = callElapsedSeconds.value + 1
            }
        }
    }

    /**
     * Chamet-style real-time billing for the payer (outgoing caller / `isStreamer = true`).
     *
     * Behaviour:
     *  1. Charges **1 minute immediately** when the call connects.
     *  2. Charges **1 more minute every 60 s** while the call is alive.
     *  3. After each charge [walletDiamondBalance] is updated so the UI reflects the deduction live.
     *  4. If the remaining balance is **less than the rate**, the call is auto-ended.
     *
     * The post-call bulk charge in [endRegularCallAndReturn] is skipped when this job ran
     * (flag [realtimeBillingRan]) to avoid double-charging.
     */
    private fun startRealtimeCallBilling() {
        if (!isStreamer || isPkSession || overlayPeerId.isBlank()) return
        val myUid = FirebaseAuth.getInstance().currentUser?.uid?.trim().orEmpty()
        if (myUid.isBlank()) return
        realtimeBillingJob?.cancel()
        realtimeBillingRan = true
        realtimeBillingJob = lifecycleScope.launch {
            // ── Minute 1: charge immediately when call connects ──────────────────
            val rate = callDiamondRatePerMinute.value
            if (rate <= 0) return@launch

            val firstResult = runCatching {
                firebaseService.chargeOneCallMinute(myUid, overlayPeerId, rate)
            }.getOrElse { Result.failure(it) }

            firstResult.onSuccess { newBal ->
                // newBal == -1 → sentinel: balance was already below rate, call should never
                // have connected. End immediately.
                // newBal >= 0  → charge succeeded; call continues for the full 60 s.
                // DO NOT check (newBal < rate) here — that would end the call the moment
                // the first minute is deducted, which is the bug (e.g. 2000 bal - 1500 = 500,
                // 500 < 1500 → wrong early termination).
                if (newBal == -1) {
                    showInsufficientToast()
                    endRegularCallAndReturn()
                    return@launch
                }
                walletDiamondBalance.value = newBal
            }

            // ── Subsequent minutes: charge every 59 s ────────────────────────────
            // Chamet model: minute N is paid up-front. After 59 s we try to charge
            // minute N+1. If the balance is insufficient the call ends at ~59 s per
            // paid minute (2 000 diamonds → ~59 s; 3 000 → ~1 m 59 s, etc.).
            while (isActive) {
                delay(59_000L)
                if (!isActive) break
                val currentRate = callDiamondRatePerMinute.value
                if (currentRate <= 0) continue
                val chargeResult = runCatching {
                    firebaseService.chargeOneCallMinute(myUid, overlayPeerId, currentRate)
                }.getOrElse { Result.failure(it) }
                chargeResult.onSuccess { newBal ->
                    if (newBal == -1) {
                        // Ran out of diamonds for the next minute → end call
                        showInsufficientToast()
                        endRegularCallAndReturn()
                        return@launch
                    }
                    walletDiamondBalance.value = newBal
                }
                // On network failure we don't end the call — let the next tick retry
            }
        }
    }

    private fun showInsufficientToast() {
        runOnUiThread {
            android.widget.Toast.makeText(
                this@LiveStreamActivity,
                getString(R.string.call_ended_insufficient_diamonds),
                android.widget.Toast.LENGTH_LONG
            ).show()
        }
    }

    private fun observeSelfWalletAndPartnerRate() {
        val myUid = FirebaseAuth.getInstance().currentUser?.uid?.trim().orEmpty()
        if (myUid.isNotEmpty()) {
            lifecycleScope.launch {
                firebaseService.observeUserProfile(myUid).collect { p ->
                    p?.let {
                        walletDiamondBalance.value = it.diamondBalance.toInt()
                        if (isPkSession) livePkSelfProfileHud.value = it
                    }
                }
            }
        }
        if (!isPkSession && overlayPeerId.isNotBlank()) {
            lifecycleScope.launch {
                val p = runCatching { firebaseService.getUserProfile(overlayPeerId) }.getOrNull()
                if (p != null) {
                    callDiamondRatePerMinute.value = if (isVideoCall) {
                        p.customVideoPrice ?: VirtualEconomyMath.DEFAULT_CALL_VIDEO_DIAMONDS_PER_MIN
                    } else {
                        p.customAudioPrice ?: VirtualEconomyMath.DEFAULT_CALL_AUDIO_DIAMONDS_PER_MIN
                    }
                }
            }
        }
    }

    private fun sendPkBattleAudienceGift(receiverUserId: String, gift: Gift, count: Int) {
        val session = pkArenaSession.value ?: return
        val streamId = firestoreLiveStreamAudienceDocId().trim()
        val senderId = FirebaseAuth.getInstance().currentUser?.uid?.trim().orEmpty()
        val rid = receiverUserId.trim()
        if (streamId.isEmpty() || senderId.isEmpty() || rid.isEmpty()) return
        if (senderId == rid) {
            runOnUiThread {
                Toast.makeText(this, getString(R.string.live_pk_gift_no_self), Toast.LENGTH_SHORT).show()
            }
            return
        }
        if (rid != session.hostUserId && rid != session.guestUserId) {
            runOnUiThread {
                Toast.makeText(this, getString(R.string.pk_gift_select_battler_first), Toast.LENGTH_SHORT).show()
            }
            return
        }
        val totalCost = gift.price * count
        if (totalCost <= 0 || giftSendInProgress.value) return
        if (!pkFirestoreScoringOpen.value) {
            runOnUiThread {
                Toast.makeText(this, getString(R.string.live_pk_gift_no_score), Toast.LENGTH_SHORT).show()
            }
            return
        }
        val rawPkBeans = VirtualEconomyMath.giftReceiverBeansEarned(totalCost.toLong(), gift)
        /** Match [DatingViewModel.sendGiftToReceiver]: avoid zero PK increments from rounding on tiny gifts. */
        val pkScoreDelta = rawPkBeans.coerceAtLeast(1L)
        val prevWallet = walletDiamondBalance.value
        if (prevWallet < totalCost) return
        giftSendInProgress.value = true
        walletDiamondBalance.value = prevWallet - totalCost
        lifecycleScope.launch {
            try {
                val txId = UUID.randomUUID().toString()
                when (
                    val r = firebaseService.sendGift(
                        transactionId = txId,
                        senderId = senderId,
                        hostId = rid,
                        giftCost = totalCost,
                        gift = gift,
                        livePkScoreStreamDocId = session.hostUserId,
                        livePkScoreDelta = pkScoreDelta
                    )
                ) {
                    is LiveEconomyGiftResult.Success -> {
                        walletDiamondBalance.value = r.newWalletBalance
                        pkArenaSession.value = pkArenaSession.value?.let { cur ->
                            when (rid.trim()) {
                                cur.hostUserId.trim() ->
                                    cur.copy(hostBeansEarned = cur.hostBeansEarned + pkScoreDelta)
                                cur.guestUserId.trim() ->
                                    cur.copy(guestBeansEarned = cur.guestBeansEarned + pkScoreDelta)
                                else -> cur
                            }
                        }
                        val senderName = FirebaseAuth.getInstance().currentUser?.displayName?.trim().orEmpty()
                            .ifBlank { getString(R.string.live_chat_sender_default) }
                        firebaseService.sendLiveStreamGiftMessage(
                            streamId = streamId,
                            messageDocId = txId,
                            senderId = senderId,
                            senderName = senderName,
                            gift = gift,
                            count = count,
                            giftRecipientUserId = rid
                        ).onFailure { e ->
                            android.util.Log.w("LiveStreamActivity", "sendLiveStreamGiftMessage PK", e)
                        }
                        lastGiftOverlaySeenTimestampMs = System.currentTimeMillis()
                        skipListenerGiftOverlayUntilMs = System.currentTimeMillis() + 7500L
                        playingGiftOverlay.value = gift
                        pkGiftSheetVisible.value = false
                    }
                    is LiveEconomyGiftResult.Failed -> runOnUiThread {
                        walletDiamondBalance.value = prevWallet
                        Toast.makeText(this@LiveStreamActivity, r.reason, Toast.LENGTH_SHORT).show()
                    }
                }
            } finally {
                giftSendInProgress.value = false
            }
        }
    }

    private fun sendLiveCallGift(gift: Gift, count: Int) {
        val streamId = roomId?.trim().orEmpty()
        val senderId = FirebaseAuth.getInstance().currentUser?.uid?.trim().orEmpty()
        val receiverId = overlayPeerId.trim()
        if (streamId.isEmpty() || senderId.isEmpty() || receiverId.isEmpty() || senderId == receiverId) return
        val totalCost = gift.price * count
        if (totalCost <= 0 || giftSendInProgress.value) return
        val prevWallet = walletDiamondBalance.value
        if (prevWallet < totalCost) return
        giftSendInProgress.value = true
        walletDiamondBalance.value = prevWallet - totalCost
        lifecycleScope.launch {
            try {
                val txId = UUID.randomUUID().toString()
                when (
                    val r = firebaseService.sendGift(
                        transactionId = txId,
                        senderId = senderId,
                        hostId = receiverId,
                        giftCost = totalCost,
                        gift = gift
                    )
                ) {
                    is LiveEconomyGiftResult.Success -> {
                        walletDiamondBalance.value = r.newWalletBalance
                        val senderName = FirebaseAuth.getInstance().currentUser?.displayName?.trim().orEmpty()
                            .ifBlank { getString(R.string.live_chat_sender_default) }
                        firebaseService.sendLiveStreamGiftMessage(
                            streamId = streamId,
                            messageDocId = txId,
                            senderId = senderId,
                            senderName = senderName,
                            gift = gift,
                            count = count,
                            giftRecipientUserId = receiverId
                        ).onFailure { e ->
                            android.util.Log.w("LiveStreamActivity", "sendLiveStreamGiftMessage", e)
                        }
                        lastGiftOverlaySeenTimestampMs = System.currentTimeMillis()
                        skipListenerGiftOverlayUntilMs = System.currentTimeMillis() + 7500L
                        playingGiftOverlay.value = gift
                        showGiftPickerSheet.value = false
                    }
                    is LiveEconomyGiftResult.Failed -> runOnUiThread {
                        walletDiamondBalance.value = prevWallet
                        Toast.makeText(this@LiveStreamActivity, r.reason, Toast.LENGTH_SHORT).show()
                    }
                }
            } finally {
                giftSendInProgress.value = false
            }
        }
    }

    private suspend fun processLuckyGiftsCloud(
        receiverId: String,
        giftPrice: Int,
        quantity: Int,
    ): LuckyGiftsOutcome {
        val myUid = FirebaseAuth.getInstance().currentUser?.uid?.trim().orEmpty()
        if (myUid.isEmpty()) return LuckyGiftsOutcome.Failure("Not signed in")
        val rid = receiverId.trim()
        if (rid.isBlank() || rid == myUid) return LuckyGiftsOutcome.Failure("No recipient")
        val total = giftPrice * quantity
        if (total <= 0) return LuckyGiftsOutcome.Failure("Invalid amount")
        if (walletDiamondBalance.value < total) return LuckyGiftsOutcome.Failure("Not enough diamonds")
        return try {
            val result = zipperFirebaseFunctions()
                .getHttpsCallable("processLuckyGifts")
                .call(
                    hashMapOf(
                        "receiverId" to rid,
                        "giftPrice" to giftPrice,
                        "quantity" to quantity,
                    ),
                )
                .await()
            val data = result.data
            val success = data.callablePayloadSuccess()
            val diamondsWon = data.callablePayloadDiamondsWon()
            val transactionId = data.callablePayloadTransactionId()
            if (!success) {
                val msg = data.callablePayloadErrorMessage()
                    ?: "Could not process lucky gifts"
                return LuckyGiftsOutcome.Failure(msg)
            }
            val provisional =
                (walletDiamondBalance.value.toLong() - total.toLong() + diamondsWon.toLong())
                    .toInt()
                    .coerceAtLeast(0)
            walletDiamondBalance.value = provisional
            lifecycleScope.launch(Dispatchers.IO) {
                runCatching {
                    firebaseService.getUserProfile(
                        myUid,
                        com.google.firebase.firestore.Source.SERVER,
                    )?.let { p ->
                        walletDiamondBalance.value = p.diamondBalance.toInt()
                    }
                }
            }
            LuckyGiftsOutcome.Success(diamondsWon, transactionId)
        } catch (e: Exception) {
            android.util.Log.e("LiveStreamActivity", "processLuckyGiftsCloud", e)
            LuckyGiftsOutcome.Failure(e.callableFailureMessage())
        }
    }

    private fun postLuckyGiftVisualAfterLucky(gift: Gift, receiverId: String, count: Int, transactionId: String?) {
        val streamId = roomId?.trim().orEmpty()
        val senderId = FirebaseAuth.getInstance().currentUser?.uid?.trim().orEmpty()
        if (senderId.isEmpty()) return
        val msgId = transactionId?.trim()?.takeIf { it.isNotBlank() } ?: UUID.randomUUID().toString()
        lifecycleScope.launch {
            if (streamId.isNotEmpty()) {
                val senderName = FirebaseAuth.getInstance().currentUser?.displayName?.trim().orEmpty()
                    .ifBlank { getString(R.string.live_chat_sender_default) }
                firebaseService.sendLiveStreamGiftMessage(
                    streamId = streamId,
                    messageDocId = msgId,
                    senderId = senderId,
                    senderName = senderName,
                    gift = gift,
                    count = count,
                    giftRecipientUserId = receiverId.trim(),
                ).onFailure { e ->
                    android.util.Log.w("LiveStreamActivity", "sendLiveStreamGiftMessage lucky", e)
                }
            }
            lastGiftOverlaySeenTimestampMs = System.currentTimeMillis()
            skipListenerGiftOverlayUntilMs = System.currentTimeMillis() + 7500L
            playingGiftOverlay.value = gift
        }
    }

    private fun sendOverlayChatMessage(text: String) {
        val streamDocId = firestoreLiveStreamAudienceDocId().takeIf { it.isNotBlank() } ?: return
        val senderId = FirebaseAuth.getInstance().currentUser?.uid ?: return
        val name = FirebaseAuth.getInstance().currentUser?.displayName?.takeIf { !it.isNullOrBlank() }
            ?: liveHostProfile.value?.takeIf { it.id == senderId }?.name?.takeIf { it.isNotBlank() }
            ?: getString(R.string.live_chat_sender_default)
        android.util.Log.i("CALL_CHAT", "sendLiveOverlay streamDocId=$streamDocId sender=$senderId")
        lifecycleScope.launch {
            firebaseService.sendLiveStreamChatMessage(streamDocId, senderId, name, text)
                .onFailure { e ->
                    android.util.Log.e(
                        "LiveStreamActivity",
                        "sendLiveStreamChatMessage FAILED streamDocId=$streamDocId",
                        e
                    )
                    runOnUiThread {
                        Toast.makeText(
                            this@LiveStreamActivity,
                            getString(R.string.live_chat_send_failed),
                            Toast.LENGTH_SHORT
                        ).show()
                    }
                }
        }
    }

    private fun eligibleForAgoraOneToOneVideo(): Boolean =
        !isPkSession && isVideoCall && BuildConfig.AGORA_APP_ID.trim().isNotEmpty()

    private fun eligibleForAgoraPkSessionVideo(): Boolean =
        isPkSession && isVideoCall && BuildConfig.AGORA_APP_ID.trim().isNotEmpty()

    private fun swapAgoraOrWebRtcPip() {
        if (privateVideoUsesAgora) {
            if (agoraBoundRemoteUid == null) return
            privateAgoraPipShowsLocal = !privateAgoraPipShowsLocal
            applyAgoraVideoBindings()
        } else {
            rtcManager?.swapCallVideoPipLayout()
        }
    }

    private fun applyAgoraVideoBindings() {
        val am = agoraManager ?: return
        val pip = agoraTexturePip ?: return
        val full = agoraTextureFull ?: return
        val ru = agoraBoundRemoteUid
        if (ru == null) {
            am.bindLocalVideo(pip, VideoCanvas.RENDER_MODE_HIDDEN, Constants.VIDEO_MIRROR_MODE_ENABLED)
            return
        }
        if (privateAgoraPipShowsLocal) {
            am.bindLocalVideo(pip, VideoCanvas.RENDER_MODE_HIDDEN, Constants.VIDEO_MIRROR_MODE_ENABLED)
            am.bindRemoteVideo(full, ru, VideoCanvas.RENDER_MODE_HIDDEN, Constants.VIDEO_MIRROR_MODE_DISABLED)
        } else {
            // Local full-bleed: avoid selfie mirror; remote PiP: never mirror.
            am.bindLocalVideo(full, VideoCanvas.RENDER_MODE_HIDDEN, Constants.VIDEO_MIRROR_MODE_DISABLED)
            am.bindRemoteVideo(pip, ru, VideoCanvas.RENDER_MODE_HIDDEN, Constants.VIDEO_MIRROR_MODE_DISABLED)
        }
    }

    private fun ensureAgoraStandardCallSurfaces() {
        if (agoraTextureFull != null) return
        val container = liveStreamBinding.standardCallContainer
        remoteView.visibility = View.GONE
        localView.visibility = View.GONE
        val full =
            TextureView(this).apply {
                layoutParams = FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                )
            }
        container.addView(full, 0)
        val pip =
            TextureView(this).apply {
                layoutParams = FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                )
            }
        liveStreamBinding.localViewCard.addView(pip)
        agoraTextureFull = full
        agoraTexturePip = pip
        full.isClickable = true
        full.setOnClickListener { swapAgoraOrWebRtcPip() }
    }

    private fun teardownAgoraPrivateVideo() {
        pkAgoraRemoteBindJob?.cancel()
        pkAgoraRemoteBindJob = null
        pkVideoUsesAgora = false
        pkAgoraLeftTexture = null
        pkAgoraRightTexture = null
        agoraObserveJob?.cancel()
        agoraObserveJob = null
        agoraManager?.destroy()
        agoraManager = null
        agoraBoundRemoteUid = null
        privateAgoraPipShowsLocal = true
        agoraStreamerJoinRequested = false
    }

    private fun replacePkArenaWithAgoraSurfaces() {
        val row = liveStreamBinding.pkArenaRow
        row.removeAllViews()
        val left =
            TextureView(this).apply {
                isOpaque = false
            }
        val right =
            TextureView(this).apply {
                isOpaque = false
            }
        pkAgoraLeftTexture = left
        pkAgoraRightTexture = right
        val lp = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f)
        row.addView(left, lp)
        row.addView(right, lp)
    }

    private fun performPkAgoraBattlerJoin(channel: String) {
        val am = agoraManager ?: return
        val left = pkAgoraLeftTexture ?: return
        val right = pkAgoraRightTexture ?: return
        val fbUid = FirebaseAuth.getInstance().currentUser?.uid.orEmpty()
        if (fbUid.isEmpty()) return
        val uid = am.agoraUidFromFirebaseUid(fbUid)
        pkAgoraRemoteBindJob?.cancel()
        pkAgoraRemoteBindJob =
            lifecycleScope.launch {
                val token = withContext(Dispatchers.IO) { fetchAgoraTokenForPrivateCall(channel) }
                withContext(Dispatchers.Main) {
                    if (teardownHandled) return@withContext
                    am.bindLocalVideo(
                        left,
                        VideoCanvas.RENDER_MODE_HIDDEN,
                        Constants.VIDEO_MIRROR_MODE_ENABLED,
                    )
                    if (token == null) {
                        endPkAndReturn()
                        return@withContext
                    }
                    val code =
                        am.joinAsCoHostBroadcaster(
                            channel.trim(),
                            uid,
                            token,
                            true,
                        )
                    if (code != 0) {
                        am.startPreviewIfNeeded()
                    }
                    updateCallStatus(CallStatus.CONNECTED)
                }
                val opp = overlayPeerId.trim()
                if (opp.isEmpty()) return@launch
                val oppUid = AgoraManager.fromFirebaseUid(opp)
                val mgr = agoraManager ?: return@launch
                try {
                    mgr.remoteUids.first { it.contains(oppUid) }
                } catch (_: Exception) {
                    return@launch
                }
                withContext(Dispatchers.Main) {
                    if (teardownHandled) return@withContext
                    mgr.bindRemoteVideo(
                        right,
                        oppUid,
                        VideoCanvas.RENDER_MODE_HIDDEN,
                        Constants.VIDEO_MIRROR_MODE_DISABLED,
                    )
                }
            }
    }

    private fun startAgoraRemoteUidObservation() {
        agoraObserveJob?.cancel()
        val am = agoraManager ?: return
        agoraObserveJob =
            lifecycleScope.launch {
                var hadRemote = false
                am.remoteUid.collect { ru ->
                    if (ru != null) {
                        hadRemote = true
                        agoraBoundRemoteUid = ru
                        runOnUiThread {
                            applyAgoraVideoBindings()
                            if (!isPkSession) {
                                when (currentCallUiState) {
                                    CallUIState.Connecting,
                                    is CallUIState.Reconnecting -> applyCallUiState(CallUIState.Hidden)
                                    else -> Unit
                                }
                            }
                            updateCallStatus(CallStatus.CONNECTED)
                        }
                    } else if (hadRemote && privateVideoUsesAgora && !teardownHandled) {
                        runOnUiThread { setCallUiState(CallUIState.PeerDisconnected) }
                    }
                }
            }
    }

    private suspend fun fetchAgoraTokenForPrivateCall(channelName: String): String? {
        val ch = channelName.trim()
        if (ch.isEmpty()) return null
        val fbUid = FirebaseAuth.getInstance().currentUser?.uid?.trim().orEmpty()
        if (fbUid.isEmpty()) return null
        val uid = AgoraManager.fromFirebaseUid(fbUid)
        return try {
            val result =
                zipperFirebaseFunctions()
                    .getHttpsCallable("getAgoraToken")
                    .call(
                        hashMapOf(
                            "channelName" to ch,
                            "uid" to uid,
                            "isPublisher" to true,
                        ),
                    )
                    .await()
            val data = result.data as? Map<*, *> ?: return null
            (data["token"] as? String)?.takeIf { it.isNotBlank() }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            android.util.Log.e("LiveStreamActivity", "getAgoraToken", e)
            null
        }
    }

    private suspend fun performAgoraJoin(channel: String) {
        val am = agoraManager ?: return
        val fbUid = FirebaseAuth.getInstance().currentUser?.uid?.trim().orEmpty()
        if (fbUid.isEmpty()) return
        val uid = am.agoraUidFromFirebaseUid(fbUid)

        // Pre-init engine + fetch token in parallel on IO — keeps Main thread free,
        // avoids the 473ms StrictMode DiskReadViolation from RtcEngine.create().
        val token = withContext(Dispatchers.IO) {
            am.initEngineAsync()                        // loads native libs + clears bad SQLite
            fetchAgoraTokenForPrivateCall(channel)      // Firebase HTTPS callable
        }

        if (token == null) {
            android.util.Log.e("LiveStreamActivity", "performAgoraJoin: token fetch failed for channel=$channel")
            withContext(Dispatchers.Main) {
                if (!teardownHandled) setCallUiState(CallUIState.CallFailed)
            }
            return
        }

        withContext(Dispatchers.Main) {
            if (teardownHandled) return@withContext
            applyAgoraVideoBindings()
            val code = am.joinOneToOneVideo(channel, uid, token)
            android.util.Log.d("AgoraManager", "joinOneToOneVideo channel=$channel uid=$uid code=$code")
            if (code != 0) {
                android.util.Log.e("LiveStreamActivity", "joinOneToOneVideo failed code=$code — showing CallFailed")
                setCallUiState(CallUIState.CallFailed)
            }
        }
    }

    private fun joinAgoraPrivateVideoAfterAcceptIfNeeded() {
        if (!privateVideoUsesAgora || !isStreamer || teardownHandled) return
        if (agoraStreamerJoinRequested) return
        agoraStreamerJoinRequested = true
        val ch = roomId?.trim().orEmpty()
        if (ch.isEmpty()) {
            android.util.Log.e("LiveStreamActivity", "joinAgoraPrivateVideoAfterAcceptIfNeeded: blank roomId, aborting join")
            return
        }
        android.util.Log.d("AgoraManager", "joinAgoraPrivateVideoAfterAcceptIfNeeded: joining channel=$ch as streamer")
        lifecycleScope.launch { performAgoraJoin(ch) }
    }

    /** Video calls need camera + mic; audio-only 1:1 needs mic only. */
    private fun hasWebrtcPermissionsForCallMode(): Boolean {
        val micOk = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (!micOk) return false
        if (isPkSession || isVideoCall) {
            return ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        }
        return true
    }

    private fun startLiveStream() {
        val safeRoom = roomId?.takeIf { it.isNotBlank() }
        if (safeRoom == null) {
            android.util.Log.e("LiveStreamActivity", "startLiveStream aborted: blank roomId")
            Toast.makeText(this, getString(R.string.call_invalid_room), Toast.LENGTH_SHORT).show()
            finish()
            return
        }
        startLiveFirestoreOverlays()
        observeSelfWalletAndPartnerRate()
        android.util.Log.d("WebRTC_SIGNAL", "LiveStreamActivity startLiveStream room=$safeRoom isStreamer=$isStreamer")

        // Route audio to earpiece for audio-only 1:1 calls; loudspeaker for video/PK when no headset/USB/BT sink.
        val audioManager = getSystemService(AUDIO_SERVICE) as AudioManager
        WebRTCManager.applyLivePlaybackSpeakerMode(
            audioManager,
            preferLoudSpeaker = isPkSession || isVideoCall,
        )
        isSpeakerOnFlow.value = isPkSession || isVideoCall
        @Suppress("DEPRECATION")
        android.util.Log.d(
            "WebRTC_SIGNAL",
            "AudioManager routing: speakerOn=${audioManager.isSpeakerphoneOn} isPk=$isPkSession isVideo=$isVideoCall"
        )

        if (!isPkSession && isVideoCall && BuildConfig.AGORA_APP_ID.trim().isEmpty()) {
            Toast.makeText(this, getString(R.string.live_video_requires_agora), Toast.LENGTH_LONG).show()
            finish()
            return
        }

        privateVideoUsesAgora = false
        if (eligibleForAgoraOneToOneVideo()) {
            privateVideoUsesAgora = true
            rtcManager = null
            teardownAgoraPrivateVideo()
            ensureAgoraStandardCallSurfaces()
            agoraManager = AgoraManager(this)
            startAgoraRemoteUidObservation()
            if (!isPkSession) {
                setCallUiState(CallUIState.Connecting)
            }
            if (isStreamer) {
                updateCallStatus(CallStatus.RINGING)
                if (!isPkSession) {
                    CallSoundManager.startOutgoingDialTone(lifecycleScope)
                }
                startCallResponseListener()
                startRingingTimeout()
            } else {
                updateCallStatus(CallStatus.CONNECTING)
                lifecycleScope.launch { performAgoraJoin(safeRoom) }
            }
            return
        }

        if (eligibleForAgoraPkSessionVideo()) {
            rtcManager = null
            teardownAgoraPrivateVideo()
            pkVideoUsesAgora = true
            replacePkArenaWithAgoraSurfaces()
            agoraManager = AgoraManager(this)
            performPkAgoraBattlerJoin(safeRoom)
            if (isStreamer) {
                updateCallStatus(CallStatus.RINGING)
                startCallResponseListener()
                startRingingTimeout()
            } else {
                updateCallStatus(CallStatus.CONNECTING)
            }
            return
        }

        val audioOnlyCall = !isPkSession && !isVideoCall
        rtcManager = WebRTCManager(
            context = this,
            roomId = safeRoom,
            localView = localView,
            remoteView = remoteView,
            onPeerDisconnected = {
                runOnUiThread {
                    if (ignoreNextPeerDisconnectForPkSolo) {
                        ignoreNextPeerDisconnectForPkSolo = false
                        return@runOnUiThread
                    }
                    if (isPkSession) endPkAndReturn()
                    else setCallUiState(CallUIState.PeerDisconnected)
                }
            },
            onConnectionStateChanged = { state ->
                when (state) {
                    PeerConnection.IceConnectionState.CONNECTED,
                    PeerConnection.IceConnectionState.COMPLETED -> runOnUiThread {
                        if (!isPkSession) {
                            when (currentCallUiState) {
                                CallUIState.Connecting,
                                is CallUIState.Reconnecting -> applyCallUiState(CallUIState.Hidden)
                                else -> Unit
                            }
                        }
                        updateCallStatus(CallStatus.CONNECTED)
                        if (isPkSession && rtcManager != null) {
                            runCatching { rtcManager!!.refreshVideoSinkAttachments("pk_ice_connected") }
                        }
                    }
                    PeerConnection.IceConnectionState.DISCONNECTED -> runOnUiThread {
                        if (!isPkSession && oneOnOneCallReachedConnected) {
                            setCallUiState(
                                CallUIState.Reconnecting(1, WebRTCManager.SESSION_FULL_RENEG_MAX_ATTEMPTS),
                            )
                        }
                    }
                    else -> Unit
                }
            },
            broadcastMode = false,
            viewerSignalingId = null,
            audioOnly = audioOnlyCall,
            pkArenaSideBySide = isPkSession,
            callRemotePeerUid = overlayPeerId.trim().takeIf { it.isNotEmpty() && !isPkSession },
            onPeerPresenceLost = {
                runOnUiThread {
                    if (isPkSession) endPkAndReturn()
                    else setCallUiState(CallUIState.PeerDisconnected)
                }
            },
            onCallFailed = {
                runOnUiThread {
                    if (isPkSession) endPkAndReturn()
                    else setCallUiState(CallUIState.CallFailed)
                }
            },
            onStallWatchdogReconnect = { attempt, maxAttempts ->
                runOnUiThread {
                    if (!isPkSession) {
                        setCallUiState(CallUIState.Reconnecting(attempt, maxAttempts))
                    }
                }
            },
            onCameraCaptureResumeFailed = {
                runOnUiThread {
                    if (!isPkSession && isVideoCall) setCallUiState(CallUIState.CameraUnavailable)
                }
            },
        )

        if (!isPkSession) {
            setCallUiState(CallUIState.Connecting)
        }

        if (isStreamer) {
            updateCallStatus(CallStatus.RINGING)
            if (!isPkSession) {
                CallSoundManager.startOutgoingDialTone(lifecycleScope)
            }
            startCallResponseListener()
            startRingingTimeout()
            rtcManager!!.startCall()
        } else {
            updateCallStatus(CallStatus.CONNECTING)
            rtcManager!!.joinCall()
        }

        // For PK sessions, explicitly register the challenger sink so any late-arriving
        // remote video track is routed to the right tile even if onTrack fires before
        // attachPkChallengerSink would otherwise be wired.
        if (isPkSession) {
            pkChallengerView?.let { rtcManager!!.attachPkChallengerSink(it) }
        }

        if (isPkSession && isStreamer && !pkVideoUsesAgora) {
            startPkHostSpectatorFanoutWhenReady()
        }
        if (isPkSession && !isStreamer && !pkVideoUsesAgora) {
            startPkGuestSpectatorFanoutWhenReady()
        }
    }

    /**
     * Publishes host PK camera/mic to `live_publishers/{streamDoc}/{hostUid}/` so solo live viewers
     * on `rooms/{hostUid}` transition to PK tiles without reconnecting to a new stream id.
     */
    private fun startPkHostSpectatorFanoutWhenReady() {
        val streamDoc = pkFirestoreHostDocId.ifBlank {
            pkArenaSession.value?.hostUserId?.trim().orEmpty()
        }.ifBlank { FirebaseAuth.getInstance().currentUser?.uid.orEmpty() }
        val myUid = FirebaseAuth.getInstance().currentUser?.uid?.trim().orEmpty()
        if (streamDoc.isBlank() || myUid.isBlank()) {
            android.util.Log.w("LiveStreamActivity", "PK host spectator fanout skipped: streamDoc=$streamDoc uid=$myUid")
            return
        }
        lifecycleScope.launch {
            repeat(100) {
                if (teardownHandled) return@launch
                if (rtcManager == null) return@launch
                val (f, v, a) = rtcManager!!.peekFactoryAndLiveTracks()
                if (f != null && v != null && a != null) {
                    runOnUiThread {
                        if (!teardownHandled && pkHostSpectatorFanout == null) {
                            pkHostSpectatorFanout = PkHostSpectatorFanout(streamDoc, myUid, v, a, f)
                            pkHostSpectatorFanout?.start()
                            android.util.Log.d(
                                "LiveStreamActivity",
                                "PK host spectator fanout started live_publishers/$streamDoc/$myUid"
                            )
                        }
                    }
                    return@launch
                }
                delay(120)
            }
            android.util.Log.w("LiveStreamActivity", "PK host spectator fanout: tracks not ready in time")
        }
    }

    /**
     * Reuses PK [WebRTCManager] camera/mic tracks to publish a parallel broadcast tree at
     * `live_publishers/{hostLiveDoc}/{guestUid}/` for spectators already watching `rooms/{hostUid}`.
     */
    private fun startPkGuestSpectatorFanoutWhenReady() {
        val streamDoc = intent.getStringExtra(EXTRA_PK_LIVE_STREAM_DOC_ID)?.trim().orEmpty()
            .ifBlank { overlayPeerId }
        val myUid = FirebaseAuth.getInstance().currentUser?.uid?.trim().orEmpty()
        if (streamDoc.isBlank() || myUid.isBlank()) {
            android.util.Log.w("LiveStreamActivity", "PK guest spectator fanout skipped: streamDoc=$streamDoc uid=$myUid")
            return
        }
        lifecycleScope.launch {
            repeat(100) {
                if (teardownHandled) return@launch
                if (rtcManager == null) return@launch
                val (f, v, a) = rtcManager!!.peekFactoryAndLiveTracks()
                if (f != null && v != null && a != null) {
                    runOnUiThread {
                        if (!teardownHandled && pkSpectatorFanout == null) {
                            pkSpectatorFanout = PkGuestSpectatorFanout(streamDoc, myUid, v, a, f)
                            pkSpectatorFanout?.start()
                            android.util.Log.d(
                                "LiveStreamActivity",
                                "PK guest spectator fanout started live_publishers/$streamDoc/$myUid"
                            )
                        }
                    }
                    return@launch
                }
                delay(120)
            }
            android.util.Log.w("LiveStreamActivity", "PK guest spectator fanout: tracks not ready in time")
        }
    }

    private fun stopPkSpectatorFanout() {
        pkHostSpectatorFanout?.stop()
        pkHostSpectatorFanout = null
        pkSpectatorFanout?.stop()
        pkSpectatorFanout = null
    }

    private fun setupStatusChip() {
        val root = liveStreamBinding.root
        statusChip = TextView(this).apply {
            text = getString(R.string.call_status_connecting)
            setTextColor(0xFFFFFFFF.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, CallStatusChipSpec.CHIP_TEXT_SIZE_SP)
            setPadding(
                dp(CallStatusChipSpec.CHIP_HORIZONTAL_PADDING_DP),
                dp(CallStatusChipSpec.CHIP_VERTICAL_PADDING_DP),
                dp(CallStatusChipSpec.CHIP_HORIZONTAL_PADDING_DP),
                dp(CallStatusChipSpec.CHIP_VERTICAL_PADDING_DP)
            )
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(CallStatusChipSpec.CHIP_CORNER_RADIUS_DP).toFloat()
                setColor(CallStatusChipSpec.CHIP_BG_COLOR)
            }
            elevation = dp(CallStatusChipSpec.CHIP_ELEVATION_DP).toFloat()
        }
        val params = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT,
            FrameLayout.LayoutParams.WRAP_CONTENT
        ).apply {
            gravity = android.view.Gravity.TOP or android.view.Gravity.CENTER_HORIZONTAL
            topMargin = dp(CallStatusChipSpec.CHIP_TOP_MARGIN_DP)
        }
        root.addView(statusChip, params)
    }

    private fun updateCallStatus(status: CallStatus) {
        if (teardownHandled) return
        if (callStatus == status) return
        callStatus = status
        callStatusForUi.value = status
        statusAnimJob?.cancel()

        val visual = CallStatusChipSpec.visualFor(status)
        if (visual.shouldPulse) animateChip(visual) else setChipText(visual)

        if (status != CallStatus.RINGING) {
            CallSoundManager.stopOutgoingDialTone()
        }

        if (status == CallStatus.CONNECTED) {
            CallSoundManager.stopAll()
            ringTimeoutJob?.cancel()
            stopCallResponseListener()
            if (isStreamer && streamSessionStartWallMs == 0L) {
                streamSessionStartWallMs = System.currentTimeMillis()
            }
            if (isPkSession) {
                statusChip.visibility = View.GONE
            } else {
                oneOnOneCallReachedConnected = true
                startCallElapsedTicker()
                // Chamet-style: charge first minute now, then every 60 s (payer only)
                startRealtimeCallBilling()
            }
        }

        if (isPkSession && status != CallStatus.CONNECTED) {
            statusChip.visibility = View.VISIBLE
        }

        if (visual.isTerminal) {
            CallSoundManager.stopAll()
            ringTimeoutJob?.cancel()
            stopCallResponseListener()
            terminalStatusJob?.cancel()
            terminalStatusJob = lifecycleScope.launch {
                delay(CallStatusChipSpec.TERMINAL_HOLD_MS)
                endRegularCallAndReturn()
            }
        }
    }

    private fun animateChip(visual: CallStatusChipSpec.Visual) {
        statusAnimJob = lifecycleScope.launch {
            while (true) {
                val min = CallStatusChipSpec.PULSE_MIN_ALPHA
                val max = CallStatusChipSpec.PULSE_MAX_ALPHA
                val step = 0.08f * statusPulseDirection
                currentPulseAlpha = (currentPulseAlpha + step).coerceIn(min, max)
                if (currentPulseAlpha == min || currentPulseAlpha == max) statusPulseDirection *= -1
                val alphaColor = withAlpha(visual.colorInt, currentPulseAlpha)
                statusChip.setTextColor(alphaColor)
                statusChip.text = "${visual.glyph} ${visual.label}"
                delay(CallStatusChipSpec.PULSE_DURATION_MS / 10)
            }
        }
    }

    private fun setChipText(visual: CallStatusChipSpec.Visual) {
        currentPulseAlpha = CallStatusChipSpec.PULSE_MIN_ALPHA
        statusPulseDirection = 1
        statusChip.setTextColor(visual.colorInt)
        statusChip.text = "${visual.glyph} ${visual.label}"
    }

    private fun startCallResponseListener() {
        if (!isStreamer) return
        val callerId = FirebaseAuth.getInstance().currentUser?.uid ?: return
        val expectedRoomId = roomId ?: return
        callResponseListener = object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                val payload = snapshot.value as? Map<*, *> ?: return
                val payloadRoomId = payload["roomId"]?.toString() ?: return
                if (payloadRoomId != expectedRoomId) return
                when (payload["status"]?.toString()) {
                    "accepted" -> {
                        updateCallStatus(CallStatus.CONNECTING)
                        joinAgoraPrivateVideoAfterAcceptIfNeeded()
                    }
                    "busy" -> updateCallStatus(CallStatus.BUSY)
                    "declined" -> updateCallStatus(CallStatus.DECLINED)
                }
            }

            override fun onCancelled(error: DatabaseError) = Unit
        }
        callResponsesRef.child(callerId).addValueEventListener(callResponseListener as ValueEventListener)
    }

    private fun stopCallResponseListener() {
        val callerId = FirebaseAuth.getInstance().currentUser?.uid ?: return
        callResponseListener?.let { listener ->
            callResponsesRef.child(callerId).removeEventListener(listener)
        }
        callResponseListener = null
    }

    private fun startRingingTimeout() {
        ringTimeoutJob?.cancel()
        ringTimeoutJob = lifecycleScope.launch {
            delay(30_000)
            if (callStatus != CallStatus.CONNECTED && !teardownHandled) {
                updateCallStatus(CallStatus.TIMEOUT)
            }
        }
    }

    private fun dp(value: Int): Int {
        return TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            value.toFloat(),
            resources.displayMetrics
        ).toInt()
    }

    private fun ensureCallUiOverlay() {
        if (callUiOverlay != null) return
        val parent = liveStreamBinding.standardCallContainer
        val overlay = FrameLayout(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            visibility = View.GONE
            isClickable = true
            isFocusable = true
        }
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER,
            )
        }
        val spinner = ProgressBar(this)
        val msg = TextView(this).apply {
            gravity = Gravity.CENTER
            setTextColor(0xFFFFFFFF.toInt())
            textSize = 16f
            setPadding(dp(16), dp(12), dp(16), 0)
        }
        val btnRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            visibility = View.GONE
            setPadding(0, dp(20), 0, 0)
        }
        val btnPrimary = Button(this)
        val btnSecondary = Button(this)
        val rowMargin = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = 0 }
        column.addView(spinner)
        column.addView(msg, rowMargin)
        val primaryLp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply { marginEnd = dp(8) }
        btnRow.addView(btnPrimary, primaryLp)
        btnRow.addView(btnSecondary)
        column.addView(btnRow)
        overlay.addView(column)
        parent.addView(overlay)
        overlay.bringToFront()
        callUiOverlay = overlay
        callUiSpinner = spinner
        callUiMessage = msg
        callUiButtonRow = btnRow
        callUiBtnPrimary = btnPrimary
        callUiBtnSecondary = btnSecondary
    }

    private fun applyCallUiState(state: CallUIState) {
        currentCallUiState = state
        if (isPkSession) {
            callUiOverlay?.visibility = View.GONE
            return
        }
        when (state) {
            CallUIState.Hidden -> {
                callUiOverlay?.visibility = View.GONE
                return
            }
            else -> Unit
        }
        ensureCallUiOverlay()
        val overlay = callUiOverlay ?: return
        val spinner = callUiSpinner ?: return
        val msg = callUiMessage ?: return
        val row = callUiButtonRow ?: return
        val b1 = callUiBtnPrimary ?: return
        val b2 = callUiBtnSecondary ?: return

        overlay.visibility = View.VISIBLE
        overlay.bringToFront()
        b1.setOnClickListener(null)
        b2.setOnClickListener(null)

        when (state) {
            CallUIState.Connecting -> {
                overlay.setBackgroundColor(0x66000000.toInt())
                spinner.visibility = View.VISIBLE
                msg.text = "Connecting..."
                row.visibility = View.GONE
            }
            is CallUIState.Reconnecting -> {
                overlay.setBackgroundColor(0x99000000.toInt())
                spinner.visibility = View.VISIBLE
                msg.text =
                    "Reconnecting... (attempt ${state.attempt}/${state.maxAttempts})"
                row.visibility = View.GONE
            }
            CallUIState.PeerDisconnected -> {
                overlay.setBackgroundColor(0xCC000000.toInt())
                spinner.visibility = View.GONE
                msg.text = "User disconnected"
                row.visibility = View.VISIBLE
                b1.visibility = View.VISIBLE
                b2.visibility = View.GONE
                b1.text = getString(R.string.call_end_stream)
                b1.setOnClickListener { endRegularCallAndReturn() }
            }
            CallUIState.CameraUnavailable -> {
                overlay.setBackgroundColor(0xCC000000.toInt())
                spinner.visibility = View.GONE
                msg.text = "Camera unavailable"
                row.visibility = View.VISIBLE
                b1.visibility = View.VISIBLE
                b2.visibility = View.VISIBLE
                b1.text = "Retry"
                b2.text = getString(R.string.call_end_stream)
                b1.setOnClickListener { retryCameraAfterUnavailable() }
                b2.setOnClickListener { endRegularCallAndReturn() }
            }
            CallUIState.CallFailed -> {
                overlay.setBackgroundColor(0xCC000000.toInt())
                spinner.visibility = View.GONE
                msg.text = "Call failed"
                row.visibility = View.VISIBLE
                b1.visibility = View.VISIBLE
                b2.visibility = View.VISIBLE
                b1.text = "Retry"
                b2.text = getString(R.string.call_end_stream)
                b1.setOnClickListener { retryWebRtcAfterCallFailure() }
                b2.setOnClickListener { endRegularCallAndReturn() }
            }
            CallUIState.Hidden -> Unit
        }
    }

    private fun setCallUiState(state: CallUIState) {
        runOnUiThread {
            if (teardownHandled && state != CallUIState.Hidden) return@runOnUiThread
            applyCallUiState(state)
        }
    }

    private fun retryCameraAfterUnavailable() {
        if (privateVideoUsesAgora) {
            applyAgoraVideoBindings()
            setCallUiState(CallUIState.Hidden)
            return
        }
        if (rtcManager == null) return
        rtcManager!!.resumeCapturingFrames()
        setCallUiState(CallUIState.Hidden)
    }

    private fun retryWebRtcAfterCallFailure() {
        if (isPkSession || teardownHandled) return
        runCatching { rtcManager?.onDestroy() }
        rtcManager = null
        teardownAgoraPrivateVideo()
        setCallUiState(CallUIState.Connecting)
        startLiveStream()
    }

    private fun withAlpha(color: Int, alpha: Float): Int {
        val a = (alpha.coerceIn(0f, 1f) * 255).toInt()
        return (color and 0x00FFFFFF) or (a shl 24)
    }

    private fun flushStreamingAnalytics() {
        if (streamingMetricsReported || !isStreamer || streamSessionStartWallMs == 0L) return
        streamingMetricsReported = true
        val uid = FirebaseAuth.getInstance().currentUser?.uid ?: return
        val mins =
            ((System.currentTimeMillis() - streamSessionStartWallMs) / 60_000L).toInt().coerceAtLeast(1)
        streamSessionStartWallMs = 0L
        lifecycleScope.launch {
            runCatching { firebaseService.addHostStreamingMinutes(uid, mins) }
        }
    }

    private fun decrementViewerIfNeeded() {
        if (!didIncrementViewerAsGuest) return
        val streamDocId = firestoreLiveStreamAudienceDocId().takeIf { it.isNotBlank() } ?: return
        didIncrementViewerAsGuest = false
        lifecycleScope.launch(Dispatchers.IO) {
            runCatching { firebaseService.incrementLiveStreamViewers(streamDocId, -1) }
                .onFailure { android.util.Log.w("LiveStreamActivity", "incrementLiveStreamViewers -1", it) }
        }
    }

    /** User tapped End / X / back — confirm before tearing down WebRTC. */
    private fun confirmUserCloseThen(action: () -> Unit) {
        if (teardownHandled) return
        pendingCloseConfirmAction = action
        showCloseConfirmDialog.value = true
    }

    /**
     * PK arena row: opponent tile removed so the remaining battler (host camera) is full-width.
     * Pair with [applyPkSoloFullScreenArenaLayout] so the arena uses all space above the chat panel.
     *
     * [R.id.pk_arena_row] is a horizontal [LinearLayout] inside a [FrameLayout] (width match_parent in XML).
     * [View.GONE] alone can still leave a 50/50 weight budget; we **detach** the challenger so measurement
     * cannot reserve space. [LinearLayout.setWeightSum] is **1**; host gets [MATCH_PARENT] width with **weight 0**.
     */
    private fun applyPkArenaSingleTileLayout() {
        val arenaRow = liveStreamBinding.pkArenaRow
        val host = pkHostView ?: return
        val challenger = pkChallengerView ?: return
        if (challenger.parent == arenaRow) {
            arenaRow.removeView(challenger)
        }
        arenaRow.weightSum = 1f
        val rowLp = arenaRow.layoutParams
        rowLp.width = ViewGroup.LayoutParams.MATCH_PARENT
        arenaRow.layoutParams = rowLp
        val lp = host.layoutParams as LinearLayout.LayoutParams
        lp.width = ViewGroup.LayoutParams.MATCH_PARENT
        lp.height = ViewGroup.LayoutParams.MATCH_PARENT
        lp.weight = 0f
        host.layoutParams = lp
        host.requestLayout()
        arenaRow.requestLayout()
    }

    /** Expand video arena to all space above the audience Compose panel (vs fixed ~5:2 split). */
    private fun applyPkSoloFullScreenArenaLayout() {
        if (!isPkSession) return
        val splitRoot = liveStreamBinding.pkSplitRoot
        if (splitRoot.childCount < 2) return
        val arenaWrapper = splitRoot.getChildAt(0)
        val audiencePanel = liveStreamBinding.pkAudiencePanel
        val lpArena = arenaWrapper.layoutParams as LinearLayout.LayoutParams
        lpArena.weight = 1f
        lpArena.height = 0
        val lpAud = audiencePanel.layoutParams as LinearLayout.LayoutParams
        lpAud.weight = 0f
        lpAud.height = LinearLayout.LayoutParams.WRAP_CONTENT
        arenaWrapper.layoutParams = lpArena
        audiencePanel.layoutParams = lpAud
        splitRoot.requestLayout()
    }

    /** Restore 50/50 tiles and ~5:2 arena/audience split when a new PK round starts (e.g. rematch). */
    private fun restorePkSplitArenaLayout() {
        if (!isPkSession) return
        pkSoloAfterBattleChrome.value = false
        val splitRoot = liveStreamBinding.pkSplitRoot
        if (splitRoot.childCount < 2) return
        val arenaWrapper = splitRoot.getChildAt(0)
        val audiencePanel = liveStreamBinding.pkAudiencePanel
        val lpArena = arenaWrapper.layoutParams as LinearLayout.LayoutParams
        lpArena.weight = 11f
        lpArena.height = 0
        val lpAud = audiencePanel.layoutParams as LinearLayout.LayoutParams
        lpAud.weight = 9f
        lpAud.height = 0
        arenaWrapper.layoutParams = lpArena
        audiencePanel.layoutParams = lpAud
        val arenaRow = liveStreamBinding.pkArenaRow
        val rowLp = arenaRow.layoutParams
        rowLp.width = ViewGroup.LayoutParams.MATCH_PARENT
        arenaRow.layoutParams = rowLp
        arenaRow.weightSum = 2f
        pkChallengerView?.let { challenger ->
            if (challenger.parent == null) {
                arenaRow.addView(challenger)
            }
            challenger.visibility = View.VISIBLE
            val gLp = challenger.layoutParams as LinearLayout.LayoutParams
            gLp.weight = 1f
            gLp.width = 0
            gLp.height = ViewGroup.LayoutParams.MATCH_PARENT
            challenger.layoutParams = gLp
        }
        pkHostView?.let { host ->
            val hLp = host.layoutParams as LinearLayout.LayoutParams
            hLp.weight = 1f
            hLp.width = 0
            hLp.height = ViewGroup.LayoutParams.MATCH_PARENT
            host.layoutParams = hLp
            host.requestLayout()
        }
        pkChallengerView?.requestLayout()
        splitRoot.requestLayout()
        arenaRow.requestLayout()
    }

    /**
     * PK host in [LiveStreamActivity]: return to [MainActivity] and start random PK matchmaking
     * (same contract as [EXTRA_PK_FIND_RANDOM_MATCH] from challenger).
     */
    private fun hostFindAnotherRandomPkOpponent() {
        if (teardownHandled || !isStreamer || !isPkSession) return
        val dur = pkArenaSession.value?.durationSeconds?.coerceIn(60, 3600) ?: 300
        teardownHandled = true
        unbindPrivateCallForProcessTeardown()
        playingGiftOverlay.value = null
        callSessionRemoteEndJob?.cancel()
        callSessionRemoteEndJob = null
        stopPkSpectatorFanout()
        pkGiftSheetVisible.value = false
        callElapsedTickJob?.cancel()
        callElapsedTickJob = null
        CallSoundManager.stopAll()
        decrementViewerIfNeeded()
        liveFirestoreOverlayJob?.cancel()
        liveFirestoreOverlayJob = null
        flushStreamingAnalytics()
        ringTimeoutJob?.cancel()
        statusAnimJob?.cancel()
        terminalStatusJob?.cancel()
        stopCallResponseListener()
        rtcManager?.onDestroy()
        rtcManager = null
        setResult(
            RESULT_OK,
            android.content.Intent().apply {
                putExtra(EXTRA_PK_FIND_RANDOM_MATCH, true)
                putExtra(EXTRA_PK_DURATION_SECONDS, dur)
            },
        )
        finish()
    }

    /**
     * Challenger: tear down 1:1 peer, clear Firestore PK mirrors, emit [FirebaseService.emitEndPkStayLiveSignal],
     * then return to MainActivity to start random PK matchmaking.
     */
    private fun challengerFindAnotherOpponent() {
        if (teardownHandled || isStreamer) return
        val dur = pkArenaSession.value?.durationSeconds?.coerceIn(60, 3600) ?: 300
        dismissChallengerPkContinueSolo()
        setResult(
            RESULT_OK,
            android.content.Intent().apply {
                putExtra(EXTRA_PK_FIND_RANDOM_MATCH, true)
                putExtra(EXTRA_PK_DURATION_SECONDS, dur)
            }
        )
        finish()
    }

    /**
     * Challenger post-PK: stay in activity in solo chrome — tear down 1:1 peer only,
     * clear Firestore PK mirrors, emit [FirebaseService.emitEndPkStayLiveSignal].
     */
    private fun dismissChallengerPkContinueSolo() {
        if (teardownHandled || isStreamer) return
        val s = pkArenaSession.value ?: return
        val rid = roomId?.trim().orEmpty()
        val hostDoc = pkFirestoreHostDocId.ifBlank { s.hostUserId.trim() }
        showPkEndedContinueInterstitial.value = false
        lifecycleScope.launch {
            if (rid.isNotEmpty()) {
                runCatching { firebaseService.emitEndPkStayLiveSignal(rid, hostDoc) }
            }
            runCatching { firebaseService.clearLiveStreamPkBattleMirrors(s.hostUserId, s.guestUserId) }
        }
        ignoreNextPeerDisconnectForPkSolo = true
        rtcManager?.endPeerSessionOnly()
        applyPkArenaSingleTileLayout()
        applyPkSoloFullScreenArenaLayout()
        pkArenaSession.value = null
        pkSoloAfterBattleChrome.value = true
        lifecycleScope.launch {
            delay(320)
            runCatching { rtcManager?.refreshVideoSinkAttachments("pk_challenger_dismiss_solo") }
        }
    }

    private fun endPkAndReturn() {
        if (teardownHandled) return
        teardownHandled = true
        unbindPrivateCallForProcessTeardown()
        playingGiftOverlay.value = null
        callSessionRemoteEndJob?.cancel()
        callSessionRemoteEndJob = null
        stopPkSpectatorFanout()
        pkGiftSheetVisible.value = false
        callElapsedTickJob?.cancel()
        callElapsedTickJob = null
        CallSoundManager.stopAll()
        decrementViewerIfNeeded()
        liveFirestoreOverlayJob?.cancel()
        liveFirestoreOverlayJob = null
        flushStreamingAnalytics()
        ringTimeoutJob?.cancel()
        statusAnimJob?.cancel()
        terminalStatusJob?.cancel()
        stopCallResponseListener()
        rtcManager?.onDestroy()
        rtcManager = null
        setResult(
            RESULT_OK,
            android.content.Intent().apply { putExtra(EXTRA_PK_ENDED, true) }
        )
        finish()
    }

    private fun endRegularCallAndReturn() {
        if (teardownHandled) return
        setCallUiState(CallUIState.Hidden)
        callSessionRemoteEndJob?.cancel()
        callSessionRemoteEndJob = null
        teardownHandled = true
        // Stop per-minute billing job immediately so no extra charge fires during teardown
        realtimeBillingJob?.cancel()
        realtimeBillingJob = null
        playingGiftOverlay.value = null

        // If Chamet-style per-minute billing already ran, skip the legacy bulk post-call charge
        // to avoid double-billing. Legacy path is only used as fallback if billing never started
        // (e.g. very old code path or PK session guard bypassed).
        val needLegacyCharge = !isPkSession && oneOnOneCallReachedConnected && isStreamer &&
            !realtimeBillingRan
        val uidCharge  = FirebaseAuth.getInstance().currentUser?.uid?.trim().orEmpty()
        val peerCharge = overlayPeerId.trim()
        val elapsedCharge = callElapsedSeconds.value
        val rateCharge = callDiamondRatePerMinute.value
        if (needLegacyCharge && uidCharge.isNotEmpty() && peerCharge.isNotEmpty() &&
            elapsedCharge > 0 && rateCharge > 0) {
            lifecycleScope.launch {
                withContext(Dispatchers.IO) {
                    runCatching {
                        firebaseService.chargeCallDiamondSessionWithAgentSplit(
                            uidCharge, peerCharge, elapsedCharge, rateCharge
                        )
                    }.onFailure { e ->
                        android.util.Log.w("LiveStreamActivity", "legacyChargeCallDiamond", e)
                    }
                }
                finishEndRegularCallSequence()
            }
        } else {
            finishEndRegularCallSequence()
        }
    }

    private fun finishEndRegularCallSequence() {
        unbindPrivateCallForProcessTeardown()
        callElapsedTickJob?.cancel()
        callElapsedTickJob = null
        CallSoundManager.stopAll()
        decrementViewerIfNeeded()
        liveFirestoreOverlayJob?.cancel()
        liveFirestoreOverlayJob = null
        flushStreamingAnalytics()
        ringTimeoutJob?.cancel()
        statusAnimJob?.cancel()
        terminalStatusJob?.cancel()
        stopCallResponseListener()
        teardownAgoraPrivateVideo()
        rtcManager?.onDestroy()
        rtcManager = null
        setResult(
            RESULT_OK,
            android.content.Intent().apply {
                putExtra(EXTRA_CALL_ENDED, true)
                putExtra(EXTRA_ROOM_ID, roomId)
            }
        )
        finish()
    }

    // ── Picture-in-Picture ──────────────────────────────────────────────────────
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        enterPipIfActive()
    }

    private fun enterPipIfActive() {
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.O) return
        // Only enter PiP if there is an active media stream (not on confirmation dialog or idle)
        if (!isStreamer && !isPkSession && !oneOnOneCallReachedConnected) return
        try {
            val params = android.app.PictureInPictureParams.Builder()
                .setAspectRatio(android.util.Rational(9, 16))
                .build()
            enterPictureInPictureMode(params)
        } catch (e: Exception) {
            android.util.Log.w("LiveStreamActivity", "enterPictureInPictureMode failed", e)
        }
    }

    override fun onPictureInPictureModeChanged(
        isInPictureInPictureMode: Boolean,
        newConfig: android.content.res.Configuration
    ) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        // Hide all Compose overlays (chat, controls, buttons) when in PiP; restore when returning.
        val overlayVisibility = if (isInPictureInPictureMode) View.GONE else View.VISIBLE
        runOnUiThread {
            if (isPkSession) {
                // PK layout: audience panel + arena HUD + gift overlay
                liveStreamBinding.composePkAudience.visibility = overlayVisibility
                liveStreamBinding.composePkArenaHud.visibility = overlayVisibility
            } else {
                // Standard 1:1 layout: top and bottom Compose bands
                liveStreamBinding.composeOverlayTop.visibility = overlayVisibility
                liveStreamBinding.composeOverlayBottom.visibility = overlayVisibility
            }
            // Gift overlay is always hidden in PiP
            liveStreamBinding.composeGiftOverlay.visibility = overlayVisibility
        }
    }
    // ───────────────────────────────────────────────────────────────────────────

    @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        confirmUserCloseThen {
            if (isPkSession) endPkAndReturn() else endRegularCallAndReturn()
        }
    }

    override fun onDestroy() {
        // Host must drop Firestore live state even on swipe-kill / crash teardown paths (stale "Live" ghosts).
        if (isStreamer) {
            val hostUid = FirebaseAuth.getInstance().currentUser?.uid?.trim().orEmpty()
            val streamDoc = roomId?.trim().orEmpty().takeIf { it.isNotEmpty() }
            if (hostUid.isNotEmpty()) {
                @OptIn(kotlinx.coroutines.DelicateCoroutinesApi::class)
                GlobalScope.launch(Dispatchers.IO + NonCancellable) {
                    runCatching { firebaseService.endLiveStream(hostUid, streamDoc) }
                        .onFailure { e ->
                            android.util.Log.e("LiveStreamActivity", "endLiveStream onDestroy host=$hostUid", e)
                        }
                }
            }
        }
        if (!teardownHandled) {
            decrementViewerIfNeeded()
        }
        // Best-effort signaling even when teardownHandled is already true (e.g. diamond charge defers
        // [finishEndRegularCallSequence]); companion is cleared only after that runs or here via fire/unbind.
        if (!isPkSession && roomId?.startsWith("call_") == true) {
            firePrivateCallSignalingTeardownIfBound(firebaseService)
        }
        unbindPrivateCallForProcessTeardown()
        liveFirestoreOverlayJob?.cancel()
        flushStreamingAnalytics()
        // Restore audio routing so the system reverts to its default mode after the call.
        runCatching {
            @Suppress("DEPRECATION")
            val am = getSystemService(AUDIO_SERVICE) as AudioManager
            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn = false
            am.mode = AudioManager.MODE_NORMAL
        }
        CallSoundManager.stopAll()
        detachPkRematchListenersActivity()
        callSessionRemoteEndJob?.cancel()
        callSessionRemoteEndJob = null
        super.onDestroy()
        ringTimeoutJob?.cancel()
        statusAnimJob?.cancel()
        terminalStatusJob?.cancel()
        stopCallResponseListener()
        stopPkSpectatorFanout()
        teardownAgoraPrivateVideo()
        if (rtcManager != null) {
            if (!teardownHandled) {
                runCatching { rtcManager!!.onDestroy() }
            }
        }
        rtcManager = null
    }

    @Composable
    private fun LiveStreamComposeTheme(
        prefs: AppPreferencesRepository,
        content: @Composable () -> Unit
    ) {
        val themeMode by prefs.themeMode.collectAsStateWithLifecycle(ThemeModePreference.DARK)
        val systemDark = isSystemInDarkTheme()
        val darkTheme = when (themeMode) {
            ThemeModePreference.LIGHT -> false
            ThemeModePreference.DARK -> true
            ThemeModePreference.SYSTEM -> systemDark
        }
        BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
            val widthClass = maxWidth.toWindowWidthClass()
            CompositionLocalProvider(LocalWindowWidthClass provides widthClass) {
                DatingAppTheme(darkTheme = darkTheme, content = content)
            }
        }
    }

    companion object {
        const val EXTRA_IS_VIDEO_CALL = "is_video_call"
        const val EXTRA_IS_PK_SESSION = "is_pk_session"
        const val EXTRA_PK_ENDED = "pk_ended"
        /** Challenger chose random PK matchmaking after post-battle screen; [MainActivity] starts [DatingViewModel.startRandomPk]. */
        const val EXTRA_PK_FIND_RANDOM_MATCH = "pk_find_random_match"
        const val EXTRA_CALL_ENDED = "call_ended"
        const val EXTRA_ROOM_ID = "room_id"
        const val EXTRA_OVERLAY_PEER_ID = "overlay_peer_id"
        const val EXTRA_OVERLAY_PEER_NAME = "overlay_peer_name"
        const val EXTRA_OVERLAY_PEER_PHOTO = "overlay_peer_photo"
        /** Wall clock [System.currentTimeMillis] when the PK battle timer should start (sync with ViewModel). */
        const val EXTRA_PK_BATTLE_START_MS = "pk_battle_start_ms"
        /** Firestore / RTDB live doc id for the PK host (typically host Firebase uid); used for guest co-publish path. */
        const val EXTRA_PK_LIVE_STREAM_DOC_ID = "pk_live_stream_doc_id"
        /** PK round length in seconds (e.g. 180 or 300). */
        const val EXTRA_PK_DURATION_SECONDS = "pk_duration_seconds"

        /**
         * Firestore `calls/{id}` + RTDB `rooms/{id}` cleanup when the process dies without [finishEndRegularCallSequence].
         * Set from [bindPrivateCallForProcessTeardown]; cleared on graceful exit or after firing.
         */
        @Volatile
        private var privateCallRoomIdForProcessTeardown: String? = null

        fun bindPrivateCallForProcessTeardown(roomId: String, isPkSession: Boolean) {
            if (isPkSession) {
                privateCallRoomIdForProcessTeardown = null
                return
            }
            val r = roomId.trim()
            privateCallRoomIdForProcessTeardown = if (r.startsWith("call_")) r else null
        }

        fun unbindPrivateCallForProcessTeardown() {
            privateCallRoomIdForProcessTeardown = null
        }

        /**
         * Best-effort: `calls/{roomId}` → ENDED and RTDB WebRTC room cleared (matches [DatingViewModel.onCallActivityEnded]).
         */
        fun firePrivateCallSignalingTeardownIfBound(firebaseService: FirebaseService) {
            val rid = privateCallRoomIdForProcessTeardown ?: return
            privateCallRoomIdForProcessTeardown = null
            @OptIn(kotlinx.coroutines.DelicateCoroutinesApi::class)
            GlobalScope.launch(Dispatchers.IO + NonCancellable) {
                try {
                    firebaseService.setCallSessionStatus(rid, "ENDED")
                } catch (e: Exception) {
                    android.util.Log.w("LiveStreamActivity", "best-effort setCallSessionStatus ENDED rid=$rid", e)
                }
                try {
                    firebaseService.clearCallRoom(rid)
                } catch (e: Exception) {
                    android.util.Log.w("LiveStreamActivity", "best-effort clearCallRoom rid=$rid", e)
                }
                try {
                    firebaseService.cleanupCallFirestoreSignalingCollections(rid)
                } catch (e: Exception) {
                    android.util.Log.w("LiveStreamActivity", "best-effort cleanupCallFirestore rid=$rid", e)
                }
            }
        }

        /**
         * Backup when [Activity.onDestroy] is skipped (some kill paths); see [DatingApp].
         */
        @JvmStatic
        fun onApplicationProcessLifecycleDestroyed() {
            firePrivateCallSignalingTeardownIfBound(FirebaseService())
        }
    }
}

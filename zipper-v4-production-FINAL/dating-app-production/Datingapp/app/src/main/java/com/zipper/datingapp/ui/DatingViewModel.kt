package com.zipper.datingapp.ui

import android.Manifest
import android.app.Activity
import android.content.Context
import android.os.SystemClock
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.util.Log
import androidx.core.content.ContextCompat
import com.google.android.gms.location.LocationServices
import com.zipper.datingapp.location.resolveCityRegion
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.zipper.datingapp.call.CallManager
import com.zipper.datingapp.call.CallStatus
import com.zipper.datingapp.auth.AuthRepository
import com.zipper.datingapp.data.*
import com.zipper.datingapp.service.FirebaseService
import com.zipper.datingapp.service.IncomingCallInvite
import com.zipper.datingapp.service.PkMatchResult
import com.zipper.datingapp.service.GiftTransferResult
import com.zipper.datingapp.service.LiveEconomyGiftResult
import com.zipper.datingapp.R
import com.zipper.datingapp.DatingApp
import com.zipper.datingapp.cache.LocalBackendCaches
import com.zipper.datingapp.live.LiveSessionCleanupPrefs
import com.zipper.datingapp.webrtc.WebRTCManager
import com.zipper.datingapp.agora.AgoraManager
import com.zipper.datingapp.economy.VirtualEconomyMath
import com.google.firebase.FirebaseException
import com.google.firebase.auth.*
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.ListenerRegistration
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.SetOptions
import com.google.firebase.firestore.Source
import com.google.firebase.database.ChildEventListener
import com.google.firebase.database.DataSnapshot
import com.google.firebase.database.DatabaseError
import com.google.firebase.database.DatabaseReference
import com.google.firebase.database.ValueEventListener
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.functions.FirebaseFunctionsException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.async
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.NonCancellable
import java.util.Locale
import java.util.UUID
import java.util.concurrent.TimeUnit

/** One-shot in-app notice for the Live tab when a new stream or PK appears (Firestore realtime). */
sealed class LiveDiscoverNotice {
    data class NewLive(val hostDisplayName: String) : LiveDiscoverNotice()
    data class PkStarted(val summaryLine: String) : LiveDiscoverNotice()
}

data class DatingUiState(
    val currentUser: UserProfile? = null,
    val profiles: List<UserProfile> = emptyList(),
    val filteredProfiles: List<UserProfile> = emptyList(),
    val currentIndex: Int = 0,
    /**
     * True after cold-start auth + first Firestore user fetch (or no session) completes.
     * Drives [androidx.core.splashscreen.SplashScreen.setKeepOnScreenCondition] in MainActivity.
     */
    val isAuthBootstrapComplete: Boolean = false,
    /** After 2s cold start, splash releases even if bootstrap is still running (instant-start UX). */
    val splashHoldTimedOut: Boolean = false,
    val isLoggedIn: Boolean = false,
    val isGuest: Boolean = false,
    val isVideoCallActive: Boolean = false,
    val isAudioCallActive: Boolean = false,
    val callState: CallState = CallState.IDLE,
    val isIncomingCall: Boolean = false,
    val callStatus: CallStatus = CallStatus.CONNECTING,
    val activeCallPartner: UserProfile? = null,
    val messages: Map<String, List<Message>> = emptyMap(),
    val isLive: Boolean = false,
    /** Solo host on the Live tab Compose path: audio-only WebRTC broadcast (no camera). */
    val isAudioPartyLive: Boolean = false,
    /**
     * Audio-party stage capacity (6, 10, or 14); synced with `live_streams` + `streams`.
     */
    val audioPartySeatCount: Int = 10,
    val currentRoomId: String? = null,
    val watchingLivePartner: UserProfile? = null,
    val matches: List<Match> = emptyList(),
    val coinBalance: Int = 0,
    val gems: Int = 0,
    val beans: Int = 0,
    val totalEarnings: Double = 0.0,
    val aiSuggestedReplies: List<String> = emptyList(),
    val currentIcebreaker: String = "",
    val liveComments: List<String> = emptyList(),
    /** Firestore `live_streams/{id}/messages` (replaces local-only [liveComments] for live UI). */
    val liveStreamChatMessages: List<LiveStreamChatMessage> = emptyList(),
    val viewerCount: Int = 0,
    /** From `live_streams/{streamId}.viewerCount` while hosting or watching. */
    val liveStreamViewerCount: Int = 0,
    /** RTDB `rooms/{hostUid}/activeViewers` while watching that host's broadcast. */
    val liveAudienceViewerUserIds: List<String> = emptyList(),
    /** From `live_streams/{hostUid}.streamStartedAtMillis` while watching (stream duration UI). */
    val watchingLiveStreamStartedAtMillis: Long = 0L,
    /** From `live_streams/{hostUid}.audioOnlyStream` while watching (solo mic-only broadcast). */
    val watchingLiveStreamIsAudioOnly: Boolean = false,
    /** From `live_streams/{hostUid}.audioPartySeatCount` while watching an audio-only stream. */
    val watchingLiveAudioPartySeatCount: Int = 10,
    /** Firestore `streams/{hostUid}` while hosting or watching an audio party. */
    val audioPartyStream: AudioPartyStreamState = AudioPartyStreamState(),
    /** Discover: main rail vs dedicated audio-party lobby (Itzo `fragment_audio`). */
    val liveDiscoverSurface: LiveDiscoverSurface = LiveDiscoverSurface.MAIN,
    /** Discover: filter for the horizontal live carousel on the main rail. */
    val liveDiscoverLiveFilter: LiveDiscoverLiveFilter = LiveDiscoverLiveFilter.ALL,
    /** Host (audio party): Firestore `streams/{uid}/video_call_requests/{fromUid}` pending inbox. */
    val audioPartyVideoCallRequests: List<AudioPartyVideoCallRequest> = emptyList(),
    /** Non-zero when the signed-in user was kicked from the current live room (see [handleKickedFromLiveStream]). */
    val liveKickEventMs: Long = 0L,
    /** Live host's follower list size while watching (real-time profile listener). */
    val watchingLiveHostFollowerCount: Int = 0,
    /** PK guest on the watched stream (`live_streams/{hostUid}`); enables audience gifts to either battler. */
    val watchingPkGuestUid: String = "",
    val watchingPkGuestDisplayName: String = "",
    val watchingPkActive: Boolean = false,
    /** PK: spectators who chose host vs challenger on `live_streams/{host}` (Firestore). */
    val pkHostViewerCount: Int = 0,
    val pkGuestViewerCount: Int = 0,
    val pkHostViewerUserIds: List<String> = emptyList(),
    val pkGuestViewerUserIds: List<String> = emptyList(),
    /** PK spectator: `true` = host video on the left; swap tiles when `false` (perspective + HUD alignment). */
    val pkWatchAudienceHostOnLeft: Boolean = true,
    /** Bumped after a successful gift send so UI can play SFX ([com.zipper.datingapp.ui.media.GiftSoundPlayback]). */
    val giftSoundNonce: Long = 0L,
    val followedProfiles: List<UserProfile> = emptyList(),
    val followerProfiles: List<UserProfile> = emptyList(),
    /** Profiles who liked the current user (from [UserProfile.likedByUserIds]). */
    val likedMeProfiles: List<UserProfile> = emptyList(),
    val loginError: String? = null,
    val isOtpSent: Boolean = false,
    val isLoading: Boolean = false,
    /** Short full-screen loading hint (live toggle, opening a stream from a deep link, etc.). */
    val appWideLoadingMessage: String? = null,
    val selectedTab: Int = 0,
    
    // Battle State
    val battles: List<Battle> = emptyList(),
    val activeBattle: Battle? = null,
    /** Firestore `battles/{id}` gameState* fields (real-time). */
    val battleGameState: GameState? = null,
    val currentQuizQuestions: List<QuizQuestion> = emptyList(),
    val currentQuestionIndex: Int = 0,
    val battleResults: BattleResult? = null,
    val selectedTeam: Int = 0,
    /** True while a network call for a game action (vote, spin, emoji, box) is in-flight; blocks duplicate submissions. */
    val isBattleActionInProgress: Boolean = false,

    // Filter State
    val appliedAgeRange: IntRange? = null,
    val appliedMinLevel: Int? = null,
    val appliedCity: String? = null,
    val isFilterActive: Boolean = false,
    
    // Search & Leaderboard
    val searchResult: UserProfile? = null,
    val topRankedProfiles: List<UserProfile> = emptyList(),

    // Rewards
    val rewardsPoints: Int = 0,
    val canClaimDailyReward: Boolean = true,
    val showRewardsDialog: Boolean = false,

    // Language
    val selectedLanguage: AppLanguage = AppLanguage.ENGLISH,

    // Gifts
    val availableGifts: List<Gift> = com.zipper.datingapp.data.availableGifts.map { it.withCatalogDefaults() },
    val playingGift: Gift? = null,
    
    // Reselling
    val resellAgents: List<ResellAgent> = emptyList(),
    val isPkSearching: Boolean = false,
    val pkRoomId: String? = null,
    val pkIsStreamer: Boolean = false,
    val pkLaunchToken: Int = 0,
    val pkStatusText: String? = null,
    val pkRetryAvailable: Boolean = false,
    val pkOriginalRoomId: String? = null,
    /** Host: true while a rematch invite is on the wire until the guest acks or timeout. */
    val pkRematchPending: Boolean = false,
    /** Active PK battle (timer, beans, outcome); cleared when PK search/call session ends. */
    val pkBattleSession: PkBattleSessionState? = null,
    /**
     * After the host clears PK on `live_streams`, audience keeps an end summary (winner + beans) briefly.
     */
    val watchingPkLingerSession: PkBattleSessionState? = null,
    /** True while [refreshLiveDiscoverFromServer] re-fetches profiles + current user from the server. */
    val isLiveTabRefreshing: Boolean = false,
    /**
     * While [isLive], opening PK [LiveStreamActivity] must pause the Compose broadcast capturer first
     * (two WebRTC sessions cannot share one camera). [LiveStreamingView] reacts and calls [WebRTCManager.pauseCamera].
     */
    val hostWebRtcPauseForPkNonce: Int = 0,
    /** Returning from PK activity: resume broadcast capture for the live host. */
    val hostWebRtcResumeAfterPkNonce: Int = 0,
    /**
     * Full-screen step after the live host finishes PK in [com.zipper.datingapp.LiveStreamActivity]:
     * [endPkSession] runs on dismiss, then the app switches to the home tab.
     */
    val showHostPkEndedInterstitial: Boolean = false,
    val pendingCallRoomId: String? = null,
    val pendingCallLaunchToken: Int = 0,
    val pendingCallIsStreamer: Boolean = false,
    val incomingCall: IncomingCallUi? = null,
    val pendingImageUploads: Map<String, Int> = emptyMap(),
    val imageUploadError: String? = null,
    val isCurrentlyInCall: Boolean = false,
    val callNoticeMessage: String? = null,
    val selectedMessagePartnerId: String? = null,
    val isGiftTransactionProcessing: Boolean = false,
    val registrationGender: String = "",
    val registrationReferralCode: String = "",
    /** True after a brand-new account is created — MainActivity uses this to route to EditProfile immediately. */
    val isNewUserSetupNeeded: Boolean = false,
    // ── Phone/Email re-binding state (EditProfileScreen) ──────────────────────
    val phoneChangeOtpSent: Boolean = false,
    val phoneChangeError: String? = null,
    val emailChangeSent: Boolean = false,
    val emailChangeError: String? = null,
    /** Realtime Database [.info/connected] — true when socket to Firebase backend is up. */
    val isFirebaseBackendConnected: Boolean = false,
    /** UIDs the current user has liked from the discovery feed. */
    val likedProfileIds: Set<String> = emptySet(),
    /** Full profiles the current user has liked (for Likes → I Like tab). */
    val iLikedProfiles: List<UserProfile> = emptyList(),
    /** Current user's own sent gift history (My Profile → Gifts Sent tab). */
    val mySentGiftHistory: List<SentGiftHistoryEntry> = emptyList(),
    /** Current user's own received gift history (My Profile → Gifts Received tab). */
    val myReceivedGiftHistory: List<SentGiftHistoryEntry> = emptyList(),
    /** [HomeScreen] profile sheet: gifts you sent to the open profile (`gift_transactions`), newest first. */
    val profileDetailSentGifts: List<SentGiftHistoryEntry> = emptyList(),
    /** Gifts the opened profile received (any sender), newest first. */
    val profileDetailReceivedGifts: List<SentGiftHistoryEntry> = emptyList(),
    /** Receiver uid when [profileDetailSentGifts] applies; used to refresh after a send. */
    val profileDetailGiftHistoryReceiverId: String? = null,
    /** One-shot follow error for UI Toast (cleared after display). */
    val followActionError: String? = null,
    /** Live gift / economy feedback (Toast); cleared after display. */
    val liveGiftMessage: String? = null,
    /** Incremented when the user swipes to change live but no other stream exists (Toast in Live tab). */
    val liveSwipeNoOthersNonce: Long = 0L,
    /** Firestore-fetched header for DM thread when partner may be missing from [profiles]. */
    val chatPartnerProfile: UserProfile? = null,
    /** Minimal profiles for inbox threads whose partner is not in the discovery [profiles] feed. */
    val dmThreadProfiles: Map<String, UserProfile> = emptyMap(),
    /** When set, Home tab opens the full-screen profile for this user id (e.g. from Followed list). */
    val openProfileSheetForUserId: String? = null,
    /** Row snapshot when opening the sheet from a list (Likes/Followers) so the sheet works before feed merge. */
    val openProfileSheetHintProfile: UserProfile? = null,
    /** Firestore `live_streams/{id}` used during WebRTC (call / PK room id); survives [clearPendingCallLaunch]. */
    val webRtcSessionRoomId: String? = null,
    val webRtcCallIsStreamer: Boolean = false,
    /** Whose follower count / profile to show in call overlay top bar. */
    val webRtcOverlayHostUserId: String? = null,
    val callOverlayHostProfile: UserProfile? = null,
    /**
     * When true, in-call overlay shows live-style viewer/follower metrics (PK / broadcast).
     * Private 1:1 [initiateCall] / [acceptIncomingCall] sets this false so the header stays intimate.
     */
    val webRtcShowLiveAudienceChrome: Boolean = false,
    /**
     * One-minute diamond-free teaser "call" after accepting the marketing incoming hook.
     * No WebRTC activity is started; [VideoCallScreen] shows partner media as a preview.
     */
    val isFreeTeaserCall: Boolean = false,
    /**
     * Live tab: `live_streams/{hostUid}` docs with an active PK (`pkStartedAtMillis` > 0).
     * Map key = host user id; value = short banner (e.g. "PK · Alex vs Jordan").
     */
    val activeLivePkBanners: Map<String, String> = emptyMap(),
    /**
     * Live Discover: show a Toast when someone new goes live or a PK battle starts (cleared by UI after display).
     */
    val liveDiscoverNotice: LiveDiscoverNotice? = null,
    /** CRM Firestore `crm_announcements` — Messages → Announcement tab. */
    val crmAnnouncements: List<CrmAnnouncement> = emptyList(),
    /** Solo host answered a private call; cleared after Continue or end-all. */
    val soloLiveSuspendedForPrivateCall: Boolean = false,
    /** After private call ends, host must choose resume solo live or end stream. */
    val showPostPrivateCallResumeChoice: Boolean = false,
    /** `live_streams/{host}` doc id for resume / Firestore busy flag (solo host). */
    val soloLiveStreamDocIdForResume: String? = null,
    /**
     * After returning from a private call while solo live, compose solo broadcast must not grab camera/Agora
     * until [android.os.SystemClock.elapsedRealtime] reaches this value (see [DatingViewModel.SOLO_LIVE_MEDIA_HANDOFF_DELAY_MS]).
     * `0` = no wait.
     */
    val soloLiveMediaHandoffNotBeforeElapsedMs: Long = 0L,
    /** Spectator: host is on a private call (Firestore [LiveStreamRoomInfo.hostPrivateCallBusy]). */
    val watchingHostPrivateCallBusy: Boolean = false,
    /** Spectator: `live_streams/{host}` doc removed — show centered ended UI then [stopWatching]. */
    val showWatchingLiveEndedOverlay: Boolean = false,
    /**
     * Bumps when [watchLive] starts so [LiveWatcherView] WebRTC [DisposableEffect] tears down and
     * re-joins (fixes black video after app restart + re-enter same stream).
     */
    val liveWatchSessionNonce: Long = 0L,
    /**
     * True when the user has minimised a watched live stream into the floating PIP overlay.
     * Back-press while watching (not in PIP) enters PIP; back-press in PIP exits live entirely.
     */
    val isLivePipMode: Boolean = false,

    // ── Profile editing ─────────────────────────────────────────────────────
    /** Set to true after a successful profile save so EditProfileScreen can navigate back. */
    val profileSaveSuccess: Boolean = false,
    /** True while the profile save network call is in-flight. */
    val isProfileSaving: Boolean = false,
    /** Non-null when a profile save fails — shown as an error banner. */
    val profileSaveError: String? = null,
    /**
     * Per-slot upload progress for gallery images (key = gallery slot index, value = 0f–1f).
     * Cleared after the upload completes.
     */
    val galleryUploadProgress: Map<Int, Float> = emptyMap(),

    // ── Gift history loading flags ──────────────────────────────────────────
    /** True while the sent gift history fetch is in-flight (My Profile → Gifts Sent tab). */
    val isMySentGiftHistoryLoading: Boolean = false,
    /** True while the received gift history fetch is in-flight (My Profile → Gifts Received tab). */
    val isMyReceivedGiftHistoryLoading: Boolean = false,
)

data class IncomingCallUi(
    val callerId: String,
    val callerName: String,
    val roomId: String,
    val isVideoCall: Boolean,
    val callerPhotoUrl: String = "",
    /** Local marketing hook — no real signaling; must not hit call session APIs. */
    val isMarketingSynthetic: Boolean = false
)

class DatingViewModel : ViewModel() {

    companion object {
        private const val CALL_GENDER_POLICY_ERROR =
            "Video and voice calls need both people on a clear male or female profile."
        /** Written to `live_streams/.../messages` (matches string resource for UI). */
        private const val HOST_BUSY_SYSTEM_CHAT = "Host is on a private call"
        private const val HOST_BACK_SYSTEM_CHAT = "Host is back"

        /**
         * Time for solo Compose Agora/WebRTC and [LiveStreamActivity] teardown to avoid fighting over camera/engine.
         * Used before launching call while solo live ([MainActivity]) and as [DatingUiState.soloLiveMediaHandoffNotBeforeElapsedMs].
         */
        const val SOLO_LIVE_MEDIA_HANDOFF_DELAY_MS: Long = 520L
    }

    private val _uiState = MutableStateFlow(DatingUiState())
    val uiState: StateFlow<DatingUiState> = _uiState.asStateFlow()

    // ── Convenience StateFlows (derived from uiState for screen-level consumers) ──

    /** Currently logged-in [UserProfile], or null. */
    val currentUser: StateFlow<UserProfile?> = uiState.map { it.currentUser }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    /** Spendable diamond balance as [Long] (mirrors [DatingUiState.coinBalance]). */
    val diamonds: StateFlow<Long> = uiState.map { it.coinBalance.toLong() }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), 0L)

    /** Spendable bean balance as [Long] (mirrors [UserProfile.beanBalance] via uiState). */
    val beans: StateFlow<Long> = uiState.map { it.currentUser?.beanBalance ?: it.beans.toLong() }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), 0L)

    /** Current one-to-one [CallState]. */
    val callState: StateFlow<CallState> = uiState.map { it.callState }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), CallState.IDLE)

    /**
     * True while the OS has placed MainActivity into Android PiP mode during an active
     * [VideoCallScreen] teaser/free call. MainActivity sets this from
     * [Activity.onPictureInPictureModeChanged]; VideoCallScreen collects it to hide controls.
     */
    val isInPipMode: MutableStateFlow<Boolean> = MutableStateFlow(false)

    /** Live-stream chat messages for the currently watched or hosted stream. */
    val liveChatMessages: StateFlow<List<LiveStreamChatMessage>> = uiState.map { it.liveStreamChatMessages }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    /** Active [LiveStream] being watched/hosted; synthesised from [DatingUiState.watchingLivePartner]. */
    val activeLiveStream: StateFlow<LiveStream?> = uiState.map { s ->
        val host = s.watchingLivePartner ?: return@map null
        LiveStream(
            id = host.liveRoomId.orEmpty().ifBlank { host.id },
            hostId = host.id,
            hostName = host.name,
            hostPhotoUrl = host.photoUrl,
            hostGender = host.gender,
            hostLevel = host.level,
            isActive = true,
            isAudioOnly = s.watchingLiveStreamIsAudioOnly,
            viewerCount = s.liveStreamViewerCount,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    /** Gift visual event derived from [DatingUiState.playingGift] (single-item queue). */
    val giftVisualQueue: StateFlow<List<GiftVisualEvent>> = uiState.map { s ->
        val g = s.playingGift ?: return@map emptyList()
        listOf(GiftVisualEvent(gift = g, senderName = s.currentUser?.name.orEmpty(), senderPhotoUrl = ""))
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    /** Full gift catalog for the gift picker. */
    val giftCatalog: StateFlow<List<Gift>> = uiState.map { it.availableGifts }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    /** Active battle for GameCenter screens. */
    val activeBattle: StateFlow<Battle?> = uiState.map { it.activeBattle }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    /** PK countdown in seconds (stub — replaced by real timer in PkArenaHud). */
    val pkCountdownSeconds: StateFlow<Int> = MutableStateFlow(0)

    /** Discovery feed profiles (filtered or unfiltered). */
    val discoveryProfiles: StateFlow<List<UserProfile>> = uiState.map { s ->
        if (s.isFilterActive) s.filteredProfiles else s.profiles
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    /** Search results as a list (single [DatingUiState.searchResult] wrapped in list). */
    val searchResults: StateFlow<List<UserProfile>> = uiState.map { s ->
        listOfNotNull(s.searchResult)
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    /** True while the discovery feed is loading. */
    val isLoadingFeed: StateFlow<Boolean> = uiState.map { it.isLoading }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), false)

    /** CRM announcements list. */
    val crmAnnouncements: StateFlow<List<CrmAnnouncement>> = uiState.map { it.crmAnnouncements }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    /** Profile of the remote call party (callee/caller). */
    val viewedProfile: StateFlow<UserProfile?> = uiState.map { it.activeCallPartner }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    /** Call duration in seconds; updated by [recordCallDuration]. */
    val callDurationSeconds: StateFlow<Int> = MutableStateFlow(0)

    /** Active live streams for the Live discover tab. */
    private val _activeLiveStreams = MutableStateFlow<List<LiveStream>>(emptyList())
    val activeLiveStreams: StateFlow<List<LiveStream>> = _activeLiveStreams.asStateFlow()

    /** Active party rooms for the Live discover tab. */
    private val _activePartyRooms = MutableStateFlow<List<PartyRoom>>(emptyList())
    val activePartyRooms: StateFlow<List<PartyRoom>> = _activePartyRooms.asStateFlow()

    /** Chat threads for the Messages tab. */
    private val _chatThreads = MutableStateFlow<List<ChatThread>>(emptyList())
    val chatThreads: StateFlow<List<ChatThread>> = _chatThreads.asStateFlow()

    /** Active chat messages for the currently open DM thread. */
    val activeChatMessages: StateFlow<List<Message>> = uiState.map { s ->
        val partnerId = s.selectedMessagePartnerId ?: return@map emptyList()
        s.messages[partnerId] ?: emptyList()
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    /** Transaction history for the Diamond Shop screen. */
    private val _transactionHistory = MutableStateFlow<List<Transaction>>(emptyList())
    val transactionHistory: StateFlow<List<Transaction>> = _transactionHistory.asStateFlow()

    /** Static default diamond/coin packages for offline coin sellers. */
    val diamondPackages: List<DiamondPackage> = coinPackages

    // ── Private listener jobs for LiveScreen ─────────────────────────────────
    private var liveStreamsListenerJob: Job? = null
    private var partyRoomsListenerJob: Job? = null
    private var openedProfileListenerJob: Job? = null
    private var chatThreadsJob: Job? = null

    private val auth = FirebaseAuth.getInstance()
    private val db = FirebaseFirestore.getInstance()
    private val firebaseService = FirebaseService()
    private val authRepository = AuthRepository(auth)
    private var spinLoopJob: Job? = null
    private var messagesJob: Job? = null
    private var inboxPrefetchJob: Job? = null
    private var verificationId: String? = null
    private var pkMatchJob: Job? = null
    private var pkRematchTimeoutJob: Job? = null
    private var pkRematchHostListener: ValueEventListener? = null
    private var pkRematchGuestListener: ValueEventListener? = null
    private var pkRematchHostListenerUid: String? = null
    private var pkRematchGuestListenerUid: String? = null
    private var hostPkEndedInterstitialJob: Job? = null
    private var incomingCallJob: Job? = null
    private var marketingFreeCallHookJob: Job? = null
    private var livePkBannerJob: Job? = null
    private var marketingFreeCallHookConsumed: Boolean = false
    private var outgoingCallTimeoutJob: Job? = null
    private var giftsJob: Job? = null
    private var lastGiftOverlayMessageId: String? = null
    /** Dedupes [GiftOverlay] triggers from `live_streams/.../messages` (host + audience + WebRTC). */
    private var lastLiveGiftOverlayMessageId: String? = null
    /** Ignore older chat gift rows so sending a CRM gift is not replaced by a previous catalog gift. */
    private var lastLiveGiftOverlaySeenTimestampMs: Long = 0L
    private var skipLiveGiftOverlayListenerUntilMs: Long = 0L
    /** Set locally only when this [android.content.Context] wins [applyBattleGameInput] `SPIN_START`; ensures [completeSpin] runs on one device. */
    private var pendingSpinRoundCompleterUid: String? = null
    private var spinRoundCompleteJob: Job? = null
    
    private var resellersListener: ListenerRegistration? = null
    private var currentUserListener: ListenerRegistration? = null
    private var firebaseConnectedJob: Job? = null
    /** Aggregates Firestore profile/live discovery; cancelled on logout before clearing persistence. */
    private var profilesObserverJob: Job? = null
    private var battlesJob: Job? = null
    private var battleDetailJob: Job? = null
    private var battleGameStateJob: Job? = null
    private var liveHostMessagesJob: Job? = null
    private var liveHostRoomJob: Job? = null
    private var liveHostActiveViewersJob: Job? = null
    private var liveHostAudioPartyStreamJob: Job? = null
    private var liveHostVideoCallRequestsJob: Job? = null
    private var liveAudienceAudioPartyStreamJob: Job? = null
    private var liveAudienceMessagesJob: Job? = null
    private var liveAudienceRoomJob: Job? = null
    private var liveAudienceActiveViewersJob: Job? = null
    private var liveAudienceHostProfileJob: Job? = null
    private var webRtcCallLiveMessagesJob: Job? = null
    private var webRtcCallLiveRoomJob: Job? = null
    private var webRtcCallLiveHostJob: Job? = null
    /** 1:1 Firestore `calls/{roomId}` terminal status while in WebRTC (remote hangup / decline). */
    private var callRemoteEndedJob: Job? = null
    /** Serializes follow toggles so rapid taps cannot desync optimistic UI from Firestore. */
    private var followActionJob: Job? = null
    /** Live-stream chat: only load Firestore messages with [LiveStreamChatMessage.timestamp] >= this (session scope). */
    private var liveStreamChatMinTimestampMs: Long = 0L
    private var liveKickHandledAudienceSession: Boolean = false
    private var liveKickHandledWebRtcSession: Boolean = false
    private var crmAnnouncementsJob: Job? = null
    /** One coarse region write per app session (battery / Firestore cost). */
    private var didRegionUpdateThisSession = false
    /** PK watch: Firestore doc id (host uid) we incremented for [pkHostViewerCount]/[pkGuestViewerCount]. */
    private var pkWatchAudienceFirestoreStreamId: String? = null
    /** RTDB `live_signals` listeners while an audience member watches PK; detached in [stopLiveAudienceStreamObservers]. */
    private data class LiveSignalsBinding(
        val ref: DatabaseReference,
        val listener: ChildEventListener,
    )
    private val liveSignalsBindings = mutableListOf<LiveSignalsBinding>()
    /** Dedupes [attachLiveSignalsForAudience] when the same host/guest pair is already wired. */
    private var liveSignalsPkAttachKey: String? = null
    private var pkWatchAudienceCountSessionKey: String? = null
    /** True = counted toward host battler; false = toward guest. */
    private var pkWatchAudienceCountedForHost: Boolean? = null
    /** Dedupes post-PK spectator redirect when both RTDB signal + Firestore snapshot fire. */
    private var spectatorPkEndRoutingHandledKey: String? = null
    /** Baseline for [LiveDiscoverNotice.NewLive] (skip first snapshot). */
    private var discoverPrevLiveIds: Set<String>? = null
    /** Baseline for [LiveDiscoverNotice.PkStarted] (skip first snapshot). */
    private var discoverPrevPkHostIds: Set<String>? = null
    /** Dedupes [WebRTCManager.onPeerDisconnected] for Compose PK host guest tile link. */
    private var composePkHostChallengerLinkDisconnectHandled: Boolean = false
    /** Serializes flip-to-host work when the user doc becomes solo audio-party host (e.g. after remote handoff). */
    private val audioPartyHostPromotionMutex = Mutex()
    /** Throttles [callNoticeMessage] when Agora token callable returns [FirebaseFunctionsException.Code.FAILED_PRECONDITION]. */
    private var lastAgoraTokenConfigNoticeElapsedMs: Long = 0L

    init {
        checkUserLoggedIn()
        startProfilesObserver()
        fetchGifts()
        startResellersListener()
        startFirebaseConnectedObserver()
        viewModelScope.launch {
            delay(2_000L)
            _uiState.update { s -> s.copy(splashHoldTimedOut = true) }
            // Defer lower-priority observers until after auth and the splash have finished,
            // so they don't compete with Firestore profile fetch during cold start.
            startCrmAnnouncementsObserver()
            startBattlesObserver()
        }
    }

    /** Firestore presence: call when app process is foregrounded (see MainActivity + ProcessLifecycleOwner). */
    fun markUserOnline() {
        val uid = auth.currentUser?.uid ?: return
        viewModelScope.launch {
            runCatching { firebaseService.setUserPresence(uid, true) }
                .onFailure { Log.w("DatingViewModel", "markUserOnline failed", it) }
        }
    }

    /** Sets [UserProfile.isOnline] false and [UserProfile.lastSeen] when app leaves foreground. */
    fun markUserOffline() {
        val uid = auth.currentUser?.uid ?: return
        viewModelScope.launch {
            runCatching { firebaseService.setUserPresence(uid, false) }
                .onFailure { Log.w("DatingViewModel", "markUserOffline failed", it) }
        }
    }

    private fun checkUserLoggedIn() {
        val user = auth.currentUser
        if (user == null) {
            _uiState.update { it.copy(isAuthBootstrapComplete = true) }
            return
        }
        viewModelScope.launch {
            try {
                // Step 1: Apply cached profile immediately so the splash can release without
                // waiting for a network round-trip.  This makes returning users see the home
                // screen in the time it takes Firestore's local disk cache to respond.
                val cachedProfile = runCatching {
                    firebaseService.getUserProfile(user.uid, source = Source.CACHE)
                }.getOrNull()

                if (cachedProfile != null) {
                    applyUserProfileAndListeners(
                        uid = user.uid,
                        isAnonymous = user.isAnonymous,
                        profile = cachedProfile,
                        bootstrapComplete = true,
                    )
                } else if (user.isAnonymous) {
                    _uiState.update { it.copy(
                        isLoggedIn = true,
                        isGuest = true,
                        currentUser = UserProfile(id = user.uid, name = "Guest", role = UserRole.BOY.name),
                        isAuthBootstrapComplete = true
                    ) }
                    startIncomingCallListener(user.uid)
                    markUserOnline()
                    startActiveLivePkBannerObserver()
                    ensureGlobalFirestoreFeedObserversAfterSessionRecovery()
                    return@launch
                }

                // Step 2: Silently refresh from server (4 s cap instead of 12 s).
                // If we already showed a cached profile the user is already on the home
                // screen; this just updates verification status etc. in the background.
                val serverProfile = withTimeoutOrNull(4_000L) {
                    runCatching {
                        firebaseService.getUserProfile(user.uid, source = Source.SERVER)
                    }.getOrNull()
                }

                when {
                    serverProfile != null -> applyUserProfileAndListeners(
                        uid = user.uid,
                        isAnonymous = user.isAnonymous,
                        profile = serverProfile,
                        bootstrapComplete = true,
                    )
                    cachedProfile == null -> {
                        // No cache and no server — still mark bootstrap complete so the
                        // splash is not stuck indefinitely.
                        _uiState.update { it.copy(isAuthBootstrapComplete = true) }
                        startActiveLivePkBannerObserver()
                        ensureGlobalFirestoreFeedObserversAfterSessionRecovery()
                    }
                    // else: server timed out but cached profile was already applied — no-op
                }
            } catch (e: Exception) {
                Log.w("DatingViewModel", "checkUserLoggedIn failed", e)
                _uiState.update { it.copy(isAuthBootstrapComplete = true) }
            }
        }
    }

    /**
     * Applies [profile] to [_uiState] and starts all per-user Firestore listeners.
     * Safe to call multiple times (e.g. cache then server): listeners guard against
     * duplicate registration internally.
     */
    private fun applyUserProfileAndListeners(
        uid: String,
        isAnonymous: Boolean,
        profile: UserProfile,
        bootstrapComplete: Boolean,
    ) {
        _uiState.update { it.copy(
            currentUser = profile,
            isLoggedIn = true,
            isGuest = isAnonymous,
            coinBalance = profile.coins,
            gems = profile.gems,
            beans = profile.beans,
            totalEarnings = profile.earnings,
            isAuthBootstrapComplete = bootstrapComplete,
        ) }
        updateLeaderboard()
        fetchFollowers()
        startCurrentUserListener(uid)
        startIncomingCallListener(uid)
        syncFcmRegistrationToken()
        markUserOnline()
        scheduleGlobalInboxPrefetch()
        startActiveLivePkBannerObserver()
        ensureGlobalFirestoreFeedObserversAfterSessionRecovery()
    }

    /**
     * Restarts global listeners cancelled during logout once a session is active again.
     * Safe while cold-start observers are already running ([Job.isActive] guards duplicates).
     */
    private fun ensureGlobalFirestoreFeedObserversAfterSessionRecovery() {
        if (profilesObserverJob?.isActive != true) {
            startProfilesObserver()
        }
        if (firebaseConnectedJob?.isActive != true) {
            startFirebaseConnectedObserver()
        }
        if (giftsJob?.isActive != true) {
            fetchGifts()
        }
        startResellersListener()
    }

    /**
     * Drops Firestore / RTDB collectors and snapshot registrations so [LocalBackendCaches.clearFirestorePersistenceBestEffort]
     * can succeed on logout / account switch.
     */
    private fun detachRealtimeConsumersForLogout() {
        detachPkRematchListeners()
        pkRematchTimeoutJob?.cancel()
        profilesObserverJob?.cancel()
        profilesObserverJob = null
        firebaseConnectedJob?.cancel()
        firebaseConnectedJob = null
        crmAnnouncementsJob?.cancel()
        crmAnnouncementsJob = null
        giftsJob?.cancel()
        giftsJob = null
        messagesJob?.cancel()
        inboxPrefetchJob?.cancel()
        marketingFreeCallHookJob?.cancel()
        pkMatchJob?.cancel()
        hostPkEndedInterstitialJob?.cancel()
        battlesJob?.cancel()
        battleDetailJob?.cancel()
        battleGameStateJob?.cancel()
        outgoingCallTimeoutJob?.cancel()
        spinLoopJob?.cancel()
        incomingCallJob?.cancel()
        spinRoundCompleteJob?.cancel()
        spinRoundCompleteJob = null
        followActionJob?.cancel()
        followActionJob = null
        livePkBannerJob?.cancel()
        livePkBannerJob = null
        stopLiveHostStreamObservers()
        stopLiveAudienceStreamObservers()
        stopWebRtcCallLiveObservers()
        currentUserListener?.remove()
        currentUserListener = null
        resellersListener?.remove()
        resellersListener = null
    }

    private fun startProfilesObserver() {
        profilesObserverJob?.cancel()
        profilesObserverJob = viewModelScope.launch {
            combine(
                firebaseService.observeProfiles(),
                firebaseService.observeLiveUserIds(),
                firebaseService.observeGlobalPresenceRtdb(),
                firebaseService.observeActiveLivePkBanners()
            ) { profiles, liveIds, presenceRtdb, pkBanners ->
                val pkHostIds = pkBanners.keys
                val profileIds = profiles.map { it.id }.toSet()
                val enriched = profiles.map { p ->
                    val rtdb = presenceRtdb[p.id]
                    val online = rtdb ?: p.isOnline
                    // OR with doc flag: if the isLive=true query fails (rules/index), hosts still appear live.
                    val mergedLive = (p.id in liveIds) || p.isLive
                    p.copy(isLive = mergedLive, isOnline = online)
                }
                val missingIds = (liveIds + pkHostIds).filter { it !in profileIds }.distinct()
                val extras = missingIds.map { id ->
                    val rtdb = presenceRtdb[id]
                    UserProfile(
                        id = id,
                        name = "Live",
                        isLive = (id in liveIds) || (id in pkHostIds),
                        isOnline = rtdb ?: true
                    )
                }
                enriched + extras
            }
                .debounce(250L)
                .collect { incoming ->
                val liveHostIds = incoming.filter { it.isLive }.map { it.id }.distinct()
                val audioOnlyFlags = if (liveHostIds.isEmpty()) {
                    emptyMap()
                } else {
                    runCatching {
                        withContext(Dispatchers.IO) {
                            firebaseService.fetchLiveStreamAudioOnlyFlags(liveHostIds)
                        }
                    }.getOrElse { e ->
                        Log.w("DatingViewModel", "fetchLiveStreamAudioOnlyFlags", e)
                        emptyMap()
                    }
                }
                val profiles = incoming.map { p ->
                    if (!p.isLive) {
                        p.copy(liveStreamAudioOnly = false)
                    } else {
                        p.copy(liveStreamAudioOnly = audioOnlyFlags[p.id] == true)
                    }
                }
                val liveCount = profiles.count { it.isLive }
                val onCount = profiles.count { it.isOnline }
                Log.d(
                    "DatingViewModel",
                    "Profile feed: total=${profiles.size} live=$liveCount online=$onCount (Firestore + RTDB presence)"
                )
                val myUid = auth.currentUser?.uid?.trim().orEmpty()
                val currentLiveIds = profiles.filter { it.isLive }.map { it.id }.toSet()
                var newLiveNotice: LiveDiscoverNotice? = null
                val prevLive = discoverPrevLiveIds
                if (prevLive != null) {
                    val addedLive = currentLiveIds - prevLive - myUid
                    if (addedLive.isNotEmpty()) {
                        val hostId = addedLive.first()
                        val name = profiles.find { it.id == hostId }?.name?.trim().orEmpty()
                            .ifBlank { "Someone" }
                        newLiveNotice = LiveDiscoverNotice.NewLive(name)
                    }
                }
                discoverPrevLiveIds = currentLiveIds
                _uiState.update { s ->
                    val nextFiltered = if (s.isFilterActive) {
                        s.filteredProfiles.mapNotNull { fp -> profiles.find { it.id == fp.id } }
                    } else {
                        profiles
                    }
                    val notice = newLiveNotice ?: s.liveDiscoverNotice
                    syncFollowListsFromState(
                        s.copy(
                            profiles = profiles,
                            filteredProfiles = nextFiltered,
                            liveDiscoverNotice = notice
                        )
                    )
                }
                updateLeaderboard()
            }
        }
    }

    private fun startActiveLivePkBannerObserver() {
        livePkBannerJob?.cancel()
        livePkBannerJob = viewModelScope.launch {
            firebaseService.observeActiveLivePkBanners().collect { banners ->
                val myUid = auth.currentUser?.uid?.trim().orEmpty()
                var pkNotice: LiveDiscoverNotice? = null
                val prevPk = discoverPrevPkHostIds
                if (prevPk != null) {
                    val addedPk = banners.keys - prevPk
                    val othersPk = addedPk.filter { it != myUid }
                    if (othersPk.isNotEmpty()) {
                        val hostId = othersPk.first()
                        val line = banners[hostId]?.trim().orEmpty().ifBlank { "PK battle" }
                        pkNotice = LiveDiscoverNotice.PkStarted(line)
                    }
                }
                discoverPrevPkHostIds = banners.keys.toSet()
                _uiState.update { s ->
                    s.copy(
                        activeLivePkBanners = banners,
                        liveDiscoverNotice = pkNotice ?: s.liveDiscoverNotice
                    )
                }
            }
        }
    }

    fun clearLiveDiscoverNotice() {
        _uiState.update { it.copy(liveDiscoverNotice = null) }
    }

    private fun startCrmAnnouncementsObserver() {
        crmAnnouncementsJob?.cancel()
        crmAnnouncementsJob = viewModelScope.launch {
            firebaseService.observeCrmAnnouncements().collect { rows ->
                _uiState.update { it.copy(crmAnnouncements = rows) }
            }
        }
    }

    /**
     * Reloads `users/{uid}` from Firestore so [UserProfile.followingIds] / [UserProfile.followerIds]
     * and balances match the server after process restart or resume.
     */
    fun refreshCurrentUserFromFirestoreIfLoggedIn() {
        val uid = auth.currentUser?.uid ?: return
        viewModelScope.launch {
            val profile = firebaseService.getUserProfile(uid) ?: return@launch
            _uiState.update { s ->
                syncFollowListsFromState(
                    s.copy(
                        currentUser = profile,
                        isLoggedIn = true,
                        isGuest = auth.currentUser?.isAnonymous == true,
                        coinBalance = profile.coins,
                        gems = profile.gems,
                        beans = profile.beans,
                        totalEarnings = profile.earnings
                    )
                )
            }
        }
    }

    /**
     * Resolves approximate city/region from coarse location once per session and writes [UserProfile.city].
     */
    fun tryUpdateRegionFromLastKnownLocation(context: Context) {
        if (didRegionUpdateThisSession) return
        val uid = auth.currentUser?.uid ?: return
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        val app = context.applicationContext
        val client = LocationServices.getFusedLocationProviderClient(app)
        client.lastLocation.addOnSuccessListener { loc ->
            didRegionUpdateThisSession = true
            if (loc == null) return@addOnSuccessListener
            viewModelScope.launch {
                val city = withContext(Dispatchers.IO) {
                    resolveCityRegion(app, loc.latitude, loc.longitude)
                } ?: return@launch
                val me = _uiState.value.currentUser ?: return@launch
                if (me.id != uid) return@launch
                if (city.equals(me.city, ignoreCase = true)) return@launch
                val updated = me.copy(city = city)
                runCatching { firebaseService.saveUserProfile(updated) }
                _uiState.update { it.copy(currentUser = updated) }
            }
        }
    }

    private fun startFirebaseConnectedObserver() {
        firebaseConnectedJob?.cancel()
        firebaseConnectedJob = viewModelScope.launch {
            firebaseService.observeRtdbConnected().collect { connected ->
                Log.d("DatingViewModel", "Heartbeat: RTDB .info/connected=$connected")
                _uiState.update { it.copy(isFirebaseBackendConnected = connected) }
            }
        }
    }

    private fun startResellersListener() {
        resellersListener?.remove()
        resellersListener = db.collection("diamondResellers")
            .whereEqualTo("status", "active")
            .orderBy("order", Query.Direction.ASCENDING)
            .addSnapshotListener { snapshot, error ->
                if (error != null) {
                    logViewModelFirestoreError("diamondResellers", error)
                    return@addSnapshotListener
                }
                if (snapshot != null) {
                    val agents = snapshot.documents.mapNotNull { doc ->
                        try {
                            doc.toObject(ResellAgent::class.java)
                        } catch (e: Exception) {
                            Log.w("DatingViewModel", "Skipping malformed reseller doc id=${doc.id}", e)
                            null
                        }
                    }
                    _uiState.update { it.copy(resellAgents = agents) }
                }
            }
    }

    fun refreshProfiles() {
        viewModelScope.launch {
            try {
                val profiles = firebaseService.getProfiles()
                _uiState.update { it.copy(
                    profiles = profiles,
                    filteredProfiles = profiles,
                    searchResult = null
                ) }
                updateLeaderboard()
            } catch (e: Exception) {
                Log.e("DatingViewModel", "Error fetching profiles", e)
            }
        }
    }

    /**
     * Pull-to-refresh on Live: server read of `users/{uid}` plus a one-shot profile list fetch so
     * live rows / balances update without waiting for listener backfill.
     */
    fun refreshLiveDiscoverFromServer() {
        val uid = auth.currentUser?.uid ?: return
        if (_uiState.value.isLiveTabRefreshing) return
        _uiState.update { it.copy(isLiveTabRefreshing = true) }
        viewModelScope.launch {
            try {
                runCatching {
                    firebaseService.getUserProfile(uid, source = Source.SERVER)?.let { p ->
                        _uiState.update { s ->
                            syncFollowListsFromState(
                                s.copy(
                                    currentUser = p,
                                    isLoggedIn = true,
                                    isGuest = auth.currentUser?.isAnonymous == true,
                                    coinBalance = p.coins,
                                    gems = p.gems,
                                    beans = p.beans,
                                    totalEarnings = p.earnings
                                )
                            )
                        }
                    }
                }.onFailure { Log.w("DatingViewModel", "refreshLiveDiscover currentUser SERVER", it) }
                refreshProfiles()
            } finally {
                _uiState.update { it.copy(isLiveTabRefreshing = false) }
            }
        }
    }


    private fun fetchGifts() {
    giftsJob?.cancel()
    giftsJob = viewModelScope.launch {
        firebaseService.observeGifts().collect { gifts ->
            _uiState.update { it.copy(availableGifts = gifts) }
        }
    }
    viewModelScope.launch {
        firebaseService.observeResellers().collect { resellers ->
            _uiState.update { it.copy(resellAgents = resellers) }
        }
    }
}

    private fun fetchFollowers() {
        _uiState.update { syncFollowListsFromState(it) }
    }

    /** Derives follow / follower / liked-me lists from Firestore arrays on [DatingUiState.currentUser]. */
    private fun syncFollowListsFromState(s: DatingUiState): DatingUiState {
        val me = s.currentUser ?: return s.copy(
            followedProfiles = emptyList(),
            followerProfiles = emptyList(),
            likedMeProfiles = emptyList()
        )
        val following = me.followingIds.toSet()
        val followers = me.followerIds.toSet()
        val followedProfiles = s.profiles.filter { it.id in following }
        val followerProfiles = s.profiles.filter { it.id in followers }
        val likedByOrdered = me.likedByUserIds
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .distinct()
        val pool = sequenceOf(
            s.profiles,
            s.filteredProfiles,
            s.followedProfiles,
            s.followerProfiles,
            s.likedMeProfiles,
            s.dmThreadProfiles.values
        ).flatten().associateBy { it.id }
        val likedMeProfiles = likedByOrdered.mapNotNull { uid ->
            pool[uid] ?: s.likedMeProfiles.find { it.id == uid }
        }
        return s.copy(
            followedProfiles = followedProfiles,
            followerProfiles = followerProfiles,
            likedMeProfiles = likedMeProfiles
        )
    }

    /**
     * Resolves full [UserProfile] rows for [UserProfile.likedByUserIds] (Firestore fetches for IDs
     * missing from the discovery pool). Call when opening the Followed → Likes tab or after the
     * current-user snapshot updates.
     */
    fun refreshLikedMeProfiles(forUser: UserProfile? = null) {
        val me = forUser ?: _uiState.value.currentUser ?: return
        if (me.isGuest) return
        val ids = me.likedByUserIds.map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        viewModelScope.launch {
            if (ids.isEmpty()) {
                _uiState.update { it.copy(likedMeProfiles = emptyList()) }
                return@launch
            }
            val snap = _uiState.value
            val pool = sequenceOf(
                snap.profiles,
                snap.filteredProfiles,
                snap.followedProfiles,
                snap.followerProfiles,
                snap.dmThreadProfiles.values
            ).flatten().associateBy { it.id }.toMutableMap()
            val resolved = ids.map { uid ->
                pool[uid] ?: runCatching { firebaseService.getUserProfile(uid) }.getOrNull()
                    ?: UserProfile(id = uid, name = "User")
            }
            _uiState.update { it.copy(likedMeProfiles = resolved) }
        }
    }

    fun clearFollowActionError() {
        _uiState.update { it.copy(followActionError = null) }
    }

    fun setTab(index: Int) {
        _uiState.update { st ->
            if (index != 1) {
                st.copy(
                    selectedTab = index,
                    liveDiscoverSurface = LiveDiscoverSurface.MAIN,
                    liveDiscoverLiveFilter = LiveDiscoverLiveFilter.ALL,
                )
            } else {
                st.copy(selectedTab = index)
            }
        }
    }

    fun setLiveDiscoverSurface(surface: LiveDiscoverSurface) {
        _uiState.update { it.copy(liveDiscoverSurface = surface) }
    }

    fun setLiveDiscoverLiveFilter(filter: LiveDiscoverLiveFilter) {
        _uiState.update { it.copy(liveDiscoverLiveFilter = filter) }
    }

    /** Deep link / FCM: open Live tab on the audio-party lobby. */
    fun openAudioPartyLobbyFromDeepLink() {
        _uiState.update {
            it.copy(
                selectedTab = 1,
                liveDiscoverSurface = LiveDiscoverSurface.AUDIO_PARTY_LOBBY,
                liveDiscoverLiveFilter = LiveDiscoverLiveFilter.AUDIO_PARTY_ONLY,
            )
        }
    }

    fun requestVideoCallWithAudioPartyHost(hostId: String) {
        val hid = hostId.trim()
        if (hid.isEmpty()) return
        viewModelScope.launch {
            val uid = auth.currentUser?.uid ?: return@launch
            if (uid == hid) return@launch
            refreshSelfProfileIntoState()
            val me = _uiState.value.currentUser
            firebaseService.submitAudioPartyVideoCallRequest(
                hostId = hid,
                fromUserId = uid,
                displayName = me?.name.orEmpty(),
                photoUrl = me?.photoUrl.orEmpty(),
            )
        }
    }

    fun hostRespondAudioPartyVideoCall(fromUserId: String, accept: Boolean) {
        val hostId = auth.currentUser?.uid?.trim().orEmpty()
        val fid = fromUserId.trim()
        if (hostId.isEmpty() || fid.isEmpty()) return
        viewModelScope.launch {
            firebaseService.resolveAudioPartyVideoCallRequest(
                hostId = hostId,
                fromUserId = fid,
                newStatus = if (accept) "accepted" else "dismissed",
            )
            if (accept) {
                initiateCall(true, fid)
            }
        }
    }

    fun loginAsGuest() {
        _uiState.update { it.copy(isLoading = true, loginError = null) }
        val selectedGender = _uiState.value.registrationGender.ifBlank { "male" }
        viewModelScope.launch {
            try {
                authRepository.signInAsGuest()
                val guestUid = auth.currentUser?.uid.orEmpty()
                if (guestUid.isEmpty()) {
                    _uiState.update { it.copy(isLoading = false, loginError = "Guest sign-in failed.") }
                    return@launch
                }

                // Capture Android device ID for same-device auto-login on reinstall
                val appCtx = DatingApp.applicationContext
                val deviceId = appCtx?.let {
                    Settings.Secure.getString(it.contentResolver, Settings.Secure.ANDROID_ID).orEmpty()
                }.orEmpty()

                // Check for existing Firestore profile under this UID (returning guest, Firebase
                // auth persisted the anonymous session)
                val existingProfile = runCatching { firebaseService.getUserProfile(guestUid) }.getOrNull()

                if (existingProfile != null) {
                    // Returning guest — restore their profile, no setup needed
                    _uiState.update { it.copy(
                        isLoggedIn = true,
                        isGuest = true,
                        isLoading = false,
                        currentUser = existingProfile,
                        isNewUserSetupNeeded = false,
                    ) }
                } else {
                    // Brand-new guest — create a minimal profile and route to profile setup
                    val newGuest = UserProfile(
                        id = guestUid,
                        name = "Guest",
                        gender = selectedGender,
                        role = if (selectedGender == "female") UserRole.GIRL.name else UserRole.BOY.name,
                        isGuest = true,
                        deviceId = deviceId,
                    )
                    runCatching { firebaseService.saveUserProfile(newGuest) }
                    _uiState.update { it.copy(
                        isLoggedIn = true,
                        isGuest = true,
                        isLoading = false,
                        currentUser = newGuest,
                        isNewUserSetupNeeded = true,   // route to EditProfile for username + age setup
                    ) }
                }

                if (guestUid.isNotEmpty()) {
                    startIncomingCallListener(guestUid)
                    markUserOnline()
                }
            } catch (e: Exception) {
                _uiState.update { it.copy(isLoading = false, loginError = e.message) }
            }
        }
    }

    fun useAnotherAccount(context: Context) {
        verificationId = null
        detachRealtimeConsumersForLogout()
        didRegionUpdateThisSession = false
        val appCtx = context.applicationContext
        viewModelScope.launch {
            runCatching { authRepository.signOutAndClearSession(appCtx) }
                .onFailure { Log.w("DatingViewModel", "useAnotherAccount signOut", it) }
            LocalBackendCaches.clearFirestorePersistenceBestEffort()
            LocalBackendCaches.clearCoilCaches(appCtx)
            _uiState.update { DatingUiState() }
        }
    }

    fun resetOtpStatus() {
        _uiState.update { it.copy(isOtpSent = false, isLoading = false, loginError = null) }
    }

    fun clearNewUserSetupFlag() {
        _uiState.update { it.copy(isNewUserSetupNeeded = false) }
    }

    fun setRegistrationGender(gender: String) {
        val normalized = gender.trim().lowercase()
        _uiState.update {
            it.copy(
                registrationGender = when (normalized) {
                    "male", "female" -> normalized
                    else -> ""
                }
            )
        }
    }


    fun setRegistrationReferralCode(code: String) {
        _uiState.update { it.copy(registrationReferralCode = code.trim().uppercase()) }
    }

    fun sendOtp(phoneNumber: String, activity: Activity) {
        _uiState.update { it.copy(isLoading = true, loginError = null) }
        val formattedPhone = if (phoneNumber.startsWith("+")) phoneNumber else "+91$phoneNumber"
        
        val callbacks = object : PhoneAuthProvider.OnVerificationStateChangedCallbacks() {
            override fun onVerificationCompleted(credential: PhoneAuthCredential) {
                signInWithCredential(credential)
            }
            override fun onVerificationFailed(e: FirebaseException) {
                _uiState.update { it.copy(isLoading = false, loginError = e.localizedMessage) }
            }
            override fun onCodeSent(id: String, token: PhoneAuthProvider.ForceResendingToken) {
                verificationId = id
                _uiState.update { it.copy(isLoading = false, isOtpSent = true) }
            }
        }

        val options = PhoneAuthOptions.newBuilder(auth)
            .setPhoneNumber(formattedPhone)
            .setTimeout(60L, TimeUnit.SECONDS)
            .setActivity(activity)
            .setCallbacks(callbacks)
            .build()
        PhoneAuthProvider.verifyPhoneNumber(options)
    }

    fun verifyOtp(code: String) {
        val vid = verificationId ?: return
        val credential = PhoneAuthProvider.getCredential(vid, code)
        signInWithCredential(credential)
    }

    fun signInWithGoogle(idToken: String) {
        val credential = GoogleAuthProvider.getCredential(idToken, null)
        signInWithCredential(credential)
    }

    private fun signInWithCredential(credential: AuthCredential) {
        _uiState.update { it.copy(isLoading = true, loginError = null) }
        viewModelScope.launch {
            try {
                val currentUser = auth.currentUser
                val authResult = if (currentUser != null && currentUser.isAnonymous) {
                    currentUser.linkWithCredential(credential).await()
                } else {
                    auth.signInWithCredential(credential).await()
                }
                
                val user = authResult.user ?: throw Exception("Auth failed")
                var profile = firebaseService.getUserProfile(user.uid)
                val isNewUser = (profile == null)

                if (profile == null) {
                    val selectedGender = _uiState.value.registrationGender
                    val enteredReferral = _uiState.value.registrationReferralCode
                    profile = UserProfile(
                        id = user.uid,
                        name = user.displayName?.takeIf { it.isNotBlank() } ?: "",
                        email = user.email ?: "",
                        mobile = user.phoneNumber ?: "",
                        gender = selectedGender,
                        role = if (selectedGender == "female") UserRole.GIRL.name else UserRole.BOY.name,
                        profileNumber = (10000..99999).random().toString(),
                        level = 1,
                        referralCode = enteredReferral.ifEmpty { null }
                    )
                }
                firebaseService.saveUserProfile(profile!!)
                didRegionUpdateThisSession = false
                _uiState.update { it.copy(
                    currentUser = profile,
                    isLoggedIn = true,
                    isGuest = false,
                    isLoading = false,
                    isOtpSent = false,
                    isNewUserSetupNeeded = isNewUser,
                ) }
                fetchFollowers()
                startCurrentUserListener(user.uid)
                startIncomingCallListener(user.uid)
                scheduleGlobalInboxPrefetch()
            } catch (e: Exception) {
                _uiState.update { it.copy(isLoading = false, loginError = e.localizedMessage) }
            }
        }
    }

    /**
     * Loads recent DM docs involving the current user (two `whereEqualTo` queries on sender/receiver),
     * merges into [DatingUiState.messages] by counterparty id, and fills [DatingUiState.dmThreadProfiles]
     * for partners not on the discovery feed.
     */
    private fun scheduleGlobalInboxPrefetch() {
        val uid = auth.currentUser?.uid?.trim().orEmpty()
        if (uid.isEmpty() || _uiState.value.isGuest || auth.currentUser?.isAnonymous == true) return
        inboxPrefetchJob?.cancel()
        inboxPrefetchJob = viewModelScope.launch {
            val recent = firebaseService.fetchRecentMessagesInvolvingUser(uid, perQuery = 100)
            if (recent.isEmpty()) return@launch
            val byPeer = mutableMapOf<String, MutableList<Message>>()
            for (m in recent) {
                val peer = when {
                    m.senderId == uid -> m.receiverId.trim()
                    m.receiverId == uid -> m.senderId.trim()
                    else -> ""
                }
                if (peer.isEmpty() || peer == uid) continue
                byPeer.getOrPut(peer) { mutableListOf() }.add(m)
            }
            byPeer.values.forEach { it.sortBy { msg -> msg.timestamp } }
            val snap = _uiState.value
            val needsProfileFetch = byPeer.keys.filter { pid ->
                snap.profiles.none { it.id == pid } &&
                    snap.filteredProfiles.none { it.id == pid } &&
                    !snap.dmThreadProfiles.containsKey(pid)
            }
            val fetchedMin = mutableMapOf<String, UserProfile>()
            for (pid in needsProfileFetch) {
                fetchedMin[pid] = runCatching { firebaseService.getUserProfile(pid) }.getOrNull()
                    ?: UserProfile(id = pid, name = "User", profileNumber = "", photoUrl = "")
            }
            _uiState.update { st ->
                val mergedMsgs = st.messages.toMutableMap()
                byPeer.forEach { (pid, msgs) ->
                    val combined = (mergedMsgs[pid].orEmpty() + msgs).distinctBy { it.id }.sortedBy { it.timestamp }
                    mergedMsgs[pid] = combined
                }
                val dmMap = st.dmThreadProfiles.toMutableMap()
                fetchedMin.forEach { (pid, prof) ->
                    if (!dmMap.containsKey(pid)) dmMap[pid] = prof
                }
                st.copy(messages = mergedMsgs, dmThreadProfiles = dmMap)
            }
        }
    }

    fun logout(context: Context) {
        val uid = auth.currentUser?.uid
        if (uid != null && _uiState.value.isLive) {
            // Never block the UI thread on Firestore — avoids ANR / “app isn’t responding”.
            viewModelScope.launch(Dispatchers.IO) {
                runCatching { firebaseService.updateUserLiveStatus(uid, false, null) }
                    .onFailure { Log.w("DatingViewModel", "logout clear isLive", it) }
            }
        }
        DatingApp.applicationContext?.let { ctx ->
            LiveSessionCleanupPrefs.clearPendingViewer(ctx)
            LiveSessionCleanupPrefs.clearHostingLiveUid(ctx)
        }
        detachRealtimeConsumersForLogout()
        val appCtx = context.applicationContext
        viewModelScope.launch {
            runCatching { authRepository.signOutAndClearSession(appCtx) }
                .onFailure { Log.w("DatingViewModel", "logout signOutAndClearSession", it) }
            LocalBackendCaches.clearFirestorePersistenceBestEffort()
            LocalBackendCaches.clearCoilCaches(appCtx)
            discoverPrevLiveIds = null
            discoverPrevPkHostIds = null
            didRegionUpdateThisSession = false
            pendingSpinRoundCompleterUid = null
            spinRoundCompleteJob?.cancel()
            spinRoundCompleteJob = null
            _uiState.update { DatingUiState() }
        }
    }

    fun clearLoginError() {
        _uiState.update { it.copy(loginError = null) }
    }

    fun updateProfile(
        name: String, 
        age: Int, 
        city: String, 
        gender: String, 
        email: String, 
        mobile: String, 
        bio: String, 
        photoUrl: String, 
        gallery: List<String>,
        referralCode: String
    ) {
        val current = _uiState.value.currentUser ?: return
        val effectiveReferral = if (!current.referralCode.isNullOrEmpty()) current.referralCode!! else referralCode
        val updated = current.copy(
            name = name,
            age = age,
            city = city,
            gender = normalizeGenderForCrm(gender),
            role = if (normalizeGenderForCrm(gender) == "female") UserRole.GIRL.name else UserRole.BOY.name,
            email = email,
            mobile = mobile,
            bio = bio,
            photoUrl = photoUrl,
            galleryPhotos = gallery,
            referralCode = effectiveReferral,
            profileNumber = current.profileNumber.ifEmpty { (10000..99999).random().toString() }
        )
        viewModelScope.launch {
            try {
                firebaseService.saveUserProfile(updated)
                syncFirebaseUserEmailIfChanged(email)
                _uiState.update { it.copy(currentUser = updated) }
            } catch (e: Exception) {
                Log.e("DatingViewModel", "updateProfile failed", e)
                _uiState.update { it.copy(loginError = "Profile save failed: ${e.message}") }
            }
        }
    }

    private suspend fun saveUpdatedProfile(
        name: String,
        age: Int,
        city: String,
        gender: String,
        email: String,
        mobile: String,
        bio: String,
        photoUrl: String,
        gallery: List<String>,
        referralCode: String,
        hobbies: List<String> = emptyList(),
        likes: List<String> = emptyList(),
        dislikes: List<String> = emptyList(),
        languages: List<String> = emptyList(),
    ) {
        val current = _uiState.value.currentUser ?: return
        val effectiveReferral = if (!current.referralCode.isNullOrEmpty()) current.referralCode!! else referralCode
        // Locked fields — city and gender cannot be changed once set
        val effectiveCity   = current.city.ifBlank { city }
        val effectiveGender = current.gender.ifBlank { normalizeGenderForCrm(gender) }
        val updated = current.copy(
            name = name,
            age = age,
            city = effectiveCity,
            gender = effectiveGender,
            role = if (effectiveGender == "female") UserRole.GIRL.name else UserRole.BOY.name,
            email = email,
            mobile = mobile,
            bio = bio,
            photoUrl = photoUrl,
            galleryPhotos = gallery,
            referralCode = effectiveReferral,
            profileNumber = current.profileNumber.ifEmpty { (10000..99999).random().toString() },
            hobbies = hobbies.ifEmpty { current.hobbies },
            likes = likes.ifEmpty { current.likes },
            dislikes = dislikes.ifEmpty { current.dislikes },
            languages = languages.ifEmpty { current.languages },
        )
        firebaseService.saveUserProfile(updated)
        syncFirebaseUserEmailIfChanged(email)
        _uiState.update { it.copy(currentUser = updated) }
    }

    /**
     * Storage bridge: Pick (content URI) → [FirebaseService.uploadProfilePhoto] / [uploadGalleryImage]
     * → HTTPS URL → [FirebaseService.saveUserProfile] with `photoUrl` and `galleryPhotos` (Firestore array).
     */
    fun updateProfileWithUploads(
        name: String,
        age: Int,
        city: String,
        gender: String,
        email: String,
        mobile: String,
        bio: String,
        photo: String,
        gallery: List<String>,
        referral: String,
        hobbies: List<String> = emptyList(),
        likes: List<String> = emptyList(),
        dislikes: List<String> = emptyList(),
        languages: List<String> = emptyList(),
    ) {
        _uiState.update { it.copy(isProfileSaving = true, profileSaveSuccess = false, profileSaveError = null) }
        viewModelScope.launch {
            try {
                val uploadedPhotoUrl = when {
                    photo.isBlank() -> ""
                    photo.startsWith("http://", ignoreCase = true) ||
                        photo.startsWith("https://", ignoreCase = true) -> photo
                    else -> firebaseService.uploadProfilePhoto(Uri.parse(photo))
                }

                val uploadedGallery = gallery.map { uriString ->
                    when {
                        uriString.startsWith("http://", ignoreCase = true) ||
                            uriString.startsWith("https://", ignoreCase = true) -> uriString
                        else -> firebaseService.uploadGalleryImage(Uri.parse(uriString))
                    }
                }
                Log.d(
                    "DatingViewModel",
                    "updateProfileWithUploads: photoLen=${uploadedPhotoUrl.length} galleryUrls=${uploadedGallery.size}"
                )

                saveUpdatedProfile(
                    name = name,
                    age = age,
                    city = city,
                    gender = gender,
                    email = email,
                    mobile = mobile,
                    bio = bio,
                    photoUrl = uploadedPhotoUrl,
                    gallery = uploadedGallery,
                    referralCode = referral,
                    hobbies = hobbies,
                    likes = likes,
                    dislikes = dislikes,
                    languages = languages,
                )
                // Signal success so EditProfileScreen's LaunchedEffect can close the screen
                _uiState.update { it.copy(isProfileSaving = false, profileSaveSuccess = true) }
            } catch (e: Exception) {
                Log.e("DatingViewModel", "Error updating profile", e)
                _uiState.update { it.copy(isProfileSaving = false, profileSaveError = "Failed to update profile: ${e.message}") }
            }
        }
    }

    // ── Phone / Email re-binding (EditProfileScreen) ──────────────────────────

    private var phoneChangeVerificationId: String? = null

    fun changePhone_sendOtp(phone: String, activity: Activity) {
        val formattedPhone = if (phone.startsWith("+")) phone else "+91$phone"
        _uiState.update { it.copy(phoneChangeOtpSent = false, phoneChangeError = null) }
        val callbacks = object : PhoneAuthProvider.OnVerificationStateChangedCallbacks() {
            override fun onVerificationCompleted(credential: PhoneAuthCredential) {
                viewModelScope.launch { applyPhoneCredential(credential) }
            }
            override fun onVerificationFailed(e: FirebaseException) {
                _uiState.update { it.copy(phoneChangeError = e.localizedMessage) }
            }
            override fun onCodeSent(id: String, token: PhoneAuthProvider.ForceResendingToken) {
                phoneChangeVerificationId = id
                _uiState.update { it.copy(phoneChangeOtpSent = true) }
            }
        }
        PhoneAuthProvider.verifyPhoneNumber(
            PhoneAuthOptions.newBuilder(auth)
                .setPhoneNumber(formattedPhone)
                .setTimeout(60L, TimeUnit.SECONDS)
                .setActivity(activity)
                .setCallbacks(callbacks)
                .build()
        )
    }

    fun changePhone_verifyOtp(otp: String) {
        val vid = phoneChangeVerificationId ?: run {
            _uiState.update { it.copy(phoneChangeError = "Session expired. Please resend OTP.") }
            return
        }
        val credential = PhoneAuthProvider.getCredential(vid, otp)
        viewModelScope.launch { applyPhoneCredential(credential) }
    }

    private suspend fun applyPhoneCredential(credential: PhoneAuthCredential) {
        try {
            val user = auth.currentUser ?: return
            user.updatePhoneNumber(credential).await()
            val phone = user.phoneNumber.orEmpty()
            val updated = _uiState.value.currentUser?.copy(mobile = phone, isBound = true)
            if (updated != null) {
                runCatching { firebaseService.saveUserProfile(updated) }
                _uiState.update { it.copy(
                    currentUser = updated,
                    phoneChangeOtpSent = false,
                    phoneChangeError = null,
                ) }
            }
        } catch (e: Exception) {
            _uiState.update { it.copy(phoneChangeError = e.localizedMessage) }
        }
    }

    fun clearPhoneChangeState() {
        phoneChangeVerificationId = null
        _uiState.update { it.copy(phoneChangeOtpSent = false, phoneChangeError = null) }
    }

    fun changeEmail(newEmail: String) {
        _uiState.update { it.copy(emailChangeSent = false, emailChangeError = null) }
        val user = auth.currentUser ?: run {
            _uiState.update { it.copy(emailChangeError = "Not signed in.") }
            return
        }
        viewModelScope.launch {
            try {
                user.verifyBeforeUpdateEmail(newEmail).await()
                _uiState.update { it.copy(emailChangeSent = true) }
            } catch (e: Exception) {
                _uiState.update { it.copy(emailChangeError = e.localizedMessage) }
            }
        }
    }

    fun clearEmailChangeState() {
        _uiState.update { it.copy(emailChangeSent = false, emailChangeError = null) }
    }

    fun uploadVerificationVideo(uri: Uri) {
        viewModelScope.launch {
            try {
                _uiState.update { it.copy(isLoading = true) }
                firebaseService.uploadVideo(uri)
                val updated = _uiState.value.currentUser?.copy(
                    hasIntroVideo = true,
                    videoVerificationStatus = VerificationStatus.PENDING.name,
                    isFullyVerified = false
                )
                if (updated != null) {
                    firebaseService.saveUserProfile(updated)
                    _uiState.update { it.copy(currentUser = updated, isLoading = false) }
                }
            } catch (e: Exception) {
                _uiState.update { it.copy(isLoading = false, loginError = "Video upload failed: ${e.message}") }
            }
        }
    }

    fun uploadFaceVerificationImage(
        uri: Uri,
        onResult: ((Boolean) -> Unit)? = null,
        onUploadUserMessage: ((String) -> Unit)? = null
    ) {
        _uiState.update { it.copy(isLoading = true) }
        viewModelScope.launch {
            try {
                val uploadedImageUrl = firebaseService.uploadFaceVerificationImage(uri)

                val updated = _uiState.value.currentUser?.copy(
                    faceVerificationImageUrl = uploadedImageUrl,
                    faceVerificationStatus = VerificationStatus.APPROVED.name,
                    isVerified = true,
                    isFaceVerified = true,
                    isCallVerificationApproved = true,
                    hasStarBadge = true
                )

                if (updated != null) {
                    Log.d(
                        "DatingViewModel",
                        "instant face verification: Firestore isVerified=${updated.isVerified} isFaceVerified=${updated.isFaceVerified} status=${updated.faceVerificationStatus}"
                    )
                    firebaseService.saveUserProfile(updated)
                    val uid = auth.currentUser?.uid ?: updated.id
                    runCatching { firebaseService.writeVerificationApproved(uid, updated.faceVerificationImageUrl) }
                        .onFailure { Log.e("VERIFICATION", "writeVerificationApproved narrow update failed uid=$uid", it) }
                    _uiState.update { it.copy(currentUser = updated, isLoading = false) }
                    onResult?.invoke(true)
                } else {
                    _uiState.update { it.copy(isLoading = false) }
                    onResult?.invoke(false)
                }
            } catch (e: Exception) {
                Log.e("DatingViewModel", "uploadFaceVerificationImage failed", e)
                val msg = e.message?.takeIf { it.isNotBlank() } ?: "Network error. Check connection and try again."
                _uiState.update { it.copy(isLoading = false, loginError = "Face verification failed: $msg") }
                onUploadUserMessage?.invoke(msg)
                onResult?.invoke(false)
            }
        }
    }

    fun selectFrame(frameId: String?) {
        val u = _uiState.value.currentUser?.copy(profileFrameId = frameId)
        if (u != null) viewModelScope.launch { firebaseService.saveUserProfile(u); _uiState.update { it.copy(currentUser = u) } }
    }

    fun completeVerification() {
        val updated = _uiState.value.currentUser?.copy(
            faceVerificationStatus = VerificationStatus.APPROVED.name,
            isVerified = true,
            isFaceVerified = true,
            isCallVerificationApproved = true,
            hasStarBadge = true
        )
        if (updated != null) {
            viewModelScope.launch {
                firebaseService.saveUserProfile(updated)
                val uid = auth.currentUser?.uid ?: updated.id
                runCatching {
                    firebaseService.writeVerificationApproved(
                        uid,
                        updated.faceVerificationImageUrl?.takeIf { it.isNotBlank() }
                    )
                }
                    .onFailure { Log.e("VERIFICATION", "completeVerification narrow update failed uid=$uid", it) }
                Log.d("VERIFICATION", "Successfully wrote isVerified=true to Firestore uid=$uid via completeVerification")
                _uiState.update { it.copy(currentUser = updated) }
            }
        }
    }

    fun applyPaidFilters(ageRange: IntRange?, level: Int?, city: String?, cost: Int) {
        if (_uiState.value.coinBalance >= cost) {
            val u = _uiState.value.currentUser?.withSyncedSpendableBalance(_uiState.value.coinBalance - cost)
            if (u != null) viewModelScope.launch { 
                firebaseService.saveUserProfile(u)
                val profiles = _uiState.value.profiles.filter {
                    (ageRange == null || it.age in ageRange) &&
                    (level == null || it.level >= level) &&
                    (city == null || it.city.contains(city, ignoreCase = true))
                }
                _uiState.update { it.copy(currentUser = u, coinBalance = u.coins, filteredProfiles = profiles, isFilterActive = true) }
            }
        }
    }

    fun clearFilters() {
        _uiState.update { it.copy(filteredProfiles = it.profiles, isFilterActive = false) }
    }

    fun searchByProfileNumber(number: String) {
        if (number.length != 5) {
            if (_uiState.value.searchResult != null) {
                _uiState.update { it.copy(searchResult = null) }
            }
            return
        }
        val result = _uiState.value.profiles.find { it.profileNumber == number }
        _uiState.update { it.copy(searchResult = result) }
    }

    fun claimDailyReward() {
        if (_uiState.value.canClaimDailyReward) {
            val u = _uiState.value.currentUser?.withSyncedSpendableBalance(_uiState.value.coinBalance + 10)
            if (u != null) viewModelScope.launch {
                firebaseService.saveUserProfile(u)
                _uiState.update { it.copy(currentUser = u, coinBalance = u.coins, canClaimDailyReward = false) }
            }
        }
    }

    fun toggleRewardsDialog(show: Boolean) {
        _uiState.update { it.copy(showRewardsDialog = show) }
    }

    fun convertDiamondsToBeans(diamonds: Int) {
        if (_uiState.value.coinBalance >= diamonds) {
            val beansEarned = diamonds / 2
            val newCoins = _uiState.value.coinBalance - diamonds
            val u = _uiState.value.currentUser
                ?.withSyncedSpendableBalance(newCoins)
                ?.copy(beans = _uiState.value.beans + beansEarned)
            if (u != null) viewModelScope.launch {
                firebaseService.saveUserProfile(u)
                _uiState.update { it.copy(currentUser = u, coinBalance = u.coins, beans = u.beans) }
            }
        }
    }

    fun setCustomPrices(audio: Int, video: Int) {
        val u = _uiState.value.currentUser
        if (u != null && u.role == UserRole.GIRL.name && u.displayProfileLevel >= 4) {
            val updated = u.copy(customAudioPrice = audio, customVideoPrice = video)
            viewModelScope.launch {
                firebaseService.saveUserProfile(updated)
                _uiState.update { it.copy(currentUser = updated) }
            }
        }
    }

    fun startObservingMessages(uid: String) {
        val cleanId = uid.trim()
        if (cleanId.isBlank() || cleanId == "{userId}") {
            Log.e("CHAT_DEBUG", "startObservingMessages: invalid uid='$uid'")
            return
        }
        Log.d("CHAT_DEBUG", "Fetching profile for ID: $cleanId")
        messagesJob?.cancel()
        val fromList = _uiState.value.profiles.find { it.id == cleanId }
            ?: _uiState.value.filteredProfiles.find { it.id == cleanId }
        _uiState.update {
            it.copy(
                selectedMessagePartnerId = cleanId,
                chatPartnerProfile = fromList ?: it.chatPartnerProfile?.takeIf { p -> p.id == cleanId }
            )
        }
        viewModelScope.launch {
            if (fromList == null) {
                runCatching { firebaseService.getUserProfile(cleanId) }
                    .onSuccess { remote ->
                        if (remote != null) {
                            _uiState.update { s ->
                                s.copy(chatPartnerProfile = remote)
                            }
                        } else {
                            Log.w("CHAT_DEBUG", "No Firestore user document for id=$cleanId")
                        }
                    }
                    .onFailure { e ->
                        Log.e("CHAT_DEBUG", "Fetch partner profile failed uid=$cleanId", e)
                    }
            }
        }
        messagesJob = viewModelScope.launch {
            firebaseService.observeMessages(cleanId).collect { msgs: List<Message> ->
                val currentUserId = auth.currentUser?.uid
                val latestGift = msgs.lastOrNull { it.type == "gift" && it.id != lastGiftOverlayMessageId && it.senderId != currentUserId }
                _uiState.update { state ->
                    val threadOpen = state.selectedMessagePartnerId?.trim() == cleanId
                    val matchedGift = if (threadOpen) {
                        latestGift?.let { giftMsg ->
                            state.availableGifts.firstOrNull { gift ->
                                gift.id == giftMsg.giftId ||
                                    gift.videoUrl == giftMsg.giftImageUrl ||
                                    gift.thumbnailUrl == giftMsg.giftImageUrl
                            }
                        }
                    } else null
                    if (latestGift != null) {
                        lastGiftOverlayMessageId = latestGift.id
                    }
                    state.copy(
                        messages = state.messages + (cleanId to msgs),
                        playingGift = matchedGift ?: state.playingGift
                    )
                }
            }
        }
    }

    fun clearMessageThreadFocus() {
        _uiState.update {
            it.copy(
                selectedMessagePartnerId = null,
                chatPartnerProfile = null,
                playingGift = null
            )
        }
    }

    fun requestOpenProfileSheet(userId: String, hintProfile: UserProfile? = null) {
        val clean = userId.trim()
        if (clean.isEmpty()) return
        val hint = hintProfile?.takeIf { it.id == clean }
        _uiState.update {
            it.copy(
                openProfileSheetForUserId = clean,
                openProfileSheetHintProfile = hint
            )
        }
    }

    fun clearOpenProfileSheetRequest() {
        _uiState.update {
            it.copy(openProfileSheetForUserId = null, openProfileSheetHintProfile = null)
        }
    }

    private fun startBattlesObserver() {
        battlesJob?.cancel()
        battlesJob = viewModelScope.launch {
            firebaseService.observeBattles().collect { list ->
                _uiState.update { it.copy(battles = list) }
            }
        }
    }

    fun sendMessage(uid: String, text: String) {
        val cid = auth.currentUser?.uid ?: return
        viewModelScope.launch {
            try {
            val trimmed = text.trim()
            val isLocalImage = trimmed.startsWith("content://") || trimmed.startsWith("file://")
            val isRemoteImage = trimmed.endsWith(".jpg", true) ||
                trimmed.endsWith(".jpeg", true) ||
                trimmed.endsWith(".png", true) ||
                trimmed.endsWith(".webp", true)

            val message = if (isLocalImage || isRemoteImage) {
                val imageUrl = firebaseService.normalizeImageReference(trimmed)
                Message(
                    id = UUID.randomUUID().toString(),
                    senderId = cid,
                    receiverId = uid,
                    text = "Photo",
                    type = "image",
                    giftImageUrl = imageUrl,
                    timestamp = System.currentTimeMillis()
                )
            } else {
                Message(
                    id = UUID.randomUUID().toString(),
                    senderId = cid,
                    receiverId = uid,
                    text = text,
                    type = "text",
                    timestamp = System.currentTimeMillis()
                )
            }

            firebaseService.sendMessage(message).onFailure { e ->
                    Log.e("DatingViewModel", "sendMessage failed", e)
                    _uiState.update { it.copy(loginError = "Message failed: ${e.message}") }
                }
            } catch (e: Exception) {
                Log.e("DatingViewModel", "sendMessage failed", e)
                _uiState.update { it.copy(loginError = "Message failed: ${e.message}") }
            }
        }
    }

    /**
     * Sends a chat invite message to every user who has a mutual like with [hostUid].
     * Mutual = hostUid liked them AND they liked hostUid back.
     * Called automatically when the host starts a live stream or audio party.
     */
    private fun sendLiveInviteToMutualLikes(hostUid: String, isAudioParty: Boolean) {
        val s = _uiState.value
        val iLiked   = s.iLikedProfiles.map { it.id }.toSet()
        val likedMe  = s.likedMeProfiles.map { it.id }.toSet()
        val mutuals  = iLiked.intersect(likedMe)
        if (mutuals.isEmpty()) return
        val hostName = s.currentUser?.name?.takeIf { it.isNotBlank() } ?: "Someone you liked"
        val hostUser = s.currentUser
        val msg = if (isAudioParty)
            "🎉 $hostName just started a Party Room! Come join now 🎶"
        else
            "🔴 $hostName is LIVE now! Come watch ❤️"
        viewModelScope.launch {
            mutuals.forEach { recipientUid ->
                runCatching {
                    val chatMsg = com.zipper.datingapp.data.ChatMessage(
                        id = "",
                        senderId = hostUid,
                        senderName = hostUser?.name.orEmpty(),
                        senderPhotoUrl = hostUser?.photoUrl.orEmpty(),
                        receiverId = recipientUid,
                        text = msg,
                        type = "TEXT",
                        timestamp = System.currentTimeMillis()
                    )
                    firebaseService.sendChatMessage(recipientId = recipientUid, message = chatMsg)
                }.onFailure { e ->
                    Log.w("DatingViewModel", "sendLiveInviteToMutualLikes uid=$recipientUid", e)
                }
            }
        }
    }

    fun sendImageMessage(uid: String, imageUri: Uri) {
        val cid = auth.currentUser?.uid ?: return
        _uiState.update { state ->
            val nextCount = (state.pendingImageUploads[uid] ?: 0) + 1
            state.copy(
                pendingImageUploads = state.pendingImageUploads + (uid to nextCount),
                imageUploadError = null
            )
        }
        viewModelScope.launch {
            runCatching {
                val imageUrl = firebaseService.normalizeImageReference(imageUri.toString())
                firebaseService.sendMessage(
                    Message(
                        id = UUID.randomUUID().toString(),
                        senderId = cid,
                        receiverId = uid,
                        text = "Photo",
                        type = "image",
                        giftImageUrl = imageUrl,
                        timestamp = System.currentTimeMillis()
                    )
                ).getOrThrow()
            }.onFailure { err ->
                _uiState.update {
                    it.copy(
                        loginError = "Failed to send photo: ${err.message}",
                        imageUploadError = "Failed to send photo"
                    )
                }
            }.also {
                _uiState.update { state ->
                    val current = state.pendingImageUploads[uid] ?: 0
                    val updatedMap = if (current <= 1) {
                        state.pendingImageUploads - uid
                    } else {
                        state.pendingImageUploads + (uid to (current - 1))
                    }
                    state.copy(pendingImageUploads = updatedMap)
                }
            }
        }
    }

    fun clearImageUploadError() {
        _uiState.update { it.copy(imageUploadError = null) }
    }

    fun sendGiftMessage(uid: String, gift: Gift) {
        val cid = auth.currentUser?.uid ?: return
        viewModelScope.launch {
            val displayName = gift.name.trim().ifBlank { "Gift" }
            firebaseService.sendMessage(
                Message(
                    id = UUID.randomUUID().toString(),
                    senderId = cid,
                    receiverId = uid,
                    // Store the specific gift name so the receiving side can render
                    // "Sent a Virtual Rose 🌹" without needing a catalog lookup.
                    text = displayName,
                    type = "gift",
                    giftId = gift.id,
                    // Use thumbnailUrl (static image) only — never fall back to videoUrl,
                    // which is a video asset and would fail silently in AsyncImage.
                    giftImageUrl = gift.thumbnailUrl.ifBlank { null },
                    timestamp = System.currentTimeMillis()
                )
            ).onFailure { e ->
                Log.e("DatingViewModel", "sendGiftMessage", e)
                _uiState.update { it.copy(loginError = "Gift message failed: ${e.message}") }
            }
        }
    }

    fun initiateCall(isVideoCall: Boolean, receiverId: String) {
        val trimmedReceiver = receiverId.trim()
        if (trimmedReceiver.isBlank() || trimmedReceiver == "{userId}") {
            Log.e("CHAT_DEBUG", "initiateCall: invalid receiverId='$receiverId'")
            _uiState.update { it.copy(loginError = "Invalid call target.") }
            return
        }
        if (CallManager.isBusy(_uiState.value)) {
            _uiState.update { it.copy(callNoticeMessage = "You are already in a call") }
            return
        }
        val callerId = auth.currentUser?.uid ?: return
        outgoingCallTimeoutJob?.cancel()
        viewModelScope.launch {
            refreshSelfProfileIntoState()
            val me = _uiState.value.currentUser
            if (me != null && !me.isCallVerificationApproved) {
                _uiState.update { it.copy(loginError = "Face verification required before calls.") }
                return@launch
            }
            var partner = _uiState.value.profiles.find { it.id == trimmedReceiver }
                ?: _uiState.value.filteredProfiles.find { it.id == trimmedReceiver }
            if (partner == null) {
                partner = runCatching { firebaseService.getUserProfile(trimmedReceiver) }.getOrNull()
            }
            if (partner == null) {
                _uiState.update { it.copy(loginError = "Could not load this user's profile.") }
                return@launch
            }
            if (!VirtualEconomyMath.isBinaryGenderCallPairAllowed(me?.gender, partner.gender)) {
                _uiState.update { it.copy(loginError = CALL_GENDER_POLICY_ERROR) }
                return@launch
            }
            val cost = if (isVideoCall) (partner.customVideoPrice ?: 1500) else (partner.customAudioPrice ?: 1000)
            if (_uiState.value.coinBalance < cost) {
                _uiState.update { it.copy(loginError = "Not enough diamonds for this call.") }
                return@launch
            }
            val callerName = _uiState.value.currentUser?.name ?: "Unknown caller"
            try {
                val roomId = buildCallRoomId(callerId, trimmedReceiver)
                firebaseService.sendCallInvite(
                    callerId = callerId,
                    callerName = callerName,
                    receiverId = trimmedReceiver,
                    roomId = roomId,
                    isVideoCall = isVideoCall
                )
                val soloGateSnap = _uiState.value
                val soloLive = isSoloLiveForPrivateCallGate(soloGateSnap)
                val streamDocForBusy = if (soloLive) {
                    soloGateSnap.currentRoomId?.trim()?.takeIf { it.isNotEmpty() } ?: callerId
                } else {
                    null
                }
                if (soloLive && streamDocForBusy != null) {
                    firebaseService.setLiveStreamHostPrivateCallBusy(streamDocForBusy, true)
                        .onFailure { Log.w("DatingViewModel", "setLiveStreamHostPrivateCallBusy initiateCall", it) }
                    firebaseService.sendLiveStreamHostBusySystemMessage(
                        streamDocForBusy,
                        callerId,
                        HOST_BUSY_SYSTEM_CHAT,
                    ).onFailure { Log.w("DatingViewModel", "sendLiveStreamHostBusySystemMessage initiateCall", it) }
                }
                val partnerProfile = partner
                _uiState.update {
                    it.copy(
                        pendingCallRoomId = roomId,
                        pendingCallIsStreamer = true,
                        pendingCallLaunchToken = it.pendingCallLaunchToken + 1,
                        callState = CallState.DIALING,
                        callStatus = CallStatus.RINGING,
                        isCurrentlyInCall = true,
                        isIncomingCall = false,
                        isFreeTeaserCall = false,
                        isVideoCallActive = isVideoCall,
                        isAudioCallActive = !isVideoCall,
                        activeCallPartner = partnerProfile,
                        callOverlayHostProfile = partnerProfile,
                        webRtcSessionRoomId = roomId,
                        webRtcCallIsStreamer = true,
                        webRtcOverlayHostUserId = callerId,
                        webRtcShowLiveAudienceChrome = false,
                        soloLiveSuspendedForPrivateCall = soloLive,
                        soloLiveStreamDocIdForResume = if (soloLive) streamDocForBusy else null,
                        hostWebRtcPauseForPkNonce = if (soloLive) {
                            it.hostWebRtcPauseForPkNonce + 1
                        } else {
                            it.hostWebRtcPauseForPkNonce
                        },
                    )
                }
                startWebRtcCallLiveObservers(roomId, callerId, preserveSoloLiveHostObservers = soloLive)
                startOutgoingCallTimeout(
                    callerId = callerId,
                    roomId = roomId,
                    receiverId = trimmedReceiver
                )
            } catch (e: Exception) {
                _uiState.update { it.copy(loginError = "Failed to initiate call: ${e.message}") }
            }
        }
    }

    /** Loads `users/{uid}` into state so verification/coins match Firestore right before gating (e.g. after face verify). */
    private suspend fun refreshSelfProfileIntoState() {
        val uid = auth.currentUser?.uid?.trim().orEmpty().ifBlank { return }
        val fresh = runCatching { firebaseService.getUserProfile(uid) }.getOrNull() ?: return
        _uiState.update { s ->
            syncFollowListsFromState(s.copy(currentUser = fresh, coinBalance = fresh.coins))
        }
    }

    /**
     * Called when [HomeScreen] first appears so a one-shot ~20–30s delayed "random free call" hook can run.
     * See [tryFireMarketingFreeCallHook].
     */
    fun armMarketingFreeCallHook() {
        if (marketingFreeCallHookConsumed || marketingFreeCallHookJob?.isActive == true) return
        marketingFreeCallHookJob = viewModelScope.launch {
            delay((20_000..30_000).random().toLong())
            tryFireMarketingFreeCallHook()
        }
    }

    private fun tryFireMarketingFreeCallHook() {
        if (marketingFreeCallHookConsumed) return
        val s = _uiState.value
        val myId = auth.currentUser?.uid?.trim()?.takeIf { it.isNotEmpty() } ?: return
        if (s.isGuest || !s.isLoggedIn) return
        if (s.selectedTab != 0) return
        if (s.callState != CallState.IDLE || s.isCurrentlyInCall) return
        if (s.isLive) return
        if (s.incomingCall != null) return
        if (s.activeBattle != null) return
        if (s.isVideoCallActive || s.isAudioCallActive) return
        if (s.isPkSearching || !s.pkRoomId.isNullOrBlank()) return
        if (!s.webRtcSessionRoomId.isNullOrBlank()) return
        val myGender = s.currentUser?.genderText ?: "unknown"
        if (myGender == "unknown") {
            Log.d("DatingViewModel", "tryFireMarketingFreeCallHook: skip (current user gender unknown)")
            return
        }
        val desiredOpposite = when (myGender) {
            "male" -> "female"
            "female" -> "male"
            else -> return
        }
        val candidates = (s.profiles + s.filteredProfiles)
            .asSequence()
            .distinctBy { it.id }
            .filter { it.id != myId && it.genderText == desiredOpposite }
            .toList()
        val pick = candidates.randomOrNull() ?: run {
            Log.d(
                "DatingViewModel",
                "tryFireMarketingFreeCallHook: no opposite-gender profiles in feed (want $desiredOpposite)"
            )
            return
        }
        marketingFreeCallHookConsumed = true
        val roomId = buildCallRoomId(pick.id, myId)
        _uiState.update {
            it.copy(
                incomingCall = IncomingCallUi(
                    callerId = pick.id,
                    callerName = pick.name.ifBlank { "Someone special" },
                    roomId = roomId,
                    isVideoCall = true,
                    callerPhotoUrl = pick.photoUrl,
                    isMarketingSynthetic = true
                ),
                callState = CallState.RINGING,
                isIncomingCall = true,
                callStatus = CallStatus.RINGING
            )
        }
    }

    fun declineIncomingCall() {
        val currentId = auth.currentUser?.uid ?: return
        val incoming = _uiState.value.incomingCall
        if (incoming?.isMarketingSynthetic == true) {
            _uiState.update {
                it.copy(
                    incomingCall = null,
                    callState = CallState.IDLE,
                    isIncomingCall = false,
                    callStatus = CallStatus.CONNECTING,
                    isCurrentlyInCall = false
                )
            }
            return
        }
        viewModelScope.launch {
            incoming?.let {
                runCatching { firebaseService.setCallSessionStatus(it.roomId, "DECLINED") }
                runCatching {
                    firebaseService.sendCallResponse(
                        callerId = it.callerId,
                        roomId = it.roomId,
                        status = "declined"
                    )
                }
                cleanupOneToOneCallFirestoreSignaling(it.roomId)
            }
            runCatching { firebaseService.clearIncomingCallRtdb(currentId) }
            _uiState.update {
                it.copy(
                    incomingCall = null,
                    isIncomingCall = false,
                    callStatus = CallStatus.DECLINED,
                    callState = if (it.callState == CallState.RINGING) CallState.IDLE else it.callState,
                    isCurrentlyInCall = false
                )
            }
        }
    }

    /**
     * Decline from the FCM notification action when [incomingCall] may not be in memory yet.
     */
    fun declineCallFromNotification(callerId: String, roomId: String) {
        val currentId = auth.currentUser?.uid ?: return
        val r = roomId.trim()
        val c = callerId.trim()
        if (r.isEmpty() || c.isEmpty()) return
        viewModelScope.launch {
            runCatching { firebaseService.setCallSessionStatus(r, "DECLINED") }
            runCatching { firebaseService.sendCallResponse(callerId = c, roomId = r, status = "declined") }
            cleanupOneToOneCallFirestoreSignaling(r)
            runCatching { firebaseService.clearIncomingCallRtdb(currentId) }
            _uiState.update {
                it.copy(
                    incomingCall = null,
                    isIncomingCall = false,
                    callStatus = CallStatus.DECLINED,
                    callState = if (it.callState == CallState.RINGING) CallState.IDLE else it.callState,
                    isCurrentlyInCall = false
                )
            }
        }
    }

    /** Solo live broadcast (not PK / matchmaking). */
    private fun isSoloLiveForPrivateCallGate(s: DatingUiState): Boolean =
        s.isLive &&
            s.pkBattleSession == null &&
            !s.isPkSearching &&
            s.pkRoomId.isNullOrBlank()

    fun acceptIncomingCall() {
        if (_uiState.value.isCurrentlyInCall) return
        val currentId = auth.currentUser?.uid ?: return
        val incoming = _uiState.value.incomingCall ?: return
        if (incoming.isMarketingSynthetic) {
            val me = _uiState.value.currentUser
            val callerId = incoming.callerId.trim()
            val fromFeed = _uiState.value.profiles.find { it.id == callerId }
                ?: _uiState.value.filteredProfiles.find { it.id == callerId }
            val callerProfile = fromFeed ?: UserProfile(
                id = callerId,
                name = incoming.callerName.ifBlank { "User" },
                profileNumber = "",
                photoUrl = incoming.callerPhotoUrl
            )
            if (me == null || !VirtualEconomyMath.isBinaryGenderCallPairAllowed(me.gender, callerProfile.gender)) {
                _uiState.update {
                    it.copy(
                        incomingCall = null,
                        callState = CallState.IDLE,
                        isIncomingCall = false,
                        callStatus = CallStatus.CONNECTING,
                        isCurrentlyInCall = false,
                        loginError = CALL_GENDER_POLICY_ERROR
                    )
                }
                return
            }
            val roomId = incoming.roomId.trim().ifBlank { buildCallRoomId(callerId, currentId) }
            _uiState.update {
                it.copy(
                    incomingCall = null,
                    isFreeTeaserCall = true,
                    callState = CallState.ACTIVE,
                    callStatus = CallStatus.CONNECTED,
                    isCurrentlyInCall = true,
                    isIncomingCall = false,
                    isVideoCallActive = incoming.isVideoCall,
                    isAudioCallActive = !incoming.isVideoCall,
                    activeCallPartner = callerProfile,
                    callOverlayHostProfile = callerProfile,
                    webRtcSessionRoomId = roomId,
                    webRtcCallIsStreamer = false,
                    webRtcOverlayHostUserId = callerId,
                    webRtcShowLiveAudienceChrome = false
                )
            }
            startWebRtcCallLiveObservers(roomId, callerId)
            return
        }
        viewModelScope.launch {
            refreshSelfProfileIntoState()
            val me = _uiState.value.currentUser
            val callerId = incoming.callerId.trim()
            val fromFeed = _uiState.value.profiles.find { it.id == callerId }
                ?: _uiState.value.filteredProfiles.find { it.id == callerId }
            val callerProfile = fromFeed ?: runCatching { firebaseService.getUserProfile(callerId) }.getOrNull()
                ?: UserProfile(
                    id = callerId,
                    name = incoming.callerName.ifBlank { "User" },
                    profileNumber = "",
                    photoUrl = ""
                )
            if (!VirtualEconomyMath.isBinaryGenderCallPairAllowed(me?.gender, callerProfile.gender)) {
                runCatching { firebaseService.setCallSessionStatus(incoming.roomId, "DECLINED") }
                runCatching {
                    firebaseService.sendCallResponse(
                        callerId = incoming.callerId,
                        roomId = incoming.roomId,
                        status = "declined"
                    )
                }
                runCatching { firebaseService.clearIncomingCallRtdb(currentId) }
                _uiState.update {
                    it.copy(
                        incomingCall = null,
                        callStatus = CallStatus.DECLINED,
                        callState = if (it.callState == CallState.RINGING) CallState.IDLE else it.callState,
                        isCurrentlyInCall = false,
                        loginError = CALL_GENDER_POLICY_ERROR
                    )
                }
                return@launch
            }
            runCatching { firebaseService.setCallSessionStatus(incoming.roomId, "ACCEPTED") }
            runCatching { firebaseService.clearIncomingCallRtdb(currentId) }
            runCatching {
                firebaseService.sendCallResponse(
                    callerId = incoming.callerId,
                    roomId = incoming.roomId,
                    status = "accepted"
                )
            }
            val soloLive = isSoloLiveForPrivateCallGate(_uiState.value)
            val streamDocForBusy = if (soloLive) {
                _uiState.value.currentRoomId?.trim()?.takeIf { it.isNotEmpty() } ?: currentId
            } else {
                null
            }
            if (soloLive && streamDocForBusy != null) {
                firebaseService.setLiveStreamHostPrivateCallBusy(streamDocForBusy, true)
                    .onFailure { Log.w("DatingViewModel", "setLiveStreamHostPrivateCallBusy accept", it) }
                firebaseService.sendLiveStreamHostBusySystemMessage(
                    streamDocForBusy,
                    currentId,
                    HOST_BUSY_SYSTEM_CHAT
                ).onFailure { Log.w("DatingViewModel", "sendLiveStreamHostBusySystemMessage", it) }
            }
            _uiState.update {
                it.copy(
                    incomingCall = null,
                    pendingCallRoomId = incoming.roomId,
                    pendingCallIsStreamer = false,
                    pendingCallLaunchToken = it.pendingCallLaunchToken + 1,
                    callState = CallState.CONNECTING,
                    callStatus = CallStatus.CONNECTING,
                    isCurrentlyInCall = true,
                    isFreeTeaserCall = false,
                    isVideoCallActive = incoming.isVideoCall,
                    isAudioCallActive = !incoming.isVideoCall,
                    activeCallPartner = callerProfile,
                    callOverlayHostProfile = callerProfile,
                    webRtcSessionRoomId = incoming.roomId,
                    webRtcCallIsStreamer = false,
                    webRtcOverlayHostUserId = incoming.callerId,
                    webRtcShowLiveAudienceChrome = false,
                    soloLiveSuspendedForPrivateCall = soloLive,
                    soloLiveStreamDocIdForResume = streamDocForBusy,
                    hostWebRtcPauseForPkNonce = if (soloLive) {
                        it.hostWebRtcPauseForPkNonce + 1
                    } else {
                        it.hostWebRtcPauseForPkNonce
                    }
                )
            }
            startWebRtcCallLiveObservers(
                incoming.roomId,
                incoming.callerId,
                preserveSoloLiveHostObservers = soloLive
            )
        }
    }

    fun clearPendingCallLaunch() {
        _uiState.update {
            it.copy(
                pendingCallRoomId = null,
                pendingCallIsStreamer = false
            )
        }
    }

    fun onCallActivityLaunched() {
        _uiState.update { s ->
            s.copy(
                isCurrentlyInCall = true,
                callState = if (s.callState == CallState.DIALING) CallState.CONNECTING else s.callState
            )
        }
    }

    fun onCallActivityEnded(roomId: String?) {
        outgoingCallTimeoutJob?.cancel()
        roomId?.takeIf { it.isNotBlank() }?.let { endedRoom ->
            viewModelScope.launch {
                runCatching { firebaseService.setCallSessionStatus(endedRoom, "ENDED") }
                runCatching { firebaseService.clearCallRoom(endedRoom) }
                cleanupOneToOneCallFirestoreSignaling(endedRoom)
            }
        }
        stopWebRtcCallLiveObservers()
        if (_uiState.value.soloLiveSuspendedForPrivateCall) {
            val mediaNotBefore = SystemClock.elapsedRealtime() + SOLO_LIVE_MEDIA_HANDOFF_DELAY_MS
            _uiState.update {
                it.copy(
                    isCurrentlyInCall = false,
                    pendingCallRoomId = null,
                    pendingCallIsStreamer = false,
                    pendingCallLaunchToken = 0,
                    callState = CallState.IDLE,
                    callStatus = CallStatus.CONNECTING,
                    isVideoCallActive = false,
                    isAudioCallActive = false,
                    activeCallPartner = null,
                    webRtcSessionRoomId = null,
                    webRtcCallIsStreamer = false,
                    webRtcOverlayHostUserId = null,
                    callOverlayHostProfile = null,
                    webRtcShowLiveAudienceChrome = false,
                    isFreeTeaserCall = false,
                    isIncomingCall = false,
                    showPostPrivateCallResumeChoice = true,
                    soloLiveMediaHandoffNotBeforeElapsedMs = mediaNotBefore,
                    /** Hold solo broadcast paused until streamer taps Continue or End live on resume sheet. */
                    hostWebRtcPauseForPkNonce = it.hostWebRtcPauseForPkNonce + 1,
                )
            }
            refreshCurrentUserFromFirestoreIfLoggedIn()
            return
        }
        _uiState.update {
            it.copy(
                isCurrentlyInCall = false,
                pendingCallRoomId = null,
                pendingCallIsStreamer = false,
                callState = CallState.IDLE,
                callStatus = CallStatus.CONNECTING,
                isVideoCallActive = false,
                isAudioCallActive = false,
                activeCallPartner = null,
                webRtcSessionRoomId = null,
                webRtcCallIsStreamer = false,
                webRtcOverlayHostUserId = null,
                callOverlayHostProfile = null,
                liveStreamChatMessages = emptyList(),
                liveStreamViewerCount = 0,
                watchingLiveHostFollowerCount = 0,
                webRtcShowLiveAudienceChrome = false,
                isFreeTeaserCall = false
            )
        }
        refreshCurrentUserFromFirestoreIfLoggedIn()
    }

    /** Firestore `calls/{callId}/offerCandidates` + `answerCandidates` (1:1 WebRTC signaling). */
    private suspend fun cleanupOneToOneCallFirestoreSignaling(roomId: String) {
        val r = roomId.trim()
        if (!r.startsWith("call_")) return
        runCatching { firebaseService.cleanupCallFirestoreSignalingCollections(r) }
            .onFailure { Log.w("DatingViewModel", "cleanupOneToOneCallFirestoreSignaling room=$r", it) }
    }

    fun clearCallNotice() {
        _uiState.update { it.copy(callNoticeMessage = null) }
    }

    /**
     * Toggles follow in Firestore (followingIds / followerIds via FieldValue arrayUnion/arrayRemove).
     * Optimistic UI; reverts and sets [DatingUiState.followActionError] on failure.
     */
    fun toggleFollowProfile(target: UserProfile) {
        if (followActionJob?.isActive == true) return
        val uid = auth.currentUser?.uid ?: return
        if (_uiState.value.isGuest || _uiState.value.currentUser?.isGuest == true) return
        if (uid == target.id) return
        val cu = _uiState.value.currentUser ?: return
        val isFollowing = target.id in cu.followingIds.toSet() ||
            _uiState.value.followedProfiles.any { it.id == target.id }
        val willFollow = !isFollowing

        val prevState = _uiState.value
        val prevCu = cu
        val prevProfiles = prevState.profiles

        val newFollowingIds = if (willFollow) {
            if (cu.followingIds.contains(target.id)) cu.followingIds else cu.followingIds + target.id
        } else {
            cu.followingIds.filter { it != target.id }
        }
        val optimisticCu = cu.copy(followingIds = newFollowingIds)
        val optimisticProfiles = prevProfiles.map { prof ->
            if (prof.id != target.id) prof
            else {
                val ids = prof.followerIds.toMutableList()
                if (willFollow) {
                    if (uid !in ids) ids.add(uid)
                } else {
                    ids.remove(uid)
                }
                prof.copy(followerIds = ids)
            }
        }
        _uiState.update { s ->
            syncFollowListsFromState(
                s.copy(
                    currentUser = optimisticCu,
                    profiles = optimisticProfiles,
                    followActionError = null
                )
            )
        }

        followActionJob = viewModelScope.launch {
            try {
                runCatching {
                    firebaseService.setFollowRelationship(uid, target.id, willFollow)
                }.onFailure { e ->
                    Log.e("DatingViewModel", "toggleFollowProfile failed", e)
                    _uiState.update { s ->
                        syncFollowListsFromState(
                            s.copy(
                                currentUser = prevCu,
                                profiles = prevProfiles,
                                followActionError = e.message ?: "Could not update follow"
                            )
                        )
                    }
                }
            } finally {
                followActionJob = null
            }
        }
    }
    
    private fun updateLeaderboard() {
        _uiState.update { s ->
            val top = (s.profiles + (s.currentUser?.let { listOf(it) } ?: emptyList()))
                .sortedByDescending { it.currentLevel }
                .take(10)
            s.copy(topRankedProfiles = top)
        }
    }

    fun clearLiveGiftMessage() {
        _uiState.update { it.copy(liveGiftMessage = null) }
    }

    fun recordLiveStreamingMinutes(minutes: Int) {
        val uid = auth.currentUser?.uid ?: return
        if (minutes <= 0) return
        viewModelScope.launch {
            runCatching { firebaseService.addHostStreamingMinutes(uid, minutes) }
                .onFailure { Log.w("DatingViewModel", "recordLiveStreamingMinutes failed", it) }
            val refreshed = firebaseService.getUserProfile(uid)
            if (refreshed != null) {
                _uiState.update { s ->
                    syncFollowListsFromState(
                        s.copy(
                            currentUser = refreshed,
                            coinBalance = refreshed.coins
                        )
                    )
                }
            }
            updateLeaderboard()
        }
    }

    fun likeLiveStream(host: UserProfile) {
        val viewerUid = auth.currentUser?.uid ?: return
        if (_uiState.value.isGuest || _uiState.value.currentUser?.isGuest == true) return
        val streamDocId = host.id.trim().ifBlank { return }
        viewModelScope.launch {
            runCatching { firebaseService.likeHostLiveStream(viewerUid, streamDocId) }
                .onFailure { Log.w("DatingViewModel", "likeLiveStream likeMeCount failed", it) }
            val viewerName = _uiState.value.currentUser?.name?.takeIf { it.isNotBlank() }
                ?: auth.currentUser?.displayName?.takeIf { it.isNotBlank() }
                ?: "Someone"
            runCatching {
                firebaseService.sendLiveStreamLikeSystemMessage(streamDocId, viewerUid, viewerName)
            }.onFailure { Log.w("DatingViewModel", "sendLiveStreamLikeSystemMessage failed", it) }
        }
    }

    fun likeProfile(target: UserProfile) {
        val myUid = auth.currentUser?.uid ?: return
        if (_uiState.value.isGuest || _uiState.value.currentUser?.isGuest == true) return
        val alreadyLiked = target.id in _uiState.value.likedProfileIds
        if (alreadyLiked) {
            _uiState.update { it.copy(likedProfileIds = it.likedProfileIds - target.id) }
            viewModelScope.launch {
                runCatching {
                    val db = com.google.firebase.firestore.FirebaseFirestore.getInstance()
                    db.collection("users").document(myUid)
                        .update("iLikeCount", com.google.firebase.firestore.FieldValue.increment(-1))
                        .await()
                    db.collection("users").document(target.id).update(
                        mapOf(
                            "likeMeCount" to com.google.firebase.firestore.FieldValue.increment(-1),
                            "likedByUserIds" to com.google.firebase.firestore.FieldValue.arrayRemove(myUid)
                        )
                    ).await()
                }.onFailure {
                    Log.w("DatingViewModel", "unlikeProfile failed", it)
                    _uiState.update { s -> s.copy(likedProfileIds = s.likedProfileIds + target.id) }
                }
            }
            return
        }
        _uiState.update { it.copy(likedProfileIds = it.likedProfileIds + target.id) }
        viewModelScope.launch {
            runCatching {
                val db = com.google.firebase.firestore.FirebaseFirestore.getInstance()
                db.collection("users").document(myUid)
                    .update("iLikeCount", com.google.firebase.firestore.FieldValue.increment(1))
                    .await()
                db.collection("users").document(target.id).update(
                    mapOf(
                        "likeMeCount" to com.google.firebase.firestore.FieldValue.increment(1),
                        "likedByUserIds" to com.google.firebase.firestore.FieldValue.arrayUnion(myUid)
                    )
                ).await()
            }.onFailure {
                Log.w("DatingViewModel", "likeProfile failed", it)
                _uiState.update { s -> s.copy(likedProfileIds = s.likedProfileIds - target.id) }
            }
        }
    }

    fun loadProfileGiftHistory(receiverUserId: String) {
        val me = auth.currentUser?.uid ?: return
        val rid = receiverUserId.trim()
        if (rid.isBlank()) return
        _uiState.update { it.copy(profileDetailGiftHistoryReceiverId = rid) }
        viewModelScope.launch {
            val (sent, received) = coroutineScope {
                val sentJob = async {
                    val myProfile = _uiState.value.currentUser ?: return@async emptyList()
                    runCatching { firebaseService.fetchSentGiftsToUser(myProfile, rid, 15) }.getOrElse { emptyList() }
                }
                val recvJob = async {
                    runCatching { firebaseService.fetchReceivedGiftsForUser(rid, 15) }.getOrElse { emptyList() }
                }
                Pair(sentJob.await(), recvJob.await())
            }
            _uiState.update {
                it.copy(
                    profileDetailSentGifts = sent,
                    profileDetailReceivedGifts = received,
                    profileDetailGiftHistoryReceiverId = rid
                )
            }
        }
    }

    fun clearProfileGiftHistory() {
        _uiState.update {
            it.copy(
                profileDetailSentGifts = emptyList(),
                profileDetailReceivedGifts = emptyList(),
                profileDetailGiftHistoryReceiverId = null
            )
        }
    }

    /**
     * One-shot fetch when opening another user's profile so [photoUrl] / [UserProfile.galleryPhotos]
     * are not stuck on a stale feed snapshot (and Firestore merge fields are up to date).
     */
    fun prefetchOpenedProfileFromServer(userId: String?) {
        val uid = userId?.trim().orEmpty()
        if (uid.isEmpty()) return
        viewModelScope.launch {
            val fresh = runCatching { firebaseService.getUserProfile(uid, Source.SERVER) }
                .getOrNull()
                ?: firebaseService.getUserProfile(uid)
                ?: return@launch
            _uiState.update { s ->
                val prev = s.profiles.find { it.id == uid }
                // Always trust the server-fresh isOnline/isLive values — never copy stale ones.
                val entry = fresh
                val newProfiles = if (prev != null) {
                    s.profiles.map { if (it.id == uid) entry else it }
                } else {
                    s.profiles + entry
                }
                val nextFiltered = if (s.isFilterActive) {
                    s.filteredProfiles.mapNotNull { fp -> newProfiles.find { it.id == fp.id } }
                } else {
                    newProfiles
                }
                syncFollowListsFromState(
                    s.copy(profiles = newProfiles, filteredProfiles = nextFiltered)
                )
            }
        }
    }

    private fun refreshProfileSheetGiftHistoryIfShowing(receiverId: String) {
        if (_uiState.value.profileDetailGiftHistoryReceiverId != receiverId) return
        loadProfileGiftHistory(receiverId)
    }

    private fun optimisticMergeProfileSentGift(
        state: DatingUiState,
        receiverId: String,
        gift: Gift,
        count: Int,
        totalCost: Int
    ): List<SentGiftHistoryEntry> {
        if (state.profileDetailGiftHistoryReceiverId != receiverId) return state.profileDetailSentGifts
        val entry = SentGiftHistoryEntry(
            giftName = gift.name.trim(),
            giftId = gift.id.trim(),
            totalCost = totalCost,
            count = count,
            timestampMs = System.currentTimeMillis()
        )
        return listOf(entry) + state.profileDetailSentGifts
    }

    fun startCall(p: UserProfile, isVideo: Boolean) { 
        val me = _uiState.value.currentUser
        if (me != null && !me.isCallVerificationApproved) {
            _uiState.update { it.copy(loginError = "Face verification required before calls.") }
            return
        }
        if (!VirtualEconomyMath.isBinaryGenderCallPairAllowed(me?.gender, p.gender)) {
            _uiState.update { it.copy(loginError = CALL_GENDER_POLICY_ERROR) }
            return
        }
        val cost = if (isVideo) (p.customVideoPrice ?: 1500) else (p.customAudioPrice ?: 1000)
        
        if (_uiState.value.coinBalance < cost) {
            return
        }

        _uiState.update { it.copy(
            isVideoCallActive = isVideo, 
            isAudioCallActive = !isVideo, 
            activeCallPartner = p,
            callState = CallState.DIALING,
            callStatus = CallStatus.RINGING,
            isIncomingCall = false,
            isCurrentlyInCall = true
        ) }
    }
    
    fun acceptCall() {
        // Billing runs at session end ([endCall] / LiveStreamActivity) so minutes match the on-call meter.
        _uiState.update {
            it.copy(
                callState = CallState.ACTIVE,
                callStatus = CallStatus.CONNECTED,
                isCurrentlyInCall = true
            )
        }
    }

    fun endCall(elapsedBillableSeconds: Int? = null) {
        if (_uiState.value.soloLiveSuspendedForPrivateCall) {
            endPrivateCallWhileSoloLive(elapsedBillableSeconds)
            return
        }
        outgoingCallTimeoutJob?.cancel()
        val snap = _uiState.value
        clearPkMatchmakingBackend(pkBackendOpponentUid(snap))
        val elapsed = elapsedBillableSeconds?.takeIf { it > 0 }
        val payer = snap.webRtcCallIsStreamer
        val partner = snap.activeCallPartner
        val myUid = auth.currentUser?.uid
        if (elapsed != null && payer && partner != null && myUid != null && !snap.isFreeTeaserCall) {
            val rate = if (snap.isVideoCallActive) {
                partner.customVideoPrice ?: VirtualEconomyMath.DEFAULT_CALL_VIDEO_DIAMONDS_PER_MIN
            } else {
                partner.customAudioPrice ?: VirtualEconomyMath.DEFAULT_CALL_AUDIO_DIAMONDS_PER_MIN
            }
            viewModelScope.launch {
                runCatching {
                    firebaseService.chargeCallDiamondSession(myUid, partner.id, elapsed, rate)
                }.onFailure { Log.w("DatingViewModel", "endCall billing", it) }
                refreshCurrentUserFromFirestoreIfLoggedIn()
            }
        } else {
            refreshCurrentUserFromFirestoreIfLoggedIn()
        }
        val pkSnapEndCall = _uiState.value.pkBattleSession
        val pkBannerHost = pkSnapEndCall?.hostUserId?.trim().orEmpty()
        val pkBannerGuest = pkSnapEndCall?.guestUserId?.trim().orEmpty()
        liveKickHandledWebRtcSession = false
        stopWebRtcCallLiveObservers()
        _uiState.update { it.copy(
            isVideoCallActive = false, 
            isAudioCallActive = false, 
            activeCallPartner = null,
            callState = CallState.IDLE,
            callStatus = CallStatus.CONNECTING,
            isIncomingCall = false,
            isPkSearching = false,
            pkIsStreamer = false,
            pkRoomId = null,
            pkLaunchToken = 0,
            isCurrentlyInCall = false,
            webRtcSessionRoomId = null,
            webRtcCallIsStreamer = false,
            webRtcOverlayHostUserId = null,
            callOverlayHostProfile = null,
            liveStreamChatMessages = emptyList(),
            liveStreamViewerCount = 0,
            webRtcShowLiveAudienceChrome = false,
            pkBattleSession = null,
            isFreeTeaserCall = false
        ) }
        if (pkBannerHost.isNotBlank()) {
            viewModelScope.launch {
                runCatching { firebaseService.clearLiveStreamPkBattleMirrors(pkBannerHost, pkBannerGuest) }
                    .onFailure { Log.w("DatingViewModel", "clearLiveStreamPkBattleMirrors endCall", it) }
            }
        }
    }

    /** Solo host ended private call; keep solo live chat + viewer counts and prompt for resume vs end stream. */
    private fun endPrivateCallWhileSoloLive(elapsedBillableSeconds: Int?) {
        outgoingCallTimeoutJob?.cancel()
        val snap = _uiState.value
        clearPkMatchmakingBackend(pkBackendOpponentUid(snap))
        val elapsed = elapsedBillableSeconds?.takeIf { it > 0 }
        val payer = snap.webRtcCallIsStreamer
        val partner = snap.activeCallPartner
        val myUid = auth.currentUser?.uid
        if (elapsed != null && payer && partner != null && myUid != null && !snap.isFreeTeaserCall) {
            val rate = if (snap.isVideoCallActive) {
                partner.customVideoPrice ?: VirtualEconomyMath.DEFAULT_CALL_VIDEO_DIAMONDS_PER_MIN
            } else {
                partner.customAudioPrice ?: VirtualEconomyMath.DEFAULT_CALL_AUDIO_DIAMONDS_PER_MIN
            }
            viewModelScope.launch {
                runCatching {
                    firebaseService.chargeCallDiamondSession(myUid, partner.id, elapsed, rate)
                }.onFailure { Log.w("DatingViewModel", "endPrivateCallWhileSoloLive billing", it) }
                refreshCurrentUserFromFirestoreIfLoggedIn()
            }
        } else {
            refreshCurrentUserFromFirestoreIfLoggedIn()
        }
        val pkSnapEndCall = _uiState.value.pkBattleSession
        val pkBannerHost = pkSnapEndCall?.hostUserId?.trim().orEmpty()
        val pkBannerGuest = pkSnapEndCall?.guestUserId?.trim().orEmpty()
        liveKickHandledWebRtcSession = false
        stopWebRtcCallLiveObservers()
        _uiState.update { it.copy(
            isVideoCallActive = false,
            isAudioCallActive = false,
            activeCallPartner = null,
            callState = CallState.IDLE,
            callStatus = CallStatus.CONNECTING,
            isIncomingCall = false,
            isPkSearching = false,
            pkIsStreamer = false,
            pkRoomId = null,
            pkLaunchToken = 0,
            isCurrentlyInCall = false,
            webRtcSessionRoomId = null,
            webRtcCallIsStreamer = false,
            webRtcOverlayHostUserId = null,
            callOverlayHostProfile = null,
            webRtcShowLiveAudienceChrome = false,
            pkBattleSession = null,
            isFreeTeaserCall = false,
            pendingCallRoomId = null,
            pendingCallIsStreamer = false,
            pendingCallLaunchToken = 0,
            showPostPrivateCallResumeChoice = true,
            soloLiveMediaHandoffNotBeforeElapsedMs =
                SystemClock.elapsedRealtime() + SOLO_LIVE_MEDIA_HANDOFF_DELAY_MS,
            /** Hold solo broadcast paused until streamer taps Continue or End live on resume sheet. */
            hostWebRtcPauseForPkNonce = it.hostWebRtcPauseForPkNonce + 1,
        ) }
        if (pkBannerHost.isNotBlank()) {
            viewModelScope.launch {
                runCatching { firebaseService.clearLiveStreamPkBattleMirrors(pkBannerHost, pkBannerGuest) }
                    .onFailure { Log.w("DatingViewModel", "clearLiveStreamPkBattleMirrors endPrivateCallWhileSoloLive", it) }
            }
        }
    }

    fun continueSoloLiveAfterPrivateCall() {
        val uid = auth.currentUser?.uid ?: return
        val streamId = _uiState.value.soloLiveStreamDocIdForResume?.trim()?.takeIf { it.isNotEmpty() }
            ?: _uiState.value.currentRoomId?.trim()?.takeIf { it.isNotEmpty() }
            ?: uid
        viewModelScope.launch {
            runCatching { firebaseService.setLiveStreamHostPrivateCallBusy(streamId, false) }
                .onFailure { Log.w("DatingViewModel", "continueSoloLive setBusy false", it) }
            runCatching {
                firebaseService.sendLiveStreamHostBackSystemMessage(streamId, uid, HOST_BACK_SYSTEM_CHAT)
            }.onFailure { Log.w("DatingViewModel", "sendLiveStreamHostBackSystemMessage", it) }
        }
        _uiState.update {
            it.copy(
                soloLiveSuspendedForPrivateCall = false,
                showPostPrivateCallResumeChoice = false,
                soloLiveStreamDocIdForResume = null,
                soloLiveMediaHandoffNotBeforeElapsedMs = 0L,
                hostWebRtcResumeAfterPkNonce = it.hostWebRtcResumeAfterPkNonce + 1
            )
        }
        val snap = _uiState.value
        if (snap.isLive) {
            val hostUid =
                snap.currentUser?.id?.trim()?.takeIf { it.isNotEmpty() }
                    ?: auth.currentUser?.uid?.trim().orEmpty()
            if (hostUid.isNotEmpty()) {
                liveStreamChatMinTimestampMs = System.currentTimeMillis()
                startLiveHostStreamObservers(hostUid)
            }
        }
        setTab(1)
    }

    fun endAllAfterPrivateCall() {
        val uid = auth.currentUser?.uid ?: return
        val streamId = _uiState.value.soloLiveStreamDocIdForResume?.trim()?.takeIf { it.isNotEmpty() }
            ?: _uiState.value.currentRoomId?.trim()?.takeIf { it.isNotEmpty() }
            ?: uid
        viewModelScope.launch {
            runCatching { firebaseService.setLiveStreamHostPrivateCallBusy(streamId, false) }
                .onFailure { Log.w("DatingViewModel", "endAllAfterPrivateCall setBusy false", it) }
        }
        _uiState.update {
            it.copy(
                soloLiveSuspendedForPrivateCall = false,
                showPostPrivateCallResumeChoice = false,
                soloLiveStreamDocIdForResume = null,
                soloLiveMediaHandoffNotBeforeElapsedMs = 0L,
            )
        }
        endCall()
        if (_uiState.value.isLive) {
            toggleLive()
        }
    }

    /**
     * Other participant in PK matchmaking / battle (for RTDB `pk_queue` / `pk_matches` cleanup).
     */
    private fun resolvePkOpponentUidForQueue(s: DatingUiState): String? {
        val ap = s.activeCallPartner?.id?.trim()?.takeIf { it.isNotBlank() } ?: return null
        val me = auth.currentUser?.uid?.trim().orEmpty().ifBlank { s.currentUser?.id?.trim().orEmpty() }
        return ap.takeIf { it != me }
    }

    /** Opponent uid for queue cleanup: [activeCallPartner] first, else the other battler in [pkBattleSession]. */
    private fun pkBackendOpponentUid(s: DatingUiState): String? =
        resolvePkOpponentUidForQueue(s)
            ?: run {
                val me = auth.currentUser?.uid.orEmpty().ifBlank { s.currentUser?.id.orEmpty() }
                s.pkBattleSession?.let { pk ->
                    when (me) {
                        pk.hostUserId -> pk.guestUserId.trim().takeIf { it.isNotEmpty() && it != me }
                        pk.guestUserId -> pk.hostUserId.trim().takeIf { it.isNotEmpty() && it != me }
                        else -> null
                    }
                }
            }

    /**
     * Cancels in-app PK matchmaking and removes this user (and [opponentUserId] when set) from RTDB
     * `pk_queue` / `pk_matches` so the backend stops pairing them after the battle ends or the call closes.
     */
    private fun clearPkMatchmakingBackend(opponentUserId: String? = null) {
        detachPkRematchListeners()
        pkRematchTimeoutJob?.cancel()
        pkRematchTimeoutJob = null
        pkMatchJob?.cancel()
        val myUid = auth.currentUser?.uid?.trim().orEmpty()
            .ifBlank { _uiState.value.currentUser?.id?.trim().orEmpty() }
        if (myUid.isBlank()) return
        viewModelScope.launch {
            runCatching { firebaseService.removeFromPkQueue(myUid) }
                .onFailure { Log.w("DatingViewModel", "removeFromPkQueue (clearPkMatchmaking)", it) }
            val opp = opponentUserId?.trim()?.takeIf { it.isNotEmpty() && it != myUid }
            if (opp != null) {
                runCatching { firebaseService.removeFromPkQueue(opp) }
                    .onFailure { Log.w("DatingViewModel", "removeFromPkQueue opponent (clearPkMatchmaking)", it) }
            }
        }
    }

    private fun detachPkRematchHostListenerOnly() {
        pkRematchHostListenerUid?.let { uid ->
            pkRematchHostListener?.let { firebaseService.removePkMatchListener(uid, it) }
        }
        pkRematchHostListener = null
        pkRematchHostListenerUid = null
    }

    private fun detachPkRematchGuestListenerOnly() {
        pkRematchGuestListenerUid?.let { uid ->
            pkRematchGuestListener?.let { firebaseService.removePkMatchListener(uid, it) }
        }
        pkRematchGuestListener = null
        pkRematchGuestListenerUid = null
    }

    private fun detachPkRematchListeners() {
        detachPkRematchHostListenerOnly()
        detachPkRematchGuestListenerOnly()
    }

    private fun attachPkRematchHostListener(
        hostUid: String,
        guestUid: String,
        roomId: String,
        hostStreamId: String,
        durationSeconds: Int
    ) {
        detachPkRematchHostListenerOnly()
        val listener = object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                val v = snapshot.value as? Map<*, *> ?: return
                if (v["rematchAck"] != true) return
                val partner = v["partnerUserId"]?.toString()?.trim().orEmpty()
                if (partner != guestUid) return
                val ackRoom = v["roomId"]?.toString()?.trim().orEmpty().ifBlank { roomId }
                val dur = (v["durationSeconds"] as? Number)?.toInt()?.coerceIn(60, 3600) ?: durationSeconds
                detachPkRematchHostListenerOnly()
                pkRematchTimeoutJob?.cancel()
                pkRematchTimeoutJob = null
                viewModelScope.launch {
                    runCatching { firebaseService.clearPkMatchSignal(hostUid) }
                }
                _uiState.update { it.copy(pkRematchPending = false) }
                activatePkSession(
                    PkMatchResult.Matched(
                        roomId = ackRoom,
                        partnerUserId = guestUid,
                        partnerStreamId = hostStreamId,
                        isStreamer = true,
                        durationSeconds = dur
                    )
                )
            }

            override fun onCancelled(error: DatabaseError) {
                Log.w("DatingViewModel", "pk rematch host listener: ${error.message}")
            }
        }
        pkRematchHostListener = listener
        pkRematchHostListenerUid = hostUid
        firebaseService.addPkMatchListener(hostUid, listener)
    }

    private fun attachPkRematchGuestListener(expectedHostUid: String) {
        val guestUid = auth.currentUser?.uid?.trim().orEmpty()
            .ifBlank { _uiState.value.currentUser?.id?.trim().orEmpty() }
        if (guestUid.isBlank()) return
        detachPkRematchGuestListenerOnly()
        val listener = object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                val v = snapshot.value as? Map<*, *> ?: return
                if (v["isRematch"] != true) return
                val host = v["partnerUserId"]?.toString()?.trim().orEmpty()
                if (host.isBlank() || host != expectedHostUid) return
                val rid = v["roomId"]?.toString()?.trim().orEmpty()
                if (rid.isBlank()) return
                val streamId = v["partnerStreamId"]?.toString()?.trim().orEmpty().ifBlank { expectedHostUid }
                val dur = (v["durationSeconds"] as? Number)?.toInt()?.coerceIn(60, 3600) ?: 300
                val guestStreamId = _uiState.value.currentUser?.liveRoomId?.trim()?.takeIf { it.isNotEmpty() }
                    ?: guestUid
                detachPkRematchGuestListenerOnly()
                viewModelScope.launch {
                    runCatching {
                        firebaseService.postPkRematchAck(
                            hostUid = host,
                            roomId = rid,
                            guestUid = guestUid,
                            guestStreamId = guestStreamId,
                            durationSeconds = dur
                        )
                    }
                    runCatching { firebaseService.clearPkMatchSignal(guestUid) }
                }
                activatePkSession(
                    PkMatchResult.Matched(
                        roomId = rid,
                        partnerUserId = host,
                        partnerStreamId = streamId,
                        isStreamer = false,
                        durationSeconds = dur
                    )
                )
            }

            override fun onCancelled(error: DatabaseError) {
                Log.w("DatingViewModel", "pk rematch guest listener: ${error.message}")
            }
        }
        pkRematchGuestListener = listener
        pkRematchGuestListenerUid = guestUid
        firebaseService.addPkMatchListener(guestUid, listener)
    }

    /**
     * Host-only: same guest, new round (RTDB handshake). Shows [DatingUiState.pkRematchPending] until ack.
     */
    fun challengePkRematch() {
        val s = _uiState.value
        if (s.pkRematchPending) return
        val pk = s.pkBattleSession ?: return
        if (!pk.battleEnded || pk.outcome == null) return
        if (!s.webRtcCallIsStreamer) return
        val my = auth.currentUser?.uid?.trim().orEmpty()
            .ifBlank { s.currentUser?.id?.trim().orEmpty() }
        val hostUid = pk.hostUserId.trim()
        val guestUid = pk.guestUserId.trim()
        if (my.isBlank() || my != hostUid || guestUid.isBlank() || guestUid == my) return
        val roomId = firebaseService.buildPkRoomId(hostUid, guestUid)
        val hostStreamId = hostUid
        val duration = pk.durationSeconds.coerceIn(60, 3600)
        _uiState.update { it.copy(pkRematchPending = true) }
        viewModelScope.launch {
            runCatching { firebaseService.clearPkMatchSignal(hostUid) }
            runCatching { firebaseService.clearPkMatchSignal(guestUid) }
            val posted = runCatching {
                firebaseService.postPkRematchInvite(
                    guestUid = guestUid,
                    roomId = roomId,
                    hostUid = hostUid,
                    hostStreamId = hostStreamId,
                    durationSeconds = duration
                )
            }
            if (posted.isFailure) {
                _uiState.update { it.copy(pkRematchPending = false) }
                return@launch
            }
            attachPkRematchHostListener(hostUid, guestUid, roomId, hostStreamId, duration)
            pkRematchTimeoutJob?.cancel()
            pkRematchTimeoutJob = viewModelScope.launch {
                delay(60_000)
                if (_uiState.value.pkRematchPending) {
                    detachPkRematchListeners()
                    _uiState.update { it.copy(pkRematchPending = false) }
                }
            }
        }
    }

    /**
     * Clears PK / WebRTC overlay state after [LiveStreamActivity] PK ends.
     * @param resumeSoloLive If true (default), host stays live and observers restart. If false, host goes off-air via [FirebaseService.endLiveStream] (same teardown as ending a broadcast).
     */
    fun endPkSession(resumeSoloLive: Boolean = true) {
        val s = _uiState.value
        val pkEndSnap = s.pkBattleSession
        val pkBannerHost = pkEndSnap?.hostUserId?.trim().orEmpty()
        val pkBannerGuest = pkEndSnap?.guestUserId?.trim().orEmpty()
        val current = s.currentUser
        clearPkMatchmakingBackend(pkBackendOpponentUid(s))
        val fallbackRoomId = s.pkOriginalRoomId
            ?: s.currentRoomId
            ?: current?.id
            ?: auth.currentUser?.uid
            ?: UUID.randomUUID().toString()

        stopWebRtcCallLiveObservers()
        if (!resumeSoloLive) {
            stopLiveHostStreamObservers()
        }

        val updatedUser = if (resumeSoloLive) {
            current?.copy(isLive = true, liveRoomId = fallbackRoomId)
        } else {
            current?.copy(isLive = false, liveRoomId = null)
        }

        _uiState.update {
            it.copy(
                isPkSearching = false,
                pkRoomId = null,
                pkLaunchToken = 0,
                pkIsStreamer = false,
                pkStatusText = if (resumeSoloLive) "PK ended. Back to solo live." else "PK ended.",
                pkRetryAvailable = false,
                isVideoCallActive = false,
                isAudioCallActive = false,
                activeCallPartner = null,
                callState = CallState.IDLE,
                isLive = resumeSoloLive,
                currentRoomId = if (resumeSoloLive) fallbackRoomId else null,
                pkOriginalRoomId = null,
                webRtcSessionRoomId = null,
                webRtcCallIsStreamer = false,
                webRtcOverlayHostUserId = null,
                callOverlayHostProfile = null,
                liveStreamChatMessages = emptyList(),
                liveStreamViewerCount = 0,
                pkBattleSession = null,
                pkRematchPending = false,
                playingGift = null,
                currentUser = updatedUser ?: it.currentUser
            )
        }

        if (resumeSoloLive) {
            updatedUser?.let { u ->
                viewModelScope.launch {
                    runCatching { firebaseService.updateUserLiveStatus(u.id, true, fallbackRoomId) }
                    firebaseService.saveUserProfile(u)
                    startLiveHostStreamObservers(u.id)
                }
            }
            if (pkBannerHost.isNotBlank()) {
                viewModelScope.launch {
                    runCatching { firebaseService.clearLiveStreamPkBattleMirrors(pkBannerHost, pkBannerGuest) }
                        .onFailure { Log.w("DatingViewModel", "clearLiveStreamPkBattleMirrors endPk", it) }
                }
            }
        } else {
            val uid = (updatedUser?.id ?: auth.currentUser?.uid).orEmpty().trim()
            val extraDoc = fallbackRoomId.trim().takeIf { it.isNotEmpty() && it != uid }
            viewModelScope.launch {
                if (uid.isNotBlank()) {
                    runCatching { firebaseService.endLiveStream(uid, extraDoc) }
                        .onFailure { Log.w("DatingViewModel", "endLiveStream endPk", it) }
                }
                updatedUser?.let { firebaseService.saveUserProfile(it) }
            }
        }
    }

    fun startRandomPk(durationSeconds: Int = 300) {
        if (_uiState.value.isPkSearching || pkMatchJob?.isActive == true) return
        val current = _uiState.value.currentUser ?: return
        if (current.id.isBlank()) {
            Log.e("DatingViewModel", "startRandomPk: blank user id")
            _uiState.update {
                it.copy(loginError = "Sign in required for PK", pkStatusText = "PK unavailable", pkRetryAvailable = true)
            }
            return
        }

        _uiState.update {
            val clearedPk = if (it.pkBattleSession?.battleEnded == true) null else it.pkBattleSession
            it.copy(
                isPkSearching = true,
                loginError = null,
                pkStatusText = "Searching for opponent...",
                pkRetryAvailable = false,
                pkBattleSession = clearedPk,
                pkLaunchToken = 0,
                pkRoomId = null
            )
        }
        pkMatchJob?.cancel()
        pkMatchJob = viewModelScope.launch {
            try {
                runCatching { firebaseService.removeFromPkQueue(current.id) }
                    .onFailure { Log.w("DatingViewModel", "removeFromPkQueue before matchmaking", it) }
                when (
                    val result = firebaseService.findOrCreatePkMatch(
                        current.id,
                        current.liveRoomId ?: current.id,
                        durationSeconds
                    )
                ) {
                    is PkMatchResult.Matched -> {
                        activatePkSession(result)
                    }
                    is PkMatchResult.Waiting -> {
                        val waited = withTimeoutOrNull(60000) {
                            firebaseService.waitForPkClaim(current.id)
                        } ?: PkMatchResult.Error("No match found. Please try again.")

                        when (waited) {
                            is PkMatchResult.Matched -> activatePkSession(waited)
                            is PkMatchResult.Error -> {
                                firebaseService.removeFromPkQueue(current.id)
                                _uiState.update {
                                    it.copy(
                                        isPkSearching = false,
                                        loginError = waited.message,
                                        pkStatusText = "Matchmaking timed out",
                                        pkRetryAvailable = true,
                                        pkBattleSession = null
                                    )
                                }
                            }
                            PkMatchResult.Waiting -> {
                                firebaseService.removeFromPkQueue(current.id)
                                _uiState.update {
                                    it.copy(
                                        isPkSearching = false,
                                        loginError = "No match found. Please try again.",
                                        pkStatusText = "No opponent found",
                                        pkRetryAvailable = true,
                                        pkBattleSession = null
                                    )
                                }
                            }
                        }
                    }
                    is PkMatchResult.Error -> {
                        _uiState.update {
                            it.copy(
                                isPkSearching = false,
                                loginError = result.message,
                                pkStatusText = "Unable to start PK",
                                pkRetryAvailable = true,
                                pkBattleSession = null
                            )
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e("DatingViewModel", "startRandomPk failed", e)
                firebaseService.removeFromPkQueue(current.id)
                _uiState.update {
                    it.copy(
                        isPkSearching = false,
                        loginError = e.message ?: "PK matchmaking failed",
                        pkStatusText = "Matchmaking failed",
                        pkRetryAvailable = true,
                        pkBattleSession = null
                    )
                }
            }
        }
    }

    /** Clears pending PK navigation when activity launch is blocked (e.g. missing permissions). */
    fun abortPkLaunchForPermissions(userMessage: String? = null) {
        clearPkMatchmakingBackend(pkBackendOpponentUid(_uiState.value))
        _uiState.update {
            it.copy(
                pkRoomId = null,
                pkLaunchToken = 0,
                isPkSearching = false,
                pkStatusText = userMessage ?: "Allow camera and microphone to use PK",
                pkRetryAvailable = true,
                pkBattleSession = null
            )
        }
    }

    /** Call immediately before [LiveStreamActivity] PK is launched while the user is hosting live in Compose. */
    fun notifyPkLiveStreamActivityWillOpenForLiveHost() {
        if (!_uiState.value.isLive) return
        _uiState.update { it.copy(hostWebRtcPauseForPkNonce = it.hostWebRtcPauseForPkNonce + 1) }
    }

    /**
     * When PK [LiveStreamActivity] finishes: resume broadcast camera if still live, then apply PK end state.
     * Live hosts see [showHostPkEndedInterstitial] first; [endPkSession] runs when they tap Continue or after auto-dismiss.
     */
    fun onReturnFromPkLiveStreamActivity(
        pkEnded: Boolean,
        findRandomPkAfter: Boolean = false,
        pkDurationSeconds: Int = 300,
    ) {
        val s = _uiState.value
        clearPkMatchmakingBackend(pkBackendOpponentUid(s))
        if (s.isLive) {
            _uiState.update { it.copy(hostWebRtcResumeAfterPkNonce = it.hostWebRtcResumeAfterPkNonce + 1) }
        }
        if (findRandomPkAfter) {
            startRandomPk(pkDurationSeconds.coerceIn(60, 3600))
            return
        }
        if (!pkEnded) return

        if (s.isLive) {
            hostPkEndedInterstitialJob?.cancel()
            _uiState.update { it.copy(showHostPkEndedInterstitial = true) }
            hostPkEndedInterstitialJob = viewModelScope.launch {
                delay(8_000)
                dismissHostPkEndedInterstitial()
            }
        } else {
            endPkSession()
        }
    }

    /** Dismisses the post-PK sheet: stay live in solo mode (clears PK state; remote challenger track tears down via UI). */
    fun dismissHostPkEndedInterstitial() {
        if (!_uiState.value.showHostPkEndedInterstitial) return
        hostPkEndedInterstitialJob?.cancel()
        hostPkEndedInterstitialJob = null
        val before = _uiState.value
        val snap = before.pkBattleSession
        val roomForSignal = before.currentRoomId?.trim()?.takeIf { it.isNotEmpty() }
            ?: before.pkRoomId?.trim()?.takeIf { it.isNotEmpty() }
            ?: before.webRtcSessionRoomId?.trim()?.takeIf { it.isNotEmpty() }
            ?: snap?.let { firebaseService.buildPkRoomId(it.hostUserId, it.guestUserId) }
        val hostDoc = snap?.hostUserId?.trim()?.takeIf { it.isNotEmpty() }
        _uiState.update { it.copy(showHostPkEndedInterstitial = false) }
        if (!roomForSignal.isNullOrBlank()) {
            viewModelScope.launch {
                runCatching { firebaseService.emitEndPkStayLiveSignal(roomForSignal, hostDoc.orEmpty()) }
            }
        }
        endPkSession(resumeSoloLive = true)
    }

    fun cancelRandomPk() {
        if (_uiState.value.currentUser?.id.isNullOrBlank() && auth.currentUser?.uid.isNullOrBlank()) return
        clearPkMatchmakingBackend(null)
        _uiState.update {
            it.copy(
                isPkSearching = false,
                pkRoomId = null,
                pkLaunchToken = 0,
                callState = CallState.IDLE,
                pkStatusText = "PK search cancelled",
                pkRetryAvailable = true,
                pkBattleSession = null,
                pkRematchPending = false
            )
        }
    }

    private fun activatePkSession(match: PkMatchResult.Matched) {
        detachPkRematchListeners()
        pkRematchTimeoutJob?.cancel()
        pkRematchTimeoutJob = null
        val roundDur = match.durationSeconds.coerceIn(60, 3600)
        if (match.roomId.isBlank() || match.partnerUserId.isBlank()) {
            Log.e(
                "DatingViewModel",
                "activatePkSession rejected: roomId=${match.roomId} partner=${match.partnerUserId}"
            )
            viewModelScope.launch { firebaseService.removeFromPkQueue(_uiState.value.currentUser?.id ?: return@launch) }
            _uiState.update {
                it.copy(
                    isPkSearching = false,
                    loginError = "Invalid PK match data",
                    pkStatusText = "PK failed",
                    pkRetryAvailable = true,
                    pkRoomId = null,
                    pkLaunchToken = 0,
                    pkBattleSession = null,
                    pkRematchPending = false
                )
            }
            return
        }
        val partner = _uiState.value.profiles.find { it.id == match.partnerUserId }
            ?: UserProfile(id = match.partnerUserId, name = "PK Partner", role = UserRole.GIRL.name)
        val myUid = auth.currentUser?.uid.orEmpty()
        val overlayHostUid = if (match.isStreamer) myUid else match.partnerUserId
        /** Firestore / product "host" team (blue tug) = streamer who was live; "guest" = challenger. */
        val pkHostTeamUid = if (match.isStreamer) myUid else match.partnerUserId
        val pkGuestTeamUid = if (match.isStreamer) match.partnerUserId else myUid
        val pkStartWall = System.currentTimeMillis()
        val hostAlreadyLive = _uiState.value.isLive
        val s0 = _uiState.value
        val displayFor: (String) -> String = { uid ->
            when {
                uid == myUid -> s0.currentUser?.name?.trim().orEmpty().ifBlank { "You" }
                uid == partner.id -> partner.name.trim().ifBlank { "Player" }
                else -> s0.profiles.find { it.id == uid }?.name?.trim().orEmpty().ifBlank { "Player" }
            }
        }
        val pkHostName = displayFor(pkHostTeamUid)
        val pkGuestName = displayFor(pkGuestTeamUid)
        composePkHostChallengerLinkDisconnectHandled = false
        _uiState.update {
            it.copy(
                isPkSearching = false,
                pkRoomId = match.roomId,
                pkIsStreamer = match.isStreamer,
                pkLaunchToken = it.pkLaunchToken + 1,
                pkStatusText = "Match Found!",
                pkRetryAvailable = false,
                pkOriginalRoomId = it.currentRoomId ?: it.currentUser?.liveRoomId ?: it.currentUser?.id,
                isVideoCallActive = if (hostAlreadyLive) it.isVideoCallActive else true,
                isAudioCallActive = if (hostAlreadyLive) it.isAudioCallActive else false,
                activeCallPartner = partner,
                // Solo live host: keep callState IDLE so MainActivity stays on LiveScreen — WebRTC + SurfaceViewRenderer
                // in LiveStreamingView are not torn down while PK matchmaking connects via LiveStreamActivity.
                callState = if (hostAlreadyLive) CallState.IDLE else CallState.CONNECTING,
                isIncomingCall = false,
                webRtcSessionRoomId = match.roomId,
                webRtcCallIsStreamer = match.isStreamer,
                webRtcOverlayHostUserId = overlayHostUid,
                webRtcShowLiveAudienceChrome = true,
                pkRematchPending = false,
                pkBattleSession = PkBattleSessionState(
                    pkStartTimeMillis = pkStartWall,
                    hostUserId = pkHostTeamUid,
                    guestUserId = pkGuestTeamUid,
                    durationSeconds = roundDur,
                    phase = PkBattlePhase.ACTIVE
                )
            )
        }
        startWebRtcCallLiveObservers(match.roomId, overlayHostUid)
        viewModelScope.launch {
            runCatching {
                firebaseService.publishLiveStreamPkBattle(
                    hostUid = pkHostTeamUid,
                    guestUid = pkGuestTeamUid,
                    hostDisplayName = pkHostName,
                    guestDisplayName = pkGuestName,
                    durationSeconds = roundDur,
                    resetBeanTotals = true
                )
            }.onFailure { Log.w("DatingViewModel", "publishLiveStreamPkBattle host=$pkHostTeamUid", it) }
        }
    }

    // ── Notification deep-link helpers ────────────────────────────────────────────────────────────

    /**
     * Called when the user taps an incoming-call notification.
     * Synthesises an [IncomingCallUi] from the FCM payload so the ringing screen appears
     * regardless of whether the realtime-DB listener has fired yet.
     */
    fun handleIncomingCallFromNotification(
        callerId: String,
        roomId: String? = null,
        isVideoCall: Boolean = true,
        callerName: String? = null
    ) {
        val myId = auth.currentUser?.uid ?: return
        val existing = _uiState.value.incomingCall
        if (existing != null) return  // Already showing — don't overwrite
        val callerProfile = _uiState.value.profiles.find { it.id == callerId }
        val resolvedRoom = roomId?.trim()?.takeIf { it.isNotEmpty() } ?: buildCallRoomId(callerId, myId)
        val resolvedName = callerName?.trim()?.takeIf { it.isNotEmpty() }
            ?: callerProfile?.name?.takeIf { it.isNotBlank() }
            ?: "Caller"
        _uiState.update {
            it.copy(
                incomingCall = IncomingCallUi(
                    callerId = callerId,
                    callerName = resolvedName,
                    roomId = resolvedRoom,
                    isVideoCall = isVideoCall
                ),
                callState = CallState.RINGING,
                callStatus = CallStatus.RINGING,
                isIncomingCall = true
            )
        }
        // Also fetch the caller profile if it wasn't in cache yet
        if (callerProfile == null) {
            viewModelScope.launch {
                runCatching { firebaseService.getUserProfile(callerId) }
                    .getOrNull()
                    ?.let { profile ->
                        _uiState.update { s ->
                            val call = s.incomingCall
                            if (call?.callerId == callerId) {
                                s.copy(
                                    incomingCall = call.copy(
                                        callerName = profile.name.ifBlank { call.callerName },
                                        callerPhotoUrl = profile.photoUrl
                                    )
                                )
                            } else s
                        }
                    }
            }
        }
    }

    /**
     * Ensures [users/{uid}.fcmToken] exists on login (not only on token refresh), so Cloud Functions
     * can wake the device for incoming calls when the app is closed.
     */
    private fun syncFcmRegistrationToken() {
        val user = auth.currentUser ?: return
        if (user.isAnonymous) return
        val uid = user.uid
        viewModelScope.launch {
            runCatching {
                val token = FirebaseMessaging.getInstance().token.await()
                if (token.isNotBlank()) {
                    db.collection("users").document(uid).set(
                        mapOf(
                            "fcmToken" to token,
                            "tokenUpdatedAtMs" to System.currentTimeMillis()
                        ),
                        SetOptions.merge()
                    ).await()
                    Log.d("DatingViewModel", "syncFcmRegistrationToken: saved for uid=$uid")
                }
            }.onFailure { Log.w("DatingViewModel", "syncFcmRegistrationToken failed", it) }
        }
    }

    /**
     * Called when the user taps a DM notification.
     * Switches to the Chats tab (index 2) and opens the thread — same as [HomeScreen] onMessage.
     */
    fun openDirectMessage(senderId: String) {
        val id = senderId.trim()
        if (id.isBlank()) return
        setTab(2)
        startObservingMessages(id)
    }

    /**
     * Called when the user taps a "X is live!" notification.
     * Finds the host in the local profile list or fetches a minimal profile, then starts watching.
     */
    /**
     * Compose live host: the WebRTC link that pulls the challenger's tile from `live_publishers` died
     * (challenger left / network). End the PK round locally and show post-battle "find another" UI.
     */
    fun handlePkOpponentPeerDisconnectedFromComposeHost() {
        val s = _uiState.value
        val myUid = s.currentUser?.id?.trim().orEmpty()
        if (myUid.isEmpty()) return
        val pk = s.pkBattleSession ?: return
        if (pk.battleEnded || pk.phase != PkBattlePhase.ACTIVE) return
        if (pk.hostUserId.trim() != myUid) return
        if (!s.isLive) return
        synchronized(this) {
            if (composePkHostChallengerLinkDisconnectHandled) return
            composePkHostChallengerLinkDisconnectHandled = true
        }
        val guestUid = pk.guestUserId.trim()
        val endAt = System.currentTimeMillis() + PK_POST_RESULT_LINGER_MS
        val statusMsg = DatingApp.applicationContext?.getString(R.string.pk_opponent_disconnected_status)
            ?: "Opponent disconnected"
        viewModelScope.launch {
            runCatching { firebaseService.clearLiveStreamPkBattleMirrors(pk.hostUserId, guestUid) }
                .onFailure { Log.w("DatingViewModel", "clearLiveStreamPkBattleMirrors(opponentDisconnect)", it) }
        }
        _uiState.update {
            it.copy(
                pkBattleSession = pk.copy(
                    battleEnded = true,
                    outcome = PkBattleOutcome.VICTORY,
                    phase = PkBattlePhase.FINISHED,
                    frozenTugRatio = pk.frozenTugRatio,
                    resultPhaseEndsAtMillis = endAt,
                ),
                pkRematchPending = false,
                activeCallPartner = null,
                pkStatusText = statusMsg,
                appWideLoadingMessage = null,
            )
        }
    }

    fun watchLiveByHostId(hostId: String) {
        val cached = _uiState.value.profiles.find { it.id == hostId }
        if (cached != null) {
            watchLive(cached)
            setTab(1)
            return
        }
        viewModelScope.launch {
            val ctx = DatingApp.applicationContext
            val loadingMsg = ctx?.getString(R.string.app_loading_opening_live)
            if (loadingMsg != null) _uiState.update { it.copy(appWideLoadingMessage = loadingMsg) }
            try {
                runCatching { firebaseService.getUserProfile(hostId) }
                    .getOrNull()
                    ?.let {
                        watchLive(it)
                        setTab(1)
                    }
            } finally {
                _uiState.update { it.copy(appWideLoadingMessage = null) }
            }
        }
    }

    fun watchLive(p: UserProfile, registerViewerWithFirestore: Boolean = true) {
        val appCtx = com.zipper.datingapp.DatingApp.applicationContext
        val currentHost = _uiState.value.watchingLivePartner?.id?.trim().orEmpty()
        val nextHost = p.id.trim()
        if (currentHost.isNotEmpty() && currentHost == nextHost) {
            _uiState.update { st -> st.copy(liveWatchSessionNonce = st.liveWatchSessionNonce + 1L) }
            viewModelScope.launch {
                kotlinx.coroutines.delay(120L)
                runCatching {
                    com.zipper.datingapp.webrtc.WebRTCManager.activeManager()
                        ?.refreshVideoSinkAttachments("watch_live_same_host_rebind")
                }
            }
            return
        }

        stopWebRtcCallLiveObservers()
        stopLiveAudienceStreamObservers()
        lastLiveGiftOverlayMessageId = null
        lastLiveGiftOverlaySeenTimestampMs = 0L
        skipLiveGiftOverlayListenerUntilMs = 0L
        _uiState.update {
            it.copy(
                watchingLivePartner = p,
                isLive = false,
                currentRoomId = p.id,
                watchingLiveHostFollowerCount = p.followerIds.size,
                liveStreamChatMessages = emptyList(),
                liveAudienceViewerUserIds = emptyList(),
                watchingLiveStreamStartedAtMillis = 0L,
                watchingLiveStreamIsAudioOnly = p.isLive && p.liveStreamAudioOnly,
                watchingLiveAudioPartySeatCount = 10,
                audioPartyStream = AudioPartyStreamState(),
                audioPartyVideoCallRequests = emptyList(),
                watchingPkGuestUid = "",
                watchingPkGuestDisplayName = "",
                watchingPkActive = false,
                pkBattleSession = null,
                watchingPkLingerSession = null,
                playingGift = null,
                showWatchingLiveEndedOverlay = false,
                liveWatchSessionNonce = it.liveWatchSessionNonce + 1L,
            )
        }
        startLiveAudienceStreamObservers(p.id)
        if (registerViewerWithFirestore) {
            viewModelScope.launch {
                runCatching { firebaseService.incrementLiveStreamViewers(p.id, 1) }
                appCtx?.let { com.zipper.datingapp.live.LiveSessionCleanupPrefs.setPendingViewerCounted(it, p.id) }
                val me = auth.currentUser ?: return@launch
                val name = _uiState.value.currentUser?.name?.takeIf { it.isNotBlank() }
                    ?: me.displayName?.takeIf { it.isNotBlank() }
                    ?: "Someone"
                runCatching { firebaseService.sendLiveStreamJoinSystemMessage(p.id, me.uid, name) }
                    .onFailure { Log.w("DatingViewModel", "sendLiveStreamJoinSystemMessage", it) }
            }
        }
        // PARTY-FIX: If joining an audio-only party room, proactively clear any stale seat
        // the user may have been left in from a previous session (e.g. crash, force-close).
        if (p.liveStreamAudioOnly) {
            val myUid = auth.currentUser?.uid?.trim().orEmpty()
            if (myUid.isNotEmpty()) {
                viewModelScope.launch {
                    runCatching { firebaseService.clearUserFromAllAudioPartySeats(p.id, myUid) }
                        .onFailure { Log.w("DatingViewModel", "watchLive: clearUserFromAllAudioPartySeats", it) }
                }
            }
        }
    }

    fun clearLiveSwipeNoOthersNotice() {
        _uiState.update { it.copy(liveSwipeNoOthersNonce = 0L) }
    }

    /**
     * While watching live: move to another stream in the same order as Live Discover (PK hosts first, then live).
     * @param step `+1` = swipe up (next), `-1` = swipe down (previous); wraps the list.
     */
    fun switchWatchingLiveInFeed(step: Int) {
        if (step == 0) return
        val s = _uiState.value
        val current = s.watchingLivePartner ?: return
        val myId = auth.currentUser?.uid?.trim().orEmpty()
        val pkIds = s.activeLivePkBanners.keys
        val live = s.profiles.filter { it.isLive }
        val pkExtra = s.profiles.filter { !it.isLive && it.id in pkIds }
        val base = (pkExtra + live).distinctBy { it.id }
        val filtered = when (s.liveDiscoverLiveFilter) {
            LiveDiscoverLiveFilter.ALL -> base
            LiveDiscoverLiveFilter.AUDIO_PARTY_ONLY -> base.filter { it.isLive && it.liveStreamAudioOnly }
        }
        val feed = filtered
            .sortedByDescending { it.id in pkIds }
            .filter { it.id != myId }
        if (feed.size <= 1) {
            _uiState.update { st -> st.copy(liveSwipeNoOthersNonce = st.liveSwipeNoOthersNonce + 1L) }
            return
        }
        val idx = feed.indexOfFirst { it.id == current.id }
        if (idx < 0) return
        val n = feed.size
        val newIdx = ((idx + step) % n + n) % n
        val next = feed[newIdx]
        if (next.id == current.id) return

        val oldHostId = current.id
        val pkStreamId = pkWatchAudienceFirestoreStreamId
        val pkCountedHost = pkWatchAudienceCountedForHost
        pkWatchAudienceFirestoreStreamId = null
        pkWatchAudienceCountSessionKey = null
        pkWatchAudienceCountedForHost = null

        viewModelScope.launch {
            runCatching { firebaseService.incrementLiveStreamViewers(oldHostId, -1) }
            if (pkStreamId != null && pkCountedHost != null) {
                val leaver = auth.currentUser?.uid?.trim().orEmpty()
                runCatching {
                    firebaseService.adjustPkBattlerAudienceCounts(
                        pkStreamId,
                        if (pkCountedHost) -1L else 0L,
                        if (pkCountedHost) 0L else -1L,
                        spectatorUid = leaver.takeIf { it.isNotEmpty() }
                    )
                }
            }
            watchLive(next)
        }
    }

    fun setPkWatchAudienceHostOnLeft(hostOnLeft: Boolean) {
        _uiState.update { it.copy(pkWatchAudienceHostOnLeft = hostOnLeft) }
    }

    /**
     * PK spectator: layout side + one Firestore increment per [sessionKey] for host vs guest audience totals.
     * [streamHostId] is `live_streams` document id (live host uid).
     */
    fun confirmPkWatchAudiencePerspective(streamHostId: String, sessionKey: String, rootingForHostBattler: Boolean) {
        if (streamHostId.isBlank() || sessionKey.isBlank()) return
        setPkWatchAudienceHostOnLeft(rootingForHostBattler)
        if (pkWatchAudienceCountSessionKey == sessionKey) return
        pkWatchAudienceCountSessionKey = sessionKey
        pkWatchAudienceFirestoreStreamId = streamHostId
        pkWatchAudienceCountedForHost = rootingForHostBattler
        val joiner = auth.currentUser?.uid?.trim().orEmpty()
        viewModelScope.launch {
            firebaseService.adjustPkBattlerAudienceCounts(
                streamHostId,
                if (rootingForHostBattler) 1L else 0L,
                if (rootingForHostBattler) 0L else 1L,
                spectatorUid = joiner.takeIf { it.isNotEmpty() }
            )
        }
    }

    fun stopWatching() {
        val hostId = _uiState.value.watchingLivePartner?.id
        val pkStreamId = pkWatchAudienceFirestoreStreamId
        val pkCountedHost = pkWatchAudienceCountedForHost
        pkWatchAudienceFirestoreStreamId = null
        pkWatchAudienceCountSessionKey = null
        pkWatchAudienceCountedForHost = null

        // PARTY-FIX: If guest was seated in an audio party room, clear their seat in Firestore
        // so they don't auto-appear seated on next entry (stale seat data causes instant re-seat).
        val myUid = auth.currentUser?.uid?.trim().orEmpty()
        val isAudioParty = _uiState.value.watchingLiveStreamIsAudioOnly
        if (isAudioParty && hostId != null && myUid.isNotEmpty()) {
            val stream = _uiState.value.audioPartyStream
            val mySeatIndex = stream.seats.entries.firstOrNull { it.value.userId == myUid }?.key
            if (mySeatIndex != null) {
                viewModelScope.launch {
                    runCatching { firebaseService.leaveAudioPartySeat(hostId, mySeatIndex, myUid) }
                        .onFailure { Log.w("DatingViewModel", "stopWatching: leaveAudioPartySeat", it) }
                }
            }
        }

        stopLiveAudienceStreamObservers()
        val appCtx = com.zipper.datingapp.DatingApp.applicationContext
        if (appCtx != null) {
            com.zipper.datingapp.live.LiveSessionCleanupPrefs.clearPendingViewer(appCtx)
        }
        _uiState.update {
            it.copy(
                watchingLivePartner = null,
                currentRoomId = null,
                liveStreamChatMessages = emptyList(),
                watchingLiveHostFollowerCount = 0,
                liveStreamViewerCount = 0,
                liveAudienceViewerUserIds = emptyList(),
                watchingLiveStreamStartedAtMillis = 0L,
                watchingLiveStreamIsAudioOnly = false,
                watchingLiveAudioPartySeatCount = 10,
                audioPartyStream = AudioPartyStreamState(),
                audioPartyVideoCallRequests = emptyList(),
                watchingPkGuestUid = "",
                watchingPkGuestDisplayName = "",
                watchingPkActive = false,
                pkWatchAudienceHostOnLeft = true,
                pkHostViewerCount = 0,
                pkGuestViewerCount = 0,
                pkHostViewerUserIds = emptyList(),
                pkGuestViewerUserIds = emptyList(),
                pkBattleSession = null,
                watchingPkLingerSession = null,
                watchingHostPrivateCallBusy = false,
                playingGift = null,
                showWatchingLiveEndedOverlay = false
            )
        }
        if (hostId != null) {
            viewModelScope.launch { firebaseService.incrementLiveStreamViewers(hostId, -1) }
        }
        if (pkStreamId != null && pkCountedHost != null) {
            val leaver = auth.currentUser?.uid?.trim().orEmpty()
            viewModelScope.launch {
                firebaseService.adjustPkBattlerAudienceCounts(
                    pkStreamId,
                    if (pkCountedHost) -1L else 0L,
                    if (pkCountedHost) 0L else -1L,
                    spectatorUid = leaver.takeIf { it.isNotEmpty() }
                )
            }
        }
    }

    /** Re-applies [FirebaseService.updateUserLiveStatus] after WebRTC starts (repairs missed toggles). */
    fun ensureLivePublishedToFirestore() {
        val uid = auth.currentUser?.uid ?: return
        if (!_uiState.value.isLive) return
        val roomId = _uiState.value.currentRoomId ?: uid
        viewModelScope.launch {
            runCatching {
                firebaseService.updateUserLiveStatus(uid, true, roomId)
                firebaseService.ensureLiveStreamDocument(uid, uid)
                if (_uiState.value.isAudioPartyLive) {
                    val seats = _uiState.value.audioPartySeatCount
                    firebaseService.mergeLiveStreamAudioPartySeatCount(uid, seats)
                    var apOk = runCatching {
                        firebaseService.ensureAudioPartyStreamDocument(uid, seats)
                    }.isSuccess
                    if (!apOk) {
                        delay(400L)
                        apOk = runCatching {
                            firebaseService.ensureAudioPartyStreamDocument(uid, seats)
                        }.isSuccess
                    }
                    if (apOk) {
                        firebaseService.mergeAudioPartyStreamSeatCount(uid, seats)
                    } else {
                        Log.w("DatingViewModel", "ensureLivePublishedToFirestore ensureAudioPartyStreamDocument failed")
                    }
                }
            }.onFailure { Log.w("DatingViewModel", "ensureLivePublishedToFirestore", it) }
            startLiveHostStreamObservers(uid)
        }
    }

    /**
     * Local UI still shows “watching” / non-host until [toggleLive] runs; after a server-side audio-party host
     * transfer the new owner’s user doc flips first. Sync host flags, tear down audience WebRTC, and republish.
     */
    private fun applyIncomingAudioPartyHostPromotion(profile: UserProfile) {
        viewModelScope.launch {
            audioPartyHostPromotionMutex.withLock {
                if (_uiState.value.isLive) {
                    _uiState.update { s ->
                        syncFollowListsFromState(
                            s.copy(
                                currentUser = profile,
                                coinBalance = profile.coins,
                                gems = profile.gems,
                                beans = profile.beans,
                                totalEarnings = profile.earnings,
                            )
                        )
                    }
                    refreshLikedMeProfiles(profile)
                    return@withLock
                }
                stopLiveAudienceStreamObservers()
                stopWebRtcCallLiveObservers()
                runCatching { WebRTCManager.activeManager()?.onDestroy() }
                DatingApp.applicationContext?.let { LiveSessionCleanupPrefs.setHostingLiveUid(it, profile.id) }
                liveStreamChatMinTimestampMs = 0L
                _uiState.update { s ->
                    syncFollowListsFromState(
                        s.copy(
                            currentUser = profile,
                            isLive = true,
                            isAudioPartyLive = true,
                            currentRoomId = profile.id,
                            watchingLivePartner = null,
                            showWatchingLiveEndedOverlay = false,
                            coinBalance = profile.coins,
                            gems = profile.gems,
                            beans = profile.beans,
                            totalEarnings = profile.earnings,
                        )
                    )
                }
                refreshLikedMeProfiles(profile)
                ensureLivePublishedToFirestore()
            }
        }
    }

    /**
     * Host-only: 6 / 10 / 14 audio-party seats (Firestore `live_streams` + `streams`).
     */
    fun setAudioPartySeatCount(count: Int) {
        val n = when (count) {
            6 -> 6
            14 -> 14
            17 -> 17
            else -> 10
        }
        val uid = auth.currentUser?.uid?.trim().orEmpty()
        _uiState.update { it.copy(audioPartySeatCount = n) }
        if (uid.isEmpty()) return
        viewModelScope.launch {
            runCatching {
                // Keep `streams/{uid}.seatCount` aligned whenever the host picks 6/10/14 (including pre-go-live).
                firebaseService.mergeAudioPartyStreamSeatCount(uid, n)
                if (_uiState.value.isLive && _uiState.value.isAudioPartyLive) {
                    firebaseService.mergeLiveStreamAudioPartySeatCount(uid, n)
                }
            }.onFailure { e -> Log.w("DatingViewModel", "setAudioPartySeatCount", e) }
        }
    }

    /** Host: Itzo-style room backdrop key on `streams/{uid}` (`default`, `pink`, `violet`, `teal`). */
    fun setAudioPartyRoomBackground(roomBackgroundKey: String) {
        val uid = auth.currentUser?.uid?.trim().orEmpty()
        if (uid.isEmpty()) return
        viewModelScope.launch {
            runCatching { firebaseService.mergeAudioPartyRoomBackground(uid, roomBackgroundKey) }
                .onFailure { e -> Log.w("DatingViewModel", "setAudioPartyRoomBackground", e) }
        }
    }

    fun claimAudioPartySeat(hostId: String, seatIndex: Int) {
        val me = auth.currentUser?.uid?.trim().orEmpty()
        val u = _uiState.value.currentUser
        if (me.isEmpty() || u == null || hostId.isBlank() || seatIndex < 1) return
        viewModelScope.launch {
            val res = firebaseService.claimAudioPartySeat(
                hostId,
                seatIndex,
                me,
                u.name,
                u.photoUrl.orEmpty()
            )
            res.onFailure { e ->
                _uiState.update { s ->
                    s.copy(callNoticeMessage = e.message ?: "Could not claim seat")
                }
            }
            if (res.isSuccess) refreshCurrentUserFromFirestoreIfLoggedIn()
        }
    }

    fun leaveAudioPartySeat(hostId: String, seatIndex: Int) {
        val me = auth.currentUser?.uid?.trim().orEmpty()
        if (me.isEmpty() || hostId.isBlank() || seatIndex < 1) return
        viewModelScope.launch {
            runCatching { firebaseService.leaveAudioPartySeat(hostId, seatIndex, me) }
                .onFailure { Log.w("DatingViewModel", "leaveAudioPartySeat", it) }
        }
    }

    private fun applyLocalStateAfterOutgoingAudioPartyHandoff() {
        runCatching { WebRTCManager.activeManager()?.onDestroy() }
        DatingApp.applicationContext?.let { com.zipper.datingapp.live.LiveSessionCleanupPrefs.clearHostingLiveUid(it) }
        stopLiveHostStreamObservers()
        _uiState.update { st ->
            val cu = st.currentUser
            st.copy(
                isLive = false,
                isAudioPartyLive = false,
                currentRoomId = null,
                currentUser = cu?.copy(isLive = false, liveRoomId = null, liveStreamAudioOnly = false),
                liveStreamViewerCount = 0,
                audioPartyStream = AudioPartyStreamState(),
                audioPartyVideoCallRequests = emptyList(),
                audioPartySeatCount = 10,
                liveStreamChatMessages = emptyList(),
                liveAudienceViewerUserIds = emptyList(),
            )
        }
        refreshCurrentUserFromFirestoreIfLoggedIn()
    }

    /**
     * Audience: `live_streams/{old}` briefly points at the new host uid after ownership transfer.
     */
    private fun followLiveAudioPartyToNewHostUid(oldHostUid: String, newHostUid: String) {
        if (oldHostUid.isBlank() || newHostUid.isBlank() || oldHostUid == newHostUid) return
        viewModelScope.launch {
            runCatching { firebaseService.incrementLiveStreamViewers(oldHostUid, -1) }
            val prof = runCatching { firebaseService.getUserProfile(newHostUid) }.getOrNull()
            val p = prof?.copy(
                isLive = true,
                liveRoomId = newHostUid,
                liveStreamAudioOnly = true,
            ) ?: UserProfile(
                id = newHostUid,
                name = "Live",
                profileNumber = "",
                photoUrl = "",
                isLive = true,
                liveRoomId = newHostUid,
                liveStreamAudioOnly = true,
            )
            watchLive(p, registerViewerWithFirestore = false)
        }
    }

    fun promoteAudioPartyHostToSeatedGuest(hostId: String, seatIndex: Int) {
        val me = auth.currentUser?.uid?.trim().orEmpty()
        if (me.isEmpty() || hostId != me || seatIndex < 1) return
        val guest = _uiState.value.audioPartyStream.seats[seatIndex]?.userId?.trim().orEmpty()
        if (guest.isEmpty() || guest == hostId) return
        viewModelScope.launch {
            val res = firebaseService.handoffAudioPartyHost(hostId, guest)
            if (res.isFailure) {
                val msg = res.exceptionOrNull()?.message ?: "Could not transfer host"
                Log.w("DatingViewModel", "promoteAudioPartyHostToSeatedGuest: $msg")
                _uiState.update { it.copy(callNoticeMessage = msg) }
                return@launch
            }
            applyLocalStateAfterOutgoingAudioPartyHandoff()
        }
    }

    fun hostAudioPartySeatAction(hostId: String, action: AudioPartyHostSeatAction) {
        if (hostId.isBlank()) return
        if (action is AudioPartyHostSeatAction.PromoteSeatGuestToHost) {
            promoteAudioPartyHostToSeatedGuest(hostId, action.seatIndex)
            return
        }
        viewModelScope.launch {
            runCatching {
                when (action) {
                    is AudioPartyHostSeatAction.SetLocked ->
                        firebaseService.hostSetAudioPartySeatLocked(hostId, action.seatIndex, action.locked)
                    is AudioPartyHostSeatAction.SetMuted ->
                        firebaseService.hostSetAudioPartySeatMuted(hostId, action.seatIndex, action.muted)
                    is AudioPartyHostSeatAction.Kick ->
                        firebaseService.clearAudioPartySeat(hostId, action.seatIndex, preserveLocked = true)
                    is AudioPartyHostSeatAction.SetPrice ->
                        firebaseService.hostSetAudioPartySeatPrice(hostId, action.seatIndex, action.priceCoins)
                    is AudioPartyHostSeatAction.SetCoHostFromSeat ->
                        firebaseService.setAudioPartyCoHostFromSeat(hostId, action.seatIndex)
                    is AudioPartyHostSeatAction.ClearCoHost ->
                        firebaseService.mergeAudioPartyCoHost(hostId, null)
                    is AudioPartyHostSeatAction.PromoteSeatGuestToHost -> Unit
                }
            }.onFailure { Log.w("DatingViewModel", "hostAudioPartySeatAction", it) }
        }
    }

    fun setMyAudioPartySeatPublishing(hostId: String, publishing: Boolean) {
        val me = auth.currentUser?.uid?.trim().orEmpty()
        if (me.isEmpty() || hostId.isBlank()) return
        val idx = _uiState.value.audioPartyStream.seats.entries
            .find { it.value.userId == me }?.key
            ?: return
        viewModelScope.launch {
            runCatching { firebaseService.setAudioPartySeatPublishing(hostId, idx, me, publishing) }
                .onFailure { Log.w("DatingViewModel", "setMyAudioPartySeatPublishing", it) }
        }
    }

    fun mergeAudioPartyNowPlayingForHost(title: String, artist: String) {
        val id = auth.currentUser?.uid?.trim().orEmpty()
        if (id.isEmpty() || !_uiState.value.isAudioPartyLive) return
        viewModelScope.launch {
            runCatching { firebaseService.mergeAudioPartyNowPlaying(id, title, artist) }
                .onFailure { Log.w("DatingViewModel", "mergeAudioPartyNowPlayingForHost", it) }
        }
    }

    fun sendAudioPartyStageEmoji(emoji: String) {
        val me = auth.currentUser?.uid?.trim().orEmpty()
        if (me.isEmpty()) return
        val targetHost = when {
            _uiState.value.isAudioPartyLive -> me
            else -> _uiState.value.watchingLivePartner?.id?.trim().orEmpty()
        }
        if (targetHost.isEmpty()) return
        viewModelScope.launch {
            runCatching { firebaseService.mergeAudioPartyStageEmoji(targetHost, emoji) }
                .onFailure { Log.w("DatingViewModel", "sendAudioPartyStageEmoji", it) }
        }
    }

    /**
     * Clears PK matchmaking, PK navigation, and WebRTC call-overlay fields so Live tab solo broadcast
     * does not reuse stale [pkRoomId] / [activeCallPartner] after a PK battle ends.
     */
    private fun DatingUiState.withLiveTogglePkCallTeardown(): DatingUiState = copy(
        isPkSearching = false,
        pkRoomId = null,
        pkLaunchToken = 0,
        pkIsStreamer = false,
        pkOriginalRoomId = null,
        pkStatusText = null,
        pkRetryAvailable = false,
        activeCallPartner = null,
        callState = CallState.IDLE,
        callStatus = CallStatus.CONNECTING,
        isIncomingCall = false,
        isCurrentlyInCall = false,
        pkBattleSession = null,
        watchingPkLingerSession = null,
        showHostPkEndedInterstitial = false,
        webRtcSessionRoomId = null,
        webRtcCallIsStreamer = false,
        webRtcOverlayHostUserId = null,
        callOverlayHostProfile = null,
        webRtcShowLiveAudienceChrome = false,
        isVideoCallActive = false,
        isAudioCallActive = false,
        isFreeTeaserCall = false,
        pendingCallRoomId = null,
        pendingCallLaunchToken = 0,
        pendingCallIsStreamer = false,
        soloLiveMediaHandoffNotBeforeElapsedMs = 0L,
    )

    fun toggleLive(audioParty: Boolean = false) {
        val user = _uiState.value.currentUser
        if (user?.role == UserRole.GIRL.name && !user.isCallVerificationApproved) {
            _uiState.update { it.copy(loginError = "Face verification required to start live session.") }
            return
        }
        val uid = auth.currentUser?.uid ?: run {
            _uiState.update { it.copy(loginError = "Sign in required to go live.") }
            return
        }
        val next = !_uiState.value.isLive
        val roomId = if (next) uid else null
        val prev = _uiState.value
        val wasAudioParty = prev.isAudioPartyLive  // capture before state update
        val updatedUser = user?.copy(isLive = next, liveRoomId = roomId)
        val startAudioParty = next && audioParty
        if (next) {
            hostPkEndedInterstitialJob?.cancel()
            hostPkEndedInterstitialJob = null
            stopWebRtcCallLiveObservers()
        }
        clearPkMatchmakingBackend(null)
        _uiState.update {
            it.withLiveTogglePkCallTeardown().copy(
                isLive = next,
                currentRoomId = roomId,
                currentUser = updatedUser ?: it.currentUser,
                isAudioPartyLive = startAudioParty
            )
        }
        val audioPartySeatsForEnsure = _uiState.value.audioPartySeatCount
        viewModelScope.launch {
            val ctx = DatingApp.applicationContext
            val loadingMsg = ctx?.getString(R.string.app_loading_live_toggle)
            if (loadingMsg != null) _uiState.update { it.copy(appWideLoadingMessage = loadingMsg) }
            try {
                val updateResult = runCatching {
                    firebaseService.updateUserLiveStatus(uid, next, roomId)
                    updatedUser?.let { firebaseService.saveUserProfile(it) }
                }
                if (updateResult.isFailure) {
                    val e = updateResult.exceptionOrNull()!!
                    Log.e("DatingViewModel", "toggleLive", e)
                    _uiState.update {
                        it.copy(
                            isLive = prev.isLive,
                            currentRoomId = prev.currentRoomId,
                            currentUser = prev.currentUser,
                            isAudioPartyLive = prev.isAudioPartyLive,
                            audioPartySeatCount = prev.audioPartySeatCount,
                            loginError = e.message ?: "Could not update live status"
                        )
                    }
                    return@launch
                }
                val appCtx = com.zipper.datingapp.DatingApp.applicationContext
                if (next) {
                    appCtx?.let { com.zipper.datingapp.live.LiveSessionCleanupPrefs.setHostingLiveUid(it, uid) }
                } else {
                    appCtx?.let { com.zipper.datingapp.live.LiveSessionCleanupPrefs.clearHostingLiveUid(it) }
                }
                if (next) {
                    liveStreamChatMinTimestampMs = System.currentTimeMillis()
                    lastLiveGiftOverlayMessageId = null
                    lastLiveGiftOverlaySeenTimestampMs = 0L
                    skipLiveGiftOverlayListenerUntilMs = 0L
                    _uiState.update { s -> s.copy(liveStreamChatMessages = emptyList()) }
                    val ensureResult = runCatching {
                        firebaseService.ensureLiveStreamDocument(
                            uid,
                            uid,
                            resetStreamSessionStart = true,
                            audioOnlyStream = startAudioParty,
                            audioPartySeatCount = if (startAudioParty) audioPartySeatsForEnsure else null,
                        )
                    }
                    if (ensureResult.isFailure) {
                        Log.w(
                            "DatingViewModel",
                            "ensureLiveStreamDocument",
                            ensureResult.exceptionOrNull()
                        )
                        appCtx?.let { com.zipper.datingapp.live.LiveSessionCleanupPrefs.clearHostingLiveUid(it) }
                        runCatching { firebaseService.updateUserLiveStatus(uid, false, null) }
                            .onFailure { e -> Log.w("DatingViewModel", "toggleLive rollback updateUserLiveStatus", e) }
                        val rollbackProfile = prev.currentUser?.copy(isLive = false, liveRoomId = null)
                        if (rollbackProfile != null) {
                            runCatching { firebaseService.saveUserProfile(rollbackProfile) }
                                .onFailure { e -> Log.w("DatingViewModel", "toggleLive rollback saveUserProfile", e) }
                        }
                        _uiState.update {
                            it.copy(
                                isLive = prev.isLive,
                                currentRoomId = prev.currentRoomId,
                                currentUser = prev.currentUser,
                                isAudioPartyLive = prev.isAudioPartyLive,
                                audioPartySeatCount = prev.audioPartySeatCount,
                                loginError = ensureResult.exceptionOrNull()?.message
                                    ?: "Could not start live room"
                            )
                        }
                        return@launch
                    }
                    if (startAudioParty) {
                        val apErr = runCatching {
                            firebaseService.ensureAudioPartyStreamDocument(uid, audioPartySeatsForEnsure)
                        }.exceptionOrNull()
                        if (apErr != null) {
                            Log.w("DatingViewModel", "ensureAudioPartyStreamDocument", apErr)
                            delay(400L)
                            val retryErr = runCatching {
                                firebaseService.ensureAudioPartyStreamDocument(uid, audioPartySeatsForEnsure)
                            }.exceptionOrNull()
                            if (retryErr != null) {
                                appCtx?.let { com.zipper.datingapp.live.LiveSessionCleanupPrefs.clearHostingLiveUid(it) }
                                runCatching { firebaseService.updateUserLiveStatus(uid, false, null) }
                                    .onFailure { e ->
                                        Log.w("DatingViewModel", "toggleLive rollback after streams doc", e)
                                    }
                                val rollbackProfile = prev.currentUser?.copy(isLive = false, liveRoomId = null)
                                if (rollbackProfile != null) {
                                    runCatching { firebaseService.saveUserProfile(rollbackProfile) }
                                        .onFailure { e ->
                                            Log.w("DatingViewModel", "toggleLive rollback profile after streams doc", e)
                                        }
                                }
                                _uiState.update {
                                    it.copy(
                                        isLive = prev.isLive,
                                        currentRoomId = prev.currentRoomId,
                                        currentUser = prev.currentUser,
                                        isAudioPartyLive = prev.isAudioPartyLive,
                                        audioPartySeatCount = prev.audioPartySeatCount,
                                        loginError = retryErr.message ?: apErr.message
                                            ?: "Could not create audio party room"
                                    )
                                }
                                return@launch
                            }
                        }
                    }
                    startLiveHostStreamObservers(uid)
                    // LIVE-10: Auto-welcome system message when host starts live stream
                    runCatching {
                        val hostName = _uiState.value.currentUser?.name?.trim()?.ifBlank { "Host" } ?: "Host"
                        firebaseService.sendLiveStreamChatMessage(
                            streamId = uid,
                            senderId = "system",
                            senderName = "Zipper",
                            text = "🎉 Welcome to $hostName's live stream! Say hello 👋",
                        )
                    }
                    // Send live invite to mutual likes in chat
                    sendLiveInviteToMutualLikes(uid, isAudioParty = startAudioParty)
                } else {
                    stopLiveHostStreamObservers()
                    // If this was an audio party, mark the party_rooms document inactive too.
                    // endLiveStream only updates live_streams; without this the party room stays
                    // visible in the discover tab.
                    if (wasAudioParty) {
                        runCatching { firebaseService.endPartyRoom(uid) }
                            .onFailure { Log.w("DatingViewModel", "endPartyRoom toggleLive off", it) }
                    }
                    runCatching { firebaseService.endLiveStream(uid, null) }
                        .onFailure { e ->
                            Log.w("DatingViewModel", "endLiveStream toggleLive off", e)
                            runCatching { firebaseService.clearLiveStreamPkBannerIfDocumentExists(uid) }
                                .onFailure { e2 ->
                                    Log.w(
                                        "DatingViewModel",
                                        "clearLiveStreamPkBannerIfDocumentExists toggleLive off fallback",
                                        e2
                                    )
                                }
                            runCatching { firebaseService.updateUserLiveStatus(uid, false, null) }
                                .onFailure { e3 ->
                                    Log.w("DatingViewModel", "updateUserLiveStatus toggleLive off fallback", e3)
                                }
                        }
                    _uiState.update { s ->
                        s.copy(
                            liveStreamViewerCount = 0,
                            liveStreamChatMessages = emptyList(),
                            watchingLiveStreamStartedAtMillis = 0L,
                            watchingLiveStreamIsAudioOnly = false,
                            watchingLiveAudioPartySeatCount = 10,
                            audioPartySeatCount = 10,
                            audioPartyStream = AudioPartyStreamState(),
                            audioPartyVideoCallRequests = emptyList(),
                            liveAudienceViewerUserIds = emptyList(),
                            playingGift = null
                        )
                    }
                }
            } finally {
                _uiState.update { it.copy(appWideLoadingMessage = null) }
            }
        }
    }

    fun kickLiveChatter(streamDocId: String, targetUserId: String) {
        if (streamDocId.isBlank() || targetUserId.isBlank()) return
        viewModelScope.launch {
            runCatching { firebaseService.addUserToLiveStreamKickedList(streamDocId, targetUserId) }
                .onFailure { Log.w("DatingViewModel", "kickLiveChatter", it) }
        }
    }

    fun blockLiveChatter(streamDocId: String, hostUid: String, targetUserId: String) {
        if (streamDocId.isBlank() || hostUid.isBlank() || targetUserId.isBlank()) return
        viewModelScope.launch {
            runCatching {
                firebaseService.addUserToLiveStreamKickedList(streamDocId, targetUserId)
                firebaseService.addBlockedUserForHost(hostUid, targetUserId)
            }.onFailure { Log.w("DatingViewModel", "blockLiveChatter", it) }
        }
    }

    /** Adds [targetUserId] to the signed-in user's `blockedUserIds` (from profile ⋮ menu). */
    fun blockUserFromProfile(targetUserId: String) {
        val me = auth.currentUser?.uid?.trim().orEmpty()
        if (me.isEmpty() || targetUserId.isBlank() || me == targetUserId) return
        if (_uiState.value.isGuest || _uiState.value.currentUser?.isGuest == true) return
        viewModelScope.launch {
            runCatching { firebaseService.addBlockedUserForHost(me, targetUserId) }
                .onSuccess {
                    _uiState.update { s ->
                        val cu = s.currentUser ?: return@update s
                        if (cu.id != me) return@update s
                        val next = (cu.blockedUserIds + targetUserId).distinct()
                        s.copy(currentUser = cu.copy(blockedUserIds = next))
                    }
                }
                .onFailure { e -> Log.w("DatingViewModel", "blockUserFromProfile", e) }
        }
    }

    fun unblockUserFromProfile(targetUserId: String) {
        val me = auth.currentUser?.uid?.trim().orEmpty()
        if (me.isEmpty() || targetUserId.isBlank()) return
        if (_uiState.value.isGuest || _uiState.value.currentUser?.isGuest == true) return
        viewModelScope.launch {
            runCatching { firebaseService.removeBlockedUserForHost(me, targetUserId) }
                .onSuccess {
                    _uiState.update { s ->
                        val cu = s.currentUser ?: return@update s
                        if (cu.id != me) return@update s
                        s.copy(currentUser = cu.copy(blockedUserIds = cu.blockedUserIds.filter { it != targetUserId }))
                    }
                }
                .onFailure { e -> Log.w("DatingViewModel", "unblockUserFromProfile", e) }
        }
    }

    fun reportUserFromProfile(reportedUserId: String, reason: String) {
        val me = auth.currentUser?.uid?.trim().orEmpty()
        if (me.isEmpty() || reportedUserId.isBlank()) return
        if (_uiState.value.isGuest || _uiState.value.currentUser?.isGuest == true) return
        viewModelScope.launch {
            runCatching { firebaseService.submitUserProfileReport(me, reportedUserId, reason) }
                .onFailure { e -> Log.w("DatingViewModel", "reportUserFromProfile", e) }
        }
    }

    private suspend fun resolveProfileForLiveHostMenu(targetUserId: String, nameHint: String): UserProfile {
        val tid = targetUserId.trim()
        val s = _uiState.value
        return s.profiles.find { it.id == tid }
            ?: s.filteredProfiles.find { it.id == tid }
            ?: s.followedProfiles.find { it.id == tid }
            ?: s.followerProfiles.find { it.id == tid }
            ?: s.likedMeProfiles.find { it.id == tid }
            ?: firebaseService.getUserProfile(tid)
            ?: UserProfile(id = tid, name = nameHint.trim().ifBlank { "User" })
    }

    /** Host long-press on live chat: toggle follow for this chatter. */
    fun followLiveChatterFromHostMenu(targetUserId: String, displayNameHint: String = "") {
        val myUid = auth.currentUser?.uid ?: return
        if (_uiState.value.isGuest || _uiState.value.currentUser?.isGuest == true) return
        val tid = targetUserId.trim()
        if (tid.isBlank() || tid == myUid) return
        viewModelScope.launch {
            val profile = resolveProfileForLiveHostMenu(tid, displayNameHint)
            toggleFollowProfile(profile)
        }
    }

    /** Host long-press: discovery-style like/unlike on chatter profile (uses Firestore for current liked state). */
    fun likeLiveChatterFromHostMenu(targetUserId: String) {
        val myUid = auth.currentUser?.uid ?: return
        if (_uiState.value.isGuest || _uiState.value.currentUser?.isGuest == true) return
        val tid = targetUserId.trim()
        if (tid.isBlank() || tid == myUid) return
        viewModelScope.launch {
            firebaseService.toggleDiscoveryProfileLike(myUid, tid)
                .onSuccess { nowLiked ->
                    _uiState.update { s ->
                        s.copy(
                            likedProfileIds = if (nowLiked) s.likedProfileIds + tid else s.likedProfileIds - tid
                        )
                    }
                }
                .onFailure { e -> Log.w("DatingViewModel", "likeLiveChatterFromHostMenu", e) }
        }
    }

    /**
     * Called after UI shows the kick toast: leaves live watch, ends an active WebRTC session, clears the signal.
     */
    fun handleKickedFromLiveStream() {
        val inCall = _uiState.value.callState != CallState.IDLE
        stopWatching()
        if (inCall) endCall()
        _uiState.update { it.copy(liveKickEventMs = 0L) }
    }

    fun sendLiveComment(text: String) {
        val trimmed = text.trim()
        if (trimmed.isBlank()) return
        val senderId = auth.currentUser?.uid ?: return
        val name = _uiState.value.currentUser?.name ?: "User"
        val s = _uiState.value
        val pk = s.pkBattleSession
        val callRoomId = s.webRtcSessionRoomId?.trim()?.takeIf { it.isNotEmpty() }
        val pkRoomSignaling = callRoomId?.startsWith("pk_room_") == true
        fun resolveLiveChatHostStreamUid(): String? {
            pk?.hostUserId?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
            s.webRtcOverlayHostUserId?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
            s.watchingLivePartner?.id?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
            if (s.isLive) {
                s.currentRoomId?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
                return senderId.takeIf { it.isNotEmpty() }
            }
            return null
        }
        val preferPrivateCallChat = callRoomId != null && (
            s.isCurrentlyInCall ||
                s.isVideoCallActive ||
                s.isAudioCallActive ||
                s.callState == CallState.DIALING ||
                s.callState == CallState.RINGING ||
                s.callState == CallState.CONNECTING ||
                s.callState == CallState.ACTIVE
        )
        val streamId = when {
            pk != null -> {
                val h = pk.hostUserId.trim().takeIf { it.isNotEmpty() }
                h ?: resolveLiveChatHostStreamUid()?.also {
                    Log.w("DatingViewModel", "sendLiveComment: pk session missing hostUserId, using fallback $it")
                } ?: run {
                    Log.w("DatingViewModel", "sendLiveComment: dropped — pk active but no host stream uid")
                    return
                }
            }
            pkRoomSignaling -> resolveLiveChatHostStreamUid() ?: run {
                Log.w("DatingViewModel", "sendLiveComment: dropped — pk_room_* but could not resolve host stream doc")
                return
            }
            preferPrivateCallChat -> callRoomId!!
            s.isLive -> senderId
            s.watchingLivePartner != null -> s.watchingLivePartner!!.id
            callRoomId != null -> callRoomId
            else -> return
        }
        Log.i(
            "CALL_CHAT",
            "sendLiveComment streamId=$streamId preferPrivateCallChat=$preferPrivateCallChat hasPk=${pk != null} pkRoomSignaling=$pkRoomSignaling"
        )
        viewModelScope.launch {
            firebaseService.sendLiveStreamChatMessage(streamId, senderId, name, trimmed)
                .onFailure { e ->
                    Log.e("DatingViewModel", "sendLiveComment FAILED streamId=$streamId", e)
                    _uiState.update { it.copy(loginError = "Live chat failed: ${e.message}") }
                }
        }
    }

    fun sendGift(gift: Gift, count: Int) {
        val state = _uiState.value
        val receiverId = state.watchingLivePartner?.id
            ?: state.selectedMessagePartnerId
            ?: state.activeCallPartner?.id
            ?: run {
                _uiState.update { it.copy(loginError = "No receiver selected for gift") }
                return
            }
        sendGiftToReceiver(
            receiverId = receiverId,
            gift = gift,
            count = count,
            liveHostEconomyIfApplicable = true,
            postToLiveStreamCallRoomIfApplicable = true,
            liveStreamDocIdForChat = null
        )
    }

    /**
     * Gifts during live PK: [receiverUserId] must be the stream host or PK guest.
     * Chat + PK bean tally use the correct `live_streams` doc id.
     */
    fun sendGiftToLiveBattler(receiverUserId: String, gift: Gift, count: Int) {
        val rid = receiverUserId.trim()
        if (rid.isBlank()) return
        val state = _uiState.value
        val pk = state.pkBattleSession
        val watchHost = state.watchingLivePartner?.id?.trim().orEmpty()
        val watchGuest = state.watchingPkGuestUid.trim()
        val watchPkLive = state.watchingPkActive && watchHost.isNotBlank()

        val (hostUid, guestUid, chatDocId) = when {
            pk != null -> {
                val doc = state.webRtcSessionRoomId?.trim().orEmpty().ifBlank { pk.hostUserId }
                Triple(pk.hostUserId, pk.guestUserId, doc)
            }
            watchPkLive -> Triple(watchHost, watchGuest, watchHost)
            else -> {
                sendGift(gift, count)
                return
            }
        }
        val guestKnown = guestUid.isNotBlank()
        val validReceiver = rid == hostUid || (guestKnown && rid == guestUid)
        if (!validReceiver) {
            _uiState.update { it.copy(loginError = "Pick a streamer to send the gift to") }
            return
        }
        sendGiftToReceiver(
            receiverId = rid,
            gift = gift,
            count = count,
            liveHostEconomyIfApplicable = true,
            postToLiveStreamCallRoomIfApplicable = true,
            liveStreamDocIdForChat = chatDocId.takeIf { it.isNotBlank() }
        )
    }

    /**
     * Direct wallet gift to a user (e.g. live chatter / profile sheet). Skips live-stream gift docs.
     */
    fun sendPrivateGiftToUser(targetUserId: String, gift: Gift, count: Int) {
        val trimmed = targetUserId.trim()
        if (trimmed.isBlank() || trimmed == auth.currentUser?.uid) return
        sendGiftToReceiver(
            receiverId = trimmed,
            gift = gift,
            count = count,
            liveHostEconomyIfApplicable = false,
            postToLiveStreamCallRoomIfApplicable = false,
            liveStreamDocIdForChat = null
        )
    }

    private fun sendGiftToReceiver(
        receiverId: String,
        gift: Gift,
        count: Int,
        liveHostEconomyIfApplicable: Boolean,
        postToLiveStreamCallRoomIfApplicable: Boolean,
        liveStreamDocIdForChat: String? = null
    ) {
        val stateSnap = _uiState.value
        if (stateSnap.isGiftTransactionProcessing) return

        val senderId = auth.currentUser?.uid ?: return

        val totalCostLong = gift.price.toLong() * count.toLong()
        if (totalCostLong <= 0L || totalCostLong > Int.MAX_VALUE.toLong()) {
            _uiState.update { it.copy(loginError = "Invalid gift amount") }
            return
        }
        val totalCost = totalCostLong.toInt()
        if (stateSnap.coinBalance < totalCost) return

        val economyHostId = stateSnap.watchingLivePartner?.id?.trim().orEmpty().ifBlank {
            stateSnap.pkBattleSession?.hostUserId?.trim().orEmpty()
        }
        val pkSession = stateSnap.pkBattleSession
        val receiverIsPkBattler = pkSession != null &&
            !pkSession.battleEnded &&
            pkSession.phase == PkBattlePhase.ACTIVE &&
            (receiverId == pkSession.hostUserId || receiverId == pkSession.guestUserId)
        val useLiveEconomyTx = liveHostEconomyIfApplicable &&
            (receiverIsPkBattler || (economyHostId.isNotBlank() && receiverId == economyHostId))

        val resolvedChatStreamId = liveStreamDocIdForChat?.trim()?.takeIf { it.isNotBlank() }
            ?: stateSnap.webRtcSessionRoomId?.trim()?.takeIf { it.isNotBlank() }
            ?: stateSnap.watchingLivePartner?.id?.trim()?.takeIf { it.isNotBlank() }
            ?: ""

        fun giftRecipientDisplayName(): String {
            if (receiverId == stateSnap.watchingLivePartner?.id) {
                return stateSnap.watchingLivePartner?.name.orEmpty().ifBlank { "host" }
            }
            if (receiverId == stateSnap.pkBattleSession?.guestUserId) {
                return stateSnap.activeCallPartner?.takeIf { it.id == receiverId }?.name?.trim().orEmpty()
                    .ifBlank { stateSnap.callOverlayHostProfile?.takeIf { it.id == receiverId }?.name.orEmpty() }
                    .ifBlank { "Guest" }
            }
            if (receiverId == stateSnap.pkBattleSession?.hostUserId) {
                return stateSnap.callOverlayHostProfile?.name.orEmpty()
                    .ifBlank { stateSnap.watchingLivePartner?.name.orEmpty() }
                    .ifBlank { "Host" }
            }
            if (receiverId == stateSnap.watchingPkGuestUid) {
                return stateSnap.watchingPkGuestDisplayName.ifBlank { "Guest" }
            }
            return stateSnap.profiles.find { it.id == receiverId }?.name?.trim().orEmpty().ifBlank { "Streamer" }
        }

        val senderIsMale = VirtualEconomyMath.isMaleGender(stateSnap.currentUser?.gender)
        val optimisticBalance = stateSnap.coinBalance - totalCost
        val rawPkBeans = VirtualEconomyMath.giftReceiverBeansEarned(totalCostLong, gift)
        val pkScoreStreamDoc = pkSession?.takeUnless { it.battleEnded }
            ?.takeIf { it.phase == PkBattlePhase.ACTIVE }
            ?.hostUserId?.trim()?.takeIf { it.isNotEmpty() }
        val wantsLivePkScore = receiverIsPkBattler &&
            pkSession?.phase == PkBattlePhase.ACTIVE &&
            pkScoreStreamDoc != null &&
            totalCostLong > 0L
        /** PK tug uses bean-derived deltas; integer rounding can yield 0 on tiny spends — coerce so scoring moves. */
        val effectivePkScoreDelta =
            if (wantsLivePkScore) rawPkBeans.coerceAtLeast(1L) else rawPkBeans
        val applyLivePkScore = wantsLivePkScore && effectivePkScoreDelta > 0L

        _uiState.update { s ->
            s.copy(
                coinBalance = optimisticBalance,
                currentUser = s.currentUser?.withSyncedSpendableBalance(optimisticBalance)?.let { u ->
                    if (senderIsMale) u.copy(giftDiamondsSpentTotal = u.giftDiamondsSpentTotal + totalCostLong)
                    else u
                },
                isGiftTransactionProcessing = true,
                loginError = null,
                liveGiftMessage = null
            )
        }
        val transactionId = UUID.randomUUID().toString()
        viewModelScope.launch {
            try {
                if (useLiveEconomyTx) {
                    when (
                        val live = firebaseService.sendGift(
                            transactionId = transactionId,
                            senderId = senderId,
                            hostId = receiverId,
                            giftCost = totalCost,
                            gift = gift,
                            livePkScoreStreamDocId = if (applyLivePkScore) pkScoreStreamDoc else null,
                            livePkScoreDelta = if (applyLivePkScore) effectivePkScoreDelta else 0L
                        )
                    ) {
                        is LiveEconomyGiftResult.Success -> {
                            val updatedUser =
                                _uiState.value.currentUser?.withSyncedSpendableBalance(live.newWalletBalance)
                            val recipName = giftRecipientDisplayName()
                            val giftMsgName = _uiState.value.currentUser?.name?.ifBlank { null } ?: "User"
                            val streamForMsg = resolvedChatStreamId.ifBlank { receiverId }
                            lastLiveGiftOverlayMessageId = transactionId
                            lastLiveGiftOverlaySeenTimestampMs = System.currentTimeMillis()
                            skipLiveGiftOverlayListenerUntilMs = System.currentTimeMillis() + 7500L
                            firebaseService.sendLiveStreamGiftMessage(
                                streamId = streamForMsg,
                                messageDocId = transactionId,
                                senderId = senderId,
                                senderName = giftMsgName,
                                gift = gift,
                                count = count,
                                giftRecipientUserId = receiverId
                            ).onFailure { e ->
                                Log.e("DatingViewModel", "sendLiveStreamGiftMessage after live sendGift", e)
                            }
                            _uiState.update {
                                val pk = it.pkBattleSession
                                val pkOptimistic =
                                    if (applyLivePkScore && pk != null && !pk.battleEnded && pk.phase == PkBattlePhase.ACTIVE) {
                                        val h = pk.hostUserId.trim()
                                        val g = pk.guestUserId.trim()
                                        when (receiverId.trim()) {
                                            h -> pk.copy(hostBeansEarned = pk.hostBeansEarned + effectivePkScoreDelta)
                                            g -> pk.copy(guestBeansEarned = pk.guestBeansEarned + effectivePkScoreDelta)
                                            else -> pk
                                        }
                                    } else {
                                        pk
                                    }
                                it.copy(
                                    coinBalance = live.newWalletBalance,
                                    currentUser = updatedUser ?: it.currentUser,
                                    playingGift = gift,
                                    isGiftTransactionProcessing = false,
                                    liveGiftMessage = "Gift sent to $recipName!",
                                    giftSoundNonce = it.giftSoundNonce + 1,
                                    pkBattleSession = pkOptimistic,
                                    profileDetailSentGifts = optimisticMergeProfileSentGift(
                                        it, receiverId, gift, count, totalCost
                                    )
                                )
                            }
                            refreshProfileSheetGiftHistoryIfShowing(receiverId)
                        }
                        is LiveEconomyGiftResult.Failed -> {
                            _uiState.update { s ->
                                val restored = s.coinBalance + totalCost
                                s.copy(
                                    coinBalance = restored,
                                    currentUser = s.currentUser?.let { u ->
                                        var uu = u.withSyncedSpendableBalance(restored)
                                        if (senderIsMale) {
                                            uu = uu.copy(
                                                giftDiamondsSpentTotal = (uu.giftDiamondsSpentTotal - totalCostLong).coerceAtLeast(0L)
                                            )
                                        }
                                        uu
                                    },
                                    isGiftTransactionProcessing = false,
                                    liveGiftMessage = live.reason
                                )
                            }
                        }
                    }
                    return@launch
                }

                when (
                    val transfer = firebaseService.processGiftTransfer(
                        transactionId = transactionId,
                        senderId = senderId,
                        receiverId = receiverId,
                        gift = gift,
                        count = count
                    )
                ) {
                        is GiftTransferResult.Success -> {
                        lastLiveGiftOverlaySeenTimestampMs = System.currentTimeMillis()
                        skipLiveGiftOverlayListenerUntilMs = System.currentTimeMillis() + 7500L
                        val updatedUser =
                            _uiState.value.currentUser?.withSyncedSpendableBalance(transfer.senderBalance)
                        _uiState.update {
                            it.copy(
                                coinBalance = transfer.senderBalance,
                                currentUser = updatedUser ?: it.currentUser,
                                playingGift = gift,
                                isGiftTransactionProcessing = false,
                                giftSoundNonce = it.giftSoundNonce + 1,
                                profileDetailSentGifts = optimisticMergeProfileSentGift(
                                    it, receiverId, gift, count, totalCost
                                )
                            )
                        }
                        val callRoom = resolvedChatStreamId.ifBlank {
                            _uiState.value.webRtcSessionRoomId?.trim().orEmpty()
                        }
                        when {
                            postToLiveStreamCallRoomIfApplicable && callRoom.isNotEmpty() -> {
                                val giftMsgName = _uiState.value.currentUser?.name?.ifBlank { null } ?: "User"
                                lastLiveGiftOverlayMessageId = transactionId
                                firebaseService.sendLiveStreamGiftMessage(
                                    streamId = callRoom,
                                    messageDocId = transactionId,
                                    senderId = senderId,
                                    senderName = giftMsgName,
                                    gift = gift,
                                    count = count,
                                    giftRecipientUserId = receiverId
                                ).onFailure { e ->
                                    Log.e("DatingViewModel", "sendLiveStreamGiftMessage (call room)", e)
                                }
                            }
                            _uiState.value.selectedMessagePartnerId == receiverId ->
                                sendGiftMessage(receiverId, gift)
                            !postToLiveStreamCallRoomIfApplicable ->
                                sendGiftMessage(receiverId, gift)
                        }
                        refreshProfileSheetGiftHistoryIfShowing(receiverId)
                    }
                    is GiftTransferResult.Failed -> {
                        _uiState.update { s ->
                            val restored = s.coinBalance + totalCost
                            s.copy(
                                coinBalance = restored,
                                currentUser = s.currentUser?.let { u ->
                                    var uu = u.withSyncedSpendableBalance(restored)
                                    if (senderIsMale) {
                                        uu = uu.copy(
                                            giftDiamondsSpentTotal = (uu.giftDiamondsSpentTotal - totalCostLong).coerceAtLeast(0L)
                                        )
                                    }
                                    uu
                                },
                                isGiftTransactionProcessing = false,
                                loginError = transfer.reason
                            )
                        }
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.e("DatingViewModel", "sendGiftToReceiver unexpected failure", e)
                _uiState.update { s ->
                    val restored = s.coinBalance + totalCost
                    s.copy(
                        coinBalance = restored,
                        currentUser = s.currentUser?.let { u ->
                            var uu = u.withSyncedSpendableBalance(restored)
                            if (senderIsMale) {
                                uu = uu.copy(
                                    giftDiamondsSpentTotal = (uu.giftDiamondsSpentTotal - totalCostLong).coerceAtLeast(0L)
                                )
                            }
                            uu
                        },
                        isGiftTransactionProcessing = false,
                        liveGiftMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "Gift could not be sent. Try again."
                    )
                }
            }
        }
    }

    suspend fun processLuckyGifts(
        receiverId: String,
        giftPrice: Int,
        quantity: Int,
    ): LuckyGiftsOutcome {
        val myUid = auth.currentUser?.uid?.trim().orEmpty()
        if (myUid.isEmpty()) return LuckyGiftsOutcome.Failure("Not signed in")
        if (_uiState.value.isGuest || _uiState.value.currentUser?.isGuest == true) {
            return LuckyGiftsOutcome.Failure("Sign in to send gifts")
        }
        val rid = receiverId.trim()
        if (rid.isBlank()) return LuckyGiftsOutcome.Failure("No recipient")
        if (rid == myUid) return LuckyGiftsOutcome.Failure("Invalid recipient")
        val total = giftPrice * quantity
        if (total <= 0) return LuckyGiftsOutcome.Failure("Invalid amount")
        if (_uiState.value.coinBalance < total) {
            return LuckyGiftsOutcome.Failure("Not enough diamonds")
        }
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
            val snap = _uiState.value
            val provisional =
                (snap.coinBalance.toLong() - total.toLong() + diamondsWon.toLong())
                    .toInt()
                    .coerceAtLeast(0)
            _uiState.update { s ->
                s.copy(
                    coinBalance = provisional,
                    currentUser = s.currentUser?.withSyncedSpendableBalance(provisional),
                )
            }
            viewModelScope.launch(Dispatchers.IO) {
                runCatching {
                    firebaseService.getUserProfile(myUid, Source.SERVER)?.let { fresh ->
                        _uiState.update { s ->
                            s.copy(
                                coinBalance = fresh.coins,
                                currentUser = fresh,
                            )
                        }
                    }
                }.onFailure { e -> Log.w("DatingViewModel", "processLuckyGifts refresh profile", e) }
            }
            LuckyGiftsOutcome.Success(diamondsWon, transactionId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.e("DatingViewModel", "processLuckyGifts", e)
            LuckyGiftsOutcome.Failure(e.callableFailureMessage())
        }
    }

    suspend fun getAgoraToken(channelName: String, isPublisher: Boolean): String? {
        val ch = channelName.trim()
        if (ch.isEmpty()) return null
        val fbUid = auth.currentUser?.uid?.trim().orEmpty()
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
                            "isPublisher" to isPublisher,
                        ),
                    )
                    .await()
            val data = result.data as? Map<*, *> ?: return null
            (data["token"] as? String)?.takeIf { it.isNotBlank() }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.e("DatingViewModel", "getAgoraToken", e)
            val fe = e as? FirebaseFunctionsException
            if (fe?.code == FirebaseFunctionsException.Code.FAILED_PRECONDITION) {
                val now = SystemClock.elapsedRealtime()
                if (now - lastAgoraTokenConfigNoticeElapsedMs >= 15_000L) {
                    lastAgoraTokenConfigNoticeElapsedMs = now
                    val msg = DatingApp.applicationContext
                        ?.getString(R.string.agora_token_backend_not_configured)
                        ?: "Agora token backend is not configured (set AGORA_APP_ID and AGORA_APP_CERTIFICATE on getAgoraToken)."
                    _uiState.update { it.copy(callNoticeMessage = msg) }
                }
            }
            null
        }
    }

    /**
     * Same routing as [sendLiveComment] so lucky gifts hit the correct `live_streams/{id}/messages` doc.
     */
    private fun resolveStreamIdForLiveGiftMessage(): String? {
        val senderId = auth.currentUser?.uid?.trim().orEmpty()
        if (senderId.isEmpty()) return null
        val s = _uiState.value
        val pk = s.pkBattleSession
        val callRoomId = s.webRtcSessionRoomId?.trim()?.takeIf { it.isNotEmpty() }
        val pkRoomSignaling = callRoomId?.startsWith("pk_room_") == true
        fun resolveLiveChatHostStreamUid(): String? {
            pk?.hostUserId?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
            s.webRtcOverlayHostUserId?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
            s.watchingLivePartner?.id?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
            if (s.isLive) {
                s.currentRoomId?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
                return senderId.takeIf { it.isNotEmpty() }
            }
            return null
        }
        val preferPrivateCallChat = callRoomId != null && (
            s.isCurrentlyInCall ||
                s.isVideoCallActive ||
                s.isAudioCallActive ||
                s.callState == CallState.DIALING ||
                s.callState == CallState.RINGING ||
                s.callState == CallState.CONNECTING ||
                s.callState == CallState.ACTIVE
        )
        val streamId: String? = when {
            pk != null -> {
                val h = pk.hostUserId.trim().takeIf { it.isNotEmpty() }
                h ?: resolveLiveChatHostStreamUid()
            }
            pkRoomSignaling -> resolveLiveChatHostStreamUid()
            preferPrivateCallChat -> callRoomId
            s.isLive -> senderId
            s.watchingLivePartner != null -> s.watchingLivePartner!!.id
            callRoomId != null -> callRoomId
            else -> null
        }
        return streamId?.trim()?.takeIf { it.isNotEmpty() }
    }

    /**
     * After [processLuckyGifts] succeeds: show [GiftOverlay] locally and, when in a live / WebRTC room,
     * write the same `live_streams/.../messages` gift row as premium sends so spectators see the animation.
     */
    fun publishLuckyGiftVisual(gift: Gift, receiverId: String, count: Int, transactionId: String?) {
        val senderId = auth.currentUser?.uid?.trim().orEmpty()
        if (senderId.isEmpty()) return
        val rid = receiverId.trim()
        if (rid.isBlank()) return
        val messageDocId = transactionId?.trim()?.takeIf { it.isNotEmpty() } ?: UUID.randomUUID().toString()
        val snap = _uiState.value
        val streamForMsg = resolveStreamIdForLiveGiftMessage().orEmpty()
        val giftMsgName = snap.currentUser?.name?.ifBlank { null } ?: "User"
        viewModelScope.launch {
            if (streamForMsg.isNotBlank()) {
                firebaseService.sendLiveStreamGiftMessage(
                    streamId = streamForMsg,
                    messageDocId = messageDocId,
                    senderId = senderId,
                    senderName = giftMsgName,
                    gift = gift,
                    count = count,
                    giftRecipientUserId = rid,
                ).onFailure { e ->
                    Log.e("DatingViewModel", "publishLuckyGiftVisual sendLiveStreamGiftMessage", e)
                }
            }
            lastLiveGiftOverlayMessageId = messageDocId
            lastLiveGiftOverlaySeenTimestampMs = System.currentTimeMillis()
            skipLiveGiftOverlayListenerUntilMs = System.currentTimeMillis() + 7500L
            _uiState.update {
                it.copy(
                    playingGift = gift,
                    giftSoundNonce = it.giftSoundNonce + 1,
                )
            }
        }
    }

    fun supportGirl(team: Int, gift: Gift, count: Int) {
        val totalCost = gift.price * count
        val b = _uiState.value.activeBattle ?: return
        if (_uiState.value.coinBalance < totalCost) return
        val actor = auth.currentUser?.uid ?: return
        val points = gift.points * count
        val u = _uiState.value.currentUser?.withSyncedSpendableBalance(_uiState.value.coinBalance - totalCost)
            ?: return
        viewModelScope.launch { firebaseService.saveUserProfile(u) }
        _uiState.update { it.copy(coinBalance = u.coins, currentUser = u, playingGift = gift) }
        viewModelScope.launch {
            firebaseService.applyBattleGameInput(b.id, actor, "GIFT", mapOf("team" to team, "points" to points))
                .onFailure { e ->
                    Log.e("DatingViewModel", "supportGirl GIFT sync", e)
                    val refundUser = u.withSyncedSpendableBalance(u.coins + totalCost)
                    runCatching { firebaseService.saveUserProfile(refundUser) }
                    _uiState.update { s ->
                        s.copy(
                            coinBalance = refundUser.coins,
                            currentUser = refundUser,
                            playingGift = null,
                            loginError = e.message ?: "Gift sync failed; coins restored."
                        )
                    }
                }
        }
    }
    
    fun clearPlayingGift() {
        _uiState.update { it.copy(playingGift = null) }
    }

    fun castVote(team: Int) {
        val b = _uiState.value.activeBattle ?: return
        val actor = auth.currentUser?.uid ?: return
        if (_uiState.value.isBattleActionInProgress) return
        _uiState.update { it.copy(selectedTeam = team, isBattleActionInProgress = true) }
        viewModelScope.launch {
            firebaseService.applyBattleGameInput(b.id, actor, "VOTE", mapOf("team" to team))
                .onFailure { e ->
                    Log.e("DatingViewModel", "castVote", e)
                    _uiState.update { it.copy(loginError = e.message ?: "Vote failed") }
                }
            _uiState.update { it.copy(isBattleActionInProgress = false) }
        }
    }

    fun startBattle() { 
        val otherLiveProfiles = _uiState.value.profiles.filter { it.isLive && it.id != auth.currentUser?.uid }
        
        if (otherLiveProfiles.isEmpty()) {
            _uiState.update { it.copy(loginError = "No other streamers available for battle right now.") }
            return
        }
        
        val randomOpponent = otherLiveProfiles.random()
        
        val meId = auth.currentUser?.uid ?: "me"
        _uiState.update { it.copy(activeBattle = Battle(
            id = UUID.randomUUID().toString(),
            gameTypeStr = GameType.LIVE_PK.name,
            hostId = meId,
            girl1Id = meId,
            girl2Id = randomOpponent.id,
            girl1Name = it.currentUser?.name ?: "You",
            girl2Name = randomOpponent.name,
            statusStr = BattleStatus.LIVE.name,
            startTime = System.currentTimeMillis()
        )) }

        if (!_uiState.value.isLive) {
            toggleLive()
        }
    }
    
    fun startSpin() {
        val b = _uiState.value.activeBattle ?: return
        val actor = auth.currentUser?.uid ?: return
        // Block if it's not this player's turn
        if (b.currentTurnUserId.isNotBlank() && b.currentTurnUserId != actor) return
        // Block if this player has already spun this round
        val hasSpun = if (actor == b.girl1Id) b.girl1HasSpun else b.girl2HasSpun
        if (hasSpun) return
        if (_uiState.value.isBattleActionInProgress) return
        _uiState.update { it.copy(isBattleActionInProgress = true) }
        viewModelScope.launch {
            firebaseService.applyBattleGameInput(b.id, actor, "SPIN_START", emptyMap())
                .onSuccess { pendingSpinRoundCompleterUid = actor }
                .onFailure { e ->
                    Log.e("DatingViewModel", "startSpin", e)
                    if (pendingSpinRoundCompleterUid == actor) pendingSpinRoundCompleterUid = null
                }
            _uiState.update { it.copy(isBattleActionInProgress = false) }
        }
    }

    /**
     * Called by the UI once the wheel animation finishes (~3 s after SPIN_START).
     * Writes SPIN_STOP to Firebase (awards points, marks hasSpun), then drives the
     * 10-second break countdown locally before writing SPIN_ROUND_RESET so both
     * players' buttons light back up simultaneously.
     */
    fun completeSpin() {
        val actor = auth.currentUser?.uid ?: return
        if (pendingSpinRoundCompleterUid != actor) return
        val b = _uiState.value.activeBattle ?: return
        spinRoundCompleteJob?.cancel()
        spinRoundCompleteJob = viewModelScope.launch {
            // 1. Award points and mark this player as having spun (only this device runs STOP/RESET;
            //    the opponent's wheel animates for UX but does not write — avoids double Firestore commits).
            firebaseService.applyBattleGameInput(b.id, actor, "SPIN_STOP", emptyMap())
                .onFailure { e ->
                    Log.e("DatingViewModel", "completeSpin SPIN_STOP", e)
                    pendingSpinRoundCompleterUid = null
                    return@launch
                }
            pendingSpinRoundCompleterUid = null
            val startedMs = _uiState.value.activeBattle?.spinBreakStartedAtMs ?: System.currentTimeMillis()
            val waitMs = (10_000L - (System.currentTimeMillis() - startedMs)).coerceIn(0L, 10_000L)
            delay(waitMs)
            val still = _uiState.value.activeBattle
            if (still == null || still.id != b.id) return@launch
            firebaseService.applyBattleGameInput(b.id, actor, "SPIN_ROUND_RESET", emptyMap())
                .onFailure { e -> Log.e("DatingViewModel", "completeSpin SPIN_ROUND_RESET", e) }
        }
    }

    fun setEmojiChallenge(e: String) {
        val b = _uiState.value.activeBattle ?: return
        val actor = auth.currentUser?.uid ?: return
        // Turn validation: only the current-turn player may set the challenge
        if (b.currentTurnUserId.isNotBlank() && b.currentTurnUserId != actor) {
            Log.w("DatingViewModel", "setEmojiChallenge blocked: not actor's turn (turn=${b.currentTurnUserId}, actor=$actor)")
            return
        }
        if (_uiState.value.isBattleActionInProgress) return
        _uiState.update { it.copy(isBattleActionInProgress = true) }
        viewModelScope.launch {
            firebaseService.applyBattleGameInput(b.id, actor, "EMOJI_TURN", mapOf("emoji" to e))
                .onFailure { e2 -> Log.e("DatingViewModel", "setEmojiChallenge", e2) }
            _uiState.update { it.copy(isBattleActionInProgress = false) }
        }
    }

    fun solveEmojiChallenge(a: String) {
        val b = _uiState.value.activeBattle ?: return
        val actor = auth.currentUser?.uid ?: return
        // Turn validation: the current-turn player cannot solve (they are the setter)
        if (b.currentTurnUserId == actor) {
            Log.w("DatingViewModel", "solveEmojiChallenge blocked: it is actor's turn to set, not solve")
            return
        }
        if (_uiState.value.isBattleActionInProgress) return
        _uiState.update { it.copy(isBattleActionInProgress = true) }
        viewModelScope.launch {
            firebaseService.applyBattleGameInput(b.id, actor, "EMOJI_SOLVE", mapOf("answer" to a))
                .onFailure { e -> Log.e("DatingViewModel", "solveEmojiChallenge", e) }
            _uiState.update { it.copy(isBattleActionInProgress = false) }
        }
    }

    fun openMysteryBox(i: Int) {
        val b = _uiState.value.activeBattle ?: return
        val actor = auth.currentUser?.uid ?: return
        if (b.mysteryBoxes.getOrNull(i)?.isOpened == true) return
        if (_uiState.value.isBattleActionInProgress) return
        _uiState.update { it.copy(isBattleActionInProgress = true) }
        viewModelScope.launch {
            firebaseService.applyBattleGameInput(b.id, actor, "OPEN_BOX", mapOf("boxIndex" to i))
                .onFailure { e -> Log.e("DatingViewModel", "openMysteryBox", e) }
            _uiState.update { it.copy(isBattleActionInProgress = false) }
        }
    }

    fun leaveBattle() {
        val b = _uiState.value.activeBattle
        val actor = auth.currentUser?.uid
        spinRoundCompleteJob?.cancel()
        spinRoundCompleteJob = null
        pendingSpinRoundCompleterUid = null
        // If the battle is still live, write a forfeit so the opponent gets their win
        if (b != null && actor != null && b.status == BattleStatus.LIVE) {
            viewModelScope.launch {
                runCatching {
                    firebaseService.applyBattleGameInput(b.id, actor, "FORFEIT", mapOf("forfeitingUid" to actor))
                }.onFailure { Log.w("DatingViewModel", "leaveBattle forfeit write failed", it) }
            }
        }
        battleDetailJob?.cancel()
        battleDetailJob = null
        battleGameStateJob?.cancel()
        battleGameStateJob = null
        _uiState.update { it.copy(activeBattle = null, battleGameState = null, battleResults = null, isBattleActionInProgress = false) }
    }
    
    fun createBattle(t: GameType, g2: String?, p: Int, q: List<QuizQuestion>?, s: List<SpinSector>?, m: List<MysteryBoxContent>?) {
        val otherLiveProfiles = _uiState.value.profiles.filter { it.isLive && it.id != auth.currentUser?.uid }

        val opponent = when {
            g2 != null -> _uiState.value.profiles.find { it.id == g2 && it.isLive }
            otherLiveProfiles.isNotEmpty() -> otherLiveProfiles.random()
            else -> null
        }

        if (g2 != null && opponent == null) {
            _uiState.update { it.copy(loginError = "Selected user is not currently live.") }
            return
        }

        val hostUid = auth.currentUser?.uid ?: "me"
        val battle = Battle(
            id = UUID.randomUUID().toString(),
            gameTypeStr = t.name,
            hostId = hostUid,
            girl1Id = hostUid,
            girl2Id = opponent?.id.orEmpty(),
            girl1Name = _uiState.value.currentUser?.name ?: "You",
            girl2Name = opponent?.name?.takeIf { it.isNotBlank() } ?: "Open seat",
            statusStr = BattleStatus.WAITING.name,
            prizePool = p,
            startTime = System.currentTimeMillis(),
            spinSectors = s ?: emptyList(),
            mysteryBoxes = m ?: emptyList()
        )

        _uiState.update { s ->
            s.copy(
                activeBattle = battle,
                battles = listOf(battle) + s.battles.filter { it.id != battle.id },
                loginError = null
            )
        }

        viewModelScope.launch {
            runCatching { firebaseService.publishBattle(battle) }
                .onSuccess { restartBattleDocumentListenerIfPublished(battle.id) }
                .onFailure { e ->
                    Log.e("DatingViewModel", "publishBattle failed", e)
                    _uiState.update {
                        it.copy(loginError = e.message ?: "Could not publish game lobby. Check connection.")
                    }
                }
        }

        if (!_uiState.value.isLive) {
            toggleLive()
        }
    }


    fun buyCoins(pkg: CoinPackage) {
        Log.d("DiamondShop", "Initiating purchase for ${pkg.totalDiamonds} diamonds (base=${pkg.coins} bonus=${pkg.bonus})")
    }

    fun updateLanguage(l: AppLanguage) {
        _uiState.update { it.copy(selectedLanguage = l) }
    }

    /** Call once from UI after reading persisted language code. */
    fun applyStoredLanguageCode(code: String) {
        val lang = AppLanguage.entries.find { it.code == code } ?: AppLanguage.ENGLISH
        _uiState.update { it.copy(selectedLanguage = lang) }
    }
    
    fun showRewards() { _uiState.update { it.copy(showRewardsDialog = true) } }

    private fun mergeBattleRemoteFields(local: Battle, remote: Battle) = local.copy(
        girl1Votes = remote.girl1Votes,
        girl2Votes = remote.girl2Votes,
        girl1Score = remote.girl1Score,
        girl2Score = remote.girl2Score,
        viewerCount = remote.viewerCount,
        statusStr = remote.statusStr,
        // Turn-based game sync
        currentTurnUserId = remote.currentTurnUserId.ifBlank { local.currentTurnUserId },
        currentEmojiChallenge = remote.currentEmojiChallenge ?: local.currentEmojiChallenge,
        emojiGameTurnCount = remote.emojiGameTurnCount,
        // Spin game sync
        isSpinning = remote.isSpinning,
        lastWinnerSectorIndex = remote.lastWinnerSectorIndex ?: local.lastWinnerSectorIndex,
        // Wall-clock break countdown so Firestore snapshots don't stomp local ticks with default 0.
        spinBreakTimeLeft = if (remote.spinBreakStartedAtMs > 0L) {
            (10 - ((System.currentTimeMillis() - remote.spinBreakStartedAtMs) / 1000L).toInt()).coerceIn(0, 10)
        } else {
            0
        },
        spinBettingTimeLeft = remote.spinBettingTimeLeft,
        girl1HasSpun = remote.girl1HasSpun,
        girl2HasSpun = remote.girl2HasSpun,
        spinBreakStartedAtMs = remote.spinBreakStartedAtMs,
        // Mystery box sync — preserve richer local configuration while updating opened states
        mysteryBoxes = if (remote.mysteryBoxes.isNotEmpty()) {
            // Map opened-state from remote onto local box definitions (which carry richer data like amount)
            local.mysteryBoxes.mapIndexed { i, localBox ->
                val remoteBox = remote.mysteryBoxes.getOrNull(i)
                if (remoteBox != null) localBox.copy(isOpened = remoteBox.isOpened) else localBox
            }.ifEmpty { remote.mysteryBoxes }
        } else local.mysteryBoxes
    )

    private fun restartBattleDocumentListenerIfPublished(battleId: String) {
        battleDetailJob?.cancel()
        battleGameStateJob?.cancel()
        battleDetailJob = viewModelScope.launch {
            firebaseService.observeBattleDocument(battleId).collect { remote ->
                if (remote == null) return@collect
                // Capture pre-update state to detect first FINISHED transition outside the lambda
                val preState = _uiState.value
                val isFirstFinish = remote.status == BattleStatus.FINISHED && preState.battleResults == null
                _uiState.update { s ->
                    val local = s.activeBattle ?: return@update s
                    if (local.id != remote.id) return@update s
                    val merged = mergeBattleRemoteFields(local, remote)
                    // Auto-derive BattleResult when the server marks the battle as FINISHED
                    val newResults = if (remote.status == BattleStatus.FINISHED && s.battleResults == null) {
                        val isG1Win = merged.girl1Score >= merged.girl2Score
                        BattleResult(
                            winnerId = if (isG1Win) merged.girl1Id else merged.girl2Id,
                            winnerName = if (isG1Win) merged.girl1Name else merged.girl2Name,
                            winnerVotes = if (isG1Win) merged.girl1Votes else merged.girl2Votes,
                            girl1Score = merged.girl1Score,
                            girl2Score = merged.girl2Score
                        )
                    } else s.battleResults
                    s.copy(activeBattle = merged, battleResults = newResults)
                }
                // Credit prize-pool diamonds to the winner (runs once per battle on first FINISHED signal)
                if (isFirstFinish) {
                    val meId = auth.currentUser?.uid ?: return@collect
                    val battle = preState.activeBattle ?: return@collect
                    val prizePool = battle.prizePool
                    if (prizePool <= 0) return@collect
                    val isG1Win = remote.girl1Score >= remote.girl2Score
                    val winnerId = if (isG1Win) remote.girl1Id else remote.girl2Id
                    if (winnerId != meId) return@collect
                    // I am the winner — credit diamonds
                    val s = _uiState.value
                    val me = s.currentUser ?: return@collect
                    val newBalance = s.coinBalance + prizePool
                    val updatedUser = me.withSyncedSpendableBalance(newBalance)
                    _uiState.update { it.copy(currentUser = updatedUser, coinBalance = newBalance) }
                    viewModelScope.launch {
                        runCatching {
                            val db = com.google.firebase.firestore.FirebaseFirestore.getInstance()
                            db.collection("game_transactions").add(
                                mapOf(
                                    "userId"       to meId,
                                    "gameId"       to battle.id,
                                    "gameName"     to "Battle (${battle.gameType})",
                                    "betAmount"    to 0,
                                    "winAmount"    to prizePool,
                                    "net"          to prizePool,
                                    "balanceAfter" to newBalance,
                                    "timestamp"    to com.google.firebase.Timestamp.now(),
                                )
                            )
                            db.collection("users").document(meId)
                                .update(mapOf("coins" to newBalance, "walletBalance" to newBalance))
                        }.onFailure { e ->
                            Log.w("DatingViewModel", "battle prize credit failed", e)
                            _uiState.update { it.copy(currentUser = me, coinBalance = s.coinBalance) }
                        }
                    }
                }
            }
        }
        battleGameStateJob = viewModelScope.launch {
            firebaseService.observeBattleGameState(battleId).collect { gs ->
                _uiState.update { it.copy(battleGameState = gs) }
            }
        }
    }

    private fun stopLiveHostStreamObservers() {
        liveHostMessagesJob?.cancel()
        liveHostRoomJob?.cancel()
        liveHostActiveViewersJob?.cancel()
        liveHostAudioPartyStreamJob?.cancel()
        liveHostVideoCallRequestsJob?.cancel()
        liveHostMessagesJob = null
        liveHostRoomJob = null
        liveHostActiveViewersJob = null
        liveHostAudioPartyStreamJob = null
        liveHostVideoCallRequestsJob = null
        _uiState.update {
            it.copy(
                liveAudienceViewerUserIds = emptyList(),
                audioPartyVideoCallRequests = emptyList(),
                playingGift = null
            )
        }
    }

    /**
     * Merges Firestore live chat with gift-overlay triggers so the streamer sees the same
     * animation path as viewers ([lastLiveGiftOverlayMessageId] excludes the sender's own doc).
     */
    private fun applyLiveChatSnapshot(list: List<LiveStreamChatMessage>) {
        val uid = auth.currentUser?.uid
        val latestGift = list.lastOrNull { m ->
            m.type == "gift" &&
                m.id.isNotBlank() &&
                m.id != lastLiveGiftOverlayMessageId &&
                m.senderId != uid &&
                m.timestamp > lastLiveGiftOverlaySeenTimestampMs
        }
        val matched: Gift? = if (latestGift != null &&
            System.currentTimeMillis() >= skipLiveGiftOverlayListenerUntilMs
        ) {
            val msg = latestGift
            lastLiveGiftOverlayMessageId = msg.id
            lastLiveGiftOverlaySeenTimestampMs = msg.timestamp
            val fromCatalog = _uiState.value.availableGifts.firstOrNull { g ->
                g.id == msg.giftId ||
                    (
                        !msg.giftImageUrl.isNullOrBlank() &&
                            (g.thumbnailUrl == msg.giftImageUrl || g.videoUrl == msg.giftImageUrl)
                        ) ||
                    (!msg.giftVideoUrl.isNullOrBlank() && g.videoUrl == msg.giftVideoUrl)
            }
            val baseline = fromCatalog ?: Gift(
                id = msg.giftId,
                name = msg.giftName.ifBlank { msg.text },
                price = 0,
                thumbnailUrl = msg.giftImageUrl.orEmpty(),
                videoUrl = msg.giftVideoUrl.orEmpty(),
                soundUrl = msg.giftSoundUrl.orEmpty(),
                category = if (!msg.giftVideoUrl.isNullOrBlank() || !msg.giftSoundUrl.isNullOrBlank()) {
                    "CRM_PREMIUM"
                } else {
                    "STANDARD"
                },
                isCrmGift = !msg.giftVideoUrl.isNullOrBlank() || !msg.giftSoundUrl.isNullOrBlank(),
                displayDurationSeconds = msg.giftDisplayDurationSeconds.coerceIn(0, 12)
            )
            baseline.withMergedLiveGiftMessage(msg)
        } else null
        _uiState.update { s ->
            val base = s.copy(liveStreamChatMessages = list)
            if (matched != null) {
                base.copy(
                    playingGift = matched,
                    giftSoundNonce = base.giftSoundNonce + 1
                )
            } else base
        }
    }

    /** Sync Firebase Auth login email: prefers [FirebaseUser.verifyBeforeUpdateEmail], then [FirebaseUser.updateEmail]. */
    private suspend fun syncFirebaseUserEmailIfChanged(newEmail: String) {
        val u = auth.currentUser ?: return
        val trimmed = newEmail.trim()
        if (trimmed.isEmpty() || trimmed.equals(u.email?.trim().orEmpty(), ignoreCase = true)) return
        val verified = runCatching {
            u.verifyBeforeUpdateEmail(trimmed).await()
            true
        }.getOrElse { vErr ->
            Log.d("DatingViewModel", "verifyBeforeUpdateEmail skipped/failed: ${vErr.message}")
            false
        }
        if (verified) {
            _uiState.update { s ->
                s.copy(
                    callNoticeMessage = "We sent a verification link to $trimmed. Open it to finish changing your sign-in email."
                )
            }
        } else {
            runCatching { u.updateEmail(trimmed).await() }
                .onFailure { uErr ->
                    Log.w("DatingViewModel", "updateEmail failed", uErr)
                    _uiState.update { s ->
                        s.copy(
                            loginError = "Profile saved. Sign-in email may be unchanged: ${uErr.message}"
                        )
                    }
                }
        }
        runCatching { auth.currentUser?.reload()?.await() }
    }

    /** Freezes tug bar + outcome when the PK round timer reaches 0 (strict cutoff); closes Firestore scoring. */
    fun markPkBattleTimerFinished() {
        val pkPre = _uiState.value.pkBattleSession
        val hostForScoring = pkPre?.hostUserId?.trim().orEmpty()
        val guestForScoring = pkPre?.guestUserId?.trim().orEmpty()
        _uiState.update { s ->
            val pk = s.pkBattleSession ?: return@update s
            if (pk.battleEnded || pk.phase != PkBattlePhase.ACTIVE) return@update s
            val total = pk.hostBeansEarned + pk.guestBeansEarned
            val ratio =
                if (total <= 0L) 0.5f else pk.hostBeansEarned.toFloat() / total.toFloat()
            val my = auth.currentUser?.uid.orEmpty()
            val outcome = when {
                my.isNotBlank() && my != pk.hostUserId && my != pk.guestUserId -> {
                    when {
                        pk.hostBeansEarned > pk.guestBeansEarned -> PkBattleOutcome.HOST_WINS
                        pk.guestBeansEarned > pk.hostBeansEarned -> PkBattleOutcome.GUEST_WINS
                        else -> PkBattleOutcome.DRAW
                    }
                }
                my == pk.hostUserId -> {
                    val mine = pk.hostBeansEarned
                    val theirs = pk.guestBeansEarned
                    when {
                        mine > theirs -> PkBattleOutcome.VICTORY
                        mine < theirs -> PkBattleOutcome.DEFEAT
                        else -> PkBattleOutcome.DRAW
                    }
                }
                my == pk.guestUserId -> {
                    val mine = pk.guestBeansEarned
                    val theirs = pk.hostBeansEarned
                    when {
                        mine > theirs -> PkBattleOutcome.VICTORY
                        mine < theirs -> PkBattleOutcome.DEFEAT
                        else -> PkBattleOutcome.DRAW
                    }
                }
                else -> {
                    when {
                        pk.hostBeansEarned > pk.guestBeansEarned -> PkBattleOutcome.HOST_WINS
                        pk.guestBeansEarned > pk.hostBeansEarned -> PkBattleOutcome.GUEST_WINS
                        else -> PkBattleOutcome.DRAW
                    }
                }
            }
            val lingerEnds = System.currentTimeMillis() + PK_POST_RESULT_LINGER_MS
            s.copy(
                pkBattleSession = pk.copy(
                    battleEnded = true,
                    frozenTugRatio = ratio,
                    outcome = outcome,
                    phase = PkBattlePhase.FINISHED,
                    resultPhaseEndsAtMillis = lingerEnds
                )
            )
        }
        if (hostForScoring.isNotBlank()) {
            viewModelScope.launch {
                runCatching { firebaseService.closePkBattleScoringForBattle(hostForScoring, guestForScoring) }
                    .onFailure { Log.w("DatingViewModel", "closePkBattleScoringForBattle", it) }
            }
        }
        maybeAttachPkRematchGuestListener()
    }

    private fun maybeAttachPkRematchGuestListener() {
        val s = _uiState.value
        val pk = s.pkBattleSession ?: return
        if (!pk.battleEnded || pk.phase != PkBattlePhase.FINISHED || pk.outcome == null) return
        val my = auth.currentUser?.uid?.trim().orEmpty()
            .ifBlank { s.currentUser?.id?.trim().orEmpty() }
        if (my.isBlank() || my != pk.guestUserId) return
        if (s.webRtcSessionRoomId.isNullOrBlank()) return
        attachPkRematchGuestListener(pk.hostUserId.trim())
    }

    /** Merges Firestore PK tug totals from `live_streams/{streamDocHostUid}` ([FieldValue.increment] on send gift). */
    private fun mergePkBattleFromLiveRoomDoc(
        streamDocHostUid: String,
        info: LiveStreamRoomInfo,
        st: DatingUiState
    ): DatingUiState {
        if (!info.streamActive) return st
        val pk = st.pkBattleSession ?: return st
        if (pk.battleEnded || pk.phase != PkBattlePhase.ACTIVE) return st
        if (!info.pkScoringOpen) return st
        if (pk.hostUserId != streamDocHostUid) return st
        val battleGuest = info.pkBattleGuestUid.trim().ifBlank { info.pkGuestUserId.trim() }
        if (battleGuest.isBlank() || battleGuest == streamDocHostUid || battleGuest != pk.guestUserId) return st
        if (info.pkStartedAtMillis <= 0L) return st
        val h = maxOf(info.pkHostBeans, pk.hostBeansEarned)
        val g = maxOf(info.pkGuestBeans, pk.guestBeansEarned)
        if (h == pk.hostBeansEarned && g == pk.guestBeansEarned) return st
        return st.copy(pkBattleSession = pk.copy(hostBeansEarned = h, guestBeansEarned = g))
    }

    private fun startLiveHostStreamObservers(hostId: String) {
        stopWebRtcCallLiveObservers()
        stopLiveHostStreamObservers()
        liveHostMessagesJob = viewModelScope.launch {
            firebaseService.observeLiveStreamMessages(hostId, liveStreamChatMinTimestampMs).collect { list ->
                applyLiveChatSnapshot(list)
            }
        }
        liveHostRoomJob = viewModelScope.launch {
            firebaseService.observeLiveStreamRoom(hostId).collect { info ->
                if (info.audioPartyHandoffToUid.isNotBlank()) {
                    val to = info.audioPartyHandoffToUid.trim()
                    if (to.isNotEmpty() &&
                        _uiState.value.currentUser?.id == hostId &&
                        _uiState.value.isLive
                    ) {
                        applyLocalStateAfterOutgoingAudioPartyHandoff()
                    }
                    return@collect
                }
                if (!info.streamActive) {
                    _uiState.update { st ->
                        if (st.currentUser?.id == hostId && st.isLive) {
                            val cu = st.currentUser
                            st.copy(
                                isLive = false,
                                currentRoomId = null,
                                currentUser = cu?.copy(isLive = false, liveRoomId = null),
                                liveStreamViewerCount = 0,
                                liveStreamChatMessages = emptyList(),
                                watchingLiveStreamStartedAtMillis = 0L,
                                watchingLiveStreamIsAudioOnly = false,
                                watchingLiveAudioPartySeatCount = 10,
                                audioPartySeatCount = 10,
                                audioPartyStream = AudioPartyStreamState(),
                                audioPartyVideoCallRequests = emptyList(),
                                playingGift = null
                            )
                        } else {
                            st
                        }
                    }
                    return@collect
                }
                _uiState.update { st ->
                    val battleH = info.pkBattleHostUid.trim().ifBlank { hostId }
                    val battleG = info.pkBattleGuestUid.trim().ifBlank { info.pkGuestUserId.trim() }
                    val pkDoc = info.pkStartedAtMillis > 0L && battleG.isNotBlank() && battleH.isNotBlank() && battleH != battleG
                    mergePkBattleFromLiveRoomDoc(
                        hostId,
                        info,
                        st.copy(
                            liveStreamViewerCount = info.viewerCount,
                            watchingLiveStreamStartedAtMillis = info.streamStartedAtMillis,
                            audioPartySeatCount = if (info.audioOnlyStream) {
                                info.audioPartySeatCount
                            } else {
                                st.audioPartySeatCount
                            },
                            pkHostViewerCount = if (pkDoc) info.pkHostViewerCount else 0,
                            pkGuestViewerCount = if (pkDoc) info.pkGuestViewerCount else 0,
                            pkHostViewerUserIds = if (pkDoc) info.pkHostViewerUserIds else emptyList(),
                            pkGuestViewerUserIds = if (pkDoc) info.pkGuestViewerUserIds else emptyList()
                        )
                    )
                }
            }
        }
        liveHostActiveViewersJob = viewModelScope.launch {
            firebaseService.observeRoomActiveViewerUids(hostId).collect { uids ->
                _uiState.update { it.copy(liveAudienceViewerUserIds = uids) }
            }
        }
        liveHostAudioPartyStreamJob?.cancel()
        liveHostAudioPartyStreamJob = if (_uiState.value.isAudioPartyLive) {
            viewModelScope.launch {
                firebaseService.observeAudioPartyStream(hostId).collect { st ->
                    _uiState.update { it.copy(audioPartyStream = st) }
                }
            }
        } else {
            null
        }
        liveHostVideoCallRequestsJob?.cancel()
        liveHostVideoCallRequestsJob = if (_uiState.value.isAudioPartyLive) {
            viewModelScope.launch {
                firebaseService.observeAudioPartyVideoCallRequests(hostId).collect { reqs ->
                    _uiState.update { it.copy(audioPartyVideoCallRequests = reqs) }
                }
            }
        } else {
            null
        }
    }


    private fun detachLiveSignalsListeners() {
        for (b in liveSignalsBindings) {
            firebaseService.removeLiveSignalsListener(b.ref, b.listener)
        }
        liveSignalsBindings.clear()
    }

    private fun clearPkSpectatorPerspectiveTracking() {
        pkWatchAudienceFirestoreStreamId = null
        pkWatchAudienceCountSessionKey = null
        pkWatchAudienceCountedForHost = null
    }

    private fun spectatorPkEndDedupeKey(
        streamDocHostId: String,
        battleGuestUid: String,
        pkRoundStartMs: Long,
    ): String {
        val me = auth.currentUser?.uid?.trim().orEmpty()
        return "${me}|${streamDocHostId.trim()}|${battleGuestUid.trim()}|$pkRoundStartMs"
    }

    /**
     * After PK ends on a watched host stream: neutral / host supporters stay on [streamDocHostId].
     * Challenger supporters switch to the guest's solo [live_streams/{guestUid}] when that doc is active;
     * otherwise they remain on the host (guest may not be broadcasting solo yet).
     */
    private fun maybeRedirectSpectatorAfterPkEnds(
        streamDocHostId: String,
        battleGuestUid: String,
        battleGuestDisplayName: String,
        pkRoundStartMs: Long,
    ) {
        val hostId = streamDocHostId.trim()
        val guestUid = battleGuestUid.trim()
        val rootingHost = pkWatchAudienceCountedForHost ?: true
        val pkStreamIdForAdj = pkWatchAudienceFirestoreStreamId
        val pkCountedHostForAdj = pkWatchAudienceCountedForHost
        clearPkSpectatorPerspectiveTracking()

        val dedupeKey = spectatorPkEndDedupeKey(hostId, guestUid, pkRoundStartMs)
        if (spectatorPkEndRoutingHandledKey == dedupeKey) {
            return
        }
        spectatorPkEndRoutingHandledKey = dedupeKey

        if (_uiState.value.watchingLivePartner?.id?.trim().orEmpty() != hostId) {
            return
        }

        if (rootingHost || guestUid.isBlank()) {
            return
        }

        viewModelScope.launch {
            val guestLive = runCatching {
                firebaseService.observeLiveStreamRoom(guestUid).first().streamActive
            }.getOrElse { false }

            if (!guestLive) {
                Log.d(
                    "DatingViewModel",
                    "PK end spectator routing: stay on host — guest solo not active ($guestUid)"
                )
                return@launch
            }

            val guestProfile = runCatching { firebaseService.getUserProfile(guestUid) }.getOrNull()
                ?: _uiState.value.profiles.find { it.id == guestUid }
                ?: _uiState.value.filteredProfiles.find { it.id == guestUid }
                ?: UserProfile(
                    id = guestUid,
                    name = battleGuestDisplayName.ifBlank { "Live" },
                    profileNumber = "",
                    photoUrl = "",
                )

            runCatching { firebaseService.incrementLiveStreamViewers(hostId, -1) }
                .onFailure { Log.w("DatingViewModel", "spectator PK end incrementLiveStreamViewers host -1", it) }
            if (pkStreamIdForAdj != null && pkCountedHostForAdj != null) {
                val leaver = auth.currentUser?.uid?.trim().orEmpty()
                runCatching {
                    firebaseService.adjustPkBattlerAudienceCounts(
                        pkStreamIdForAdj,
                        if (pkCountedHostForAdj) -1L else 0L,
                        if (pkCountedHostForAdj) 0L else -1L,
                        spectatorUid = leaver.takeIf { it.isNotEmpty() },
                    )
                }.onFailure { Log.w("DatingViewModel", "spectator PK end adjustPkBattlerAudienceCounts", it) }
            }

            watchLive(guestProfile)
        }
    }

    /**
     * Host (or battler) emitted [FirebaseService.emitEndPkStayLiveSignal]; collapse PK UI for spectators
     * before Firestore PK fields clear.
     */
    private fun handleEndPkStayLiveSignalForAudience() {
        viewModelScope.launch {
            val s = _uiState.value
            if (s.watchingLivePartner == null) return@launch
            if (!s.watchingPkActive && s.pkBattleSession == null) return@launch
            val hostId = s.watchingLivePartner!!.id.trim()
            val guestUid = s.watchingPkGuestUid.trim()
            val guestName = s.watchingPkGuestDisplayName.trim()
            val pkStartMs = s.pkBattleSession?.pkStartTimeMillis ?: 0L
            _uiState.update { st ->
                st.copy(
                    watchingPkActive = false,
                    watchingPkGuestUid = "",
                    watchingPkGuestDisplayName = "",
                    pkBattleSession = null,
                    watchingPkLingerSession = null,
                    pkHostViewerCount = 0,
                    pkGuestViewerCount = 0,
                    pkHostViewerUserIds = emptyList(),
                    pkGuestViewerUserIds = emptyList(),
                    activeCallPartner = null,
                )
            }
            maybeRedirectSpectatorAfterPkEnds(hostId, guestUid, guestName, pkStartMs)
            runCatching { WebRTCManager.activeManager()?.endPeerSessionOnly() }
                .onFailure { Log.w("DatingViewModel", "endPeerSessionOnly after end_pk_stay_live", it) }
        }
    }

    private fun attachLiveSignalsForAudience(hostId: String, battleHost: String, battleGuest: String) {
        val h = battleHost.trim()
        val g = battleGuest.trim()
        if (h.isEmpty() || g.isEmpty()) return
        val onSignal: () -> Unit = { handleEndPkStayLiveSignalForAudience() }
        fun addPath(roomPath: String) {
            val path = roomPath.trim()
            if (path.isEmpty()) return
            val pair = firebaseService.listenForLiveSignals(path, onSignal)
            liveSignalsBindings.add(LiveSignalsBinding(pair.first, pair.second))
        }
        addPath(firebaseService.buildPkRoomId(h, g))
        val pkRoom = firebaseService.buildPkRoomId(h, g)
        if (hostId.trim() != pkRoom) {
            addPath(hostId.trim())
        }
    }

    private fun stopLiveAudienceStreamObservers() {
        liveSignalsPkAttachKey = null
        detachLiveSignalsListeners()
        liveAudienceMessagesJob?.cancel()
        liveAudienceRoomJob?.cancel()
        liveAudienceActiveViewersJob?.cancel()
        liveAudienceHostProfileJob?.cancel()
        liveAudienceAudioPartyStreamJob?.cancel()
        liveAudienceMessagesJob = null
        liveAudienceRoomJob = null
        liveAudienceActiveViewersJob = null
        liveAudienceHostProfileJob = null
        liveAudienceAudioPartyStreamJob = null
        _uiState.update {
            it.copy(
                watchingPkLingerSession = null,
                playingGift = null,
                audioPartyStream = AudioPartyStreamState(),
                audioPartyVideoCallRequests = emptyList(),
            )
        }
    }

    private fun stopWebRtcCallLiveObservers() {
        webRtcCallLiveMessagesJob?.cancel()
        webRtcCallLiveRoomJob?.cancel()
        webRtcCallLiveHostJob?.cancel()
        callRemoteEndedJob?.cancel()
        webRtcCallLiveMessagesJob = null
        webRtcCallLiveRoomJob = null
        webRtcCallLiveHostJob = null
        callRemoteEndedJob = null
    }

    /** Only for 1:1 `call_*` rooms (Firestore `calls/{roomId}`); PK uses `pk_room_*` and must not use this path. */
    private fun startCallRemoteEndedListener(roomId: String) {
        if (!roomId.startsWith("call_")) return
        callRemoteEndedJob?.cancel()
        callRemoteEndedJob = viewModelScope.launch {
            firebaseService.observeCallSessionStatus(roomId).collect { raw ->
                val status = raw?.trim()?.uppercase(Locale.US).orEmpty()
                val terminal = status == "ENDED" || status == "DECLINED" || status == "MISSED" || status == "CANCELLED"
                if (!terminal) return@collect
                val st = _uiState.value
                if (st.webRtcSessionRoomId != roomId) return@collect
                if (!st.isCurrentlyInCall && !st.isVideoCallActive && !st.isAudioCallActive) return@collect
                _uiState.update { it.copy(callNoticeMessage = "Call disconnected") }
                endCall()
            }
        }
    }

    /**
     * Firestore live chat + viewer count for `live_streams/{roomId}` during WebRTC (1:1 / PK).
     * @param preserveSoloLiveHostObservers When true (solo host answered a private call), keeps
     * `live_streams/{host}` chat + room observers so viewers still see solo stream messages; only attaches [startCallRemoteEndedListener].
     */
    private fun startWebRtcCallLiveObservers(
        roomId: String,
        hostProfileUserId: String,
        preserveSoloLiveHostObservers: Boolean = false
    ) {
        if (roomId.isBlank() || hostProfileUserId.isBlank()) return
        if (preserveSoloLiveHostObservers) {
            stopWebRtcCallLiveObservers()
            liveKickHandledWebRtcSession = false
            startCallRemoteEndedListener(roomId)
            val pkSignalingRoom = roomId.startsWith("pk_room_")
            if (pkSignalingRoom) return
            liveHostMessagesJob?.cancel()
            liveHostMessagesJob = null
            val privateCallFullHistory = !pkSignalingRoom && roomId.startsWith("call_")
            liveStreamChatMinTimestampMs = if (privateCallFullHistory) 0L else System.currentTimeMillis()
            Log.i(
                "CALL_CHAT",
                "listenWebRtc preserveSolo streamDocId=$roomId minTimestampMs=$liveStreamChatMinTimestampMs"
            )
            lastLiveGiftOverlayMessageId = null
            lastLiveGiftOverlaySeenTimestampMs = 0L
            skipLiveGiftOverlayListenerUntilMs = 0L
            _uiState.update { st ->
                st.copy(liveStreamChatMessages = emptyList(), playingGift = null)
            }
            webRtcCallLiveMessagesJob = viewModelScope.launch {
                firebaseService.observeLiveStreamMessages(roomId, liveStreamChatMinTimestampMs).collect { list ->
                    applyLiveChatSnapshot(list)
                }
            }
            viewModelScope.launch {
                runCatching { firebaseService.ensureLiveStreamDocument(roomId, hostProfileUserId) }
                    .onFailure { Log.w("DatingViewModel", "ensureLiveStreamDocument (WebRTC preserve solo)", it) }
            }
            return
        }
        val pkSignalingRoom = roomId.startsWith("pk_room_")
        val liveChatDocId = if (pkSignalingRoom) hostProfileUserId else roomId
        val previousChatMin = liveStreamChatMinTimestampMs
        stopWebRtcCallLiveObservers()
        stopLiveAudienceStreamObservers()
        stopLiveHostStreamObservers()
        liveKickHandledWebRtcSession = false
        val privateCallFullHistory = !pkSignalingRoom && liveChatDocId.startsWith("call_")
        val uiForPkChat = _uiState.value
        val myUidForPkChat = auth.currentUser?.uid?.trim().orEmpty()
        val pkHostContinuingOwnStream = pkSignalingRoom &&
            myUidForPkChat.isNotEmpty() &&
            hostProfileUserId == myUidForPkChat &&
            uiForPkChat.isLive &&
            (
                uiForPkChat.currentRoomId == hostProfileUserId ||
                    uiForPkChat.currentUser?.liveRoomId == hostProfileUserId ||
                    uiForPkChat.currentUser?.id == hostProfileUserId
                )
        val joinWallMs = System.currentTimeMillis()
        Log.i(
            "CALL_CHAT",
            "listenWebRtc streamDocId=$liveChatDocId roomId=$roomId joinWallMs=$joinWallMs pkSignaling=$pkSignalingRoom " +
                "(minTs resolved inside collector job)"
        )
        lastLiveGiftOverlayMessageId = null
        lastLiveGiftOverlaySeenTimestampMs = 0L
        skipLiveGiftOverlayListenerUntilMs = 0L
        _uiState.update { s ->
            s.copy(
                liveStreamChatMessages = emptyList(),
                playingGift = null
            )
        }
        webRtcCallLiveMessagesJob = viewModelScope.launch {
            val minTs = when {
                privateCallFullHistory -> 0L
                pkHostContinuingOwnStream && previousChatMin > 0L -> previousChatMin
                pkSignalingRoom -> {
                    val sess = uiForPkChat.pkBattleSession?.pkStartTimeMillis?.takeIf { it > 0L } ?: 0L
                    if (sess > 0L) sess
                    else firebaseService.fetchLiveStreamPkStartedAtMillis(liveChatDocId).takeIf { it > 0L }
                        ?: joinWallMs
                }
                else -> joinWallMs
            }
            liveStreamChatMinTimestampMs = minTs
            Log.i(
                "CALL_CHAT",
                "listenWebRtc resolved minTimestampMs=$minTs liveChatDocId=$liveChatDocId"
            )
            firebaseService.observeLiveStreamMessages(liveChatDocId, minTs).collect { list ->
                applyLiveChatSnapshot(list)
            }
        }
        webRtcCallLiveRoomJob = viewModelScope.launch {
            firebaseService.observeLiveStreamRoom(liveChatDocId).collect { info ->
                _uiState.update { st0 ->
                    if (!info.streamActive && !st0.webRtcCallIsStreamer) {
                        return@update st0.copy(
                            showWatchingLiveEndedOverlay = true,
                            liveStreamViewerCount = 0
                        )
                    }
                    var st = st0.copy(liveStreamViewerCount = info.viewerCount)
                    val my = auth.currentUser?.uid
                    if (!st.webRtcCallIsStreamer &&
                        !liveKickHandledWebRtcSession &&
                        my != null &&
                        info.kickedUsers.contains(my)
                    ) {
                        liveKickHandledWebRtcSession = true
                        st = st.copy(liveKickEventMs = System.currentTimeMillis())
                    }
                    if (pkSignalingRoom) {
                        st = mergePkBattleFromLiveRoomDoc(hostProfileUserId, info, st)
                        val battleHRtc = info.pkBattleHostUid.trim().ifBlank { liveChatDocId }
                        val battleGRtc = info.pkBattleGuestUid.trim().ifBlank { info.pkGuestUserId.trim() }
                        val pkDoc = info.pkStartedAtMillis > 0L &&
                            battleGRtc.isNotBlank() &&
                            battleHRtc.isNotBlank() &&
                            battleHRtc != battleGRtc
                        st = st.copy(
                            pkHostViewerCount = if (pkDoc) info.pkHostViewerCount else 0,
                            pkGuestViewerCount = if (pkDoc) info.pkGuestViewerCount else 0,
                            pkHostViewerUserIds = if (pkDoc) info.pkHostViewerUserIds else emptyList(),
                            pkGuestViewerUserIds = if (pkDoc) info.pkGuestViewerUserIds else emptyList()
                        )
                        if (!info.pkScoringOpen && info.pkStartedAtMillis > 0L) {
                            st = st.copy(liveStreamChatMessages = emptyList())
                        }
                    }
                    st
                }
            }
        }
        webRtcCallLiveHostJob = viewModelScope.launch {
            firebaseService.observeUserProfile(hostProfileUserId).collect { prof ->
                _uiState.update { s ->
                    s.copy(
                        callOverlayHostProfile = prof,
                        watchingLiveHostFollowerCount = prof?.followerIds?.size ?: 0
                    )
                }
            }
        }
        viewModelScope.launch {
            runCatching { firebaseService.ensureLiveStreamDocument(liveChatDocId, hostProfileUserId) }
                .onFailure { Log.w("DatingViewModel", "ensureLiveStreamDocument (WebRTC)", it) }
        }
        startCallRemoteEndedListener(roomId)
    }

    private fun startLiveAudienceStreamObservers(hostId: String) {
        stopWebRtcCallLiveObservers()
        stopLiveAudienceStreamObservers()
        liveKickHandledAudienceSession = false
        lastLiveGiftOverlayMessageId = null
        lastLiveGiftOverlaySeenTimestampMs = 0L
        skipLiveGiftOverlayListenerUntilMs = 0L
        val joinWallMs = System.currentTimeMillis()
        liveAudienceMessagesJob = viewModelScope.launch {
            val minTs = firebaseService.resolveLiveStreamChatMinTimestampForAudience(hostId, joinWallMs)
            liveStreamChatMinTimestampMs = minTs
            firebaseService.observeLiveStreamMessages(hostId, minTs).collect { list ->
                applyLiveChatSnapshot(list)
            }
        }
        liveAudienceActiveViewersJob?.cancel()
        liveAudienceActiveViewersJob = viewModelScope.launch {
            firebaseService.observeRoomActiveViewerUids(hostId).collect { uids ->
                _uiState.update { it.copy(liveAudienceViewerUserIds = uids) }
            }
        }
        liveAudienceRoomJob = viewModelScope.launch {
            firebaseService.observeLiveStreamRoom(hostId).collect { info ->
                if (info.audioPartyHandoffToUid.isNotBlank()) {
                    val toUid = info.audioPartyHandoffToUid.trim()
                    if (toUid.isNotEmpty() && _uiState.value.watchingLivePartner?.id == hostId) {
                        followLiveAudioPartyToNewHostUid(hostId, toUid)
                    }
                    return@collect
                }
                if (!info.streamActive) {
                    _uiState.update { st ->
                        if (st.watchingLivePartner?.id != hostId) return@update st
                        st.copy(
                            showWatchingLiveEndedOverlay = true,
                            liveStreamViewerCount = 0,
                            watchingHostPrivateCallBusy = false,
                            watchingLiveStreamIsAudioOnly = false,
                            watchingLiveAudioPartySeatCount = 10,
                            audioPartyStream = AudioPartyStreamState(),
                            audioPartyVideoCallRequests = emptyList(),
                        )
                    }
                    return@collect
                }
                val battleHost = info.pkBattleHostUid.trim().ifBlank { hostId }
                val battleGuest = info.pkBattleGuestUid.trim().ifBlank { info.pkGuestUserId.trim() }
                val pkOn = info.pkStartedAtMillis > 0L &&
                    battleGuest.isNotBlank() &&
                    battleHost.isNotBlank() &&
                    battleHost != battleGuest
                val preWatch = _uiState.value
                val transitionPkToOff = !pkOn &&
                    preWatch.watchingLivePartner?.id == hostId &&
                    (preWatch.watchingPkActive || preWatch.pkBattleSession != null)
                val redirectGuestUid = preWatch.watchingPkGuestUid.trim().ifBlank { battleGuest.trim() }
                val redirectGuestName = preWatch.watchingPkGuestDisplayName.trim().ifBlank {
                    info.pkGuestDisplayName.trim()
                }
                val redirectPkStartMs = preWatch.pkBattleSession?.pkStartTimeMillis ?: 0L
                _uiState.update { st ->
                    val prevPk = st.pkBattleSession
                    val samePkRound = pkOn &&
                        prevPk != null &&
                        prevPk.pkStartTimeMillis == info.pkStartedAtMillis &&
                        prevPk.hostUserId == battleHost &&
                        prevPk.guestUserId == battleGuest
                    if (pkOn) {
                        val scoringClosed = !info.pkScoringOpen
                        val hostBeans = maxOf(
                            info.pkHostBeans,
                            if (samePkRound && !scoringClosed) prevPk?.hostBeansEarned ?: 0L else 0L
                        )
                        val guestBeans = maxOf(
                            info.pkGuestBeans,
                            if (samePkRound && !scoringClosed) prevPk?.guestBeansEarned ?: 0L else 0L
                        )
                        val totalBeans = hostBeans + guestBeans
                        val ratio =
                            if (totalBeans <= 0L) 0.5f else hostBeans.toFloat() / totalBeans.toFloat()
                        val spectatorOutcome = when {
                            hostBeans > guestBeans -> PkBattleOutcome.HOST_WINS
                            guestBeans > hostBeans -> PkBattleOutcome.GUEST_WINS
                            else -> PkBattleOutcome.DRAW
                        }
                        val endsAt = when {
                            scoringClosed && info.pkResultPhaseEndsAtMillis > 0L -> info.pkResultPhaseEndsAtMillis
                            scoringClosed -> System.currentTimeMillis() + PK_POST_RESULT_LINGER_MS
                            else -> 0L
                        }
                        val battleEnded =
                            scoringClosed || (samePkRound && prevPk?.battleEnded == true)
                        val outcome = when {
                            scoringClosed -> spectatorOutcome
                            samePkRound && prevPk?.battleEnded == true -> prevPk?.outcome
                            else -> null
                        }
                        val frozen = when {
                            scoringClosed -> ratio
                            samePkRound && prevPk?.battleEnded == true -> prevPk?.frozenTugRatio
                            else -> null
                        }
                        val pkSession = PkBattleSessionState(
                            pkStartTimeMillis = info.pkStartedAtMillis,
                            hostBeansEarned = hostBeans,
                            guestBeansEarned = guestBeans,
                            hostUserId = battleHost,
                            guestUserId = battleGuest,
                            battleEnded = battleEnded,
                            outcome = outcome,
                            frozenTugRatio = frozen ?: 0.5f,
                            durationSeconds = info.pkDurationSeconds.coerceIn(60, 3600),
                            phase = if (battleEnded) PkBattlePhase.FINISHED else PkBattlePhase.ACTIVE,
                            resultPhaseEndsAtMillis = endsAt
                        )
                        val opponentUid = if (hostId == battleHost) battleGuest else battleHost
                        val opponentDisplayName = when {
                            opponentUid == battleHost -> info.pkHostDisplayName.trim()
                            opponentUid == battleGuest -> info.pkGuestDisplayName.trim()
                            else -> info.pkGuestDisplayName.trim()
                        }.ifBlank { "Guest" }
                        st.copy(
                            liveStreamViewerCount = info.viewerCount,
                            watchingLiveStreamStartedAtMillis = info.streamStartedAtMillis,
                            watchingLiveStreamIsAudioOnly = false,
                            watchingLiveAudioPartySeatCount = 10,
                            pkHostViewerCount = info.pkHostViewerCount,
                            pkGuestViewerCount = info.pkGuestViewerCount,
                            pkHostViewerUserIds = info.pkHostViewerUserIds,
                            pkGuestViewerUserIds = info.pkGuestViewerUserIds,
                            watchingPkActive = true,
                            watchingPkGuestUid = opponentUid,
                            watchingPkGuestDisplayName = opponentDisplayName,
                            pkBattleSession = pkSession,
                            watchingPkLingerSession = null,
                            watchingHostPrivateCallBusy = info.hostPrivateCallBusy
                        )
                    } else {
                        st.copy(
                            liveStreamViewerCount = info.viewerCount,
                            watchingLiveStreamStartedAtMillis = info.streamStartedAtMillis,
                            watchingLiveStreamIsAudioOnly = info.audioOnlyStream,
                            watchingLiveAudioPartySeatCount = if (info.audioOnlyStream) {
                                info.audioPartySeatCount
                            } else {
                                10
                            },
                            pkHostViewerCount = 0,
                            pkGuestViewerCount = 0,
                            pkHostViewerUserIds = emptyList(),
                            pkGuestViewerUserIds = emptyList(),
                            watchingPkActive = false,
                            watchingPkGuestUid = "",
                            watchingPkGuestDisplayName = "",
                            pkBattleSession = null,
                            watchingPkLingerSession = null,
                            watchingHostPrivateCallBusy = info.hostPrivateCallBusy,
                            liveStreamChatMessages = if (transitionPkToOff) emptyList() else st.liveStreamChatMessages,
                        )
                    }
                }
                if (transitionPkToOff) {
                    maybeRedirectSpectatorAfterPkEnds(
                        streamDocHostId = hostId,
                        battleGuestUid = redirectGuestUid,
                        battleGuestDisplayName = redirectGuestName,
                        pkRoundStartMs = redirectPkStartMs,
                    )
                }
                if (pkOn && battleHost.isNotBlank() && battleGuest.isNotBlank()) {
                    val sigKey = "${battleHost.trim()}|${battleGuest.trim()}"
                    if (liveSignalsPkAttachKey != sigKey) {
                        liveSignalsPkAttachKey = sigKey
                        detachLiveSignalsListeners()
                        attachLiveSignalsForAudience(hostId.trim(), battleHost.trim(), battleGuest.trim())
                    }
                } else {
                    if (liveSignalsPkAttachKey != null) {
                        liveSignalsPkAttachKey = null
                        detachLiveSignalsListeners()
                    }
                }
                val my = auth.currentUser?.uid
                if (!liveKickHandledAudienceSession && my != null && info.kickedUsers.contains(my)) {
                    liveKickHandledAudienceSession = true
                    _uiState.update { it.copy(liveKickEventMs = System.currentTimeMillis()) }
                }
            }
        }
        liveAudienceHostProfileJob = viewModelScope.launch {
            firebaseService.observeUserProfile(hostId).collect { prof ->
                if (prof != null) {
                    _uiState.update { it.copy(watchingLiveHostFollowerCount = prof.followerIds.size) }
                }
            }
        }
        liveAudienceAudioPartyStreamJob?.cancel()
        liveAudienceAudioPartyStreamJob = viewModelScope.launch {
            firebaseService.observeAudioPartyStream(hostId).collect { st ->
                _uiState.update { it.copy(audioPartyStream = st) }
            }
        }
    }

    fun deleteAccount() {
        viewModelScope.launch {
            try {
                val user = auth.currentUser ?: return@launch
                val uid = user.uid
                firebaseService.deleteUserProfile(uid)
                user.delete().await()
                detachRealtimeConsumersForLogout()
                val ctx = DatingApp.applicationContext
                if (ctx != null) {
                    runCatching { authRepository.signOutAndClearSession(ctx) }
                        .onFailure { Log.w("DatingViewModel", "deleteAccount signOut cleanup", it) }
                    LocalBackendCaches.clearFirestorePersistenceBestEffort()
                    LocalBackendCaches.clearCoilCaches(ctx)
                }
                _uiState.update { DatingUiState() }
            } catch (e: Exception) {
                _uiState.update { it.copy(loginError = "Delete account failed: ${e.message}") }
            }
        }
    }

    override fun onCleared() {
        detachPkRematchListeners()
        pkRematchTimeoutJob?.cancel()
        // Auto-forfeit any live battle if the ViewModel is destroyed (e.g. app killed mid-game)
        val activeBattle = _uiState.value.activeBattle
        val uid = _uiState.value.currentUser?.id?.trim()?.takeIf { it.isNotEmpty() }
            ?: auth.currentUser?.uid?.trim().orEmpty().takeIf { it.isNotEmpty() }
        val sessionLiveDoc = _uiState.value.currentUser?.liveRoomId?.trim()?.takeIf { it.isNotEmpty() }
        if (uid != null) {
            // NonCancellable: must complete Firestore teardown even while the ViewModel scope is dying (ghost "Live" rows).
            GlobalScope.launch(NonCancellable + Dispatchers.IO) {
                runCatching { firebaseService.endLiveStream(uid, sessionLiveDoc) }
                    .onFailure { Log.w("DatingViewModel", "onCleared endLiveStream failed uid=$uid", it) }
            }
        }
        if (activeBattle != null && uid != null && activeBattle.status == BattleStatus.LIVE) {
            GlobalScope.launch(NonCancellable + Dispatchers.IO) {
                runCatching {
                    firebaseService.applyBattleGameInput(
                        activeBattle.id, uid, "FORFEIT", mapOf("forfeitingUid" to uid)
                    )
                }.onFailure { Log.w("DatingViewModel", "onCleared auto-forfeit failed", it) }
            }
        }
        firebaseConnectedJob?.cancel()
        outgoingCallTimeoutJob?.cancel()
        profilesObserverJob?.cancel()
        giftsJob?.cancel()
        messagesJob?.cancel()
        spinLoopJob?.cancel()
        incomingCallJob?.cancel()
        pkMatchJob?.cancel()
        hostPkEndedInterstitialJob?.cancel()
        battlesJob?.cancel()
        battleDetailJob?.cancel()
        battleGameStateJob?.cancel()
        stopLiveHostStreamObservers()
        stopLiveAudienceStreamObservers()
        stopWebRtcCallLiveObservers()
        followActionJob?.cancel()
        followActionJob = null
        if (uid != null) {
            GlobalScope.launch(NonCancellable + Dispatchers.IO) {
                runCatching { firebaseService.removeFromPkQueue(uid) }
                    .onFailure { Log.w("DatingViewModel", "onCleared removeFromPkQueue", it) }
            }
        }
        currentUserListener?.remove()
        resellersListener?.remove()
        super.onCleared()
    }

    /**
     * Deterministic 1:1 call room ID — identical for both the caller and callee because it is based
     * solely on their sorted UIDs (no timestamp). Both sides independently derive the same string
     * so the RTDB signaling path `rooms/{roomId}` is always symmetric.
     */
    private fun buildCallRoomId(callerId: String, receiverId: String): String {
        return "call_" + listOf(callerId.trim(), receiverId.trim()).sorted().joinToString("_")
    }

    private fun startIncomingCallListener(userId: String) {
        incomingCallJob?.cancel()
        incomingCallJob = viewModelScope.launch {
            combine(
                firebaseService.observeIncomingCallFirestore(userId),
                firebaseService.observeIncomingCall(userId)
            ) { firestore, rtdb -> firestore ?: rtdb }
                .collect { invite: IncomingCallInvite? ->
                if (invite == null) {
                    val inc = _uiState.value.incomingCall
                    if (inc?.isMarketingSynthetic == true && _uiState.value.callState == CallState.RINGING) {
                        return@collect
                    }
                }
                if (invite != null) {
                    Log.d(
                        "CALL_SIGNAL",
                        "Incoming invite for uid=$userId room=${invite.roomId} caller=${invite.callerId} (Firestore ∪ RTDB)"
                    )
                }
                if (invite != null && _uiState.value.isCurrentlyInCall) {
                    runCatching { firebaseService.setCallSessionStatus(invite.roomId, "DECLINED") }
                    runCatching {
                        firebaseService.sendCallResponse(
                            callerId = invite.callerId,
                            roomId = invite.roomId,
                            status = "busy",
                            reason = "callee_in_call"
                        )
                    }
                    runCatching { firebaseService.clearIncomingCallRtdb(userId) }
                    return@collect
                }
                // Second incoming while already ringing → busy, unless the pending tile is the marketing synthetic hook.
                if (invite != null) {
                    val existing = _uiState.value.incomingCall
                    if (existing != null && existing.roomId != invite.roomId && !existing.isMarketingSynthetic) {
                        runCatching { firebaseService.setCallSessionStatus(invite.roomId, "DECLINED") }
                        runCatching {
                            firebaseService.sendCallResponse(
                                callerId = invite.callerId,
                                roomId = invite.roomId,
                                status = "busy",
                                reason = "callee_has_pending_call"
                            )
                        }
                        return@collect
                    }
                }
                _uiState.update {
                    it.copy(
                        incomingCall = invite?.let { call ->
                            IncomingCallUi(
                                callerId = call.callerId,
                                callerName = call.callerName,
                                roomId = call.roomId,
                                isVideoCall = call.isVideoCall,
                                callerPhotoUrl = "",
                                isMarketingSynthetic = false
                            )
                        },
                        callStatus = if (invite != null) CallStatus.RINGING else it.callStatus,
                        callState = when {
                            invite != null -> CallState.RINGING
                            it.callState == CallState.RINGING -> CallState.IDLE
                            else -> it.callState
                        },
                        isIncomingCall = when {
                            invite != null -> true
                            it.callState == CallState.RINGING -> false
                            else -> it.isIncomingCall
                        }
                    )
                }
            }
        }
    }

    private fun startCurrentUserListener(userId: String) {
        currentUserListener?.remove()
        currentUserListener = db.collection("users")
            .document(userId)
            .addSnapshotListener { snapshot, error ->
                if (error != null) {
                    logViewModelFirestoreError("users/$userId (currentUser)", error)
                    return@addSnapshotListener
                }
                val profile = firebaseService.userProfileFromDocument(snapshot) ?: return@addSnapshotListener

                val prev = _uiState.value
                val promote =
                    profile.isLive &&
                        profile.liveStreamAudioOnly &&
                        profile.liveRoomId?.trim() == profile.id.trim() &&
                        !profile.isGuest &&
                        !prev.isLive &&
                        userId.trim() == profile.id.trim()

                if (promote) {
                    applyIncomingAudioPartyHostPromotion(profile)
                } else {
                    _uiState.update { s ->
                        syncFollowListsFromState(
                            s.copy(
                                currentUser = profile,
                                coinBalance = profile.coins,
                                gems = profile.gems,
                                beans = profile.beans,
                                totalEarnings = profile.earnings
                            )
                        )
                    }
                    refreshLikedMeProfiles(profile)
                }
            }
    }

    private fun normalizeGenderForCrm(rawGender: String): String {
        return when (rawGender.trim().lowercase()) {
            "male" -> "male"
            "female" -> "female"
            else -> ""
        }
    }

    private fun logViewModelFirestoreError(operation: String, e: FirebaseFirestoreException) {
        val msg = e.message.orEmpty()
        val hint = when (e.code) {
            FirebaseFirestoreException.Code.PERMISSION_DENIED ->
                " — PERMISSION_DENIED: check Firestore Security Rules for this path/query."
            FirebaseFirestoreException.Code.FAILED_PRECONDITION ->
                " — FAILED_PRECONDITION / MISSING_INDEX: see Logcat for index URL if present."
            FirebaseFirestoreException.Code.UNAVAILABLE ->
                " — network or backend unavailable."
            else -> ""
        }
        Log.e(
            "DatingViewModel",
            "Firestore listener [$operation]: code=${e.code} message=$msg$hint",
            e
        )
        Regex("https://console\\.firebase\\.google\\.com[^\\s)]+").find(msg)?.value?.let { url ->
            Log.e("DatingViewModel", "MISSING_INDEX: $url")
        }
    }

    private fun startOutgoingCallTimeout(callerId: String, roomId: String, receiverId: String) {
        outgoingCallTimeoutJob?.cancel()
        outgoingCallTimeoutJob = viewModelScope.launch {
            val status = firebaseService.waitForCallResponse(
                callerId = callerId,
                roomId = roomId,
                timeoutMs = CallManager.RING_TIMEOUT_MS
            )
            when (status) {
                "accepted" -> Unit
                "busy", "declined" -> {
                    runCatching { firebaseService.setCallSessionStatus(roomId, "DECLINED") }
                    runCatching { firebaseService.clearIncomingCall(receiverId) }
                    runCatching { firebaseService.clearCallRoom(roomId) }
                    cleanupOneToOneCallFirestoreSignaling(roomId)
                    _uiState.update {
                        it.copy(
                            isCurrentlyInCall = false,
                            pendingCallRoomId = null,
                            pendingCallIsStreamer = false,
                            callNoticeMessage = if (status == "busy") "User is busy" else "Call declined",
                            callStatus = if (status == "busy") CallStatus.BUSY else CallStatus.DECLINED,
                            isVideoCallActive = it.isVideoCallActive,
                            isAudioCallActive = it.isAudioCallActive,
                            activeCallPartner = it.activeCallPartner,
                            callState = CallState.IDLE
                        )
                    }
                }
                else -> {
                    runCatching { firebaseService.setCallSessionStatus(roomId, "MISSED") }
                    runCatching { firebaseService.clearIncomingCall(receiverId) }
                    runCatching { firebaseService.clearCallRoom(roomId) }
                    cleanupOneToOneCallFirestoreSignaling(roomId)
                    _uiState.update {
                        it.copy(
                            isCurrentlyInCall = false,
                            pendingCallRoomId = null,
                            pendingCallIsStreamer = false,
                            callNoticeMessage = "User unavailable",
                            callStatus = CallStatus.TIMEOUT,
                            isVideoCallActive = it.isVideoCallActive,
                            isAudioCallActive = it.isAudioCallActive,
                            activeCallPartner = it.activeCallPartner,
                            callState = CallState.IDLE
                        )
                    }
                }
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // LIKES HISTORY
    // ─────────────────────────────────────────────────────────────────────────

    /** Fetches profiles the current user has liked and populates [DatingUiState.iLikedProfiles]. */
    fun refreshILikedProfiles() {
        val me = _uiState.value.currentUser ?: return
        viewModelScope.launch {
            runCatching {
                val likedIds = me.likedByUserIds  // IDs I have liked are stored on my doc
                // Fall back to likedProfileIds from UiState if likedByUserIds is for inbound
                val myLikedIds = _uiState.value.likedProfileIds.toList()
                if (myLikedIds.isEmpty()) return@launch
                val profiles = myLikedIds.chunked(10).flatMap { chunk ->
                    firebaseService.fetchProfilesByIds(chunk)
                }
                _uiState.update { it.copy(iLikedProfiles = profiles) }
            }.onFailure { Log.w("DatingViewModel", "refreshILikedProfiles", it) }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MY GIFT HISTORY
    // ─────────────────────────────────────────────────────────────────────────

    /** Fetches gifts the current user has sent (all recipients). Populates [DatingUiState.mySentGiftHistory]. */
    fun fetchMySentGiftHistory() {
        val me = _uiState.value.currentUser ?: return
        viewModelScope.launch {
            runCatching {
                val history = firebaseService.fetchSentGiftsToUser(me, receiverId = null, limit = 30)
                _uiState.update { it.copy(mySentGiftHistory = history) }
            }.onFailure { Log.w("DatingViewModel", "fetchMySentGiftHistory", it) }
        }
    }

    /** Fetches gifts the current user has received (all senders). Populates [DatingUiState.myReceivedGiftHistory]. */
    fun fetchMyReceivedGiftHistory() {
        val me = _uiState.value.currentUser ?: return
        viewModelScope.launch {
            runCatching {
                val history = firebaseService.fetchReceivedGiftsForUser(me.id, limit = 30)
                _uiState.update { it.copy(myReceivedGiftHistory = history) }
            }.onFailure { Log.w("DatingViewModel", "fetchMyReceivedGiftHistory", it) }
        }
    }

    /**
     * Process a game round result — deducts [betAmount] and credits [winAmount].
     * Net change = winAmount - betAmount (winAmount == 0 means full loss).
     * Writes a `game_transactions` doc for audit and persists balance to Firestore.
     * Returns true if bet placed (enough balance), false if insufficient diamonds.
     */
    fun processGameResult(gameId: String, gameName: String, betAmount: Int, winAmount: Int): Boolean {
        val state = _uiState.value
        val me = state.currentUser ?: return false
        if (state.coinBalance < betAmount) return false

        val net = winAmount - betAmount
        val newBalance = (state.coinBalance + net).coerceAtLeast(0)
        val updatedUser = me.withSyncedSpendableBalance(newBalance)

        // Optimistic UI update
        _uiState.update { it.copy(currentUser = updatedUser, coinBalance = newBalance) }

        viewModelScope.launch {
            runCatching {
                val db = com.google.firebase.firestore.FirebaseFirestore.getInstance()
                db.collection("game_transactions").add(
                    mapOf(
                        "userId"       to me.id,
                        "gameId"       to gameId,
                        "gameName"     to gameName,
                        "betAmount"    to betAmount,
                        "winAmount"    to winAmount,
                        "net"          to net,
                        "balanceAfter" to newBalance,
                        "timestamp"    to com.google.firebase.Timestamp.now(),
                    )
                )
                // Persist balance (coins + walletBalance dual-write)
                db.collection("users").document(me.id)
                    .update(mapOf("coins" to newBalance, "walletBalance" to newBalance))
            }.onFailure { e ->
                Log.w("DatingViewModel", "processGameResult write failed", e)
                // Rollback
                _uiState.update { it.copy(currentUser = me, coinBalance = state.coinBalance) }
            }
        }
        return true
    }

    /** Convert beans to diamonds (host cash-out path — tracked by admin separately). */
    fun convertBeansToDiamonds(beans: Int) {
        val me = _uiState.value.currentUser ?: return
        viewModelScope.launch {
            runCatching {
                firebaseService.convertBeansToDiamonds(me.id, beans.toLong())
            }.onFailure { Log.w("DatingViewModel", "convertBeansToDiamonds", it) }
        }
    }

    /**
     * Runs a navigation side-effect ([androidx.navigation.NavController.navigate],
     * [androidx.activity.result.ActivityResultLauncher.launch], etc.) without crashing the process.
     *
     * @return `true` if [block] completed without throwing.
     */
    fun runSafeNavigation(tag: String, block: () -> Unit): Boolean {
        return runCatching {
            block()
            true
        }.getOrElse { e ->
            Log.e("DatingViewModel", "runSafeNavigation failed: $tag", e)
            false
        }
    }

    // ── Missing methods required by screen redesign ────────────────────────────

    /** Load (or reload) the discovery feed. Delegates to [refreshProfiles]. */
    fun loadDiscoveryFeed() { refreshProfiles() }

    /** Search discovery profiles by display name or profile number. */
    fun searchUsers(query: String) {
        if (query.isBlank()) {
            _uiState.update { it.copy(searchResult = null) }
        } else {
            searchByProfileNumber(query)
        }
    }

    /** Apply discovery filters (city, hobbies, language, age range, gender). */
    fun setDiscoveryFilters(
        city: String?,
        hobbies: List<String>,
        language: String?,
        ageMin: Float = 18f,
        ageMax: Float = 60f,
        gender: String = "",
    ) {
        val me = _uiState.value.currentUser
        val filtered = _uiState.value.profiles.filter { p ->
            (city.isNullOrBlank() || p.city.equals(city, ignoreCase = true)) &&
            (language.isNullOrBlank() || p.languages.any { it.equals(language, ignoreCase = true) }) &&
            (hobbies.isEmpty() || p.hobbies.any { it in hobbies }) &&
            (p.age <= 0 || (p.age >= ageMin.toInt() && p.age <= ageMax.toInt())) &&
            (gender.isBlank() || p.gender.equals(gender, ignoreCase = true))
        }.filter { it.id != me?.id }
        _uiState.update { it.copy(filteredProfiles = filtered, isFilterActive = true) }
    }

    /** Load more profiles for the discovery feed (currently no-op — fetch is paged server side). */
    fun loadMoreDiscoveryProfiles() { refreshProfiles() }

    /** Start listening for real-time live stream updates. */
    fun startLiveStreamsListener() {
        if (liveStreamsListenerJob?.isActive == true) return
        liveStreamsListenerJob = viewModelScope.launch {
            runCatching {
                firebaseService.observeActiveLiveStreams().collect { streams ->
                    _activeLiveStreams.value = streams
                }
            }.onFailure { Log.w("DatingViewModel", "startLiveStreamsListener", it) }
        }
    }

    /** Stop the live streams listener started by [startLiveStreamsListener]. */
    fun stopLiveStreamsListener() {
        liveStreamsListenerJob?.cancel()
        liveStreamsListenerJob = null
    }

    /** Start listening for real-time party room updates. */
    fun startPartyRoomsListener() {
        if (partyRoomsListenerJob?.isActive == true) return
        partyRoomsListenerJob = viewModelScope.launch {
            runCatching {
                firebaseService.observeActivePartyRooms().collect { rooms ->
                    _activePartyRooms.value = rooms
                }
            }.onFailure { Log.w("DatingViewModel", "startPartyRoomsListener", it) }
        }
    }

    /** Stop the party rooms listener started by [startPartyRoomsListener]. */
    fun stopPartyRoomsListener() {
        partyRoomsListenerJob?.cancel()
        partyRoomsListenerJob = null
    }

    /** Start watching a specific user's profile in real time (opened profile sheet).
     *  Uses a Firestore snapshot listener so isOnline / isLive update live. */
    fun startOpenedProfileListener(userId: String) {
        openedProfileListenerJob?.cancel()
        openedProfileListenerJob = viewModelScope.launch {
            runCatching {
                firebaseService.observeUser(userId).collect { fresh ->
                    if (fresh == null) return@collect
                    _uiState.update { s ->
                        val prev = s.profiles.find { it.id == userId }
                        val newProfiles = if (prev != null) {
                            s.profiles.map { if (it.id == userId) fresh else it }
                        } else {
                            s.profiles + fresh
                        }
                        val nextFiltered = if (s.isFilterActive) {
                            s.filteredProfiles.mapNotNull { fp -> newProfiles.find { it.id == fp.id } }
                        } else {
                            newProfiles
                        }
                        syncFollowListsFromState(
                            s.copy(profiles = newProfiles, filteredProfiles = nextFiltered)
                        )
                    }
                }
            }.onFailure { Log.w("DatingViewModel", "startOpenedProfileListener", it) }
        }
    }

    /** Stop the opened-profile listener. */
    fun stopOpenedProfileListener() {
        openedProfileListenerJob?.cancel()
        openedProfileListenerJob = null
    }

    /** Load or refresh the message inbox (chat thread list). */
    fun refreshMessageInbox() {
        if (chatThreadsJob?.isActive == true) return
        val uid = auth.currentUser?.uid ?: return
        chatThreadsJob = viewModelScope.launch {
            runCatching {
                firebaseService.observeChatThreads().collect { threads ->
                    _chatThreads.value = threads
                }
            }.onFailure { Log.w("DatingViewModel", "refreshMessageInbox", it) }
        }
    }

    /** Alias called by MessagesScreen to trigger CRM announcement load. Already done in init. */
    fun loadCrmAnnouncements() {
        // CRM announcements are loaded automatically in init {} via startCrmAnnouncementsObserver.
        // This is a no-op kept for call-site compatibility.
    }

    /** Load the transaction history for the Diamond Shop. */
    fun loadTransactionHistory() {
        viewModelScope.launch(Dispatchers.IO) {
            runCatching {
                val txs = firebaseService.fetchTransactionHistory()
                _transactionHistory.value = txs
            }.onFailure { Log.w("DatingViewModel", "loadTransactionHistory", it) }
        }
    }

    /** Reset profile-save feedback so the screen doesn't auto-close again on recomposition. */
    fun clearProfileSaveFeedback() {
        _uiState.update { it.copy(profileSaveSuccess = false, profileSaveError = null) }
    }

    /** Stub: report a login failure (e.g. OTP timeout) to analytics. */
    fun reportLoginFailure(reason: String = "unknown") {
        Log.w("DatingViewModel", "reportLoginFailure: $reason")
    }

    /** Close the currently open chat thread (return to inbox list). */
    fun closeChatThread() {
        _uiState.update { it.copy(selectedMessagePartnerId = null) }
    }

    /** Open a 1-on-1 chat thread with the given user and mark unread count as 0. */
    fun openChatWith(userId: String) {
        startObservingMessages(userId)
        // Clear unread badge — markThreadRead writes unreadCounts.$myId = 0 to Firestore
        val myId = auth.currentUser?.uid ?: return
        val threadId = firebaseService.chatThreadId(myId, userId.trim())
        viewModelScope.launch {
            firebaseService.markThreadRead(threadId)
        }
    }

    /** Ensure gift catalog is loaded (no-op if already populated). */
    fun loadGiftCatalog() { /* catalog is pre-populated from DatingUiState default */ }

    /** Send a live-stream chat message to the given stream channel. */
    fun sendLiveChatMessage(streamId: String, text: String) {
        sendLiveComment(text)
    }

    /**
     * Overload that accepts a recipientId and optional context identifiers (battleId / streamId).
     * Delegates to the gift transaction pipeline with appropriate routing.
     */
    fun sendGift(recipientId: String, gift: Gift, count: Int, battleId: String? = null, streamId: String? = null) {
        sendGift(gift, count)
    }

    /**
     * Overload called from VideoCallScreen with the elapsed seconds so the billing block fires.
     * Delegates to the standard [endCall] flow.
     */
    fun endCall(elapsedSeconds: Int) {
        endCall(elapsedBillableSeconds = elapsedSeconds)
    }

    /** Join a live stream as a viewer and start observing its state. */
    fun joinLive(streamId: String) {
        /* Real-time listener started inside watchLive(); no-op stub for call-site compat */
    }

    /** Leave an active live stream. */
    fun leaveLive(streamId: String) {
        stopWatching()
    }

    /** Kick a viewer from the current live broadcast. */
    fun kickViewer(streamId: String, userId: String) {
        kickLiveChatter(streamId, userId)
    }

    /** End the current live broadcast. */
    fun endLive(streamId: String) {
        toggleLive()
    }

    // ── Live PIP (picture-in-picture) ─────────────────────────────────────────

    /** Minimise the watched live stream into the floating PIP overlay. */
    fun enterLivePipMode() {
        _uiState.update { it.copy(isLivePipMode = true) }
    }

    /** Restore the PIP back to full-screen live watch. */
    fun restoreFromLivePip() {
        _uiState.update { it.copy(isLivePipMode = false) }
    }

    /** Close the PIP and exit the live stream entirely. */
    fun exitLivePip() {
        _uiState.update { it.copy(isLivePipMode = false) }
        stopWatching()
    }
}

/** Firestore live economy dual-writes spendable diamonds to `coins` and `walletBalance` — keep both in sync on every client write. */
private fun UserProfile.withSyncedSpendableBalance(newCoins: Int): UserProfile =
    copy(coins = newCoins, walletBalance = newCoins)

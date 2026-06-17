package com.zipper.datingapp

import android.Manifest
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.view.WindowManager
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.activity.compose.BackHandler
import androidx.activity.enableEdgeToEdge
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import coil.compose.AsyncImage
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.zIndex
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.DialogProperties
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.os.LocaleListCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import com.zipper.datingapp.auth.checkAccess
import com.zipper.datingapp.security.BanManager
import com.zipper.datingapp.security.DeviceTracker
import com.zipper.datingapp.ui.screens.DeviceBanScreen
import com.zipper.datingapp.ui.DatingViewModel
import com.zipper.datingapp.ui.components.GlobalLivePip
import com.zipper.datingapp.ui.components.FuturisticConfirmCloseDialog
import com.zipper.datingapp.ui.components.GiftAssetPreloader
import com.zipper.datingapp.ui.components.GiftOverlay
import com.zipper.datingapp.ui.media.GiftSoundPlayback
import com.zipper.datingapp.ui.components.MainBottomNavigation
import com.zipper.datingapp.ui.components.MainNavigationRail
import com.zipper.datingapp.ui.screens.*
import com.zipper.datingapp.ui.theme.AppWindowWidthClass
import com.zipper.datingapp.ui.theme.DatingAppTheme
import com.zipper.datingapp.ui.theme.LocalWindowWidthClass
import com.zipper.datingapp.ui.theme.OutlineDefault
import com.zipper.datingapp.ui.theme.toWindowWidthClass
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.firebase.FirebaseApp
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.datingapp.service.CallFirebaseMessagingService
import com.zipper.datingapp.service.LiveTaskCleanupService
import com.zipper.datingapp.call.CallSoundManager
import com.zipper.datingapp.call.CallStatus
import com.zipper.datingapp.data.AppLanguage
import com.zipper.datingapp.data.CallState
import com.zipper.datingapp.data.VerificationStatus
import com.zipper.datingapp.data.preferences.AppPreferencesRepository
import com.zipper.datingapp.data.preferences.ThemeModePreference
import com.zipper.datingapp.webrtc.WebRTCManager

private const val MIN_TOTAL_RAM_BYTES_FOR_AR = 3L * 1024L * 1024L * 1024L

/**
 * Whether Snap Camera Kit should drive local video (disabled on low-RAM / under-3GB devices).
 */
fun isDeviceCapableOfAR(context: Context): Boolean {
    val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return false
    if (am.isLowRamDevice) return false
    val mi = ActivityManager.MemoryInfo()
    am.getMemoryInfo(mi)
    if (mi.totalMem < MIN_TOTAL_RAM_BYTES_FOR_AR) return false
    return true
}

private fun Context.hasAllRuntimeOnboardingPermissions(): Boolean {
    val cam = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
    val mic = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    val loc = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
    val notif =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
    return cam && mic && loc && notif
}

private fun runtimeOnboardingPermissionArray(): Array<String> {
    val list = mutableListOf(
        Manifest.permission.CAMERA,
        Manifest.permission.RECORD_AUDIO,
        Manifest.permission.ACCESS_COARSE_LOCATION,
    )
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        list.add(Manifest.permission.POST_NOTIFICATIONS)
    }
    return list.toTypedArray()
}

class MainActivity : AppCompatActivity() {
    private val viewModel: DatingViewModel by viewModels()

    /**
     * Lock the app's font scale to 1.0 regardless of the system accessibility setting.
     * Without this, increasing "Font size" in Android Settings stretches every `sp` value
     * in Compose and breaks the UI on every screen size.
     */
    override fun attachBaseContext(newBase: Context) {
        val config = android.content.res.Configuration(newBase.resources.configuration)
        config.fontScale = 1f
        super.attachBaseContext(newBase.createConfigurationContext(config))
    }

    /**
     * Holds the latest notification-tap intent so the Compose UI can react to it.
     * Updated from [onCreate] (cold-start) and [onNewIntent] (app is foreground/singleTop).
     */
    internal val notifIntentState = mutableStateOf<Intent?>(null)

    /** Process-wide: ON_START / ON_STOP so presence flips when the app is backgrounded or swiped away. */
    private val processLifecycleObserver = LifecycleEventObserver { _, event ->
        when (event) {
            Lifecycle.Event.ON_START -> viewModel.markUserOnline()
            Lifecycle.Event.ON_STOP -> viewModel.markUserOffline()
            else -> Unit
        }
    }

    override fun onStart() {
        super.onStart()
        // ProcessLifecycleOwner may have already been STARTED before we registered the observer;
        // also covers login after cold start. Re-assert presence when any Activity is visible.
        if (FirebaseAuth.getInstance().currentUser != null) {
            viewModel.markUserOnline()
        }
    }

    override fun onResume() {
        super.onResume()
        viewModel.refreshCurrentUserFromFirestoreIfLoggedIn()
        viewModel.tryUpdateRegionFromLastKnownLocation(this)
    }

    /**
     * One-shot startup diagnostics for QA / production Logcat filtering (`APP_HEALTH`).
     * Runs Firebase / Firestore init off the main thread so cold start does not worsen jank or ANRs.
     */
    private fun logStartupHealthAsync() {
        lifecycleScope.launch(Dispatchers.Default) {
            val authStatus = runCatching {
                val auth = FirebaseAuth.getInstance()
                when {
                    auth.currentUser != null -> "OK(session)"
                    else -> "OK(no_session)"
                }
            }.getOrElse { "FAIL(${it.javaClass.simpleName})" }

            val firebaseStatus = runCatching {
                FirebaseApp.getInstance()
                FirebaseFirestore.getInstance()
                "OK"
            }.getOrElse { "FAIL(${it.javaClass.simpleName})" }

            val (locStatus, coarseGranted, stateStatus) = withContext(Dispatchers.Main.immediate) {
                val loc = when (
                    val code = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(this@MainActivity)
                ) {
                    ConnectionResult.SUCCESS -> "OK"
                    else -> "DEGRADED(code=$code)"
                }
                val coarse = ContextCompat.checkSelfPermission(
                    this@MainActivity,
                    Manifest.permission.ACCESS_COARSE_LOCATION
                ) == PackageManager.PERMISSION_GRANTED
                val st = runCatching {
                    val s = viewModel.uiState.value
                    "OK(loggedIn=${s.isLoggedIn},profiles=${s.profiles.size})"
                }.getOrElse { "FAIL(${it.javaClass.simpleName})" }
                Triple(loc, coarse, st)
            }

            Log.d(
                "APP_HEALTH",
                "Auth: $authStatus | Firebase: $firebaseStatus | Location: $locStatus | CoarseLocGranted: $coarseGranted | State: $stateStatus"
            )
        }
    }

    @OptIn(ExperimentalMaterial3Api::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        val splashScreen = installSplashScreen()
        splashScreen.setKeepOnScreenCondition {
            val s = viewModel.uiState.value
            !s.isAuthBootstrapComplete && !s.splashHoldTimedOut
        }
        super.onCreate(savedInstanceState)
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
        // Prevent OS-level screenshots and screen recording; keep display awake while the app is in use (incl. embedded video calls).
        window.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE or WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
            WindowManager.LayoutParams.FLAG_SECURE or WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
        )
        logStartupHealthAsync()
        enableEdgeToEdge()
        ProcessLifecycleOwner.get().lifecycle.addObserver(processLifecycleObserver)
        runCatching {
            startService(Intent(this, LiveTaskCleanupService::class.java))
        }.onFailure { Log.w("MainActivity", "start LiveTaskCleanupService", it) }
        // Prime the notification intent state for cold-start deep-links
        if (intent?.action?.startsWith("com.zipper.datingapp.action.") == true) {
            notifIntentState.value = intent
        }
        setContent {
            val prefs = remember { AppPreferencesRepository(this@MainActivity) }
            val themeMode by prefs.themeMode.collectAsStateWithLifecycle(ThemeModePreference.DARK)
            val systemDark = isSystemInDarkTheme()
            val darkTheme = when (themeMode) {
                ThemeModePreference.LIGHT -> false
                ThemeModePreference.DARK -> true
                ThemeModePreference.SYSTEM -> systemDark
            }
            val scope = rememberCoroutineScope()
            DatingAppTheme(darkTheme = darkTheme) {
                val uiState by viewModel.uiState.collectAsStateWithLifecycle()
                val onboardingComplete by prefs.runtimePermissionsOnboardingComplete.collectAsStateWithLifecycle(
                    initialValue = false,
                )
                LaunchedEffect(Unit) {
                    val code = runCatching { prefs.appLanguageCode.first() }.getOrDefault(AppLanguage.ENGLISH.code)
                    viewModel.applyStoredLanguageCode(code)
                    AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags(code))
                }

                // ── Device ban check — runs once at app start ────────────────
                var deviceBanInfo by remember { mutableStateOf<com.zipper.datingapp.security.DeviceBanInfo?>(null) }
                LaunchedEffect(Unit) {
                    val ban = DeviceTracker.checkDeviceBan(this@MainActivity)
                    if (ban != null) deviceBanInfo = ban
                }
                if (deviceBanInfo != null) {
                    DeviceBanScreen(banInfo = deviceBanInfo!!)
                    return@DatingAppTheme
                }

                // ── Single-device session — register on login, kick on duplicate ──
                var activeSessionId by remember { mutableStateOf<String?>(null) }
                LaunchedEffect(uiState.isLoggedIn, uiState.currentUser?.id) {
                    val uid = uiState.currentUser?.id ?: return@LaunchedEffect
                    if (!uiState.isLoggedIn) return@LaunchedEffect
                    try {
                        // Register this login; any prior device gets signed out automatically
                        val sessionId = DeviceTracker.registerNewSession(this@MainActivity, uid)
                        activeSessionId = sessionId
                        // Listen: if another device logs in, sign this one out
                        DeviceTracker.startSessionListener(uid, sessionId) {
                            viewModel.logout(this@MainActivity)
                        }
                    } catch (e: Exception) {
                        android.util.Log.w("MainActivity", "Session registration failed (non-fatal): ${e.message}")
                    }
                }

                // ── Login suspension check — show remaining time if suspended ──
                LaunchedEffect(uiState.isLoggedIn, uiState.currentUser?.id) {
                    val uid = uiState.currentUser?.id ?: return@LaunchedEffect
                    if (!uiState.isLoggedIn) return@LaunchedEffect
                    val suspension = BanManager.checkLoginSuspension(uid)
                    if (suspension != null) {
                        android.widget.Toast.makeText(
                            this@MainActivity,
                            "Account suspended: ${suspension.remainingHours}h ${suspension.remainingMinutes}m remaining",
                            android.widget.Toast.LENGTH_LONG
                        ).show()
                        viewModel.logout(this@MainActivity)
                    }
                }
                LaunchedEffect(
                    uiState.isLoggedIn,
                    uiState.isAuthBootstrapComplete,
                    uiState.isGuest,
                    onboardingComplete,
                ) {
                    if (!uiState.isLoggedIn || !uiState.isAuthBootstrapComplete || uiState.isGuest) return@LaunchedEffect
                    if (onboardingComplete) return@LaunchedEffect
                    if (this@MainActivity.hasAllRuntimeOnboardingPermissions()) {
                        prefs.setRuntimePermissionsOnboardingComplete(true)
                    }
                }
                var showFaceVerification by remember { mutableStateOf(false) }
                var showEditProfile by remember { mutableStateOf(false) }
                // Auto-open EditProfile the first time a brand-new user logs in (so they can set name/DOB/photo)
                LaunchedEffect(uiState.isNewUserSetupNeeded) {
                    if (uiState.isNewUserSetupNeeded && uiState.currentUser != null) {
                        showEditProfile = true
                        viewModel.clearNewUserSetupFlag()
                    }
                }
                var showCreateBattle by remember { mutableStateOf(false) }
                var showGameCenter by remember { mutableStateOf(false) }
                var showDiamondShop by remember { mutableStateOf(false) }
                var showCustomPriceDialog by remember { mutableStateOf(false) }
                var showLoginRequiredSheet by rememberSaveable { mutableStateOf(false) }
                var pendingActionAfterUpload by remember { mutableStateOf<(() -> Unit)?>(null) }
                var showWelcomeSheet by rememberSaveable { mutableStateOf(false) }
                var welcomeHandledThisSession by rememberSaveable { mutableStateOf(false) }
                var showTeaserPaywall by rememberSaveable { mutableStateOf(false) }
                val snackbarHostState = remember { SnackbarHostState() }
                
                val context = LocalContext.current
                LaunchedEffect(uiState.liveGiftMessage) {
                    val msg = uiState.liveGiftMessage
                    if (!msg.isNullOrBlank()) {
                        Toast.makeText(context, msg, Toast.LENGTH_LONG).show()
                        viewModel.clearLiveGiftMessage()
                    }
                }
                LaunchedEffect(uiState.loginError, uiState.isLoggedIn) {
                    val err = uiState.loginError ?: return@LaunchedEffect
                    if (!uiState.isLoggedIn) return@LaunchedEffect
                    if (err.isNotBlank()) {
                        Toast.makeText(context, err, Toast.LENGTH_LONG).show()
                        viewModel.clearLoginError()
                    }
                }
                LaunchedEffect(uiState.giftSoundNonce) {
                    if (uiState.giftSoundNonce > 0L) {
                        val gift = uiState.playingGift
                        // CRM / video gifts carry their own audio track handled by ExoPlayer
                        // inside GiftOverlay — skip the generic notification sound to avoid clash.
                        val hasOwnAudio = gift?.soundUrl?.isNotBlank() == true
                            || gift?.videoUrl?.isNotBlank() == true
                        if (!hasOwnAudio) {
                            GiftSoundPlayback.playGiftSuccessSound(context)
                        }
                    }
                }

                // Coarse location: requested in one-time permission primer; sync region when granted after primer completes.
                LaunchedEffect(uiState.isLoggedIn, uiState.isGuest, onboardingComplete) {
                    if (!uiState.isLoggedIn || uiState.isGuest) return@LaunchedEffect
                    if (!onboardingComplete) return@LaunchedEffect
                    if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION)
                        == PackageManager.PERMISSION_GRANTED
                    ) {
                        viewModel.tryUpdateRegionFromLastKnownLocation(context)
                    }
                }

                // Notification deep-link: handle intents from FCM taps (both cold-start and singleTop).
                val latestIntent by notifIntentState
                LaunchedEffect(latestIntent) {
                    val intent = latestIntent ?: return@LaunchedEffect
                    when (intent.action) {
                        "com.zipper.datingapp.action.OPEN_INCOMING_CALL" -> {
                            val callerId = intent.getStringExtra(com.zipper.datingapp.service.CallFirebaseMessagingService.EXTRA_CALLER_ID) ?: return@LaunchedEffect
                            val roomId = intent.getStringExtra(com.zipper.datingapp.service.CallFirebaseMessagingService.EXTRA_ROOM_ID)
                            val callerName = intent.getStringExtra(com.zipper.datingapp.service.CallFirebaseMessagingService.EXTRA_CALLER_NAME)
                            val isVideo = intent.getBooleanExtra(
                                com.zipper.datingapp.service.CallFirebaseMessagingService.EXTRA_IS_VIDEO_CALL,
                                true
                            )
                            viewModel.handleIncomingCallFromNotification(
                                callerId = callerId,
                                roomId = roomId,
                                isVideoCall = isVideo,
                                callerName = callerName
                            )
                        }
                        "com.zipper.datingapp.action.OPEN_MESSAGES" -> {
                            val senderId = intent.getStringExtra(CallFirebaseMessagingService.EXTRA_SENDER_ID) ?: return@LaunchedEffect
                            viewModel.openDirectMessage(senderId)
                        }
                        "com.zipper.datingapp.action.DECLINE_CALL" -> {
                            val roomId = intent.getStringExtra(CallFirebaseMessagingService.EXTRA_ROOM_ID) ?: return@LaunchedEffect
                            val callerId = intent.getStringExtra(CallFirebaseMessagingService.EXTRA_CALLER_ID) ?: return@LaunchedEffect
                            NotificationManagerCompat.from(context).cancel(CallFirebaseMessagingService.NOTIF_INCOMING_CALL)
                            viewModel.declineCallFromNotification(callerId, roomId)
                        }
                        "com.zipper.datingapp.action.OPEN_LIVE" -> {
                            val hostId = intent.getStringExtra(com.zipper.datingapp.service.CallFirebaseMessagingService.EXTRA_HOST_ID) ?: return@LaunchedEffect
                            viewModel.watchLiveByHostId(hostId)
                        }
                        CallFirebaseMessagingService.ACTION_OPEN_AUDIO_PARTY_LOBBY -> {
                            viewModel.openAudioPartyLobbyFromDeepLink()
                        }
                    }
                    notifIntentState.value = null // consume so it doesn't replay on recompose
                }

                val incomingRingKey = uiState.incomingCall?.roomId
                DisposableEffect(incomingRingKey) {
                    if (incomingRingKey != null) {
                        CallSoundManager.startIncomingRingtone(context.applicationContext)
                    }
                    onDispose {
                        CallSoundManager.stopIncomingRingtone()
                    }
                }

                LaunchedEffect(uiState.callState, uiState.callStatus) {
                    if (uiState.callState == CallState.ACTIVE || uiState.callStatus == CallStatus.CONNECTED) {
                        CallSoundManager.stopAll()
                    }
                }
                LaunchedEffect(uiState.liveKickEventMs) {
                    if (uiState.liveKickEventMs <= 0L) return@LaunchedEffect
                    Toast.makeText(
                        context,
                        context.getString(R.string.live_kicked_by_host_toast),
                        Toast.LENGTH_LONG
                    ).show()
                    viewModel.handleKickedFromLiveStream()
                }

                var hasCameraPermission by remember {
                    mutableStateOf(
                        ContextCompat.checkSelfPermission(
                            context,
                            Manifest.permission.CAMERA
                        ) == PackageManager.PERMISSION_GRANTED
                    )
                }

                val activity = this@MainActivity

                val onboardingPermissionLauncher = rememberLauncherForActivityResult(
                    ActivityResultContracts.RequestMultiplePermissions(),
                ) { result ->
                    scope.launch {
                        prefs.setRuntimePermissionsOnboardingComplete(true)
                    }
                    hasCameraPermission =
                        ContextCompat.checkSelfPermission(activity, Manifest.permission.CAMERA) ==
                            PackageManager.PERMISSION_GRANTED
                    val locGranted =
                        ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_COARSE_LOCATION) ==
                            PackageManager.PERMISSION_GRANTED
                    if (locGranted) {
                        viewModel.tryUpdateRegionFromLastKnownLocation(activity)
                    }
                    val notifDenied =
                        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                            result[Manifest.permission.POST_NOTIFICATIONS] == false
                    if (notifDenied) {
                        Log.w("Notifications", "POST_NOTIFICATIONS denied — push notifications may be suppressed")
                    }
                }

                val launcher = rememberLauncherForActivityResult(
                    contract = ActivityResultContracts.RequestPermission(),
                    onResult = { isGranted ->
                        hasCameraPermission = isGranted
                        if (!isGranted && !activity.shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)) {
                            Toast.makeText(
                                activity,
                                "Camera is required for live streaming and video. Enable it in Settings.",
                                Toast.LENGTH_LONG
                            ).show()
                            activity.startActivity(
                                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                                    data = Uri.fromParts("package", activity.packageName, null)
                                }
                            )
                        }
                    }
                )
                val goLiveVideoPermissionsLauncher = rememberLauncherForActivityResult(
                    ActivityResultContracts.RequestMultiplePermissions()
                ) { result ->
                    val cam = result[Manifest.permission.CAMERA] == true
                    val mic = result[Manifest.permission.RECORD_AUDIO] == true
                    hasCameraPermission = cam
                    if (cam && mic) {
                        viewModel.toggleLive(false)
                    } else {
                        val micPermanent =
                            !mic && !activity.shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)
                        val camPermanent =
                            !cam && !activity.shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)
                        if (micPermanent || camPermanent) {
                            Toast.makeText(
                                activity,
                                activity.getString(R.string.live_host_permission_video),
                                Toast.LENGTH_LONG
                            ).show()
                            activity.startActivity(
                                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                                    data = Uri.fromParts("package", activity.packageName, null)
                                }
                            )
                        } else {
                            Toast.makeText(
                                activity,
                                activity.getString(R.string.live_host_permission_video),
                                Toast.LENGTH_LONG
                            ).show()
                        }
                    }
                }
                val goLiveAudioPermissionLauncher = rememberLauncherForActivityResult(
                    ActivityResultContracts.RequestPermission()
                ) { granted ->
                    if (granted) {
                        viewModel.toggleLive(true)
                    } else if (!activity.shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)) {
                        Toast.makeText(
                            activity,
                            activity.getString(R.string.live_host_permission_audio_only),
                            Toast.LENGTH_LONG
                        ).show()
                        activity.startActivity(
                            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                                data = Uri.fromParts("package", activity.packageName, null)
                            }
                        )
                    } else {
                        Toast.makeText(
                            activity,
                            activity.getString(R.string.live_host_permission_audio_only),
                            Toast.LENGTH_LONG
                        ).show()
                    }
                }
                var incomingDeclineConfirm by remember { mutableStateOf(false) }

                LaunchedEffect(uiState.incomingCall) {
                    if (uiState.incomingCall == null) incomingDeclineConfirm = false
                }

                val pkCallLauncher = rememberLauncherForActivityResult(
                    contract = ActivityResultContracts.StartActivityForResult()
                ) { result ->
                    val pkEnded = result.data?.getBooleanExtra(LiveStreamActivity.EXTRA_PK_ENDED, false) ?: false
                    val findRandomPk = result.data?.getBooleanExtra(LiveStreamActivity.EXTRA_PK_FIND_RANDOM_MATCH, false) == true
                    val randomDur = result.data?.getIntExtra(LiveStreamActivity.EXTRA_PK_DURATION_SECONDS, 300) ?: 300
                    viewModel.onReturnFromPkLiveStreamActivity(
                        pkEnded = pkEnded,
                        findRandomPkAfter = findRandomPk,
                        pkDurationSeconds = randomDur,
                    )
                }
                var pendingPkIntent by remember { mutableStateOf<Intent?>(null) }
                val pkMediaPermissionLauncher = rememberLauncherForActivityResult(
                    ActivityResultContracts.RequestMultiplePermissions()
                ) { result ->
                    val cam = result[Manifest.permission.CAMERA] == true
                    val mic = result[Manifest.permission.RECORD_AUDIO] == true
                    if (!cam || !mic) {
                        Log.e("WebRTC", "PK media permissions denied: camera=$cam microphone=$mic map=$result")
                        val camPermanent = !cam && !activity.shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)
                        val micPermanent = !mic && !activity.shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)
                        if (camPermanent || micPermanent) {
                            Toast.makeText(
                                activity,
                                "Camera and microphone are required for PK and calls. Enable them in Settings.",
                                Toast.LENGTH_LONG
                            ).show()
                            activity.startActivity(
                                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                                    data = Uri.fromParts("package", activity.packageName, null)
                                }
                            )
                        }
                        viewModel.abortPkLaunchForPermissions()
                        pendingPkIntent = null
                        return@rememberLauncherForActivityResult
                    }
                    pendingPkIntent?.let { intent ->
                        viewModel.notifyPkLiveStreamActivityWillOpenForLiveHost()
                        if (!viewModel.runSafeNavigation("pk_after_media_permission") { pkCallLauncher.launch(intent) }) {
                            Log.e("MainActivity", "PK launch after grant failed")
                            viewModel.onReturnFromPkLiveStreamActivity(pkEnded = false)
                            viewModel.abortPkLaunchForPermissions("Could not open PK session")
                        }
                        pendingPkIntent = null
                    }
                }
                val callLauncher = rememberLauncherForActivityResult(
                    contract = ActivityResultContracts.StartActivityForResult()
                ) { result ->
                    val roomId = result.data?.getStringExtra(LiveStreamActivity.EXTRA_ROOM_ID)
                    viewModel.onCallActivityEnded(roomId)
                }

                val showPermissionOnboarding =
                    uiState.isLoggedIn &&
                        !uiState.isGuest &&
                        uiState.isAuthBootstrapComplete &&
                        !onboardingComplete &&
                        !context.hasAllRuntimeOnboardingPermissions()

                BackHandler(enabled = showPermissionOnboarding) {
                    // Hold focus on primer until Continue or Not now (avoid accidental dismiss).
                }

                /** Hosting live on Live tab: let video extend behind nav bar; bottom inset applied in [LiveStreamingView]. */
                val rootSafeDrawingInsets =
                    if (uiState.selectedTab == 1 && uiState.isLive) {
                        WindowInsets.safeDrawing.only(
                            WindowInsetsSides.Top + WindowInsetsSides.Horizontal
                        )
                    } else {
                        WindowInsets.safeDrawing
                    }
                Surface(
                    modifier = Modifier
                        .fillMaxSize()
                        .windowInsetsPadding(rootSafeDrawingInsets)
                        .imePadding(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    Box(modifier = Modifier.fillMaxSize()) {
                    LaunchedEffect(uiState.callNoticeMessage) {
                        val notice = uiState.callNoticeMessage ?: return@LaunchedEffect
                        snackbarHostState.showSnackbar(notice)
                        viewModel.clearCallNotice()
                    }
                    LaunchedEffect(
                        uiState.isLoggedIn,
                        uiState.isAuthBootstrapComplete,
                        uiState.isGuest,
                        onboardingComplete,
                        uiState.currentUser?.id,
                        uiState.currentUser?.isFaceVerified,
                        uiState.currentUser?.faceVerificationStatus,
                        uiState.currentUser?.isVerified
                    ) {
                        if (!uiState.isLoggedIn || !uiState.isAuthBootstrapComplete) return@LaunchedEffect
                        if (!uiState.isGuest &&
                            !onboardingComplete &&
                            !context.hasAllRuntimeOnboardingPermissions()
                        ) {
                            return@LaunchedEffect
                        }
                        if (welcomeHandledThisSession) return@LaunchedEffect
                        welcomeHandledThisSession = true
                        if (uiState.isGuest) {
                            showWelcomeSheet = false
                            return@LaunchedEffect
                        }
                        val u = uiState.currentUser
                        val alreadyVerified =
                            u?.isFaceVerified == true ||
                                u?.faceVerificationStatus == VerificationStatus.APPROVED.name ||
                                u?.isVerified == true ||
                                u?.hasBlueTick == true
                        if (alreadyVerified) {
                            showWelcomeSheet = false
                            return@LaunchedEffect
                        }
                        showWelcomeSheet = true
                    }
                    LaunchedEffect(uiState.isLoggedIn) {
                        if (!uiState.isLoggedIn) {
                            welcomeHandledThisSession = false
                            showWelcomeSheet = false
                        }
                    }
                    LaunchedEffect(uiState.isAuthBootstrapComplete, uiState.currentUser?.isCallVerificationApproved, showFaceVerification) {
                        if (!uiState.isAuthBootstrapComplete) return@LaunchedEffect
                        if (showFaceVerification && uiState.currentUser?.isCallVerificationApproved == true) {
                            showFaceVerification = false
                        }
                    }
                    val composeContext = LocalContext.current
                    LaunchedEffect(uiState.pkLaunchToken, uiState.pkRoomId) {
                        try {
                            if (uiState.pkLaunchToken <= 0) return@LaunchedEffect
                            val room = uiState.pkRoomId?.trim().orEmpty()
                            // No room id yet — matchmaking or idle. Do not abort (stale token is cleared in ViewModel).
                            if (room.isEmpty()) {
                                Log.d("MainActivity", "PK launch deferred: no room_id yet")
                                return@LaunchedEffect
                            }
                            val pkPartner = uiState.activeCallPartner
                            val challengerId = pkPartner?.id?.trim().orEmpty()
                            if (pkPartner == null || challengerId.isEmpty()) {
                                Log.e("MainActivity", "PK launch skipped: missing opponent id (room=$room)")
                                Toast.makeText(
                                    composeContext,
                                    "Could not open PK. Try again.",
                                    Toast.LENGTH_LONG
                                ).show()
                                viewModel.abortPkLaunchForPermissions("Could not open PK session")
                                return@LaunchedEffect
                            }
                            val camOk = ContextCompat.checkSelfPermission(
                                composeContext,
                                Manifest.permission.CAMERA
                            ) == PackageManager.PERMISSION_GRANTED
                            val micOk = ContextCompat.checkSelfPermission(
                                composeContext,
                                Manifest.permission.RECORD_AUDIO
                            ) == PackageManager.PERMISSION_GRANTED
                            val pkLiveStreamDocId = if (uiState.pkIsStreamer) {
                                FirebaseAuth.getInstance().currentUser?.uid.orEmpty()
                            } else {
                                challengerId
                            }
                            val intent = Intent(composeContext, LiveStreamActivity::class.java).apply {
                                putExtra("is_streamer", uiState.pkIsStreamer)
                                putExtra("room_id", room)
                                putExtra(LiveStreamActivity.EXTRA_IS_PK_SESSION, true)
                                putExtra(
                                    LiveStreamActivity.EXTRA_PK_LIVE_STREAM_DOC_ID,
                                    pkLiveStreamDocId
                                )
                                putExtra(
                                    LiveStreamActivity.EXTRA_PK_BATTLE_START_MS,
                                    uiState.pkBattleSession?.pkStartTimeMillis ?: System.currentTimeMillis()
                                )
                                putExtra(
                                    LiveStreamActivity.EXTRA_PK_DURATION_SECONDS,
                                    uiState.pkBattleSession?.durationSeconds ?: 300
                                )
                                putExtra(LiveStreamActivity.EXTRA_OVERLAY_PEER_ID, challengerId)
                                putExtra(
                                    LiveStreamActivity.EXTRA_OVERLAY_PEER_NAME,
                                    pkPartner.name.ifBlank { "PK Partner" }
                                )
                                putExtra(
                                    LiveStreamActivity.EXTRA_OVERLAY_PEER_PHOTO,
                                    pkPartner.photoUrl
                                )
                            }
                            if (!camOk || !micOk) {
                                Log.w(
                                    "WebRTC",
                                    "PK: requesting CAMERA+RECORD_AUDIO (camera=$camOk mic=$micOk) before LiveStreamActivity"
                                )
                                pendingPkIntent = intent
                                pkMediaPermissionLauncher.launch(
                                    arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
                                )
                                return@LaunchedEffect
                            }
                            viewModel.notifyPkLiveStreamActivityWillOpenForLiveHost()
                            if (!viewModel.runSafeNavigation("pk_live_stream") { pkCallLauncher.launch(intent) }) {
                                viewModel.onReturnFromPkLiveStreamActivity(pkEnded = false)
                                Toast.makeText(composeContext, "Could not open PK. Try again.", Toast.LENGTH_LONG).show()
                                viewModel.abortPkLaunchForPermissions("Could not open PK session")
                            }
                        } catch (e: Exception) {
                            Log.e("MainActivity", "PK navigation", e)
                            Toast.makeText(
                                composeContext,
                                "Could not open PK. Try again.",
                                Toast.LENGTH_LONG
                            ).show()
                            viewModel.abortPkLaunchForPermissions("Could not open PK session")
                        }
                    }
                    /**
                     * Paid / normal WebRTC invite flow: [DatingViewModel.initiateCall] and [acceptIncomingCall]
                     * bump [pendingCallLaunchToken] so we open [LiveStreamActivity] (native SurfaceViews + same
                     * [WebRtcOverlayBottomChat] stack as legacy APK). Marketing teaser acceptance skips this and
                     * uses [VideoCallScreen] in-app instead ([isFreeTeaserCall]).
                     */
                    LaunchedEffect(
                        uiState.pendingCallLaunchToken,
                        uiState.pendingCallRoomId,
                        uiState.soloLiveSuspendedForPrivateCall
                    ) {
                        if (uiState.pendingCallLaunchToken <= 0) return@LaunchedEffect
                        val callRoom = uiState.pendingCallRoomId?.trim().orEmpty()
                        if (callRoom.isEmpty()) {
                            Log.e("MainActivity", "Call launch skipped: blank room_id")
                            return@LaunchedEffect
                        }
                        if (uiState.soloLiveSuspendedForPrivateCall) {
                            // Let Compose tear down solo Agora/WebRTC and release camera before LiveStreamActivity starts.
                            delay(DatingViewModel.SOLO_LIVE_MEDIA_HANDOFF_DELAY_MS)
                        }
                        try {
                            val callPartner = uiState.activeCallPartner
                            val intent = Intent(composeContext, LiveStreamActivity::class.java).apply {
                                putExtra("is_streamer", uiState.pendingCallIsStreamer)
                                putExtra("room_id", callRoom)
                                putExtra(LiveStreamActivity.EXTRA_IS_VIDEO_CALL, uiState.isVideoCallActive)
                                putExtra(LiveStreamActivity.EXTRA_OVERLAY_PEER_ID, callPartner?.id.orEmpty())
                                putExtra(LiveStreamActivity.EXTRA_OVERLAY_PEER_NAME, callPartner?.name.orEmpty())
                                putExtra(LiveStreamActivity.EXTRA_OVERLAY_PEER_PHOTO, callPartner?.photoUrl.orEmpty())
                            }
                            if (viewModel.runSafeNavigation("call_live_stream") { callLauncher.launch(intent) }) {
                                viewModel.onCallActivityLaunched()
                            } else {
                                Toast.makeText(composeContext, "Could not open call.", Toast.LENGTH_LONG).show()
                            }
                            viewModel.clearPendingCallLaunch()
                        } catch (e: Exception) {
                            Log.e("MainActivity", "Call activity launch failed", e)
                            Toast.makeText(composeContext, "Could not open call.", Toast.LENGTH_LONG).show()
                            viewModel.clearPendingCallLaunch()
                        }
                    }

                    // Auth gate: Material3 LoginScreen. Main shell uses tabs in [DatingAppApp]; the Home tab
                    // hosts a nested NavHost (see HomeScreen) for feed vs. full-screen user profile back stack.
                    if (!uiState.isLoggedIn) {
                        LoginScreen(
                            uiState = uiState,
                            onSendOtp = { phone, activity -> viewModel.sendOtp(phone, activity) },
                            onVerifyOtp = { code -> viewModel.verifyOtp(code) },
                            onGoogleSignIn = { token -> viewModel.signInWithGoogle(token) },
                            onGoogleSignInFailure = { error -> viewModel.reportLoginFailure(error.message ?: "unknown") },
                            onSelectGender = { gender -> viewModel.setRegistrationGender(gender) },
                            onSetReferralCode = { code -> viewModel.setRegistrationReferralCode(code) },
                            onGuestLogin = { viewModel.loginAsGuest() },
                            onUseAnotherAccount = { viewModel.useAnotherAccount(this@MainActivity) },
                            onBackToOptions = { viewModel.resetOtpStatus() }
                        )
                    } else if (showDiamondShop) {
                        DiamondShopScreen(
                            uiState = uiState,
                            onBack = { showDiamondShop = false },
                            onBuyDiamonds = { viewModel.buyCoins(it) }
                        )
                    } else if (showFaceVerification) {
                        if (hasCameraPermission) {
                            FaceVerificationScreen(
                                uiState = uiState,
                                onVerify = { uri, onFinished ->
                                    checkAccess(
                                        isGuest = uiState.currentUser?.isGuest == true || uiState.isGuest,
                                        onBlocked = {
                                            showLoginRequiredSheet = true
                                            onFinished()
                                        },
                                        action = {
                                            viewModel.uploadFaceVerificationImage(
                                                uri = uri,
                                                onResult = { success ->
                                                    if (success) {
                                                        Toast.makeText(
                                                            this@MainActivity,
                                                            "Verification Successful! Your Blue Tick is active.",
                                                            Toast.LENGTH_LONG
                                                        ).show()
                                                        viewModel.setTab(4)
                                                        showFaceVerification = false
                                                        pendingActionAfterUpload?.invoke()
                                                        pendingActionAfterUpload = null
                                                    }
                                                    onFinished()
                                                },
                                                onUploadUserMessage = { msg ->
                                                    Toast.makeText(this@MainActivity, msg, Toast.LENGTH_LONG).show()
                                                }
                                            )
                                        }
                                    )
                                },
                                onCancel = {
                                    showFaceVerification = false
                                    pendingActionAfterUpload = null
                                }
                            )
                        } else {
                            LaunchedEffect(Unit) {
                                launcher.launch(Manifest.permission.CAMERA)
                            }
                            BackHandler { showFaceVerification = false }
                            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                Text(
                                    "Camera permission is required for face verification.",
                                    modifier = Modifier.padding(16.dp)
                                )
                            }
                        }
                    } else if (showEditProfile && uiState.currentUser != null) {
                        EditProfileScreen(
                            user = uiState.currentUser!!,
                            uiState = uiState,
                            onSave = { name, age, city, gender, email, mobile, bio, photo, gallery, referral, mimeTypes, hobbies, likes, dislikes, languages ->
                                checkAccess(
                                    isGuest = uiState.currentUser?.isGuest == true || uiState.isGuest,
                                    onBlocked = { showLoginRequiredSheet = true },
                                    action = {
                                        viewModel.updateProfileWithUploads(
                                            name, age, city, gender, email, mobile, bio,
                                            photo, gallery, referral,
                                            hobbies = hobbies,
                                            likes = likes,
                                            dislikes = dislikes,
                                            languages = languages,
                                        )
                                    }
                                )
                            },
                            onSaveDone = { showEditProfile = false },
                            onUploadVideo = { viewModel.uploadVerificationVideo(it) },
                            onSelectFrame = { viewModel.selectFrame(it) },
                            onBack = { showEditProfile = false },
                            onClearSaveFeedback = { viewModel.clearProfileSaveFeedback() },
                            onSendPhoneChangeOtp = { phone, activity -> viewModel.changePhone_sendOtp(phone, activity) },
                            onVerifyPhoneChangeOtp = { otp -> viewModel.changePhone_verifyOtp(otp) },
                            onClearPhoneChangeState = { viewModel.clearPhoneChangeState() },
                            onChangeEmail = { email -> viewModel.changeEmail(email) },
                            onClearEmailChangeState = { viewModel.clearEmailChangeState() },
                        )
                    } else if (showCreateBattle) {
                        CreateBattleScreen(
                            uiState = uiState,
                            onClose = { showCreateBattle = false },
                            onPublish = { type, prize, questions, sectors, boxes ->
                                viewModel.createBattle(type, null, prize, questions, sectors, boxes)
                                showCreateBattle = false
                                showGameCenter = false
                            }
                        )
                    } else if (uiState.activeBattle != null) {
                        // Game Center battles use PkBattleScreen only (not LiveWatcher PK layout); mutually exclusive with activeBattle == null branches below.
                        val battle = uiState.activeBattle!!
                        PkBattleScreen(
                            viewModel = viewModel,
                            battleId = battle.id,
                            myStreamId = uiState.currentUser?.liveRoomId.orEmpty(),
                            onBattleEnd = { viewModel.leaveBattle() },
                        )
                    } else if (showGameCenter) {
                        BattleLobbyScreen(
                            uiState = uiState,
                            onCreateBattle = { showCreateBattle = true },
                            onEnterBattle = {
                                showGameCenter = false
                                viewModel.watchLive(com.zipper.datingapp.data.UserProfile(id = it.girl1Id))
                            },
                            onBack = { showGameCenter = false }
                        )
                    } else if (
                        uiState.callState != CallState.IDLE &&
                            uiState.activeCallPartner != null &&
                            !(uiState.isLive && (uiState.isPkSearching || !uiState.pkRoomId.isNullOrBlank()))
                    ) {
                        val callPartner = uiState.activeCallPartner!!
                        VideoCallScreen(
                            viewModel = viewModel,
                            callId = uiState.webRtcSessionRoomId.orEmpty(),
                            calleeId = callPartner.id,
                            calleeName = callPartner.name,
                            calleePhotoUrl = callPartner.photoUrl,
                            isVideoCall = uiState.isVideoCallActive,
                            rtcEngine = null,
                            remoteAgoraUid = 0,
                            onCallEnded = { elapsedSeconds -> viewModel.endCall(elapsedSeconds) },
                        )
                    } else {
                        DatingAppApp(
                            viewModel = viewModel,
                            uiState = uiState,
                            onRequestLoginRequired = { showLoginRequiredSheet = true },
                            onRequireFaceVerification = { action: () -> Unit ->
                                if (uiState.currentUser?.isCallVerificationApproved == true) {
                                    action()
                                } else {
                                    pendingActionAfterUpload = action
                                    showFaceVerification = true
                                }
                            },
                            onEditProfile = { showEditProfile = true },
                            onShowGameCenter = {
                                if (uiState.currentUser?.isCallVerificationApproved == true) {
                                    showGameCenter = true
                                } else {
                                    pendingActionAfterUpload = { showGameCenter = true }
                                    showFaceVerification = true
                                }
                            },
                            onDiamondShopClick = { showDiamondShop = true },
                            onShowCustomPrice = { showCustomPriceDialog = true },
                            onRequestCameraPermission = {
                                launcher.launch(Manifest.permission.CAMERA)
                            },
                            hasCameraPermission = hasCameraPermission,
                            onToggleLive = { audioParty ->
                                if (audioParty) {
                                    val micOk = ContextCompat.checkSelfPermission(
                                        activity,
                                        Manifest.permission.RECORD_AUDIO
                                    ) == PackageManager.PERMISSION_GRANTED
                                    if (micOk) {
                                        viewModel.toggleLive(true)
                                    } else {
                                        goLiveAudioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                                    }
                                } else {
                                    val camOk = ContextCompat.checkSelfPermission(
                                        activity,
                                        Manifest.permission.CAMERA
                                    ) == PackageManager.PERMISSION_GRANTED
                                    val micOk = ContextCompat.checkSelfPermission(
                                        activity,
                                        Manifest.permission.RECORD_AUDIO
                                    ) == PackageManager.PERMISSION_GRANTED
                                    if (camOk && micOk) {
                                        viewModel.toggleLive(false)
                                    } else {
                                        goLiveVideoPermissionsLauncher.launch(
                                            arrayOf(
                                                Manifest.permission.CAMERA,
                                                Manifest.permission.RECORD_AUDIO
                                            )
                                        )
                                    }
                                }
                            },
                            onCycleTheme = {
                                scope.launch {
                                    val next = when (themeMode) {
                                        ThemeModePreference.SYSTEM -> ThemeModePreference.LIGHT
                                        ThemeModePreference.LIGHT -> ThemeModePreference.DARK
                                        ThemeModePreference.DARK -> ThemeModePreference.SYSTEM
                                    }
                                    prefs.setThemeMode(next)
                                }
                            },
                            onPersistLanguage = { lang ->
                                scope.launch { prefs.setLanguageCode(lang.code) }
                                AppCompatDelegate.setApplicationLocales(
                                    LocaleListCompat.forLanguageTags(lang.code)
                                )
                            }
                        )
                    }

                    if (showCustomPriceDialog) {
                        CustomPriceDialog(
                            currentAudio = uiState.currentUser?.customAudioPrice ?: 1000,
                            currentVideo = uiState.currentUser?.customVideoPrice ?: 1500,
                            onSave = { a: Int, v: Int ->
                                viewModel.setCustomPrices(a, v)
                                showCustomPriceDialog = false
                            },
                            onDismiss = { showCustomPriceDialog = false }
                        )
                    }

                    if (showTeaserPaywall) {
                        ModalBottomSheet(
                            onDismissRequest = { showTeaserPaywall = false },
                            containerColor = androidx.compose.material3.MaterialTheme.colorScheme.surface,
                            shape = androidx.compose.foundation.shape.RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp)
                        ) {
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .navigationBarsPadding()
                                    .padding(horizontal = 24.dp, vertical = 20.dp),
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.spacedBy(12.dp)
                            ) {
                                Text("💎", fontSize = 48.sp)
                                Text(
                                    "You're running low on diamonds!",
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.Bold,
                                    textAlign = TextAlign.Center
                                )
                                Text(
                                    "Recharge your diamonds to keep enjoying calls and gifts.",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                                    textAlign = TextAlign.Center
                                )
                                Surface(
                                    shape = RoundedCornerShape(10.dp),
                                    color = MaterialTheme.colorScheme.surfaceVariant,
                                    modifier = Modifier.fillMaxWidth()
                                ) {
                                    Row(
                                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.SpaceBetween
                                    ) {
                                        Text("Your balance", style = MaterialTheme.typography.bodyMedium)
                                        Text(
                                            "💎 ${uiState.coinBalance}",
                                            style = MaterialTheme.typography.titleSmall,
                                            fontWeight = FontWeight.Bold
                                        )
                                    }
                                }
                                Spacer(Modifier.height(4.dp))
                                Button(
                                    onClick = {
                                        showTeaserPaywall = false
                                        showDiamondShop = true
                                    },
                                    modifier = Modifier.fillMaxWidth().height(50.dp),
                                    colors = ButtonDefaults.buttonColors(
                                        containerColor = Color(0xFF9C27B0)
                                    ),
                                    shape = RoundedCornerShape(12.dp)
                                ) {
                                    Text("Get Diamonds", fontWeight = FontWeight.Bold)
                                }
                                OutlinedButton(
                                    onClick = {
                                        showTeaserPaywall = false
                                        viewModel.endCall()
                                    },
                                    modifier = Modifier.fillMaxWidth().height(50.dp),
                                    shape = RoundedCornerShape(12.dp)
                                ) {
                                    Text("End Call")
                                }
                                Spacer(Modifier.height(4.dp))
                            }
                        }
                    }

                    // In-app incoming call overlay (shown over any screen)
                    val incoming = uiState.incomingCall
                    if (incoming != null) {
                        Box(
                            modifier = Modifier
                                .fillMaxSize()
                                .background(Color.Black.copy(alpha = 0.75f))
                                .zIndex(3000f),
                            contentAlignment = Alignment.Center,
                        ) {
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth(0.85f)
                                    .clip(RoundedCornerShape(24.dp))
                                    .background(
                                        Brush.verticalGradient(
                                            listOf(Color(0xFF1A1A2E), Color(0xFF16213E))
                                        )
                                    )
                                    .padding(vertical = 32.dp, horizontal = 24.dp),
                                horizontalAlignment = Alignment.CenterHorizontally,
                            ) {
                                // Avatar
                                Box(
                                    modifier = Modifier
                                        .size(96.dp)
                                        .clip(CircleShape)
                                        .background(Color(0xFF2A2A3E)),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    if (incoming.callerPhotoUrl.isNotBlank()) {
                                        AsyncImage(
                                            model = incoming.callerPhotoUrl,
                                            contentDescription = incoming.callerName,
                                            modifier = Modifier.fillMaxSize().clip(CircleShape),
                                        )
                                    } else {
                                        Text(
                                            incoming.callerName.take(1).uppercase(),
                                            fontSize = 38.sp,
                                            color = Color.White,
                                            fontWeight = FontWeight.Bold,
                                        )
                                    }
                                }
                                Spacer(Modifier.height(16.dp))
                                Text(
                                    incoming.callerName,
                                    color = Color.White,
                                    fontSize = 22.sp,
                                    fontWeight = FontWeight.Bold,
                                )
                                Spacer(Modifier.height(4.dp))
                                Text(
                                    if (incoming.isVideoCall) "Incoming Video Call" else "Incoming Audio Call",
                                    color = Color.White.copy(alpha = 0.65f),
                                    fontSize = 14.sp,
                                )
                                Spacer(Modifier.height(32.dp))
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceEvenly,
                                ) {
                                    // Decline
                                    Column(
                                        horizontalAlignment = Alignment.CenterHorizontally,
                                    ) {
                                        Box(
                                            modifier = Modifier
                                                .size(64.dp)
                                                .clip(CircleShape)
                                                .background(Color(0xFFE53935))
                                                .clickable { incomingDeclineConfirm = true },
                                            contentAlignment = Alignment.Center,
                                        ) {
                                            Icon(
                                                imageVector = Icons.Default.Close,
                                                contentDescription = "Decline",
                                                tint = Color.White,
                                                modifier = Modifier.size(28.dp),
                                            )
                                        }
                                        Spacer(Modifier.height(8.dp))
                                        Text("Decline", color = Color.White.copy(alpha = 0.7f), fontSize = 12.sp)
                                    }
                                    // Accept
                                    Column(
                                        horizontalAlignment = Alignment.CenterHorizontally,
                                    ) {
                                        Box(
                                            modifier = Modifier
                                                .size(64.dp)
                                                .clip(CircleShape)
                                                .background(Color(0xFF43A047))
                                                .clickable { viewModel.acceptIncomingCall() },
                                            contentAlignment = Alignment.Center,
                                        ) {
                                            Icon(
                                                imageVector = Icons.Default.Call,
                                                contentDescription = "Accept",
                                                tint = Color.White,
                                                modifier = Modifier.size(28.dp),
                                            )
                                        }
                                        Spacer(Modifier.height(8.dp))
                                        Text("Accept", color = Color.White.copy(alpha = 0.7f), fontSize = 12.sp)
                                    }
                                }
                            }
                        }
                    }

                    if (incomingDeclineConfirm && uiState.incomingCall != null) {
                        FuturisticConfirmCloseDialog(
                            onDismissRequest = { incomingDeclineConfirm = false },
                            onConfirm = {
                                incomingDeclineConfirm = false
                                viewModel.declineIncomingCall()
                            },
                        )
                    }

                    if (showLoginRequiredSheet) {
                        LoginRequiredBottomSheet(
                            onDismiss = { showLoginRequiredSheet = false },
                            onLoginNow = {
                                showLoginRequiredSheet = false
                                viewModel.useAnotherAccount(this@MainActivity)
                            }
                        )
                    }

                    if (showWelcomeSheet && uiState.isLoggedIn && !showFaceVerification) {
                        WelcomeVerificationSheet(
                            onDismiss = { showWelcomeSheet = false },
                            onVerifyNow = {
                                showWelcomeSheet = false
                                showFaceVerification = true
                            }
                        )
                    }

                    SnackbarHost(
                        hostState = snackbarHostState,
                        modifier = Modifier
                            .align(Alignment.BottomCenter)
                            .padding(horizontal = 16.dp, vertical = 8.dp)
                            .padding(bottom = 72.dp)
                    )

                    GiftOverlay(
                        gift = uiState.playingGift,
                        onComplete = { viewModel.clearPlayingGift() }
                    )
                    GiftAssetPreloader(gifts = uiState.availableGifts)

                    if (uiState.showPostPrivateCallResumeChoice) {
                        Box(
                            modifier = Modifier
                                .fillMaxSize()
                                .zIndex(2650f),
                            contentAlignment = Alignment.Center
                        ) {
                            FuturisticConfirmCloseDialog(
                                onDismissRequest = { viewModel.endAllAfterPrivateCall() },
                                onConfirm = { viewModel.continueSoloLiveAfterPrivateCall() },
                                titleContent = {
                                    Text(
                                        stringResource(R.string.post_private_call_title),
                                        color = Color.White,
                                        fontWeight = FontWeight.Bold,
                                        fontSize = 22.sp,
                                        letterSpacing = 0.3.sp,
                                        lineHeight = 26.sp,
                                    )
                                },
                                textContent = {
                                    Text(
                                        stringResource(R.string.post_private_call_message),
                                        color = Color.White.copy(alpha = 0.88f),
                                        fontSize = 15.sp,
                                        lineHeight = 21.sp,
                                    )
                                },
                                cancelLabelResId = R.string.post_private_call_close_all,
                                confirmLabelResId = R.string.post_private_call_continue_live,
                                properties = DialogProperties(
                                    dismissOnBackPress = false,
                                    dismissOnClickOutside = false,
                                ),
                            )
                        }
                    }

                    if (uiState.isLoggedIn && !uiState.isAuthBootstrapComplete && uiState.splashHoldTimedOut) {
                        Box(
                            modifier = Modifier
                                .fillMaxSize()
                                .zIndex(2400f)
                                .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.94f)),
                            contentAlignment = Alignment.Center,
                        ) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                CircularProgressIndicator()
                                Spacer(Modifier.height(20.dp))
                                Text(
                                    text = stringResource(R.string.bootstrap_loading_message),
                                    style = MaterialTheme.typography.bodyLarge,
                                    color = MaterialTheme.colorScheme.onSurface,
                                    textAlign = TextAlign.Center,
                                    modifier = Modifier.padding(horizontal = 32.dp),
                                )
                            }
                        }
                    }

                    val appBusyMessage = uiState.appWideLoadingMessage
                    if (uiState.isLoggedIn && !appBusyMessage.isNullOrBlank()) {
                        Box(
                            modifier = Modifier
                                .fillMaxSize()
                                .zIndex(2450f)
                                .background(Color.Black.copy(alpha = 0.48f)),
                            contentAlignment = Alignment.Center,
                        ) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                CircularProgressIndicator(color = MaterialTheme.colorScheme.primary)
                                Spacer(Modifier.height(18.dp))
                                Text(
                                    text = appBusyMessage,
                                    style = MaterialTheme.typography.bodyLarge,
                                    color = Color.White,
                                    textAlign = TextAlign.Center,
                                    modifier = Modifier.padding(horizontal = 40.dp),
                                )
                            }
                        }
                    }

                    if (uiState.showHostPkEndedInterstitial) {
                        Box(
                            modifier = Modifier
                                .fillMaxSize()
                                .zIndex(2600f),
                            contentAlignment = Alignment.Center
                        ) {
                            Surface(
                                modifier = Modifier.fillMaxSize(),
                                color = Color(0xEE0D0D12)
                            ) {
                                Column(
                                    modifier = Modifier
                                        .fillMaxSize()
                                        .padding(24.dp),
                                    verticalArrangement = Arrangement.Center,
                                    horizontalAlignment = Alignment.CenterHorizontally
                                ) {
                                    Text(
                                        text = stringResource(R.string.pk_ended_host_title),
                                        style = MaterialTheme.typography.headlineMedium,
                                        fontWeight = FontWeight.Bold,
                                        color = Color.White,
                                        textAlign = TextAlign.Center
                                    )
                                    Spacer(Modifier.height(12.dp))
                                    Text(
                                        text = stringResource(R.string.pk_ended_host_message),
                                        style = MaterialTheme.typography.bodyLarge,
                                        color = Color.White.copy(alpha = 0.82f),
                                        textAlign = TextAlign.Center
                                    )
                                    Spacer(Modifier.height(32.dp))
                                    Button(
                                        onClick = { viewModel.dismissHostPkEndedInterstitial() },
                                        modifier = Modifier
                                            .fillMaxWidth(0.88f)
                                            .height(52.dp)
                                    ) {
                                        Text(stringResource(R.string.pk_ended_host_continue))
                                    }
                                }
                            }
                        }
                    }

                    if (showPermissionOnboarding) {
                        PermissionOnboardingOverlay(
                            modifier = Modifier
                                .fillMaxSize()
                                .zIndex(2800f),
                            onContinue = {
                                onboardingPermissionLauncher.launch(runtimeOnboardingPermissionArray())
                            },
                            onNotNow = {
                                scope.launch {
                                    prefs.setRuntimePermissionsOnboardingComplete(true)
                                }
                            },
                        )
                    }
                    }
                }
            }
        }
    }

    // ── Picture-in-Picture (VideoCallScreen teaser/free calls) ─────────────────
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        enterPipIfVideoCallActive()
    }

    private fun enterPipIfVideoCallActive() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val state = viewModel.uiState.value
        if (state.callState != com.zipper.datingapp.data.CallState.ACTIVE || !state.isVideoCallActive) return
        try {
            val params = android.app.PictureInPictureParams.Builder()
                .setAspectRatio(android.util.Rational(9, 16))
                .build()
            enterPictureInPictureMode(params)
        } catch (e: Exception) {
            Log.w("MainActivity", "enterPictureInPictureMode failed", e)
        }
    }

    override fun onPictureInPictureModeChanged(
        isInPictureInPictureMode: Boolean,
        newConfig: android.content.res.Configuration
    ) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        viewModel.isInPipMode.value = isInPictureInPictureMode
    }
    // ───────────────────────────────────────────────────────────────────────────

    /**
     * Called when the activity is already running (singleTop) and a new notification intent
     * arrives. Funnels the intent into [notifIntentState] for the Compose UI to act on.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.action?.startsWith("com.zipper.datingapp.action.") == true) {
            notifIntentState.value = intent
        }
    }

    override fun onDestroy() {
        ProcessLifecycleOwner.get().lifecycle.removeObserver(processLifecycleObserver)
        super.onDestroy()
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PermissionOnboardingOverlay(
    modifier: Modifier = Modifier,
    onContinue: () -> Unit,
    onNotNow: () -> Unit,
) {
    Box(
        modifier = modifier.background(Color.Black.copy(alpha = 0.72f)),
        contentAlignment = Alignment.Center,
    ) {
        Card(
            modifier = Modifier
                .fillMaxWidth(0.9f)
                .padding(16.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        ) {
            Column(Modifier.padding(24.dp)) {
                Text(
                    stringResource(R.string.permission_onboarding_title),
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.height(12.dp))
                Text(
                    stringResource(R.string.permission_onboarding_body),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.85f),
                )
                Spacer(Modifier.height(24.dp))
                Button(onClick = onContinue, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.permission_onboarding_continue))
                }
                Spacer(Modifier.height(8.dp))
                TextButton(onClick = onNotNow, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.permission_onboarding_not_now))
                }
            }
        }
    }
}

@Composable
fun CustomPriceDialog(currentAudio: Int, currentVideo: Int, onSave: (Int, Int) -> Unit, onDismiss: () -> Unit) {
    var audioPrice by remember { mutableStateOf(currentAudio.toString()) }
    var videoPrice by remember { mutableStateOf(currentVideo.toString()) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Set Call Prices", fontWeight = FontWeight.Bold) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text("Minimum suggested: 1000 for Audio, 1500 for Video.", fontSize = 12.sp, color = Color.Gray)
                OutlinedTextField(
                    value = audioPrice,
                    onValueChange = { audioPrice = it },
                    label = { Text("Audio Call Price (Diamonds/min)") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = videoPrice,
                    onValueChange = { videoPrice = it },
                    label = { Text("Video Call Price (Diamonds/min)") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.fillMaxWidth()
                )
            }
        },
        confirmButton = {
            Button(onClick = { onSave(audioPrice.toIntOrNull() ?: 1000, videoPrice.toIntOrNull() ?: 1500) }) {
                Text("Save Prices")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        }
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DatingAppApp(
    viewModel: DatingViewModel,
    uiState: com.zipper.datingapp.ui.DatingUiState,
    onRequestLoginRequired: () -> Unit,
    onRequireFaceVerification: (() -> Unit) -> Unit,
    onEditProfile: () -> Unit,
    onShowGameCenter: () -> Unit,
    onDiamondShopClick: () -> Unit,
    onShowCustomPrice: () -> Unit,
    onRequestCameraPermission: () -> Unit,
    hasCameraPermission: Boolean,
    /** Live tab: start solo broadcast; `true` = audio-only. */
    onToggleLive: (audioParty: Boolean) -> Unit,
    onCycleTheme: () -> Unit,
    onPersistLanguage: (AppLanguage) -> Unit
) {
    val appContext = LocalContext.current

    // ── Profile-routed screens ────────────────────────────────────────────────
    var showMyProfile       by remember { mutableStateOf(false) }
    var showLikesScreen     by remember { mutableStateOf(false) }
    var likesInitialTab     by remember { mutableStateOf(0) }
    var showDiamondHistory  by remember { mutableStateOf(false) }
    var showBeansCenter     by remember { mutableStateOf(false) }
    var showCallHistory     by remember { mutableStateOf(false) }
    var showBlockedUsers    by remember { mutableStateOf(false) }
    var showFeedbackScreen  by remember { mutableStateOf(false) }
    var showMyBagScreen     by remember { mutableStateOf(false) }

    // Full-screen overlays driven by ProfileScreen callbacks
    if (showMyProfile) {
        MyProfileScreen(
            uiState = uiState,
            onBack = { showMyProfile = false },
            onEditProfile = { showMyProfile = false; onEditProfile() },
            onEnterOwnLive = { showMyProfile = false; viewModel.setTab(1) },
            onEnterOwnParty = { showMyProfile = false; viewModel.setTab(1) }
        )
        return
    }
    if (showLikesScreen) {
        LikesScreen(
            uiState = uiState,
            initialTab = likesInitialTab,
            onBack = { showLikesScreen = false },
            onProfileClick = { profile ->
                showLikesScreen = false
                // Prefetch from server NOW so the feed list has up-to-date isLive before the
                // profile sheet opens — ensures the PIP window appears instantly without
                // waiting for startOpenedProfileListener to fire.
                viewModel.prefetchOpenedProfileFromServer(profile.id)
                viewModel.startOpenedProfileListener(profile.id)
                viewModel.requestOpenProfileSheet(profile.id, profile)
                viewModel.setTab(0)
            }
        )
        return
    }
    if (showDiamondHistory) {
        DiamondHistoryScreen(
            viewModel = viewModel,
            onBack = { showDiamondHistory = false },
            onBuyDiamonds = { showDiamondHistory = false; onDiamondShopClick() },
        )
        return
    }
    if (showBeansCenter) {
        BeansCenterScreen(
            viewModel = viewModel,
            uiState = uiState,
            onBack = { showBeansCenter = false },
            onConvertBeans = { beans -> viewModel.convertBeansToDiamonds(beans) }
        )
        return
    }
    if (showCallHistory) {
        CallHistoryScreen(
            viewModel = viewModel,
            onBack = { showCallHistory = false },
            onRecall = { userId -> viewModel.initiateCall(true, userId) }
        )
        return
    }
    if (showBlockedUsers) {
        BlockedUsersScreen(
            uiState = uiState,
            onBack = { showBlockedUsers = false },
            onUnblock = { uid -> viewModel.unblockUserFromProfile(uid) }
        )
        return
    }
    if (showFeedbackScreen) {
        FeedbackScreen(
            viewModel = viewModel,
            onBack = { showFeedbackScreen = false },
        )
        return
    }
    if (showMyBagScreen) {
        MyBagScreen(
            onBack = { showMyBagScreen = false },
        )
        return
    }
    if (uiState.openProfileSheetForUserId != null) {
        val profileUserId = uiState.openProfileSheetForUserId!!
        val profileToShow = uiState.profiles.find { it.id == profileUserId }
            ?: uiState.openProfileSheetHintProfile
        LaunchedEffect(profileUserId) {
            viewModel.prefetchOpenedProfileFromServer(profileUserId)
            viewModel.startOpenedProfileListener(profileUserId)
        }
        if (profileToShow != null) {
            UserProfileScreen(
                profile = profileToShow,
                uiState = uiState,
                viewModel = viewModel,
                onBack = {
                    viewModel.clearOpenProfileSheetRequest()
                    viewModel.stopOpenedProfileListener()
                },
                onStartChat = {
                    viewModel.clearOpenProfileSheetRequest()
                    viewModel.setTab(2)
                },
                onStartCall = { isVideo ->
                    viewModel.clearOpenProfileSheetRequest()
                    viewModel.initiateCall(isVideo, profileUserId)
                },
                onJoinLive = {
                    viewModel.clearOpenProfileSheetRequest()
                    viewModel.watchLiveByHostId(profileUserId)
                }
            )
            return
        }
    }

    LaunchedEffect(uiState.selectedTab, uiState.watchingLivePartner?.id, uiState.isLive) {
        if (uiState.selectedTab == 1 &&
            uiState.watchingLivePartner != null &&
            !uiState.isLive
        ) {
            delay(420)
            WebRTCManager.activeManager()?.refreshVideoSinkAttachments("live_tab_reselected")
        }
        // Refresh like counts whenever Settings tab (4) is opened so the counts match LikesScreen
        if (uiState.selectedTab == 4) {
            viewModel.refreshILikedProfiles()
            viewModel.refreshLikedMeProfiles()
        }
    }
    // Back from live audience: minimize to PIP instead of stopping
    BackHandler(enabled = uiState.watchingLivePartner != null && !uiState.isLivePipMode) {
        viewModel.enterLivePipMode()
    }
    // Back while PIP is active: close PIP (exits live)
    BackHandler(enabled = uiState.isLivePipMode) {
        viewModel.exitLivePip()
    }
    BackHandler(enabled = uiState.openProfileSheetForUserId != null) {
        viewModel.clearOpenProfileSheetRequest()
        viewModel.stopOpenedProfileListener()
    }
    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val widthClass = maxWidth.toWindowWidthClass()
        val isCompact = widthClass == AppWindowWidthClass.Compact
        val chatThreads by viewModel.chatThreads.collectAsStateWithLifecycle()
        val totalUnreadMessages = remember(chatThreads) {
            val myUid = com.google.firebase.auth.FirebaseAuth.getInstance().currentUser?.uid.orEmpty()
            chatThreads.sumOf { thread -> thread.unreadCounts[myUid] ?: 0 }
        }
        val hideForPkAudience =
            uiState.watchingPkActive || uiState.watchingPkLingerSession != null
        val hideForPkHostOrBattler =
            uiState.pkBattleSession != null && uiState.webRtcShowLiveAudienceChrome
        // Nav chrome hidden when watching live full-screen, but VISIBLE when in PIP mode
        val hideNavChrome = (uiState.watchingLivePartner != null && !uiState.isLivePipMode) ||
            uiState.isLive ||
            hideForPkAudience ||
            hideForPkHostOrBattler

        CompositionLocalProvider(LocalWindowWidthClass provides widthClass) {
        Scaffold(
            modifier = Modifier.fillMaxSize(),
            contentWindowInsets = WindowInsets(0, 0, 0, 0),
            bottomBar = {
                if (isCompact && !hideNavChrome) {
                    MainBottomNavigation(
                        selectedTab = uiState.selectedTab,
                        onTabSelected = { viewModel.setTab(it) },
                        unreadCount = totalUnreadMessages
                    )
                } else {
                    Spacer(Modifier.height(0.dp))
                }
            }
        ) { padding ->
            Row(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
            ) {
                if (!isCompact && !hideNavChrome) {
                    MainNavigationRail(
                        selectedTab = uiState.selectedTab,
                        onTabSelected = { viewModel.setTab(it) },
                        unreadCount = totalUnreadMessages,
                    )
                    VerticalDivider(
                        modifier = Modifier.fillMaxHeight(),
                        thickness = 1.dp,
                        color = OutlineDefault,
                    )
                }
                Box(modifier = Modifier.weight(1f).fillMaxHeight()) {
                when (uiState.selectedTab) {
                    0 -> HomeScreen(
                        viewModel = viewModel,
                        onProfileClick = { userId -> viewModel.requestOpenProfileSheet(userId) },
                        onNotificationClick = { viewModel.setTab(2) },
                    )
                    1 -> when {
                        // ── Host: audio party room ───────────────────────────────────────
                        uiState.isLive && uiState.isAudioPartyLive -> {
                            val me = uiState.currentUser
                            AudioPartyStageLayout(
                                seatCount = uiState.audioPartySeatCount,
                                stream = uiState.audioPartyStream,
                                hostUserId = me?.id.orEmpty(),
                                myUserId = me?.id.orEmpty(),
                                isHost = true,
                                title = "Party Room",
                                subtitle = me?.name.orEmpty(),
                                hostDisplayName = me?.name.orEmpty(),
                                hostPhotoUrl = me?.photoUrl.orEmpty(),
                                hostProfileNumber = me?.profileNumber.orEmpty(),
                                hostBeans = me?.beans ?: 0,
                                hostHasBlueTick = me?.hasBlueTick ?: false,
                                showSeatCountControls = true,
                                onSeatCountSelected = { viewModel.setAudioPartySeatCount(it) },
                                onClaimSeat = { seatIdx ->
                                    viewModel.claimAudioPartySeat(me?.id.orEmpty(), seatIdx)
                                },
                                onLeaveSeat = { seatIdx ->
                                    viewModel.leaveAudioPartySeat(me?.id.orEmpty(), seatIdx)
                                },
                                onHostSeatAction = { action ->
                                    viewModel.hostAudioPartySeatAction(me?.id.orEmpty(), action)
                                },
                                onToggleMySeatMic = { /* no-op: host always unmuted */ },
                                onMergeNowPlaying = { t, a ->
                                    viewModel.mergeAudioPartyNowPlayingForHost(t, a)
                                },
                                onSendStageEmoji = { viewModel.sendAudioPartyStageEmoji(it) },
                                showTopQuickEmojis = true,
                                onEndParty = { viewModel.toggleLive() },
                            )
                            // Wire Agora audio — host joins as broadcaster
                            AgoraAudioPartyRtcLayer(
                                channelId = uiState.currentRoomId.orEmpty(),
                                firebaseUid = me?.id.orEmpty(),
                                joinAsBroadcaster = true,
                                micPermissionGranted = true,
                                token = null,
                                signalHostStreamReady = false,
                                onEngineReady = {},
                            )
                        }
                        // ── Host: solo video live ────────────────────────────────────────
                        uiState.isLive -> {
                            LiveBroadcastScreen(
                                viewModel = viewModel,
                                streamId = uiState.currentRoomId.orEmpty(),
                                rtcEngine = null,
                                onEndLive = { onToggleLive(false) },
                                onStartPk = { /* PK initiated from within LiveBroadcastScreen */ },
                                onOpenGames = onShowGameCenter,
                            )
                        }
                        // ── Audience: audio party room ───────────────────────────────────
                        uiState.watchingLivePartner != null && uiState.watchingLiveStreamIsAudioOnly && !uiState.isLivePipMode -> {
                            val partner = uiState.watchingLivePartner!!
                            val myId = uiState.currentUser?.id.orEmpty()
                            AudioPartyStageLayout(
                                seatCount = uiState.watchingLiveAudioPartySeatCount,
                                stream = uiState.audioPartyStream,
                                hostUserId = partner.id,
                                myUserId = myId,
                                isHost = false,
                                title = partner.name,
                                subtitle = "",
                                hostDisplayName = partner.name,
                                hostPhotoUrl = partner.photoUrl,
                                hostProfileNumber = partner.profileNumber,
                                hostBeans = partner.beans,
                                hostHasBlueTick = partner.hasBlueTick,
                                showSeatCountControls = false,
                                onSeatCountSelected = {},
                                onClaimSeat = { seatIdx ->
                                    viewModel.claimAudioPartySeat(partner.id, seatIdx)
                                },
                                onLeaveSeat = { seatIdx ->
                                    viewModel.leaveAudioPartySeat(partner.id, seatIdx)
                                },
                                onToggleMySeatMic = { publishing ->
                                    viewModel.setMyAudioPartySeatPublishing(partner.id, publishing)
                                },
                                onLeave = { viewModel.stopWatching() },
                            )
                            // Wire Agora audio — audience joins as listener
                            AgoraAudioPartyRtcLayer(
                                channelId = partner.id,
                                firebaseUid = myId,
                                joinAsBroadcaster = false,
                                micPermissionGranted = false,
                                token = null,
                                signalHostStreamReady = false,
                                onEngineReady = {},
                            )
                        }
                        // ── Audience: full-screen live viewer ────────────────────────────
                        uiState.watchingLivePartner != null && !uiState.isLivePipMode -> {
                            val partner = uiState.watchingLivePartner!!
                            LiveViewerScreen(
                                viewModel = viewModel,
                                streamId = partner.id,
                                hostUid = 0,   // 0 = subscribe to first publisher in channel
                                rtcEngine = null,
                                onLeave = { viewModel.enterLivePipMode() },
                            )
                        }
                        // ── Default: live discovery grid ─────────────────────────────────
                        else -> LiveScreen(
                            viewModel = viewModel,
                            onJoinLive = { streamId -> viewModel.watchLive(com.zipper.datingapp.data.UserProfile(id = streamId)) },
                            onJoinParty = { roomId -> viewModel.watchLive(com.zipper.datingapp.data.UserProfile(id = roomId)) },
                            onGoLive = { onToggleLive(false) },
                            onGoParty = { onToggleLive(true) },
                        )
                    }
                    2 -> {
                    // Refresh the inbox thread list whenever the Messages tab becomes active
                    // (guards against the race where scheduleGlobalInboxPrefetch ran at login
                    // before the user had any messages, leaving the list blank until first reply).
                    LaunchedEffect(Unit) { viewModel.refreshMessageInbox() }
                    MessagesScreen(
                        viewModel = viewModel,
                        onOpenProfile = { userId -> viewModel.requestOpenProfileSheet(userId) },
                    )
                    } // end tab 2 block
                    3 -> GamesScreen(
                        viewModel = viewModel,
                        onBack = { viewModel.setTab(0) },
                    )
                    4 -> ProfileScreen(
                        uiState = uiState,
                        onEditProfile = onEditProfile,
                        onLogout = { viewModel.logout(appContext) },
                        onDeleteAccount = { viewModel.deleteAccount() },
                        onThemeToggle = onCycleTheme,
                        onBeansCenterClick = { showBeansCenter = true },
                        onBrowseForVideoCalls = { showCallHistory = true },
                        onOpenInboxForGifts = { viewModel.setTab(2) },
                        onDiamondShopClick = { showDiamondHistory = true },
                        onRewardsClick = { viewModel.showRewards() },
                        onClaimReward = { viewModel.claimDailyReward() },
                        onDismissRewards = { viewModel.toggleRewardsDialog(false) },
                        onLanguageChange = { lang ->
                            viewModel.updateLanguage(lang)
                            onPersistLanguage(lang)
                        },
                        onConvertDiamonds = { viewModel.convertDiamondsToBeans(it) },
                        onVerifyProfile = { onRequireFaceVerification {} },
                        onGameCenterClick = onShowGameCenter,
                        onSetCustomPrice = onShowCustomPrice,
                        onUnblockUser = { viewModel.unblockUserFromProfile(it) },
                        onLoadMyGiftHistory = {
                            viewModel.fetchMySentGiftHistory()
                            viewModel.fetchMyReceivedGiftHistory()
                        },
                        onShowMyProfile = {
                            viewModel.refreshILikedProfiles()
                            viewModel.refreshLikedMeProfiles()
                            viewModel.fetchMySentGiftHistory()
                            viewModel.fetchMyReceivedGiftHistory()
                            showMyProfile = true
                        },
                        onShowLikesILike = {
                            likesInitialTab = 0
                            showLikesScreen = true
                            viewModel.refreshILikedProfiles()
                            viewModel.refreshLikedMeProfiles()
                        },
                        onShowLikesLikeMe = {
                            likesInitialTab = 1
                            showLikesScreen = true
                            viewModel.refreshILikedProfiles()
                            viewModel.refreshLikedMeProfiles()
                        },
                        onShowBlockedUsers = { showBlockedUsers = true },
                        onRefreshLikeCounts = {
                            viewModel.refreshILikedProfiles()
                            viewModel.refreshLikedMeProfiles()
                        },
                        onFeedbackClick = { showFeedbackScreen = true },
                        onMyBagClick    = { showMyBagScreen = true },
                    )
                }

                if (uiState.currentUser?.isGuest == true || uiState.isGuest) {
                    Surface(
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .padding(top = 10.dp, end = 12.dp),
                        color = Color(0x99FFD54F),
                        shape = RoundedCornerShape(14.dp)
                    ) {
                        Text(
                            text = "Preview",
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                            color = Color.Black,
                            fontWeight = FontWeight.Bold,
                            fontSize = 11.sp
                        )
                    }
                }
                }   // Box(weight(1f))
            }       // Row
        }           // Scaffold content lambda
        }           // CompositionLocalProvider

        // ── Global floating live PIP ──────────────────────────────────────────
        // Shown when user minimises a live stream — floats over every screen in the app.
        val pipPartner = uiState.watchingLivePartner
        if (uiState.isLivePipMode && pipPartner != null) {
            GlobalLivePip(
                partner = pipPartner,
                viewerFirebaseUid = uiState.currentUser?.id.orEmpty(),
                onGetAgoraToken = { ch, pub -> viewModel.getAgoraToken(ch, pub) },
                onRestore = { viewModel.restoreFromLivePip() },
                onClose   = { viewModel.exitLivePip() }
            )
        }
    }               // BoxWithConstraints
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun WelcomeVerificationSheet(
    onDismiss: () -> Unit,
    onVerifyNow: () -> Unit
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = Color(0xFF15151F),
        contentColor = Color.White
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(24.dp)
                .padding(bottom = 16.dp)
        ) {
            Text("Welcome to DatingApp", fontSize = 24.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(8.dp))
            Text(
                "Get your Blue Tick to get 5x more matches and unlock trusted calls.",
                color = Color.White.copy(alpha = 0.8f)
            )
            Spacer(Modifier.height(20.dp))
            Button(
                onClick = onVerifyNow,
                modifier = Modifier.fillMaxWidth().height(52.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF4FC3F7))
            ) {
                Text("Verify Now", fontWeight = FontWeight.Bold, color = Color.Black)
            }
            Spacer(Modifier.height(8.dp))
            TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) {
                Text("Maybe later", color = Color.White.copy(alpha = 0.7f))
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LoginRequiredBottomSheet(
    onDismiss: () -> Unit,
    onLoginNow: () -> Unit
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = Color(0xFF15151F),
        contentColor = Color.White
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(24.dp)
                .padding(bottom = 16.dp)
        ) {
            Text("Get Full Access", fontSize = 22.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(8.dp))
            Text(
                "Enjoying Zipper? Log in now to start calling and sending gifts!",
                color = Color.White.copy(alpha = 0.8f)
            )
            Spacer(Modifier.height(20.dp))
            Button(
                onClick = onLoginNow,
                modifier = Modifier.fillMaxWidth().height(52.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFFF6B9D))
            ) {
                Text("Continue with Phone", fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.height(10.dp))
            OutlinedButton(
                onClick = onLoginNow,
                modifier = Modifier.fillMaxWidth().height(52.dp),
                border = androidx.compose.foundation.BorderStroke(1.dp, Color.White.copy(alpha = 0.25f)),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Color.White)
            ) {
                Text("Continue with Google", fontWeight = FontWeight.Medium)
            }
            Spacer(Modifier.height(8.dp))
            TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) {
                Text("Not now", color = Color.White.copy(alpha = 0.7f))
            }
        }
    }
}

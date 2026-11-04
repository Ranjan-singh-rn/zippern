package com.zipper.app.ui.screens.live

import android.app.Activity
import android.app.PictureInPictureParams
import android.graphics.Bitmap
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Rational
import android.view.PixelCopy
import android.view.SurfaceView
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.Videocam
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.accompanist.permissions.ExperimentalPermissionsApi
import com.google.accompanist.permissions.rememberMultiplePermissionsState
import com.zipper.app.data.model.GiftLeaderboardEntry
import com.zipper.app.data.model.LiveComment
import com.zipper.app.data.model.ViewerPresence
import com.zipper.app.ui.components.*
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import kotlinx.coroutines.delay

/*
 * Go live (host) — Figma "03 Go live" (45:230) and "09 Host / 03 Go live —
 * broadcasting" (110:54).
 *
 *   Pre-live: camera preview full-bleed, back disc, bottom sheet-like panel
 *   with title field, category pills and the gradient "Go Live" CTA.
 *   Broadcasting: same chrome as the viewer room — host pill (LIVE dot,
 *   timer), beans-earned pill, viewers chip, end (coral) — right rail with
 *   PK · Share · Mic · Call-shield · PIP, comments, host input.
 *   Face-absence overlay counts down to auto-end (moderation, unchanged).
 */

private val categories = listOf("general", "music", "dance", "gaming", "talk")

@OptIn(ExperimentalPermissionsApi::class)
@Composable
fun GoLiveScreen(
    onBack: () -> Unit = {},
    /**
     * Where the stream's own numbers leave this screen. Three of them used to
     * travel as positional arguments and the two the summary card also needed —
     * the audience and the gifters — had nowhere to sit, so the call site
     * invented a 0 and an empty list for them. [LiveSessionSummary] is a single
     * value, so a figure the card shows cannot be forgotten on the way.
     */
    onLiveEnded: (summary: LiveSessionSummary) -> Unit = {},
    onOpenProfile: (uid: String) -> Unit = {},
    viewModel: GoLiveViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    val context = LocalContext.current
    val activity = context as? Activity

    val permissions = rememberMultiplePermissionsState(listOf(android.Manifest.permission.CAMERA, android.Manifest.permission.RECORD_AUDIO))
    if (!permissions.allPermissionsGranted) {
        PermissionRationale(onRequest = { permissions.launchMultiplePermissionRequest() }, onBack = onBack)
        return
    }

    val snackbar = remember { SnackbarHostState() }
    val localSurface = remember { SurfaceView(context) }
    var showEnd by remember { mutableStateOf(false) }
    var showViewers by remember { mutableStateOf(false) }
    var showShare by remember { mutableStateOf(false) }
    // B12: the pin editor and a comment the host is about to delete.
    var showPin by remember { mutableStateOf(false) }
    var commentToDelete by remember { mutableStateOf<LiveComment?>(null) }

    // ── PIP ────────────────────────────────────────────────────────────────
    var isInPip by remember { mutableStateOf(false) }
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME || event == Lifecycle.Event.ON_PAUSE) {
                isInPip = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && activity?.isInPictureInPictureMode == true
            }
            if (event == Lifecycle.Event.ON_STOP && isInPip && state.isLive) {
                // Read the figures before ending: endLive tears the session down.
                val summary = viewModel.sessionSummary(); viewModel.endLive(); onLiveEnded(summary)
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    // Engine + preview from the first frame, so the host sees themselves while
    // they write the title — not a black screen until "Go Live".
    LaunchedEffect(Unit) {
        AgoraManager.init(context)
        AgoraManager.setupLocalVideo(localSurface)
        FaceDetectionManager.init()
        FaceDetectionManager.onFaceDetected = { viewModel.reportFaceDetected(it) }
    }
    /*
     * Keyed on cameraEpoch as well as isLive.
     *
     * When a PK battle ends the ViewModel takes the engine out of the battle
     * channel, and `AgoraManager.leaveChannel` puts the capture down with it —
     * the camera belongs to the broadcast there, not to the channel. Without a
     * re-bind the host comes back from a battle publishing a stopped camera and
     * looking at a frozen preview, with nothing on screen to explain it.
     */
    LaunchedEffect(state.isLive, state.cameraEpoch) { if (state.isLive) AgoraManager.setupLocalVideo(localSurface) }

    // Face presence, sampled every 3s while live
    LaunchedEffect(state.isLive) {
        if (!state.isLive) return@LaunchedEffect
        while (true) {
            delay(3000)
            try {
                // O10: a quarter-size frame is plenty to find a face, and a sixteenth of the memory every 3 s.
                val bmp = Bitmap.createBitmap((localSurface.width / 4).coerceAtLeast(64), (localSurface.height / 4).coerceAtLeast(64), Bitmap.Config.ARGB_8888)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    PixelCopy.request(localSurface, bmp, { r -> if (r == PixelCopy.SUCCESS) FaceDetectionManager.analyzeFrame(bmp) }, Handler(Looper.getMainLooper()))
                } else viewModel.reportFaceDetected(true)
            } catch (_: Exception) { viewModel.reportFaceDetected(true) }
        }
    }
    LaunchedEffect(state.error) { state.error?.takeIf { it.isNotBlank() }?.let { snackbar.showSnackbar(it); viewModel.clearError() } }
    // B12: the PK verdict and other one-off lines.
    LaunchedEffect(state.notice) { state.notice?.let { snackbar.showSnackbar(it); viewModel.clearNotice() } }
    /*
     * Put the camera down on the way out.
     *
     * This used to clear one callback and nothing else. The preview starts the
     * moment this screen composes — before the host has decided to go live at
     * all — so backing out of Go Live without streaming left the camera
     * capturing and the ML-Kit face detector running for the rest of the
     * process. Visible privacy indicator, battery, heat, and a camera the call
     * screen may then fail to acquire.
     *
     * `stopPreview` rather than `release`: the engine is a process-wide
     * singleton shared with calls and party rooms, and destroying it here would
     * pull the floor out from under whatever the user opens next. The capture
     * is the part that belongs to this screen, and it is the part released.
     */
    DisposableEffect(Unit) {
        onDispose {
            FaceDetectionManager.onFaceDetected = null
            FaceDetectionManager.release()
            AgoraManager.stopPreview()
        }
    }

    val listState = rememberLazyListState()
    LaunchedEffect(state.comments.size) { if (state.comments.isNotEmpty()) listState.animateScrollToItem(state.comments.size - 1) }

    Box(Modifier.fillMaxSize().background(c.bgBase)) {
        AndroidView(factory = { localSurface }, modifier = Modifier.fillMaxSize())
        if (isInPip) return@Box

        Box(Modifier.fillMaxWidth().height(220.dp).background(Brush.verticalGradient(listOf(Color(0xC7070812), Color(0x4D070812), Color.Transparent))))
        Box(Modifier.fillMaxWidth().height(360.dp).align(Alignment.BottomCenter).background(Brush.verticalGradient(listOf(Color.Transparent, Color(0x59070812), Color(0xE5070812)))))

        if (!state.isLive) {
            PreLive(
                title = state.title, category = state.category, loading = state.isLoading,
                onTitle = viewModel::onTitleChange, onCategory = viewModel::onCategoryChange,
                onGoLive = { viewModel.startLive(context) }, onBack = onBack,
                onFlip = { AgoraManager.switchCamera() },
            )
        } else {
            if (state.pkState == PKState.ACTIVE) {
                PKBattleOverlay(
                    myName = state.myName, myPhotoUrl = state.myPhotoUrl, myScore = state.pkScore,
                    partnerName = state.pkPartnerName, partnerPhotoUrl = state.pkPartnerPhotoUrl, partnerScore = state.pkPartnerScore,
                    pkEndTime = state.pkEndTime, onPKEnd = viewModel::onPKEnd,
                    modifier = Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = 100.dp),
                )
            }

            // ── Header ─────────────────────────────────────────────────────
            Column(Modifier.fillMaxWidth().statusBarsPadding().padding(top = Space.sm), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                Row(Modifier.fillMaxWidth().height(48.dp).padding(horizontal = Space.md), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    Row(
                        Modifier.height(40.dp).background(c.glassMid, CircleShape).border(1.dp, c.glassMid, CircleShape).padding(start = 2.dp, end = 12.dp, top = 2.dp, bottom = 2.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm),
                    ) {
                        Avatar(state.myPhotoUrl, size = AvatarSize.SM, ring = AvatarRing.Live, initial = state.myName)
                        Column {
                            Text(state.myName.ifBlank { "You" }, style = ZipperTheme.type.labelS, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 110.dp))
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                LiveBadge(LiveBadgeKind.Live)
                                LiveClock(viewModel.duration)
                            }
                        }
                    }
                    Spacer(Modifier.weight(1f))
                    CurrencyPill(Currency.Bean, state.totalBeansSession)
                    Box(Modifier.size(36.dp).background(c.statusDanger, CircleShape).clickableNoRipple { showEnd = true }, contentAlignment = Alignment.Center) {
                        Icon(Icons.Default.Close, "End live", tint = Color.White, modifier = Modifier.size(20.dp))
                    }
                }
                Row(Modifier.padding(horizontal = Space.md), horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
                    // The presence list, not room.viewerCount — the badge and
                    // the sheet it opens must not disagree.
                    Box(Modifier.clickableNoRipple { showViewers = true }) { GlassChip(Icons.Default.People, "${compactCount(maxOf(state.viewers.size, state.viewerCount).toLong())} watching") }
                    GlassChip(Icons.Default.CardGiftcard, compactCount(state.totalGiftsReceived))
                    if (state.callProtectionEnabled) Chip("Calls off", tint = c.tintGoldSubtle, contentColor = c.brandVip)
                    // B12: what the viewers see right now.
                    if (state.isPaused) Chip("Paused", tint = c.tintDangerSubtle, contentColor = c.statusWarning)
                    if (!state.isCameraOn && !state.isPaused) Chip("Camera off", tint = c.tintDangerSubtle, contentColor = c.statusWarning)
                }
                // B12: the host's own connection, from the engine.
                when (state.link) {
                    AgoraManager.Link.Reconnecting -> Chip(LiveRoomUi.RECONNECTING, tint = c.tintBrandMedium, contentColor = c.textPrimary, modifier = Modifier.padding(horizontal = Space.md))
                    AgoraManager.Link.Failed -> Chip(LiveRoomUi.CONNECTION_LOST, tint = c.tintDangerSubtle, contentColor = c.statusDanger, modifier = Modifier.padding(horizontal = Space.md))
                    else -> Unit
                }
                if (state.pinnedMessage.isNotBlank()) {
                    Row(
                        Modifier.padding(horizontal = Space.md).fillMaxWidth(0.8f)
                            .background(c.scrimMedium, RoundedCornerShape(Radius.md)).border(1.dp, c.glassMid, RoundedCornerShape(Radius.md))
                            .clickableNoRipple { showPin = true }.padding(horizontal = Space.md, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm),
                    ) {
                        Icon(Icons.Default.PushPin, null, tint = c.brandVip, modifier = Modifier.size(14.dp))
                        Text(state.pinnedMessage, style = ZipperTheme.type.bodyS, color = c.textPrimary, maxLines = 3, overflow = TextOverflow.Ellipsis)
                    }
                }
            }

            // ── Face absence ───────────────────────────────────────────────
            AnimatedVisibility(!state.faceDetected, enter = fadeIn(), exit = fadeOut()) {
                Box(Modifier.fillMaxSize().background(c.scrimStrong), contentAlignment = Alignment.Center) {
                    Column(Modifier.padding(Space.x3l), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                        Box(Modifier.size(64.dp).background(c.tintDangerSubtle, CircleShape), contentAlignment = Alignment.Center) { Icon(Icons.Default.FaceRetouchingOff, null, tint = c.statusDanger, modifier = Modifier.size(32.dp)) }
                        Text("We can't see you", style = ZipperTheme.type.headingM, color = c.textPrimary, textAlign = TextAlign.Center)
                        Text("Come back in front of the camera to keep the live going.", style = ZipperTheme.type.bodyM, color = c.textSecondary, textAlign = TextAlign.Center)
                        Text("Ends in ${state.faceAbsenceCountdown}s", style = ZipperTheme.type.displayM, color = c.statusDanger)
                    }
                }
            }

            // ── Right rail ─────────────────────────────────────────────────
            Column(Modifier.align(Alignment.CenterEnd).padding(end = Space.md, top = 80.dp), verticalArrangement = Arrangement.spacedBy(Space.lg), horizontalAlignment = Alignment.CenterHorizontally) {
                Rail(Icons.Default.SportsKabaddi, if (state.pkState == PKState.WAITING) "Finding…" else "PK", tint = c.brandSecondary, enabled = state.pkState == PKState.IDLE, onClick = viewModel::findPKMatch)
                Rail(Icons.Default.Share, "Share") { showShare = true }
                Rail(if (state.isMicOn) Icons.Default.Mic else Icons.Default.MicOff, if (state.isMicOn) "Mute" else "Unmute", tint = if (state.isMicOn) c.textPrimary else c.statusWarning, onClick = viewModel::toggleMic)
                Rail(Icons.Default.FlipCameraAndroid, "Flip") { AgoraManager.switchCamera() }
                // B12: camera off / on, pause / resume, and the pinned message.
                Rail(if (state.isCameraOn) Icons.Default.Videocam else Icons.Default.VideocamOff, if (state.isCameraOn) "Camera" else "Cam off", tint = if (state.isCameraOn) c.textPrimary else c.statusWarning, onClick = viewModel::toggleCamera)
                Rail(if (state.isPaused) Icons.Default.PlayArrow else Icons.Default.Pause, if (state.isPaused) "Resume" else "Pause", tint = if (state.isPaused) c.statusWarning else c.textPrimary, onClick = viewModel::togglePause)
                Rail(Icons.Default.PushPin, "Pin") { showPin = true }
                Rail(if (state.callProtectionEnabled) Icons.Default.PhoneDisabled else Icons.Default.Phone, if (state.callProtectionEnabled) "Calls off" else "Calls on", tint = if (state.callProtectionEnabled) c.brandVip else c.textPrimary, onClick = viewModel::toggleCallProtection)
                Rail(Icons.Default.PictureInPicture, "PIP") {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) activity?.enterPictureInPictureMode(PictureInPictureParams.Builder().setAspectRatio(Rational(9, 16)).build())
                }
            }

            // ── Bottom ─────────────────────────────────────────────────────
            Column(
                Modifier.fillMaxWidth().align(Alignment.BottomCenter).navigationBarsPadding().imePadding().padding(start = Space.md, end = Space.md, bottom = Space.sm),
                verticalArrangement = Arrangement.spacedBy(Space.sm),
            ) {
                state.recentGifts.firstOrNull()?.let { g -> GiftEventPill(g.senderName, g.giftName, g.quantity, null) }
                LazyColumn(state = listState, modifier = Modifier.fillMaxWidth(0.78f).heightIn(max = 150.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    // B12: a long press on a comment offers to delete it.
                    items(state.comments, key = { it.id }) { cm ->
                        Box(Modifier.pointerInput(cm.id) { detectTapGestures(onLongPress = { if (!cm.isJoin) commentToDelete = cm }) }) {
                            HostCommentPill(cm)
                        }
                    }
                }
                Row(
                    Modifier.fillMaxWidth().height(44.dp).background(c.scrimMedium, CircleShape).border(1.dp, c.glassMid, CircleShape).padding(start = 16.dp, end = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    BasicTextField(
                        value = state.commentInput, onValueChange = viewModel::onCommentInput, singleLine = true,
                        textStyle = ZipperTheme.type.bodyS.copy(color = c.textPrimary), cursorBrush = SolidColor(c.brandPrimary),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send), keyboardActions = KeyboardActions(onSend = { viewModel.sendComment() }),
                        modifier = Modifier.weight(1f),
                        decorationBox = { inner -> if (state.commentInput.isEmpty()) Text("Chat with viewers…", style = ZipperTheme.type.bodyS, color = c.textMuted); inner() },
                    )
                    Icon(Icons.AutoMirrored.Filled.Send, "Send", tint = if (state.commentInput.isBlank()) c.textMuted else c.brandPrimary, modifier = Modifier.size(20.dp).clickableNoRipple { viewModel.sendComment() })
                }
            }

            state.recentGifts.firstOrNull()?.let { GiftAnimationOverlay(giftEvent = it, onDismiss = viewModel::dismissGift) }
        }

        SnackbarHost(snackbar, Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = 120.dp)) { data ->
            Snackbar(snackbarData = data, containerColor = c.bgElevated, contentColor = c.textPrimary)
        }
    }

    // ── Dialogs & sheets ───────────────────────────────────────────────────
    if (showEnd) {
        AlertDialog(
            onDismissRequest = { showEnd = false }, containerColor = c.bgElevated,
            title = { Text("End live?", style = ZipperTheme.type.headingS, color = c.textPrimary) },
            text = { Text("Your viewers will be disconnected. You've earned ${indianGrouping(state.totalBeansSession)} beans this session.", style = ZipperTheme.type.bodyM, color = c.textSecondary) },
            confirmButton = { TextButton({ showEnd = false; val summary = viewModel.sessionSummary(); viewModel.endLive(); onLiveEnded(summary) }) { Text("End live", color = c.statusDanger) } },
            dismissButton = { TextButton({ showEnd = false }) { Text("Keep going", color = c.textSecondary) } },
        )
    }
    // B2: the room was ended from outside (staff End). The broadcast has
    // already stopped; tell the host why, then show the session summary.
    if (state.endedRemotely) {
        AlertDialog(
            onDismissRequest = {}, containerColor = c.bgElevated,
            title = { Text("Live ended", style = ZipperTheme.type.headingS, color = c.textPrimary) },
            text = { Text(state.remoteEndMessage, style = ZipperTheme.type.bodyM, color = c.textSecondary) },
            confirmButton = { TextButton({ onLiveEnded(viewModel.sessionSummary()) }) { Text("OK", color = c.textBrand) } },
        )
    }
    if (state.pkState == PKState.WAITING) PKSearchingDialog(onCancel = viewModel::cancelPKSearch)
    if (state.pkState == PKState.INVITED) state.pkInvite?.let { PKMatchFoundDialog(invite = it, myUid = state.myUid, onAccept = viewModel::acceptPKInvite, onReject = viewModel::rejectPKInvite) }
    // B12: the pinned message editor.
    if (showPin) {
        var draft by remember { mutableStateOf(state.pinnedMessage) }
        AlertDialog(
            onDismissRequest = { showPin = false }, containerColor = c.bgElevated,
            title = { Text("Pinned message", style = ZipperTheme.type.headingS, color = c.textPrimary) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(Space.xs)) {
                    OutlinedTextField(
                        value = draft, onValueChange = { draft = it.take(LiveRoomUi.PINNED_MAX) },
                        placeholder = { Text("e.g. PK at 9 pm — top gifter gets a shout-out!") },
                        maxLines = 4,
                    )
                    Text("${draft.length}/${LiveRoomUi.PINNED_MAX}", style = ZipperTheme.type.caption, color = c.textMuted)
                }
            },
            confirmButton = { TextButton({ showPin = false; viewModel.setPinnedMessage(draft) }) { Text("Pin", color = c.textBrand) } },
            dismissButton = {
                TextButton({ showPin = false; viewModel.setPinnedMessage("") }) { Text(if (state.pinnedMessage.isBlank()) "Cancel" else "Remove pin", color = c.textSecondary) }
            },
        )
    }
    // B12: delete a viewer's comment (asked first).
    commentToDelete?.let { cm ->
        AlertDialog(
            onDismissRequest = { commentToDelete = null }, containerColor = c.bgElevated,
            title = { Text("Delete this comment?", style = ZipperTheme.type.headingS, color = c.textPrimary) },
            text = { Text("${cm.name}: ${cm.message}", style = ZipperTheme.type.bodyM, color = c.textSecondary, maxLines = 4) },
            confirmButton = { TextButton({ commentToDelete = null; viewModel.deleteComment(cm.id) }) { Text("Delete", color = c.statusDanger) } },
            dismissButton = { TextButton({ commentToDelete = null }) { Text("Cancel", color = c.textSecondary) } },
        )
    }
    if (showViewers) ViewerManagementSheet(
        viewers = state.viewers,
        leaderboard = state.giftLeaderboard,
        kickPending = state.kickPending,
        mutedViewers = state.mutedViewers,
        onToggleMute = viewModel::toggleMuteViewer,
        onBlock = viewModel::blockViewer,
        onKick = viewModel::kickViewer,
        onOpenProfile = { uid -> showViewers = false; onOpenProfile(uid) },
        onDismiss = { showViewers = false },
    )
    if (showShare && state.isLive) LiveShareSheet(roomId = state.roomId, hostName = state.myName, onDismiss = { showShare = false })
}

// ── Pre-live ─────────────────────────────────────────────────────────────────

@Composable
private fun PreLive(
    title: String, category: String, loading: Boolean,
    onTitle: (String) -> Unit, onCategory: (String) -> Unit, onGoLive: () -> Unit, onBack: () -> Unit, onFlip: () -> Unit,
) {
    val c = ZipperTheme.colors
    Box(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().statusBarsPadding().padding(Space.xs), horizontalArrangement = Arrangement.SpaceBetween) {
            IconButtonCircle(Icons.AutoMirrored.Filled.ArrowBack, "Back", onBack, size = 36.dp, background = c.scrimMedium)
            IconButtonCircle(Icons.Default.FlipCameraAndroid, "Flip camera", onFlip, size = 36.dp, background = c.scrimMedium)
        }
        Column(
            Modifier.fillMaxWidth().align(Alignment.BottomCenter).navigationBarsPadding().imePadding()
                .padding(Space.lg)
                .background(c.bgElevated.copy(alpha = 0.92f), RoundedCornerShape(Radius.xl)).border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.xl))
                .padding(Space.xl),
            verticalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            Text("Set up your live", style = ZipperTheme.type.headingM, color = c.textPrimary)
            Row(
                Modifier.fillMaxWidth().height(52.dp).background(c.bgBase, RoundedCornerShape(Radius.lg)).border(1.dp, c.borderDefault, RoundedCornerShape(Radius.lg)).padding(horizontal = Space.lg),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BasicTextField(
                    value = title, onValueChange = { if (it.length <= 60) onTitle(it) }, singleLine = true,
                    textStyle = ZipperTheme.type.bodyL.copy(color = c.textPrimary), cursorBrush = SolidColor(c.brandPrimary), modifier = Modifier.weight(1f),
                    decorationBox = { inner -> if (title.isEmpty()) Text("What's happening tonight?", style = ZipperTheme.type.bodyL, color = c.textMuted); inner() },
                )
                Text("${title.length}/60", style = ZipperTheme.type.caption, color = c.textMuted)
            }
            LazyRow(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                items(categories) { cat ->
                    val on = category == cat
                    Box(
                        Modifier.height(32.dp)
                            .then(if (on) Modifier.background(Brush.horizontalGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), CircleShape) else Modifier.background(c.glassLow, CircleShape).border(1.dp, c.borderDefault, CircleShape))
                            .clickableNoRipple { onCategory(cat) }.padding(horizontal = Space.lg),
                        contentAlignment = Alignment.Center,
                    ) { Text(cat.replaceFirstChar { it.uppercase() }, style = ZipperTheme.type.labelS, color = if (on) Color.White else c.textSecondary) }
                }
            }
            Text("Stay in frame — the live ends automatically if you leave the camera for 2 minutes.", style = ZipperTheme.type.caption, color = c.textMuted)
            ZipperButton("Go Live", onGoLive, gradient = true, fullWidth = true, loading = loading, enabled = !loading, icon = Icons.Outlined.Videocam)
        }
    }
}

@Composable
private fun PermissionRationale(onRequest: () -> Unit, onBack: () -> Unit) {
    val c = ZipperTheme.colors
    Column(Modifier.fillMaxSize().background(c.bgBase).statusBarsPadding()) {
        TopBar("Go Live", onBack = onBack)
        EmptyState(Icons.Outlined.Videocam, "Camera and microphone", "Going live needs both so viewers can see and hear you. Nothing is recorded by Zipper.", actionLabel = "Allow access", onAction = onRequest)
    }
}

// ── Pieces ───────────────────────────────────────────────────────────────────

@Composable
private fun Rail(icon: ImageVector, label: String, tint: Color = ZipperTheme.colors.textPrimary, enabled: Boolean = true, onClick: () -> Unit) {
    val c = ZipperTheme.colors
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        IconButtonCircle(icon, label, onClick, size = 48.dp, background = c.glassMid, tint = tint, enabled = enabled)
        Text(label, style = ZipperTheme.type.caption, color = c.textPrimary)
    }
}

@Composable
private fun HostCommentPill(comment: LiveComment) {
    val c = ZipperTheme.colors
    Row(Modifier.background(c.scrimMedium, CircleShape).padding(horizontal = 12.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        if (comment.isJoin) {
            Text(comment.name, style = ZipperTheme.type.labelS, color = c.textBrand, maxLines = 1)
            Text(" joined", style = ZipperTheme.type.bodyS, color = c.textSecondary)
        } else {
            Text("${comment.name}:", style = ZipperTheme.type.labelS, color = c.brandVip, maxLines = 1)
            Text(comment.message, style = ZipperTheme.type.bodyS, color = c.textPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** Kept for other callers (the old shared name). */
@Composable
fun LiveCommentBubble(comment: LiveComment) = HostCommentPill(comment)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ViewerManagementSheet(
    viewers: List<ViewerPresence>,
    leaderboard: List<GiftLeaderboardEntry>,
    kickPending: Set<String>,
    /** B12: viewers muted in the chat, and the mute / block actions. */
    mutedViewers: Set<String> = emptySet(),
    onToggleMute: (String) -> Unit = {},
    onBlock: (String) -> Unit = {},
    onKick: (String) -> Unit,
    onOpenProfile: (String) -> Unit = {},
    onDismiss: () -> Unit,
) {
    val c = ZipperTheme.colors
    var tab by remember { mutableIntStateOf(0) }
    /*
     * Removing somebody is irreversible for the rest of the broadcast: their uid
     * goes into the room's kickedViewers, the token server refuses them from
     * then on, and there is no un-kick anywhere in the app. Remove was a
     * one-tap button sitting inside the row that opens a profile, so a mis-tap
     * ejected a viewer — very possibly the night's biggest gifter — for good,
     * with no dialog and nothing to undo it.
     */
    var confirmKick by remember { mutableStateOf<ViewerPresence?>(null) }
    var confirmBlock by remember { mutableStateOf<ViewerPresence?>(null) }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = c.bgElevated, dragHandle = null, shape = RoundedCornerShape(topStart = Radius.xl, topEnd = Radius.xl)) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = Space.md)) {
            Box(Modifier.padding(top = 6.dp).size(36.dp, 4.dp).background(c.borderDefault, CircleShape).align(Alignment.CenterHorizontally))
            Row(Modifier.padding(Space.lg).fillMaxWidth().height(38.dp).background(c.bgRaised, CircleShape).padding(2.dp), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                listOf("Viewers · ${viewers.size}", "Top gifters").forEachIndexed { i, t ->
                    val on = tab == i
                    Box(Modifier.weight(1f).fillMaxHeight().then(if (on) Modifier.background(Brush.horizontalGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), CircleShape) else Modifier).clickableNoRipple { tab = i }, contentAlignment = Alignment.Center) {
                        Text(t, style = ZipperTheme.type.labelM, color = if (on) Color.White else c.textMuted)
                    }
                }
            }
            HairlineDivider()
            LazyColumn(Modifier.heightIn(max = 420.dp)) {
                if (tab == 0) {
                    if (viewers.isEmpty()) item { Text("No one is watching yet — share your live!", style = ZipperTheme.type.bodyM, color = c.textSecondary, modifier = Modifier.padding(Space.lg)) }
                    items(viewers, key = { it.uid }) { v ->
                        val removing = v.uid in kickPending
                        Row(Modifier.fillMaxWidth().clickableNoRipple { onOpenProfile(v.uid) }.padding(horizontal = Space.lg, vertical = Space.sm), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
                            Avatar(v.photoUrl, size = AvatarSize.MD, initial = v.name)
                            Text(v.name, style = ZipperTheme.type.labelM, color = c.textPrimary, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (v.level > 0) LevelChip(v.level)
                            // B12: mute in chat (they keep watching) — a tap toggles it.
                            val muted = v.uid in mutedViewers
                            Icon(
                                if (muted) Icons.Default.CommentsDisabled else Icons.Default.Comment,
                                if (muted) "Unmute ${v.name} in chat" else "Mute ${v.name} in chat",
                                tint = if (muted) c.statusWarning else c.textSecondary,
                                modifier = Modifier.size(22.dp).clickableNoRipple { onToggleMute(v.uid) },
                            )
                            // B12: block — confirmed in the dialog below, like Remove.
                            Icon(
                                Icons.Default.Block, "Block ${v.name}", tint = c.statusDanger,
                                modifier = Modifier.size(22.dp).clickableNoRipple { confirmBlock = v },
                            )
                            // Spinner while the batch is in flight: the row only
                            // disappears once the viewers snapshot comes back, and
                            // until it does a failed kick and a slow one looked
                            // identical — so hosts tapped again, and kicked twice.
                            ZipperButton(
                                if (removing) "Removing…" else "Remove",
                                { confirmKick = v },
                                size = ButtonSize.Small,
                                style = ButtonStyle.Danger,
                                loading = removing,
                            )
                        }
                    }
                } else {
                    if (leaderboard.isEmpty()) item { Text("No gifts yet this session", style = ZipperTheme.type.bodyM, color = c.textSecondary, modifier = Modifier.padding(Space.lg)) }
                    items(leaderboard.size) { i ->
                        val e = leaderboard[i]
                        Row(Modifier.fillMaxWidth().clickableNoRipple { onOpenProfile(e.uid) }.padding(horizontal = Space.lg, vertical = Space.sm), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
                            Text("${i + 1}", style = ZipperTheme.type.numericM, color = if (i == 0) c.brandVip else c.textSecondary, modifier = Modifier.width(20.dp))
                            Avatar(e.photoUrl, size = AvatarSize.MD, initial = e.name, ring = if (i == 0) AvatarRing.Vip else AvatarRing.None)
                            Text(e.name, style = ZipperTheme.type.labelM, color = c.textPrimary, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Price(Currency.Diamond, e.totalDiamonds, color = c.textPrimary)
                        }
                    }
                }
            }
        }
    }

    // Outside the sheet rather than inside its content, so the dialog owns the
    // focus and the list stays where the host left it underneath.
    confirmKick?.let { target ->
        val name = target.name.ifBlank { "this viewer" }
        AlertDialog(
            onDismissRequest = { confirmKick = null }, containerColor = c.bgElevated,
            title = { Text("Remove $name?", style = ZipperTheme.type.headingS, color = c.textPrimary) },
            text = {
                Text(
                    "They'll be dropped from your live and can't rejoin this broadcast. You can't undo this.",
                    style = ZipperTheme.type.bodyM, color = c.textSecondary,
                )
            },
            confirmButton = { TextButton({ onKick(target.uid); confirmKick = null }) { Text("Remove", color = c.statusDanger) } },
            dismissButton = { TextButton({ confirmKick = null }) { Text("Cancel", color = c.textSecondary) } },
        )
    }
    // B12: block — removed now, and kept out of every future live (the server refuses them a token), calls and
    // messages too. Undone from Settings → Blocked users.
    confirmBlock?.let { target ->
        val name = target.name.ifBlank { "this viewer" }
        AlertDialog(
            onDismissRequest = { confirmBlock = null }, containerColor = c.bgElevated,
            title = { Text("Block $name?", style = ZipperTheme.type.headingS, color = c.textPrimary) },
            text = {
                Text(
                    "They'll be removed now and can't watch your lives, call or message you. Unblock any time in Settings → Blocked users.",
                    style = ZipperTheme.type.bodyM, color = c.textSecondary,
                )
            },
            confirmButton = { TextButton({ onBlock(target.uid); confirmBlock = null }) { Text("Block", color = c.statusDanger) } },
            dismissButton = { TextButton({ confirmBlock = null }) { Text("Cancel", color = c.textSecondary) } },
        )
    }
}

private fun formatClock(secs: Long): String {
    val h = secs / 3600; val m = (secs % 3600) / 60; val s = secs % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%02d:%02d".format(m, s)
}


/** O10: the on-air clock, reading its own flow so its tick redraws this label and nothing else. */
@Composable
private fun LiveClock(duration: kotlinx.coroutines.flow.StateFlow<Long>) {
    val seconds by duration.collectAsStateWithLifecycle()
    Text(formatClock(seconds), style = ZipperTheme.type.caption, color = ZipperTheme.colors.textSecondary)
}

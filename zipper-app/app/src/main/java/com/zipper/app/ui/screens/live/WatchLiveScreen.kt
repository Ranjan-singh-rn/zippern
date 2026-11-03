package com.zipper.app.ui.screens.live

import android.app.Activity
import android.app.PictureInPictureParams
import android.os.Build
import android.util.Rational
import android.view.SurfaceView
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
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
import com.zipper.app.R
import com.zipper.app.data.model.GiftLeaderboardEntry
import com.zipper.app.data.model.LiveComment
import com.zipper.app.data.model.ViewerPresence
import com.zipper.app.ui.components.*
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import kotlinx.coroutines.delay

/*
 * Watch live — Figma "02 Watch live" (43:2), with the viewer list (157:476),
 * more/report/quality sheet (160:555) and live-ended (160:728) states.
 *
 *   Header 48: host pill (40h glass: 36 avatar, name + viewers, 32 gradient
 *   Follow disc), top-3 gifter avatars (28, overlapping), more, close.
 *   Room meta: LIVE badge, eye chip, heart chip, category chip.
 *   Right rail (48 discs, 11sp labels): Viewers · Gifts · Share · PIP.
 *   Bottom: gift event pill, comment pills (22h, scrim/medium), then the
 *   44h input + Like (coral 48) + Gift (gradient 48).
 */

@Composable
fun WatchLiveScreen(
    roomId: String,
    onBack: () -> Unit = {},
    onRecharge: () -> Unit = {},
    onOpenProfile: (uid: String) -> Unit = {},
    viewModel: WatchLiveViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    val context = LocalContext.current
    val activity = context as? Activity
    val snackbar = remember { SnackbarHostState() }

    var showGifts by remember { mutableStateOf(false) }
    var showViewers by remember { mutableStateOf(false) }
    var showLeaderboard by remember { mutableStateOf(false) }
    var showMore by remember { mutableStateOf(false) }
    var showShare by remember { mutableStateOf(false) }
    var giftTargetRoom by remember { mutableStateOf<String?>(null) }
    var confirmBlock by remember { mutableStateOf(false) }

    // ── PIP ────────────────────────────────────────────────────────────────
    var isInPip by remember { mutableStateOf(false) }
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME || event == Lifecycle.Event.ON_PAUSE) {
                isInPip = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && activity?.isInPictureInPictureMode == true
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    val enterPip = {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            activity?.enterPictureInPictureMode(PictureInPictureParams.Builder().setAspectRatio(Rational(9, 16)).build())
        }
    }

    // ── Agora ──────────────────────────────────────────────────────────────
    val remoteSurface = remember { SurfaceView(context) }
    LaunchedEffect(Unit) { viewModel.initAndJoinAgora(context); viewModel.join() }
    LaunchedEffect(state.remoteUid) { if (state.remoteUid != 0) AgoraManager.setupRemoteVideo(remoteSurface, state.remoteUid) }
    // Auto-reconnect — but never after a kick. `isConnected` drops the moment
    // the host removes you, and this effect used to quietly put you back in.
    LaunchedEffect(state.isConnected, state.isHostOffline, state.wasKicked) {
        if (!state.isConnected && !state.isHostOffline && !state.wasKicked && state.joinedAt > 0L) {
            delay(3000)
            if (!state.isConnected && !state.isHostOffline && !state.wasKicked) viewModel.rejoin()
        }
    }
    // Leaving is the ViewModel's job (onCleared). Doing it here too meant one
    // join was answered by several leaves and the viewer count went negative.
    LaunchedEffect(state.error) { state.error?.let { snackbar.showSnackbar(it); viewModel.clearError() } }
    // The other half of the same snackbar: what went right. A report is filed
    // from a sheet that dismisses itself, so this line is the only thing that
    // tells the viewer their report exists.
    LaunchedEffect(state.toastMessage) { state.toastMessage?.let { snackbar.showSnackbar(it); viewModel.clearToast() } }
    // B12: the PK's verdict, as the server recorded it on this room.
    LaunchedEffect(state.pkVerdict) { state.pkVerdict?.let { snackbar.showSnackbar(it); viewModel.clearPkVerdict() } }
    // B12: blocked the host — they are gone from this viewer's app, so is this screen.
    LaunchedEffect(state.blockedHost) { if (state.blockedHost) onBack() }

    val listState = rememberLazyListState()
    LaunchedEffect(state.comments.size) { if (state.comments.isNotEmpty()) listState.animateScrollToItem(state.comments.size - 1) }

    val room = state.room

    Box(Modifier.fillMaxSize().background(c.bgBase)) {
        // Video (or a gradient backdrop while it connects)
        if (state.remoteUid == 0) {
            Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color(0xFFE81E6E), Color(0xFF7038E8), Color(0xFF0E0F21)))))
            if (room != null) {
                Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.md)) {
                    Avatar(room.hostPhotoUrl, size = AvatarSize.X3L, ring = AvatarRing.Live, initial = room.hostName)
                    Text(if (state.isHostOffline) "Host is away" else "Connecting…", style = ZipperTheme.type.bodyM, color = c.textSecondary)
                }
            }
        }
        AndroidView(factory = { remoteSurface }, modifier = Modifier.fillMaxSize())

        // B12: camera off or paused — the host's photo over the (black) video, never a frozen frame.
        if (room != null && state.remoteUid != 0 && (state.isCameraOff || state.isPaused)) {
            Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color(0xFF2A1A4A), Color(0xFF0E0F21)))))
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.md)) {
                Avatar(room.hostPhotoUrl, size = AvatarSize.X3L, ring = AvatarRing.Live, initial = room.hostName)
                if (state.isPaused) {
                    Text(LiveRoomUi.PAUSED_TITLE, style = ZipperTheme.type.headingM, color = c.textPrimary)
                    Text(LiveRoomUi.PAUSED_BODY, style = ZipperTheme.type.bodyM, color = c.textSecondary)
                } else {
                    Text("Camera off", style = ZipperTheme.type.bodyM, color = c.textSecondary)
                }
            }
        }

        if (isInPip) return@Box

        // Scrims
        Box(Modifier.fillMaxWidth().height(220.dp).background(Brush.verticalGradient(listOf(Color(0xC7070812), Color(0x4D070812), Color.Transparent))))
        Box(Modifier.fillMaxWidth().height(360.dp).align(Alignment.BottomCenter).background(Brush.verticalGradient(listOf(Color.Transparent, Color(0x59070812), Color(0xE5070812)))))

        // PK overlay
        if (state.pkActive) {
            PKBattleOverlay(
                myName = room?.hostName ?: "", myPhotoUrl = room?.hostPhotoUrl ?: "", myScore = state.pkScore,
                partnerName = state.pkPartnerName, partnerPhotoUrl = state.pkPartnerPhotoUrl, partnerScore = state.pkPartnerScore,
                pkEndTime = state.pkEndTime, onPKEnd = viewModel::onPKEnd,
                modifier = Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = 100.dp),
            )
        }

        // ── Top overlay ────────────────────────────────────────────────────
        Column(Modifier.fillMaxWidth().statusBarsPadding().padding(top = Space.sm), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            Row(Modifier.fillMaxWidth().height(48.dp).padding(horizontal = Space.md), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                // Host pill
                Row(
                    Modifier.height(40.dp).background(c.glassMid, CircleShape).border(1.dp, c.glassMid, CircleShape).padding(2.dp)
                        .clickableNoRipple { room?.hostUid?.let(onOpenProfile) },
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm),
                ) {
                    Avatar(room?.hostPhotoUrl, size = AvatarSize.SM, ring = AvatarRing.Live, initial = room?.hostName ?: "")
                    Column(Modifier.widthIn(max = 100.dp)) {
                        Text(room?.hostName ?: "Live", style = ZipperTheme.type.labelS, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        // One source of truth: the presence docs the viewer
                        // sheet already lists. `room.viewerCount` is a counter
                        // that drifts, and showed a different number right next
                        // to the list it disagreed with.
                        // B12: the server's count (recounted from these presence rows), with the host's level.
                        Text(
                            (if (state.hostLevel > 0) "Lv ${state.hostLevel} · " else "") +
                                "${compactCount(maxOf(state.viewers.size, room?.viewerCount ?: 0).toLong())} watching",
                            style = ZipperTheme.type.caption, color = c.textSecondary, maxLines = 1,
                        )
                    }
                    if (!state.isFollowing) {
                        Box(
                            Modifier.size(32.dp).background(Brush.linearGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), CircleShape)
                                .clickableNoRipple(viewModel::followHost),
                            contentAlignment = Alignment.Center,
                        ) { Icon(Icons.Default.Add, "Follow", tint = Color.White, modifier = Modifier.size(18.dp)) }
                    } else {
                        Box(Modifier.size(32.dp).background(c.tintSuccessSubtle, CircleShape), contentAlignment = Alignment.Center) {
                            Icon(Icons.Default.Check, "Following", tint = c.statusSuccess, modifier = Modifier.size(18.dp))
                        }
                    }
                }
                // Top gifters
                if (state.giftLeaderboard.isNotEmpty()) {
                    Box(Modifier.clickableNoRipple { showLeaderboard = true }) {
                        state.giftLeaderboard.take(3).forEachIndexed { i, e ->
                            Avatar(
                                e.photoUrl, size = AvatarSize.XS, initial = e.name,
                                ring = if (i == 0) AvatarRing.Vip else AvatarRing.None,
                                modifier = Modifier.padding(start = (18 * i).dp),
                            )
                        }
                    }
                }
                Spacer(Modifier.weight(1f))
                IconButtonCircle(Icons.Default.MoreVert, "More", { showMore = true }, size = 32.dp, background = Color.Transparent)
                IconButtonCircle(Icons.Default.Close, "Leave", onBack, size = 32.dp, background = Color.Transparent)
            }
            // Room meta
            Row(Modifier.padding(horizontal = Space.md), horizontalArrangement = Arrangement.spacedBy(Space.xs), verticalAlignment = Alignment.CenterVertically) {
                LiveBadge(LiveBadgeKind.Live)
                GlassChip(Icons.Outlined.Visibility, compactCount(state.viewers.size.toLong()))
                GlassChip(Icons.Default.Favorite, compactCount(state.likeCount))
                if (!room?.category.isNullOrBlank()) {
                    Box(Modifier.height(18.dp).background(c.scrimMedium, CircleShape).border(1.dp, c.glassMid, CircleShape).padding(horizontal = 8.dp), contentAlignment = Alignment.Center) {
                        Text(room!!.category.replaceFirstChar { it.uppercase() }, style = ZipperTheme.type.caption, color = c.textPrimary)
                    }
                }
            }
            // B12: the connection, from the engine — and the host's video leaving the channel.
            val linkNote = when {
                state.isRejoining || state.link == AgoraManager.Link.Reconnecting -> LiveRoomUi.RECONNECTING
                state.link == AgoraManager.Link.Failed -> LiveRoomUi.CONNECTION_LOST
                state.hostVideoLost && !state.isLiveEnded -> LiveRoomUi.HOST_VIDEO_LOST
                else -> null
            }
            AnimatedVisibility(linkNote != null, enter = fadeIn(), exit = fadeOut()) {
                Box(Modifier.padding(horizontal = Space.md).background(c.tintBrandMedium, CircleShape).padding(horizontal = Space.md, vertical = 6.dp)) {
                    Text(linkNote.orEmpty(), style = ZipperTheme.type.labelS, color = c.textPrimary)
                }
            }
            // B12: the host's pinned announcement.
            if (state.pinnedMessage.isNotBlank()) {
                Row(
                    Modifier.padding(horizontal = Space.md).fillMaxWidth(0.8f)
                        .background(c.scrimMedium, RoundedCornerShape(Radius.md)).border(1.dp, c.glassMid, RoundedCornerShape(Radius.md))
                        .padding(horizontal = Space.md, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm),
                ) {
                    Icon(Icons.Default.PushPin, null, tint = c.brandVip, modifier = Modifier.size(14.dp))
                    Text(state.pinnedMessage, style = ZipperTheme.type.bodyS, color = c.textPrimary, maxLines = 3, overflow = TextOverflow.Ellipsis)
                }
            }
        }

        // ── Right rail ─────────────────────────────────────────────────────
        Column(
            Modifier.align(Alignment.CenterEnd).padding(end = Space.md, top = 80.dp),
            verticalArrangement = Arrangement.spacedBy(Space.lg), horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            RailButton(Icons.Default.People, compactCount(state.viewers.size.toLong())) { showViewers = true }
            RailButton(Icons.Default.Star, "Gifts", tint = c.brandVip) { showLeaderboard = true }
            RailButton(Icons.Default.Share, "Share") { showShare = true }
            RailButton(Icons.Default.PictureInPicture, "PIP") { enterPip() }
        }

        // ── Bottom overlay ─────────────────────────────────────────────────
        Column(
            Modifier.fillMaxWidth().align(Alignment.BottomCenter).navigationBarsPadding().imePadding()
                .padding(start = Space.md, end = Space.md, bottom = Space.sm),
            verticalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            state.recentGifts.firstOrNull()?.let { g ->
                GiftEventPill(g.senderName, g.giftName, g.quantity, null)
            }
            if (state.showComments) {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxWidth(0.78f).heightIn(max = 150.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    items(state.comments, key = { it.id }) { CommentPill(it) }
                }
            }
            Row(Modifier.fillMaxWidth().height(48.dp), horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalAlignment = Alignment.CenterVertically) {
                Row(
                    Modifier.weight(1f).height(44.dp).background(c.scrimMedium, CircleShape).border(1.dp, c.glassMid, CircleShape).padding(start = 16.dp, end = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    BasicTextField(
                        // B12: at most 300 characters (the rules refuse more); a muted viewer cannot type at all.
                        value = state.commentInput, onValueChange = { v -> viewModel.onCommentInput(v.take(LiveRoomUi.COMMENT_MAX)) }, singleLine = true,
                        enabled = !state.isMutedInChat,
                        textStyle = ZipperTheme.type.bodyS.copy(color = c.textPrimary), cursorBrush = SolidColor(c.brandPrimary),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                        keyboardActions = KeyboardActions(onSend = { viewModel.sendComment() }),
                        modifier = Modifier.weight(1f),
                        decorationBox = { inner ->
                            if (state.commentInput.isEmpty()) {
                                Text(if (state.isMutedInChat) LiveRoomUi.MUTED_PLACEHOLDER else "Say something…", style = ZipperTheme.type.bodyS, color = c.textMuted)
                            }
                            inner()
                        },
                    )
                    Icon(Icons.AutoMirrored.Filled.Send, "Send", tint = if (state.commentInput.isBlank()) c.textMuted else c.brandPrimary,
                        modifier = Modifier.size(20.dp).clickableNoRipple { viewModel.sendComment() })
                }
                LikeButton(viewModel::addLike)
                Box(
                    Modifier.size(48.dp).background(Brush.linearGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), CircleShape).clickableNoRipple { showGifts = true },
                    contentAlignment = Alignment.Center,
                ) { Icon(painterResource(R.drawable.ic_gift), "Gift", tint = Color.White, modifier = Modifier.size(20.dp)) }
            }
        }

        // Gift animation
        state.recentGifts.firstOrNull()?.let { GiftAnimationOverlay(giftEvent = it, onDismiss = viewModel::dismissGift) }

        // Spec §11: the server's lucky roll, celebrated for a few seconds.
        state.luckyWin?.let { win ->
            LaunchedEffect(win) { kotlinx.coroutines.delay(4_000); viewModel.clearLuckyWin() }
            LuckyWinBanner(win, Modifier.align(Alignment.Center).padding(Space.xl))
        }

        SnackbarHost(snackbar, Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = 120.dp)) { data ->
            Snackbar(snackbarData = data, containerColor = c.bgElevated, contentColor = c.textPrimary)
        }

        // A kick outranks everything else on screen.
        if (state.wasKicked) {
            KickedOverlay(room?.hostPhotoUrl, room?.hostName ?: "The host", onBack)
        } else if (state.isLiveEnded) {
            LiveEndedOverlay(room?.hostName ?: "The host", room?.hostPhotoUrl, state.isFollowing, viewModel::followHost, onBack)
        }
    }

    // ── Sheets ─────────────────────────────────────────────────────────────
    if (showGifts && room != null) {
        val recipients = if (state.pkActive) listOf(
            GiftRecipient(roomId, room.hostName, room.hostPhotoUrl),
            GiftRecipient(state.pkPartnerId, state.pkPartnerName, state.pkPartnerPhotoUrl),
        ) else emptyList()
        val targetRoom = giftTargetRoom ?: roomId
        GiftDrawer(
            gifts = state.gifts, balanceDiamonds = state.myDiamonds,
            recipientName = room.hostName, recipientPhotoUrl = room.hostPhotoUrl,
            sending = state.giftSending,
            recipients = recipients, selectedRecipientId = targetRoom,
            onSelectRecipient = { giftTargetRoom = it.id },
            onSend = { gift, qty ->
                val hostUid = if (targetRoom == roomId) room.hostUid else state.pkPartnerUid
                viewModel.sendGift(gift, qty, targetRoom, hostUid); showGifts = false
            },
            onRecharge = { showGifts = false; onRecharge() },
            onDismiss = { showGifts = false },
        )
    }
    if (showViewers) ViewerListSheet(state.viewers, onOpenProfile) { showViewers = false }
    if (showLeaderboard) LeaderboardSheet(state.giftLeaderboard, onOpenProfile) { showLeaderboard = false }
    if (showShare) LiveShareSheet(roomId = roomId, hostName = room?.hostName ?: "", onDismiss = { showShare = false })
    // B12: block the host — asked first, because it also stops their calls and messages.
    if (confirmBlock) {
        AlertDialog(
            onDismissRequest = { confirmBlock = false }, containerColor = c.bgElevated,
            title = { Text("Block ${room?.hostName ?: "this host"}?", style = ZipperTheme.type.headingS, color = c.textPrimary) },
            text = { Text("You'll leave this live, and they won't be able to call or message you. Unblock any time in Settings → Blocked users.", style = ZipperTheme.type.bodyM, color = c.textSecondary) },
            confirmButton = { TextButton({ confirmBlock = false; viewModel.blockHost() }) { Text("Block", color = c.statusDanger) } },
            dismissButton = { TextButton({ confirmBlock = false }) { Text("Cancel", color = c.textSecondary) } },
        )
    }
    if (showMore) {
        MoreSheet(
            showComments = state.showComments, quality = state.streamQuality,
            onToggleComments = { viewModel.toggleShowComments(); showMore = false },
            onQuality = { viewModel.setStreamQuality(it); showMore = false },
            onReport = { reason -> viewModel.reportHost(reason); showMore = false },
            onBlock = { showMore = false; confirmBlock = true },
            onDismiss = { showMore = false },
        )
    }
}

// ── Pieces ───────────────────────────────────────────────────────────────────

@Composable
private fun RailButton(icon: ImageVector, label: String, tint: Color = ZipperTheme.colors.textPrimary, onClick: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Box(
            Modifier.size(48.dp).background(ZipperTheme.colors.glassMid, CircleShape).border(1.dp, ZipperTheme.colors.glassMid, CircleShape).clickableNoRipple(onClick),
            contentAlignment = Alignment.Center,
        ) { Icon(icon, label, tint = tint, modifier = Modifier.size(24.dp)) }
        Text(label, style = ZipperTheme.type.caption, color = ZipperTheme.colors.textPrimary)
    }
}

@Composable
private fun LikeButton(onLike: () -> Unit) {
    var pop by remember { mutableStateOf(false) }
    val scale by animateFloatAsState(if (pop) 1.25f else 1f, tween(120), label = "like")
    LaunchedEffect(pop) { if (pop) { delay(120); pop = false } }
    Box(
        Modifier.size(48.dp).scale(scale).background(ZipperTheme.colors.statusLive, CircleShape).clickableNoRipple { pop = true; onLike() },
        contentAlignment = Alignment.Center,
    ) { Icon(Icons.Default.Favorite, "Like", tint = Color.White, modifier = Modifier.size(20.dp)) }
}

@Composable
private fun CommentPill(comment: LiveComment) {
    val c = ZipperTheme.colors
    Row(
        Modifier.background(c.scrimMedium, CircleShape).padding(horizontal = 12.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        if (comment.isJoin) {
            Text(comment.name, style = ZipperTheme.type.labelS, color = c.textBrand, maxLines = 1)
            Text(" joined", style = ZipperTheme.type.bodyS, color = c.textSecondary)
        } else {
            Text("${comment.name}:", style = ZipperTheme.type.labelS, color = c.brandVip, maxLines = 1)
            Text(comment.message, style = ZipperTheme.type.bodyS, color = c.textPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SheetFrame(title: String, onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    val c = ZipperTheme.colors
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = c.bgElevated, dragHandle = null, shape = RoundedCornerShape(topStart = Radius.xl, topEnd = Radius.xl)) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = Space.md)) {
            Box(Modifier.padding(top = 6.dp).size(36.dp, 4.dp).background(c.borderDefault, CircleShape).align(Alignment.CenterHorizontally))
            Text(title, style = ZipperTheme.type.headingS, color = c.textPrimary, modifier = Modifier.padding(horizontal = Space.lg, vertical = Space.md))
            HairlineDivider()
            content()
        }
    }
}

@Composable
private fun ViewerListSheet(viewers: List<ViewerPresence>, onOpen: (String) -> Unit, onDismiss: () -> Unit) {
    val c = ZipperTheme.colors
    SheetFrame("Viewers · ${viewers.size}", onDismiss) {
        if (viewers.isEmpty()) {
            Text("No one else is here yet", style = ZipperTheme.type.bodyM, color = c.textSecondary, modifier = Modifier.padding(Space.lg))
        } else LazyColumn(Modifier.heightIn(max = 420.dp)) {
            items(viewers, key = { it.uid }) { v ->
                Row(Modifier.fillMaxWidth().clickableNoRipple { onOpen(v.uid) }.padding(horizontal = Space.lg, vertical = Space.sm), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
                    Avatar(v.photoUrl, size = AvatarSize.MD, initial = v.name)
                    Text(v.name, style = ZipperTheme.type.labelM, color = c.textPrimary, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (v.level > 0) LevelChip(v.level)
                }
            }
        }
    }
}

@Composable
private fun LeaderboardSheet(entries: List<GiftLeaderboardEntry>, onOpen: (String) -> Unit, onDismiss: () -> Unit) {
    val c = ZipperTheme.colors
    SheetFrame("Top gifters", onDismiss) {
        if (entries.isEmpty()) {
            Text("No gifts yet — be the first on the board", style = ZipperTheme.type.bodyM, color = c.textSecondary, modifier = Modifier.padding(Space.lg))
        } else LazyColumn(Modifier.heightIn(max = 420.dp)) {
            items(entries.size) { i ->
                val e = entries[i]
                Row(Modifier.fillMaxWidth().clickableNoRipple { onOpen(e.uid) }.padding(horizontal = Space.lg, vertical = Space.sm), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
                    Text("${i + 1}", style = ZipperTheme.type.numericM, color = if (i == 0) c.brandVip else c.textSecondary, modifier = Modifier.width(20.dp))
                    Avatar(e.photoUrl, size = AvatarSize.MD, initial = e.name, ring = if (i == 0) AvatarRing.Vip else AvatarRing.None)
                    Text(e.name, style = ZipperTheme.type.labelM, color = c.textPrimary, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Price(Currency.Diamond, e.totalDiamonds, color = c.textPrimary)
                }
            }
        }
    }
}

@Composable
private fun MoreSheet(
    showComments: Boolean, quality: String,
    onToggleComments: () -> Unit, onQuality: (String) -> Unit, onReport: (String) -> Unit,
    /** B12: block the host from the live screen. */
    onBlock: () -> Unit,
    onDismiss: () -> Unit,
) {
    val c = ZipperTheme.colors
    var reporting by remember { mutableStateOf(false) }
    SheetFrame(if (reporting) "Report this live" else "Options", onDismiss) {
        if (reporting) {
            listOf("Nudity or sexual content", "Harassment or hate", "Scam or spam", "Underage host", "Violence", "Something else").forEach { r ->
                Text(r, style = ZipperTheme.type.bodyL, color = c.textPrimary, modifier = Modifier.fillMaxWidth().clickableNoRipple { onReport(r) }.padding(horizontal = Space.xl, vertical = Space.md))
            }
        } else {
            Row(Modifier.fillMaxWidth().clickableNoRipple(onToggleComments).padding(horizontal = Space.xl, vertical = Space.md), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
                Icon(Icons.Default.ChatBubbleOutline, null, tint = c.textPrimary, modifier = Modifier.size(22.dp))
                Text(if (showComments) "Hide comments" else "Show comments", style = ZipperTheme.type.bodyL, color = c.textPrimary)
            }
            Text("Stream quality", style = ZipperTheme.type.caption, color = c.textSecondary, modifier = Modifier.padding(horizontal = Space.xl, vertical = Space.sm))
            Row(Modifier.padding(horizontal = Space.xl), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                listOf("Auto", "High", "Low").forEach { q ->
                    val on = q == quality
                    Box(
                        Modifier.height(32.dp).background(if (on) c.tintBrandMedium else c.bgRaised, CircleShape).border(1.dp, if (on) c.brandPrimary else c.borderSubtle, CircleShape).clickableNoRipple { onQuality(q) }.padding(horizontal = 14.dp),
                        contentAlignment = Alignment.Center,
                    ) { Text(q, style = ZipperTheme.type.labelS, color = if (on) c.textPrimary else c.textSecondary) }
                }
            }
            Spacer(Modifier.height(Space.sm))
            Row(Modifier.fillMaxWidth().clickableNoRipple { reporting = true }.padding(horizontal = Space.xl, vertical = Space.md), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
                Icon(Icons.Default.Flag, null, tint = c.statusDanger, modifier = Modifier.size(22.dp))
                Text("Report", style = ZipperTheme.type.bodyL, color = c.statusDanger)
            }
            Row(Modifier.fillMaxWidth().clickableNoRipple(onBlock).padding(horizontal = Space.xl, vertical = Space.md), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
                Icon(Icons.Default.Block, null, tint = c.statusDanger, modifier = Modifier.size(22.dp))
                Text("Block host", style = ZipperTheme.type.bodyL, color = c.statusDanger)
            }
        }
    }
}

@Composable
private fun LiveEndedOverlay(hostName: String, photoUrl: String?, isFollowing: Boolean, onFollow: () -> Unit, onExit: () -> Unit) {
    val c = ZipperTheme.colors
    Box(Modifier.fillMaxSize().background(c.scrimStrong), contentAlignment = Alignment.Center) {
        Column(
            Modifier.padding(Space.x3l).fillMaxWidth().background(c.bgElevated, RoundedCornerShape(Radius.xl)).border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.xl)).padding(Space.xxl),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            Avatar(photoUrl, size = AvatarSize.XL, initial = hostName)
            Text("Live has ended", style = ZipperTheme.type.headingM, color = c.textPrimary)
            Text("$hostName has finished this broadcast. Follow to catch the next one.", style = ZipperTheme.type.bodyM, color = c.textSecondary, textAlign = TextAlign.Center)
            Spacer(Modifier.height(Space.sm))
            if (!isFollowing) ZipperButton("Follow $hostName", onFollow, gradient = true, fullWidth = true, size = ButtonSize.Medium)
            ZipperButton("Back to Live", onExit, style = ButtonStyle.Secondary, fullWidth = true, size = ButtonSize.Medium)
        }
    }
}

/** Terminal state: the host removed this viewer. No reconnect, no retry. */
@Composable
private fun KickedOverlay(photoUrl: String?, hostName: String, onExit: () -> Unit) {
    val c = ZipperTheme.colors
    Box(Modifier.fillMaxSize().background(c.scrimStrong), contentAlignment = Alignment.Center) {
        Column(
            Modifier.padding(Space.x3l).fillMaxWidth().background(c.bgElevated, RoundedCornerShape(Radius.xl)).border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.xl)).padding(Space.xxl),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            Avatar(photoUrl, size = AvatarSize.XL, initial = hostName)
            Text("Removed from this live", style = ZipperTheme.type.headingM, color = c.textPrimary)
            Text("The host removed you from this room. You can still watch their other lives.", style = ZipperTheme.type.bodyM, color = c.textSecondary, textAlign = TextAlign.Center)
            Spacer(Modifier.height(Space.sm))
            ZipperButton("Back to Live", onExit, style = ButtonStyle.Secondary, fullWidth = true, size = ButtonSize.Medium)
        }
    }
}

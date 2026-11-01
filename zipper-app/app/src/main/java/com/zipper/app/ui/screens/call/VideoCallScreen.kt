package com.zipper.app.ui.screens.call

import android.app.PictureInPictureParams
import android.os.Build
import android.util.Rational
import android.view.SurfaceView
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.*
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
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
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.Icon
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import com.zipper.app.R
import com.zipper.app.ui.components.*
import com.zipper.app.ui.screens.live.AgoraManager
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import kotlinx.coroutines.delay

/*
 * Video call — Figma "Video Call" (59:2) with the low-balance state (62:65).
 *
 * Layers, bottom to top:
 *   remote video (full bleed) · top scrim · bottom scrim
 *   header: peer pill (40h glass) · like · balance/earnings pill
 *   cost bar: Balance / Rate / Time left (336×48, r16, scrim/medium)
 *   local preview 96×128 r16 top-right with "You" chip
 *   gift event pill · in-call chat (pills on scrim/medium)
 *   input row 48h + gold gift button
 *   controls: Flip · Mute · End (64, coral) · PIP, with 11sp labels
 *
 * Money (APK 20 / spec §11): the server charges whole minutes — the first on
 * connect, then one at every 60-second mark — and every figure here comes from
 * what it reported (`CallBilling`): elapsed time by the server's clock, "next
 * minute in Ns", minutes billed, diamonds spent. "Time left" is the server's
 * affordable-minutes figure. When the server ends the call (out of diamonds) a
 * dialog says so before the screen closes.
 */

@Composable
fun VideoCallScreen(
    callId: String,
    isOutgoing: Boolean,
    onCallEnded: () -> Unit,
    onRecharge: () -> Unit = {},
    viewModel: VideoCallViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    val context = LocalContext.current
    val activity = context as? android.app.Activity
    val chatState = rememberLazyListState()
    val snackbar = remember { SnackbarHostState() }
    var showGifts by remember { mutableStateOf(false) }

    // ── PIP ────────────────────────────────────────────────────────────────
    var isInPip by remember { mutableStateOf(false) }
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME || event == Lifecycle.Event.ON_PAUSE) {
                isInPip = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && activity?.isInPictureInPictureMode == true
            }
            if (event == Lifecycle.Event.ON_STOP && isInPip && state.status == CallStatus.CONNECTED) {
                viewModel.endCall("pip_closed")
                onCallEnded()
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    val enterPip = {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            activity?.enterPictureInPictureMode(
                PictureInPictureParams.Builder().setAspectRatio(Rational(9, 16)).build()
            )
        }
    }

    // Engine first, then bind the preview — binding inside the AndroidView
    // factory ran before the engine existed and left the self-view black.
    val localSurface = remember { SurfaceView(context).apply { setZOrderMediaOverlay(true) } }
    LaunchedEffect(Unit) { viewModel.initAgora(context); AgoraManager.setupLocalVideo(localSurface) }
    LaunchedEffect(state.messages.size) {
        if (state.messages.isNotEmpty()) chatState.animateScrollToItem(state.messages.size - 1)
    }
    /*
     * A call the SERVER ended is explained before the screen closes. An
     * ordinary hang-up closes at once, as before; `insufficient_diamonds`, a
     * restriction or a displaced session hold the screen on a dialog whose OK
     * is what navigates — a call that simply vanishes is the thing people
     * report as a bug.
     */
    LaunchedEffect(state.endReason, state.serverEndMessage) {
        if (state.endReason != null && state.serverEndMessage == null) onCallEnded()
    }
    state.serverEndMessage?.let { msg ->
        if (state.endReason != null) {
            val outOfDiamonds = state.isPayer && (
                state.endReason == com.zipper.app.util.CallBilling.END_INSUFFICIENT_DIAMONDS ||
                    state.endReason == com.zipper.app.util.CallBilling.END_DIAMONDS_EXHAUSTED
                )
            // Typed explicitly: an inline conditional composable lambda leans on
            // expected-type inference through an `if`, which is fragile.
            val rechargeButton: (@Composable () -> Unit)? = if (outOfDiamonds) ({
                androidx.compose.material3.TextButton(onClick = { onCallEnded(); onRecharge() }) {
                    Text("Recharge", color = c.textSecondary)
                }
            }) else null
            androidx.compose.material3.AlertDialog(
                onDismissRequest = onCallEnded,
                containerColor = c.bgElevated,
                title = { Text("Call ended", style = ZipperTheme.type.headingS, color = c.textPrimary) },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                        Text(msg, style = ZipperTheme.type.bodyM, color = c.textSecondary)
                        Text(
                            "${formatDuration(state.durationSeconds)} · ${state.minutesBilled} min billed" +
                                (if (state.isPayer) " · ${indianGrouping(state.diamondsSpent)} diamonds"
                                 else " · ${indianGrouping(state.beansEarned)} beans earned"),
                            style = ZipperTheme.type.caption, color = c.textMuted,
                        )
                    }
                },
                confirmButton = {
                    androidx.compose.material3.TextButton(onClick = onCallEnded) { Text("OK", color = c.textBrand) }
                },
                dismissButton = rechargeButton,
            )
        }
    }
    LaunchedEffect(state.error) {
        state.error?.let { snackbar.showSnackbar(it); viewModel.clearError() }
    }
    LaunchedEffect(state.lastGiftEvent) {
        if (state.lastGiftEvent != null) { delay(4000); viewModel.clearGiftEvent() }
    }

    Box(Modifier.fillMaxSize().background(c.bgBase)) {

        // ── Remote video ───────────────────────────────────────────────────
        if (state.remoteUid != 0) {
            AndroidView(
                factory = { ctx -> SurfaceView(ctx).also { AgoraManager.setupRemoteVideo(it, state.remoteUid) } },
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            WaitingBackdrop(state)
        }

        if (isInPip) return@Box

        // ── Scrims ─────────────────────────────────────────────────────────
        Box(
            Modifier.fillMaxWidth().height(220.dp).align(Alignment.TopCenter)
                .background(Brush.verticalGradient(listOf(Color(0xC7070812), Color(0x4D070812), Color.Transparent)))
        )
        Box(
            Modifier.fillMaxWidth().height(360.dp).align(Alignment.BottomCenter)
                .background(Brush.verticalGradient(listOf(Color.Transparent, Color(0x59070812), Color(0xE5070812))))
        )

        // ── Local preview ──────────────────────────────────────────────────
        Box(
            Modifier
                .align(Alignment.TopEnd)
                .statusBarsPadding()
                .padding(top = 112.dp, end = Space.md)
                .size(96.dp, 128.dp)
                .clip(RoundedCornerShape(Radius.lg))
                .border(1.dp, c.glassHigh, RoundedCornerShape(Radius.lg))
                .background(c.bgRaised),
        ) {
            AndroidView(factory = { localSurface }, modifier = Modifier.fillMaxSize())
            Box(
                Modifier.align(Alignment.BottomStart).padding(6.dp)
                    .background(c.scrimMedium, CircleShape).padding(horizontal = 8.dp, vertical = 2.dp)
            ) { Text("You", style = ZipperTheme.type.caption, color = c.textPrimary) }
            if (!state.isMicOn) {
                Box(
                    Modifier.align(Alignment.TopEnd).padding(6.dp).size(20.dp)
                        .background(c.statusDanger, CircleShape),
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Default.MicOff, null, tint = Color.White, modifier = Modifier.size(12.dp)) }
            }
        }

        // ── Top overlay ────────────────────────────────────────────────────
        Column(
            Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = Space.md, vertical = Space.sm),
            verticalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            Row(Modifier.fillMaxWidth().height(48.dp), verticalAlignment = Alignment.CenterVertically) {
                // Peer pill
                Row(
                    Modifier.height(40.dp).background(c.glassMid, CircleShape)
                        .border(1.dp, c.glassMid, CircleShape).padding(2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Avatar(state.otherPartyPhotoUrl, size = AvatarSize.SM, initial = state.otherPartyName)
                    Column(Modifier.widthIn(max = 120.dp)) {
                        Text(state.otherPartyName, style = ZipperTheme.type.labelS, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            when (state.status) {
                                CallStatus.CONNECTED -> formatDuration(state.durationSeconds)
                                CallStatus.RINGING -> "Ringing…"
                                CallStatus.CONNECTING -> "Connecting…"
                                else -> "Ended"
                            },
                            style = ZipperTheme.type.caption, color = c.textSecondary, maxLines = 1,
                        )
                    }
                    IconButtonCircle(
                        if (state.isOtherPartyLiked) Icons.Default.Favorite else Icons.Default.FavoriteBorder,
                        "Like", viewModel::toggleLike,
                        size = 32.dp,
                        background = if (state.isOtherPartyLiked) c.tintBrandMedium else c.glassLow,
                        tint = if (state.isOtherPartyLiked) c.brandPrimary else c.textPrimary,
                    )
                }
                Spacer(Modifier.weight(1f))
                if (state.isPayer) {
                    CurrencyPill(Currency.Diamond, state.myDiamonds, onClick = onRecharge)
                } else {
                    CurrencyPill(Currency.Bean, state.beansEarned)
                }
            }

            // Cost bar (caller) / earnings bar (host)
            if (state.status == CallStatus.CONNECTED) {
                CostBar(state, state.isPayer, onRecharge)
            }
        }

        // ── Bottom overlay ─────────────────────────────────────────────────
        Column(
            Modifier.fillMaxWidth().align(Alignment.BottomCenter)
                .navigationBarsPadding().imePadding()
                .padding(start = Space.md, end = Space.md, bottom = Space.sm),
            verticalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            AnimatedVisibility(
                visible = state.lastGiftEvent != null,
                enter = slideInHorizontally { -it } + fadeIn(),
                exit = slideOutHorizontally { -it } + fadeOut(),
            ) {
                state.lastGiftEvent?.let { GiftEventPill(it.senderName, it.giftName, it.quantity, it.senderPhotoUrl) }
            }

            // Chat
            LazyColumn(
                state = chatState,
                modifier = Modifier.fillMaxWidth(0.72f).heightIn(max = 150.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                items(state.messages, key = { it.id }) { msg ->
                    Row(
                        Modifier.background(c.scrimMedium, CircleShape).padding(horizontal = 12.dp, vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("${msg.senderName}: ", style = ZipperTheme.type.labelS, color = c.brandVip, maxLines = 1)
                        Text(msg.message, style = ZipperTheme.type.bodyS, color = c.textPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }

            // Input row
            Row(Modifier.fillMaxWidth().height(48.dp), horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalAlignment = Alignment.CenterVertically) {
                Row(
                    Modifier.weight(1f).height(44.dp).background(c.scrimMedium, CircleShape)
                        .border(1.dp, c.glassMid, CircleShape).padding(start = 16.dp, end = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    BasicTextField(
                        value = state.messageInput,
                        onValueChange = viewModel::onMessageInput,
                        singleLine = true,
                        textStyle = ZipperTheme.type.bodyS.copy(color = c.textPrimary),
                        cursorBrush = SolidColor(c.brandPrimary),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                        keyboardActions = KeyboardActions(onSend = { viewModel.sendMessage() }),
                        modifier = Modifier.weight(1f),
                        decorationBox = { inner ->
                            if (state.messageInput.isEmpty()) Text("Say something…", style = ZipperTheme.type.bodyS, color = c.textMuted)
                            inner()
                        },
                    )
                    Icon(
                        Icons.AutoMirrored.Filled.Send, "Send",
                        tint = if (state.messageInput.isBlank()) c.textMuted else c.brandPrimary,
                        modifier = Modifier.size(20.dp).clickableNoRipple { viewModel.sendMessage() },
                    )
                }
                if (state.isPayer) {
                    Box(
                        Modifier.size(48.dp)
                            .background(Brush.linearGradient(listOf(Color(0xFFFFE08A), Color(0xFFFFB627), Color(0xFFE89806))), CircleShape)
                            .clickableNoRipple { showGifts = true },
                        contentAlignment = Alignment.Center,
                    ) { Icon(painterResource(R.drawable.ic_gift), "Gift", tint = Color(0xFF0E0F21), modifier = Modifier.size(22.dp)) }
                }
            }

            // Controls
            Row(
                Modifier.fillMaxWidth().padding(top = Space.xs),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.Bottom,
            ) {
                ControlButton(Icons.Default.FlipCameraAndroid, "Flip", viewModel::flipCamera)
                ControlButton(
                    if (state.isMicOn) Icons.Default.Mic else Icons.Default.MicOff,
                    if (state.isMicOn) "Mute" else "Unmute",
                    viewModel::toggleMic,
                    background = if (state.isMicOn) c.glassMid else c.statusWarning,
                    tint = if (state.isMicOn) c.textPrimary else Color(0xFF0E0F21),
                )
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Box(
                        Modifier.size(64.dp).background(c.statusDanger, CircleShape).clickableNoRipple { viewModel.endCall() },
                        contentAlignment = Alignment.Center,
                    ) { Icon(painterResource(R.drawable.ic_call_end), "End call", tint = Color.White, modifier = Modifier.size(30.dp)) }
                    Text("End", style = ZipperTheme.type.caption, color = c.textPrimary)
                }
                ControlButton(Icons.Default.PictureInPicture, "PIP", { enterPip() })
            }
        }

        // ── Low balance banner (62:65) ─────────────────────────────────────
        AnimatedVisibility(
            visible = state.isPayer && state.lowBalanceWarning && state.status == CallStatus.CONNECTED,
            modifier = Modifier.align(Alignment.Center),
            enter = fadeIn(), exit = fadeOut(),
        ) { LowBalanceCard(onRecharge) }

        // Spec §11: the server's lucky roll on an in-call gift, celebrated for a few seconds.
        state.lastLuckyWin?.let { win ->
            LaunchedEffect(win) { delay(4_000); viewModel.clearLuckyWin() }
            LuckyWinBanner(win, Modifier.align(Alignment.Center).padding(Space.xl))
        }

        SnackbarHost(snackbar, Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = 120.dp)) { data ->
            Snackbar(snackbarData = data, containerColor = c.bgElevated, contentColor = c.textPrimary)
        }

        if (showGifts) {
            GiftDrawer(
                gifts = state.gifts,
                balanceDiamonds = state.myDiamonds,
                recipientName = state.otherPartyName,
                recipientPhotoUrl = state.otherPartyPhotoUrl,
                sending = state.giftSending,
                onSend = { gift, qty -> viewModel.sendGiftInCall(state.otherPartyUid, gift, qty); showGifts = false },
                onRecharge = { showGifts = false; onRecharge() },
                onDismiss = { showGifts = false },
            )
        }
    }
}

// ── Pieces ───────────────────────────────────────────────────────────────────

@Composable
private fun WaitingBackdrop(state: VideoCallUiState) {
    val c = ZipperTheme.colors
    Box(Modifier.fillMaxSize()) {
        if (state.otherPartyPhotoUrl.isNotBlank()) {
            AsyncImage(
                state.otherPartyPhotoUrl, null, contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(), alpha = 0.35f,
            )
        }
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color(0xFFE81E6E), Color(0xFF7038E8), Color(0xFF0E0F21))), alpha = 0.6f))
        Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.lg)) {
            PulseRings { Avatar(state.otherPartyPhotoUrl, size = AvatarSize.X3L, ring = AvatarRing.Vip, initial = state.otherPartyName) }
            Text(state.otherPartyName, style = ZipperTheme.type.headingL, color = c.textPrimary, textAlign = TextAlign.Center)
            Text(
                if (state.status == CallStatus.RINGING) "Ringing…" else "Connecting…",
                style = ZipperTheme.type.bodyM, color = c.textSecondary,
            )
        }
    }
}

/** Two expanding rings (200 / 160 in Figma) around whatever sits in the middle. */
@Composable
fun PulseRings(content: @Composable () -> Unit) {
    val c = ZipperTheme.colors
    val t = rememberInfiniteTransition(label = "pulse")
    val p by t.animateFloat(0f, 1f, infiniteRepeatable(tween(1800, easing = LinearEasing)), label = "p")
    Box(Modifier.size(200.dp), contentAlignment = Alignment.Center) {
        Box(Modifier.size(160.dp + 40.dp * p).border(1.5.dp, c.brandPrimary.copy(alpha = 0.6f * (1 - p)), CircleShape))
        Box(Modifier.size(130.dp + 30.dp * p).border(1.5.dp, c.brandPrimary.copy(alpha = 0.8f * (1 - p)), CircleShape))
        content()
    }
}

/**
 * The cost bar. Every number is the server's (see `CallBilling`): minutes
 * billed and diamonds spent are what has actually been charged, "next" is the
 * countdown to the next whole-minute charge, and "left" is how many more
 * minutes the balance covers.
 */
@Composable
private fun CostBar(state: VideoCallUiState, isPayer: Boolean, onRecharge: () -> Unit) {
    val c = ZipperTheme.colors
    val rate = state.perMinRateDiamonds
    val minutesLeft = state.minutesLeft
    val next = state.secondsToNextCharge
    Column(
        Modifier.fillMaxWidth()
            .background(c.scrimMedium, RoundedCornerShape(Radius.lg))
            .border(1.dp, c.glassMid, RoundedCornerShape(Radius.lg))
            .padding(horizontal = Space.md, vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(Modifier.fillMaxWidth().height(36.dp), verticalAlignment = Alignment.CenterVertically) {
            if (isPayer) {
                Segment("Balance", indianGrouping(state.myDiamonds), Currency.Diamond, Modifier.weight(1f))
                VerticalRule()
                Segment("Rate", "$rate/min", Currency.Diamond, Modifier.weight(1f))
                VerticalRule()
                Segment(
                    "Left",
                    if (minutesLeft == null) "—" else "${minutesLeft}m",
                    null, Modifier.weight(1f),
                    valueColor = if (state.lowBalanceWarning) c.statusWarning else c.textPrimary,
                )
                Text("Top up", style = ZipperTheme.type.labelS, color = c.textBrand, modifier = Modifier.clickableNoRipple(onRecharge))
            } else {
                Segment("Earned", indianGrouping(state.beansEarned), Currency.Bean, Modifier.weight(1f))
                VerticalRule()
                Segment("Billed", "${state.minutesBilled} min", null, Modifier.weight(1f))
                VerticalRule()
                Segment("Duration", formatDuration(state.durationSeconds), null, Modifier.weight(1f))
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (isPayer) "Billed ${state.minutesBilled} min · ${indianGrouping(state.diamondsSpent)} spent"
                else "Per full minute · first minute charged on connect",
                style = ZipperTheme.type.caption, color = c.textSecondary, maxLines = 1,
            )
            Text(
                when {
                    next == null -> ""
                    next <= 0L -> "Next minute now"
                    else -> "Next minute in ${next}s"
                },
                style = ZipperTheme.type.caption,
                color = if (next != null && next <= 5L) c.statusWarning else c.textSecondary,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun Segment(label: String, value: String, currency: Currency?, modifier: Modifier, valueColor: Color = ZipperTheme.colors.textPrimary) {
    val c = ZipperTheme.colors
    Column(modifier) {
        Text(label, style = ZipperTheme.type.caption, color = c.textSecondary, maxLines = 1)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
            if (currency != null) CurrencyDisc(currency, 10.dp)
            Text(value, style = ZipperTheme.type.numericS, color = valueColor, maxLines = 1)
        }
    }
}

@Composable
private fun VerticalRule() {
    Box(Modifier.width(1.dp).height(24.dp).background(ZipperTheme.colors.glassMid).padding(horizontal = 0.dp))
    Spacer(Modifier.width(Space.md))
}

@Composable
private fun ControlButton(
    icon: ImageVector, label: String, onClick: () -> Unit,
    background: Color = ZipperTheme.colors.glassMid,
    tint: Color = ZipperTheme.colors.textPrimary,
) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        IconButtonCircle(icon, label, onClick, size = 48.dp, background = background, tint = tint)
        Text(label, style = ZipperTheme.type.caption, color = ZipperTheme.colors.textPrimary)
    }
}

@Composable
private fun LowBalanceCard(onRecharge: () -> Unit) {
    val c = ZipperTheme.colors
    Column(
        Modifier.width(280.dp)
            .background(c.bgElevated, RoundedCornerShape(Radius.xl))
            .border(1.dp, c.tintGoldSubtle, RoundedCornerShape(Radius.xl))
            .padding(Space.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.sm),
    ) {
        Box(Modifier.size(48.dp).background(c.tintGoldSubtle, CircleShape), contentAlignment = Alignment.Center) {
            Icon(painterResource(R.drawable.ic_diamond), null, tint = c.currencyDiamond, modifier = Modifier.size(24.dp))
        }
        Text("Balance running low", style = ZipperTheme.type.headingS, color = c.textPrimary)
        Text(
            "Your balance covers fewer than two more minutes. The call ends at the next " +
                "60-second mark you cannot pay for — top up now to keep it going.",
            style = ZipperTheme.type.bodyS, color = c.textSecondary, textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(Space.xs))
        ZipperButton("Recharge diamonds", onRecharge, size = ButtonSize.Medium, gradient = true, fullWidth = true)
    }
}

private fun formatDuration(secs: Long): String {
    val h = secs / 3600
    val m = (secs % 3600) / 60
    val s = secs % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%02d:%02d".format(m, s)
}

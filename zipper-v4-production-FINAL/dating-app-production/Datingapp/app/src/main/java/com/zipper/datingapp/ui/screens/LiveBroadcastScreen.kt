package com.zipper.datingapp.ui.screens

import android.app.PictureInPictureParams
import android.content.pm.PackageManager
import android.os.Build
import android.util.Rational
import androidx.activity.ComponentActivity
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.EmojiEvents
import androidx.compose.material.icons.filled.FlashOn
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.PictureInPicture
import androidx.compose.material.icons.filled.RemoveRedEye
import androidx.compose.material.icons.filled.SportsEsports
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.zipper.datingapp.data.LiveChatMessage
import com.zipper.datingapp.data.LiveStreamChatMessage
import com.zipper.datingapp.data.UserProfile
import com.zipper.datingapp.ui.DatingViewModel
import com.zipper.datingapp.ui.theme.AppBackground
import com.zipper.datingapp.ui.theme.AppSurface
import com.zipper.datingapp.ui.theme.BrandPink
import com.zipper.datingapp.ui.theme.BrandPurple
import com.zipper.datingapp.ui.theme.OutlineDefault
import com.zipper.datingapp.ui.theme.TextMuted
import com.zipper.datingapp.ui.theme.TextPrimary
import com.zipper.datingapp.ui.theme.TextSecondary
import io.agora.rtc2.RtcEngine
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LIVE BROADCAST SCREEN — Host (broadcaster) side
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Integrates with Agora RTC via the provided [rtcEngine].
 * The Activity is responsible for:
 *  - Creating and initializing the Agora RtcEngine
 *  - Calling joinChannel() before launching this screen
 *  - Passing the engine reference here
 *
 * This screen manages:
 *  - Full-screen front camera video surface
 *  - Chat overlay (bottom 40% of screen)
 *  - Host control buttons (end, mute, PK, viewers, games, gift request)
 *  - Viewer list + kick sheet
 *  - Auto-end timer (2min without face — handled by ML Kit in the Activity)
 *  - PIP mode on home press
 * ─────────────────────────────────────────────────────────────────────────────
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LiveBroadcastScreen(
    viewModel: DatingViewModel,
    streamId: String,
    rtcEngine: RtcEngine?,
    onEndLive: () -> Unit,
    onStartPk: () -> Unit,
    onOpenGames: () -> Unit,
) {
    val context = LocalContext.current
    val chatMessages by viewModel.liveChatMessages.collectAsState()
    val activeStream by viewModel.activeLiveStream.collectAsState()
    val currentUser by viewModel.currentUser.collectAsState()
    val giftQueue by viewModel.giftVisualQueue.collectAsState()
    val isInPipMode by viewModel.isInPipMode.collectAsState()

    var isMuted by remember { mutableStateOf(false) }
    var showViewers by remember { mutableStateOf(false) }
    var chatInput by remember { mutableStateOf("") }
    var showEndConfirm by remember { mutableStateOf(false) }

    val chatListState = rememberLazyListState()
    val scope = rememberCoroutineScope()

    // Auto-scroll chat to bottom on new messages
    LaunchedEffect(chatMessages.size) {
        if (chatMessages.isNotEmpty()) {
            chatListState.animateScrollToItem(chatMessages.size - 1)
        }
    }

    // Duration counter
    var durationSeconds by remember { mutableStateOf(0) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(1_000)
            durationSeconds++
        }
    }

    Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {

        // ── Agora video surface (full screen, front camera) ───────────────────
        // AgoraLiveScreen self-manages the RtcEngine: requests permissions, inits
        // the SDK with BuildConfig.AGORA_APP_ID, and joins the channel as broadcaster.
        AgoraLiveScreen(
            channelId = streamId,
            firebaseUid = currentUser?.id.orEmpty(),
            isBroadcaster = true,
            token = null,   // null = no-auth mode; replace with signed token in production
            localVideoScale = AgoraVideoScaleMode.Hidden,
            remoteVideoScale = AgoraVideoScaleMode.Fit,
            modifier = Modifier.fillMaxSize(),
        )

        // ── Gift animation overlay ────────────────────────────────────────────
        giftQueue.forEach { event ->
            GiftFloatAnimation(
                giftName = event.gift.name,
                senderName = event.senderName,
                modifier = Modifier
                    .align(Alignment.CenterStart)
                    .padding(start = 16.dp),
            )
        }

        // ── Top bar ───────────────────────────────────────────────────────────
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // LIVE + duration
            Row(
                modifier = Modifier
                    .background(BrandPink, RoundedCornerShape(6.dp))
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(modifier = Modifier.size(6.dp).background(Color.White, CircleShape))
                Text("LIVE", color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                Text(formatDuration(durationSeconds), color = Color.White.copy(0.85f), fontSize = 11.sp)
            }

            // Viewer count
            Row(
                modifier = Modifier
                    .background(Color.Black.copy(0.4f), RoundedCornerShape(6.dp))
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Default.RemoveRedEye, contentDescription = null, tint = Color.White, modifier = Modifier.size(14.dp))
                Text(
                    (activeStream?.viewerCount ?: 0).toString(),
                    color = Color.White,
                    fontSize = 11.sp,
                )
            }
        }

        // ── Bottom section: chat + controls ───────────────────────────────────
        if (!isInPipMode) Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .navigationBarsPadding()
                .imePadding(),
        ) {
            // Chat messages (last 8 visible)
            val visibleMessages = chatMessages.takeLast(8)
            LazyColumn(
                state = chatListState,
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                verticalArrangement = Arrangement.spacedBy(3.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(160.dp),
            ) {
                items(visibleMessages) { msg ->
                    LiveChatBubble(msg)
                }
            }

            Spacer(Modifier.height(4.dp))

            // Host control row
            HostControlRow(
                isMuted = isMuted,
                viewerCount = activeStream?.viewerCount ?: 0,
                onMuteToggle = {
                    isMuted = !isMuted
                    rtcEngine?.muteLocalAudioStream(isMuted)
                },
                onViewers = { showViewers = true },
                onPk = onStartPk,
                onGames = onOpenGames,
                onEnd = { showEndConfirm = true },
                onPip = {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        val activity = context as? ComponentActivity ?: return@HostControlRow
                        if (activity.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
                            val params = PictureInPictureParams.Builder()
                                .setAspectRatio(Rational(9, 16))
                                .build()
                            activity.enterPictureInPictureMode(params)
                        }
                    }
                },
            )

            // Chat input bar
            ChatInputBar(
                value = chatInput,
                onValueChange = { chatInput = it },
                onSend = {
                    if (chatInput.isNotBlank()) {
                        viewModel.sendLiveChatMessage(streamId, chatInput.trim())
                        chatInput = ""
                    }
                },
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            )
        }

        // ── Viewer list sheet ─────────────────────────────────────────────────
        if (showViewers) {
            val viewerIds = activeStream?.viewerIds ?: emptyList()
            ViewerListSheet(
                viewerIds = viewerIds,
                onKick = { userId ->
                    viewModel.kickViewer(streamId, userId)
                },
                onDismiss = { showViewers = false },
                fetchUser = { /* ViewModel loads individual profiles */ },
            )
        }

        // ── End confirm ───────────────────────────────────────────────────────
        if (showEndConfirm) {
            EndLiveConfirmDialog(
                onConfirm = {
                    showEndConfirm = false
                    // onEndLive already calls viewModel.toggleLive() via onToggleLive — do NOT
                    // also call viewModel.endLive() here or the toggle fires twice and restarts the live.
                    onEndLive()
                },
                onDismiss = { showEndConfirm = false },
            )
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// HOST CONTROL ROW
// ──────────────────────────────────────────────────────────────────────────────

@Composable
private fun HostControlRow(
    isMuted: Boolean,
    viewerCount: Int,
    onMuteToggle: () -> Unit,
    onViewers: () -> Unit,
    onPk: () -> Unit,
    onGames: () -> Unit,
    onEnd: () -> Unit,
    onPip: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp),
        horizontalArrangement = Arrangement.SpaceEvenly,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ControlButton(
            icon = if (isMuted) Icons.Default.MicOff else Icons.Default.Mic,
            label = if (isMuted) "Unmute" else "Mute",
            tint = if (isMuted) BrandPink else Color.White,
            onClick = onMuteToggle,
        )
        ControlButton(Icons.Default.RemoveRedEye, "$viewerCount", Color.White, onClick = onViewers)
        ControlButton(Icons.Default.FlashOn, "PK", BrandPink, onClick = onPk)
        ControlButton(Icons.Default.SportsEsports, "Games", Color(0xFF69F0AE), onClick = onGames)
        ControlButton(Icons.Default.PictureInPicture, "PIP", Color.White, onClick = onPip)
        // End live — red background
        Box(
            modifier = Modifier
                .size(44.dp)
                .clip(CircleShape)
                .background(Color(0xFFE53935))
                .clickable(onClick = onEnd),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Default.Stop, contentDescription = "End", tint = Color.White, modifier = Modifier.size(20.dp))
        }
    }
}

@Composable
private fun ControlButton(icon: ImageVector, label: String, tint: Color, onClick: () -> Unit) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier.clickable(onClick = onClick),
    ) {
        Box(
            modifier = Modifier
                .size(40.dp)
                .clip(CircleShape)
                .background(Color.Black.copy(0.45f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = label, tint = tint, modifier = Modifier.size(20.dp))
        }
        Spacer(Modifier.height(2.dp))
        Text(label, color = Color.White.copy(0.85f), fontSize = 9.sp)
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// CHAT BUBBLE
// ──────────────────────────────────────────────────────────────────────────────

@Composable
fun LiveChatBubble(message: LiveChatMessage) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .background(Color.Black.copy(0.5f), RoundedCornerShape(12.dp))
                .padding(horizontal = 10.dp, vertical = 5.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                Text(
                    message.senderName,
                    color = BrandPink,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                )
                Text(message.text, color = Color.White, fontSize = 11.sp, maxLines = 2)
            }
        }
    }
}

@Composable
fun LiveChatBubble(msg: LiveStreamChatMessage) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .background(Color.Black.copy(0.5f), RoundedCornerShape(12.dp))
                .padding(horizontal = 10.dp, vertical = 5.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                Text(
                    msg.senderName,
                    color = BrandPink,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                )
                Text(msg.text, color = Color.White, fontSize = 11.sp, maxLines = 2)
            }
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// CHAT INPUT BAR
// ──────────────────────────────────────────────────────────────────────────────

@Composable
fun ChatInputBar(
    value: String,
    onValueChange: (String) -> Unit,
    onSend: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            modifier = Modifier
                .weight(1f)
                .height(38.dp)
                .clip(RoundedCornerShape(19.dp))
                .background(Color.Black.copy(0.5f))
                .padding(horizontal = 14.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                singleLine = true,
                textStyle = MaterialTheme.typography.bodySmall.copy(color = Color.White),
                cursorBrush = SolidColor(BrandPink),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { onSend() }),
                modifier = Modifier.fillMaxWidth(),
                decorationBox = { inner ->
                    if (value.isEmpty()) Text("Say something…", color = Color.White.copy(0.45f), fontSize = 13.sp)
                    inner()
                }
            )
        }
        if (value.isNotBlank()) {
            Box(
                modifier = Modifier
                    .size(38.dp)
                    .clip(CircleShape)
                    .background(BrandPink)
                    .clickable(onClick = onSend),
                contentAlignment = Alignment.Center,
            ) {
                Text("→", color = Color.White, fontWeight = FontWeight.Bold)
            }
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// GIFT FLOAT ANIMATION
// ──────────────────────────────────────────────────────────────────────────────

@Composable
fun GiftFloatAnimation(giftName: String, senderName: String, modifier: Modifier = Modifier) {
    val alpha = remember { Animatable(0f) }
    val offsetY = remember { Animatable(0f) }

    LaunchedEffect(Unit) {
        alpha.animateTo(1f, tween(300))
        offsetY.animateTo(-60f, tween(2_000, easing = LinearEasing))
        alpha.animateTo(0f, tween(500))
    }

    Box(
        modifier = modifier
            .alpha(alpha.value)
            .padding(bottom = offsetY.value.dp)
            .background(Color.Black.copy(0.6f), RoundedCornerShape(20.dp))
            .padding(horizontal = 12.dp, vertical = 6.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.CardGiftcard, contentDescription = null, tint = Color(0xFFFFD700), modifier = Modifier.size(16.dp))
            Column {
                Text(senderName, color = BrandPink, fontSize = 10.sp, fontWeight = FontWeight.Bold)
                Text("sent $giftName", color = Color.White, fontSize = 10.sp)
            }
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// VIEWER LIST SHEET
// ──────────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ViewerListSheet(
    viewerIds: List<String>,
    onKick: (String) -> Unit,
    onDismiss: () -> Unit,
    fetchUser: (String) -> Unit,
) {
    val sheetState = rememberModalBottomSheetState()
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = AppSurface,
        dragHandle = { BottomSheetDefaults.DragHandle() },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp)
                .padding(bottom = 32.dp),
        ) {
            Text(
                "Viewers (${viewerIds.size})",
                style = MaterialTheme.typography.titleMedium,
                color = TextPrimary,
            )
            Spacer(Modifier.height(12.dp))
            if (viewerIds.isEmpty()) {
                Text("No viewers yet", color = TextMuted, modifier = Modifier.padding(vertical = 24.dp))
            } else {
                viewerIds.take(50).forEach { userId ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 8.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(userId.take(12) + "…", color = TextPrimary)
                        TextButton(onClick = { onKick(userId) }) {
                            Text("Kick", color = BrandPink)
                        }
                    }
                    HorizontalDivider(color = OutlineDefault)
                }
            }
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// END LIVE CONFIRM DIALOG
// ──────────────────────────────────────────────────────────────────────────────

@Composable
private fun EndLiveConfirmDialog(onConfirm: () -> Unit, onDismiss: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black.copy(0.7f))
            .clickable(onClick = onDismiss),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier
                .clip(RoundedCornerShape(16.dp))
                .background(AppSurface)
                .padding(24.dp)
                .clickable { /* consume */ },
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("End Live?", style = MaterialTheme.typography.titleMedium, color = TextPrimary)
            Spacer(Modifier.height(8.dp))
            Text("Your stream will end for all viewers.", color = TextSecondary, fontSize = 13.sp)
            Spacer(Modifier.height(20.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(10.dp))
                        .background(AppBackground)
                        .clickable(onClick = onDismiss)
                        .padding(horizontal = 20.dp, vertical = 12.dp),
                ) {
                    Text("Cancel", color = TextSecondary)
                }
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(10.dp))
                        .background(BrandPink)
                        .clickable(onClick = onConfirm)
                        .padding(horizontal = 20.dp, vertical = 12.dp),
                ) {
                    Text("End Live", color = Color.White, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────────────────────────

private fun formatDuration(seconds: Int): String {
    val m = seconds / 60
    val s = seconds % 60
    return "%02d:%02d".format(m, s)
}

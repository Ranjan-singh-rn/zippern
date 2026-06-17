package com.zipper.datingapp.ui.screens

import android.app.PictureInPictureParams
import android.content.pm.PackageManager
import android.os.Build
import android.util.Rational
import androidx.activity.ComponentActivity
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.CardGiftcard
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PictureInPicture
import androidx.compose.material.icons.filled.SportsEsports
import androidx.compose.material.icons.filled.VolumeOff
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.zipper.datingapp.data.Gift
import com.zipper.datingapp.data.LiveChatMessage
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
import kotlinx.coroutines.launch

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LIVE VIEWER SCREEN — Audience side
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Shows the host's video via Agora RTC.
 * Features:
 *  - Full-screen host video
 *  - Real-time chat overlay (bottom 40%)
 *  - Chat input bar
 *  - Gift sheet (tap 🎁)
 *  - Mute/unmute speaker
 *  - PIP button
 *  - Leave button
 *  - Gift animation overlay
 * ─────────────────────────────────────────────────────────────────────────────
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LiveViewerScreen(
    viewModel: DatingViewModel,
    streamId: String,
    hostUid: Int,       // Agora UID of the host (to render their video)
    rtcEngine: RtcEngine?,
    onLeave: () -> Unit,
) {
    val context = LocalContext.current
    val chatMessages by viewModel.liveChatMessages.collectAsState()
    val activeStream by viewModel.activeLiveStream.collectAsState()
    val giftQueue by viewModel.giftVisualQueue.collectAsState()
    val giftCatalog by viewModel.giftCatalog.collectAsState()

    var isSpeakerMuted by remember { mutableStateOf(false) }
    var chatInput by remember { mutableStateOf("") }
    var showGiftSheet by remember { mutableStateOf(false) }

    val chatListState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val giftSheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    // Join live + start observers
    LaunchedEffect(streamId) {
        viewModel.joinLive(streamId)
        viewModel.loadGiftCatalog()
    }
    DisposableEffect(streamId) {
        onDispose { viewModel.leaveLive(streamId) }
    }

    // Auto-scroll chat
    LaunchedEffect(chatMessages.size) {
        if (chatMessages.isNotEmpty()) chatListState.animateScrollToItem(chatMessages.size - 1)
    }

    Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {

        // ── Agora host video ──────────────────────────────────────────────────
        // AgoraLiveScreen self-manages the RtcEngine: requests permissions, inits the
        // SDK, and joins the channel as audience to receive the host's video stream.
        val currentUser by viewModel.currentUser.collectAsState()
        AgoraLiveScreen(
            channelId = streamId,
            firebaseUid = currentUser?.id.orEmpty(),
            isBroadcaster = false,
            token = null,   // null = no-auth mode; replace with signed token in production
            localVideoScale = AgoraVideoScaleMode.Hidden,
            remoteVideoScale = AgoraVideoScaleMode.Hidden,
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

        // ── Top controls ──────────────────────────────────────────────────────
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .padding(horizontal = 12.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Host info pill
            activeStream?.let { stream ->
                Row(
                    modifier = Modifier
                        .background(Color.Black.copy(0.45f), RoundedCornerShape(20.dp))
                        .padding(horizontal = 10.dp, vertical = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    AsyncImage(
                        model = stream.hostPhotoUrl.ifBlank { null },
                        contentDescription = null,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.size(28.dp).clip(CircleShape),
                    )
                    Column {
                        Text(stream.hostName, color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(3.dp),
                        ) {
                            Box(modifier = Modifier.size(5.dp).background(Color(0xFFE53935), CircleShape))
                            Text("${stream.viewerCount} viewers", color = Color.White.copy(0.7f), fontSize = 10.sp)
                        }
                    }
                }
            }

            // Right controls: mute, PIP, close
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                ViewerTopButton(
                    icon = if (isSpeakerMuted) Icons.Default.VolumeOff else Icons.Default.VolumeUp,
                    tint = if (isSpeakerMuted) BrandPink else Color.White,
                    onClick = {
                        isSpeakerMuted = !isSpeakerMuted
                        rtcEngine?.muteAllRemoteAudioStreams(isSpeakerMuted)
                    },
                )
                ViewerTopButton(
                    icon = Icons.Default.PictureInPicture,
                    tint = Color.White,
                    onClick = {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                            val activity = context as? ComponentActivity ?: return@ViewerTopButton
                            if (activity.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
                                activity.enterPictureInPictureMode(
                                    PictureInPictureParams.Builder()
                                        .setAspectRatio(Rational(9, 16))
                                        .build()
                                )
                            }
                        }
                    },
                )
                ViewerTopButton(
                    icon = Icons.Default.Close,
                    tint = Color.White,
                    onClick = {
                        viewModel.leaveLive(streamId)
                        onLeave()
                    },
                )
            }
        }

        // ── Bottom section: chat + action bar ─────────────────────────────────
        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .navigationBarsPadding()
                .imePadding(),
        ) {
            // Chat overlay
            val visibleMessages = chatMessages.takeLast(8)
            LazyColumn(
                state = chatListState,
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                verticalArrangement = Arrangement.spacedBy(3.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(150.dp),
            ) {
                items(visibleMessages) { msg ->
                    LiveChatBubble(msg)
                }
            }

            Spacer(Modifier.height(4.dp))

            // Action row: chat input + gift + games
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ChatInputBar(
                    value = chatInput,
                    onValueChange = { chatInput = it },
                    onSend = {
                        if (chatInput.isNotBlank()) {
                            viewModel.sendLiveChatMessage(streamId, chatInput.trim())
                            chatInput = ""
                        }
                    },
                    modifier = Modifier.weight(1f),
                )
                // Gift button — hidden for the host viewing their own stream
                val isOwnStream = currentUser?.id != null && currentUser?.id == activeStream?.hostId
                if (!isOwnStream) {
                    Box(
                        modifier = Modifier
                            .size(40.dp)
                            .clip(CircleShape)
                            .background(Color(0xFFFFD700))
                            .clickable { showGiftSheet = true },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Icons.Default.CardGiftcard, contentDescription = "Send gift", tint = Color.Black, modifier = Modifier.size(20.dp))
                    }
                }
                // Games button
                Box(
                    modifier = Modifier
                        .size(40.dp)
                        .clip(CircleShape)
                        .background(Color.Black.copy(0.5f))
                        .clickable { /* TODO: open games sheet */ },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Default.SportsEsports, contentDescription = "Games", tint = Color(0xFF69F0AE), modifier = Modifier.size(20.dp))
                }
            }
        }

        // ── Gift sheet ────────────────────────────────────────────────────────
        if (showGiftSheet && currentUser?.id != activeStream?.hostId) {
            ViewerGiftSheet(
                gifts = giftCatalog,
                sheetState = giftSheetState,
                onSendGift = { gift, qty ->
                    activeStream?.hostId?.let { hostId ->
                        viewModel.sendGift(hostId, gift, qty, streamId = streamId)
                    }
                    scope.launch { giftSheetState.hide() }
                    showGiftSheet = false
                },
                onDismiss = { showGiftSheet = false },
            )
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// VIEWER TOP BUTTON
// ──────────────────────────────────────────────────────────────────────────────

@Composable
private fun ViewerTopButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    tint: Color,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(36.dp)
            .clip(CircleShape)
            .background(Color.Black.copy(0.4f))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(18.dp))
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// GIFT SHEET (viewer → sends to host)
// ──────────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ViewerGiftSheet(
    gifts: List<Gift>,
    sheetState: androidx.compose.material3.SheetState,
    onSendGift: (Gift, Int) -> Unit,
    onDismiss: () -> Unit,
) {
    var selectedGift by remember { mutableStateOf<Gift?>(null) }
    var quantity by remember { mutableStateOf(1) }

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
            Text("Send a Gift", style = MaterialTheme.typography.titleMedium, color = TextPrimary)
            Spacer(Modifier.height(16.dp))

            // Gift grid
            LazyRow(
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                contentPadding = PaddingValues(horizontal = 4.dp),
            ) {
                items(gifts, key = { it.id }) { gift ->
                    GiftItem(
                        gift = gift,
                        isSelected = selectedGift?.id == gift.id,
                        onClick = { selectedGift = gift; quantity = 1 },
                    )
                }
            }

            Spacer(Modifier.height(16.dp))

            // Quantity selector + send button
            selectedGift?.let { gift ->
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column {
                        Text(gift.name, color = TextPrimary, fontWeight = FontWeight.SemiBold)
                        Text("💎 ${gift.effectivePrice() * quantity} diamonds", color = BrandPink, fontSize = 13.sp)
                    }
                    // Qty picker
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        listOf(1, 5, 10, 99).forEach { q ->
                            Box(
                                modifier = Modifier
                                    .background(
                                        if (quantity == q) BrandPink else AppBackground,
                                        RoundedCornerShape(8.dp),
                                    )
                                    .clickable { quantity = q }
                                    .padding(horizontal = 12.dp, vertical = 6.dp),
                            ) {
                                Text(
                                    "×$q",
                                    color = if (quantity == q) Color.White else TextSecondary,
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Medium,
                                )
                            }
                        }
                    }
                }

                Spacer(Modifier.height(16.dp))

                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(12.dp))
                        .background(Brush.linearGradient(listOf(BrandPink, BrandPurple)))
                        .clickable { onSendGift(gift, quantity) }
                        .padding(vertical = 14.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        "Send ${gift.name} ×$quantity",
                        color = Color.White,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// GIFT ITEM (in the horizontal scrolling row)
// ──────────────────────────────────────────────────────────────────────────────

@Composable
private fun GiftItem(gift: Gift, isSelected: Boolean, onClick: () -> Unit) {
    Column(
        modifier = Modifier
            .width(72.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(if (isSelected) BrandPink.copy(0.2f) else AppBackground)
            .clickable(onClick = onClick)
            .padding(8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // Gift emoji/icon placeholder — actual Lottie/ExoPlayer animation triggered on send
        Box(
            modifier = Modifier
                .size(48.dp)
                .clip(CircleShape)
                .background(Color(0xFF1A1A2E)),
            contentAlignment = Alignment.Center,
        ) {
            AsyncImage(
                model = gift.thumbnailUrl.ifBlank { null },
                contentDescription = gift.name,
                modifier = Modifier.size(40.dp),
            )
            if (gift.thumbnailUrl.isBlank()) {
                Text("🎁", fontSize = 22.sp)
            }
        }
        Spacer(Modifier.height(4.dp))
        Text(gift.name, color = TextPrimary, fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text("💎${gift.effectivePrice()}", color = BrandPink, fontSize = 9.sp, fontWeight = FontWeight.Medium)
    }
}

package com.zipper.datingapp.ui.screens

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CardGiftcard
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.EmojiEvents
import androidx.compose.material.icons.filled.FlashOn
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.zipper.datingapp.data.BattleStatus
import com.zipper.datingapp.data.Gift
import com.zipper.datingapp.economy.VirtualEconomyMath
import com.zipper.datingapp.ui.DatingViewModel
import com.zipper.datingapp.ui.theme.AppBackground
import com.zipper.datingapp.ui.theme.AppSurface
import com.zipper.datingapp.ui.theme.BrandPink
import com.zipper.datingapp.ui.theme.BrandPurple
import com.zipper.datingapp.ui.theme.TextMuted
import com.zipper.datingapp.ui.theme.TextPrimary
import com.zipper.datingapp.ui.theme.TextSecondary
import kotlinx.coroutines.launch

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PK BATTLE SCREEN
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Layout:
 *  ┌─────────────────────────────────────────┐
 *  │  [LIVE] Host Name       VS  Guest Name  │  ← top bar
 *  │ ┌──────────┬─────────────────────────┐  │
 *  │ │ Host     │  Host vid │ Guest vid   │  │
 *  │ │ support  │  [════PK bar════]       │  │
 *  │ │ bar      │           │             │  │
 *  │ └──────────┴──────────────────────┘  │
 *  │  CHAT (left side only)  ⏱ 02:45       │
 *  │  [chat input]  [🎁 gift]              │
 *  └─────────────────────────────────────────┘
 *
 * The host sees their own local video on the left; the opponent's remote
 * video on the right (via Agora RTC).
 *
 * Viewers see both videos; gifting supports one side at a time.
 * Only the viewer's own side's chat is shown.
 * ─────────────────────────────────────────────────────────────────────────────
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PkBattleScreen(
    viewModel: DatingViewModel,
    battleId: String,
    myStreamId: String,
    onBattleEnd: () -> Unit,
) {
    val battle by viewModel.activeBattle.collectAsState()
    val chatMessages by viewModel.liveChatMessages.collectAsState()
    val giftCatalog by viewModel.giftCatalog.collectAsState()
    val currentUser by viewModel.currentUser.collectAsState()

    // ── Countdown derived from battle.endTime ─────────────────────────────────
    var countdown by remember { mutableStateOf(0) }
    LaunchedEffect(battle?.endTime) {
        val endMs = battle?.endTime ?: 0L
        if (endMs <= 0L) return@LaunchedEffect
        while (true) {
            val remaining = ((endMs - System.currentTimeMillis()) / 1000L).coerceAtLeast(0L).toInt()
            countdown = remaining
            if (remaining <= 0) break
            kotlinx.coroutines.delay(1_000)
        }
    }

    var chatInput by remember { mutableStateOf("") }
    var showGiftSheet by remember { mutableStateOf(false) }
    var giftTargetIsHost by remember { mutableStateOf(true) }

    val chatListState = rememberLazyListState()
    val giftSheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        viewModel.loadGiftCatalog()
    }

    // Auto-scroll chat
    LaunchedEffect(chatMessages.size) {
        if (chatMessages.isNotEmpty()) chatListState.animateScrollToItem(chatMessages.size - 1)
    }

    // Battle ended → show result then pop
    LaunchedEffect(battle?.status) {
        if (battle?.status == BattleStatus.ENDED) {
            kotlinx.coroutines.delay(3_000)
            onBattleEnd()
        }
    }

    // Support percentages
    val hostSupport = battle?.hostDiamondSupport ?: 0L
    val guestSupport = battle?.guestDiamondSupport ?: 0L
    val total = (hostSupport + guestSupport).coerceAtLeast(1L)
    val hostPercent = (hostSupport.toFloat() / total).coerceIn(0f, 1f)

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black),
    ) {

        // ── PK Support Bar (fullWidth, top) ───────────────────────────────────
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .padding(horizontal = 12.dp, vertical = 8.dp)
                .align(Alignment.TopCenter),
        ) {
            // Names row
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // Host side
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .background(BrandPink, RoundedCornerShape(4.dp))
                            .padding(horizontal = 5.dp, vertical = 2.dp),
                    ) {
                        Text("LIVE", color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Bold)
                    }
                    Text(
                        battle?.hostUserName ?: "Host",
                        color = Color.White,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                    )
                }
                // Countdown
                Box(
                    modifier = Modifier
                        .background(Color.Black.copy(0.6f), RoundedCornerShape(20.dp))
                        .padding(horizontal = 10.dp, vertical = 4.dp),
                ) {
                    Text(
                        formatCountdown(countdown),
                        color = if (countdown <= 30) Color(0xFFFF6B6B) else Color.White,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Bold,
                    )
                }
                // Guest side
                Text(
                    battle?.guestUserName ?: "Opponent",
                    color = Color.White,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    textAlign = TextAlign.End,
                    maxLines = 1,
                )
            }

            Spacer(Modifier.height(6.dp))

            // Support bar
            PkSupportBar(hostPercent = hostPercent)

            // Diamond counts
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 3.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(3.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Default.CardGiftcard, null, tint = BrandPink, modifier = Modifier.size(11.dp))
                    Text(VirtualEconomyMath.formatCount(hostSupport), color = BrandPink, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                }
                Row(
                    horizontalArrangement = Arrangement.spacedBy(3.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(VirtualEconomyMath.formatCount(guestSupport), color = BrandPurple, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                    Icon(Icons.Default.CardGiftcard, null, tint = BrandPurple, modifier = Modifier.size(11.dp))
                }
            }
        }

        // ── Dual video feeds ──────────────────────────────────────────────────
        // Determine whether the current user is one of the two battlers or a viewer.
        val myUid = currentUser?.id.orEmpty()
        val isBattler = myUid == battle?.girl1Id || myUid == battle?.girl2Id
        val opponentUid = when (myUid) {
            battle?.girl1Id -> battle?.girl2Id.orEmpty()
            battle?.girl2Id -> battle?.girl1Id.orEmpty()
            else -> ""
        }

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.75f)
                .align(Alignment.TopCenter)
                .padding(top = 100.dp),
        ) {
            if (isBattler) {
                // Battler: local video left, remote opponent right
                AgoraPkBattlerSplit(
                    channelName = battleId,
                    myFirebaseUid = myUid,
                    opponentFirebaseUid = opponentUid,
                    onGetAgoraToken = { _, _ -> null },   // replace with signed token in production
                    onAgoraEngineChange = {},
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                // Viewer: both remote feeds
                AgoraPkSpectatorSplit(
                    channelName = battleId,
                    myFirebaseUid = myUid,
                    hostFirebaseUid = battle?.girl1Id.orEmpty(),
                    guestFirebaseUid = battle?.girl2Id.orEmpty(),
                    hostOnLeft = true,
                    onGetAgoraToken = { _, _ -> null },   // replace with signed token in production
                    hearsRemoteAudio = true,
                    modifier = Modifier.fillMaxSize(),
                )
            }

            // Labels + vertical divider overlaid on top of video
            Row(Modifier.fillMaxSize()) {
                Box(modifier = Modifier.weight(1f).fillMaxHeight()) {
                    Box(
                        modifier = Modifier
                            .align(Alignment.TopStart)
                            .padding(6.dp)
                            .background(BrandPink.copy(0.8f), RoundedCornerShape(4.dp))
                            .padding(horizontal = 5.dp, vertical = 2.dp),
                    ) {
                        Text(battle?.hostUserName?.take(10) ?: "Host", color = Color.White, fontSize = 9.sp)
                    }
                }
                Box(modifier = Modifier.width(2.dp).fillMaxHeight().background(Color.White.copy(0.3f)))
                Box(modifier = Modifier.weight(1f).fillMaxHeight()) {
                    Box(
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .padding(6.dp)
                            .background(BrandPurple.copy(0.8f), RoundedCornerShape(4.dp))
                            .padding(horizontal = 5.dp, vertical = 2.dp),
                    ) {
                        Text(battle?.guestUserName?.take(10) ?: "Opponent", color = Color.White, fontSize = 9.sp)
                    }
                }
            }
        }

        // ── Battle ended overlay ──────────────────────────────────────────────
        if (battle?.status == BattleStatus.ENDED) {
            BattleResultOverlay(
                battle = battle!!,
                currentUserId = currentUser?.id ?: "",
            )
        }

        // ── Bottom: chat + controls ───────────────────────────────────────────
        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .navigationBarsPadding()
                .imePadding(),
        ) {
            // Chat messages
            val visibleMessages = chatMessages.takeLast(6)
            LazyColumn(
                state = chatListState,
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                verticalArrangement = Arrangement.spacedBy(3.dp),
                modifier = Modifier.fillMaxWidth().height(120.dp),
            ) {
                items(visibleMessages) { msg ->
                    LiveChatBubble(msg)
                }
            }

            Spacer(Modifier.height(4.dp))

            // Input + gift row
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
                            viewModel.sendLiveChatMessage(myStreamId, chatInput.trim())
                            chatInput = ""
                        }
                    },
                    modifier = Modifier.weight(1f),
                )
                // Support host button
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(20.dp))
                        .background(Brush.linearGradient(listOf(BrandPink, BrandPurple)))
                        .clickable { giftTargetIsHost = true; showGiftSheet = true }
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                ) {
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.FlashOn, null, tint = Color.White, modifier = Modifier.size(14.dp))
                        Text("Support", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }

        // ── Gift sheet ────────────────────────────────────────────────────────
        if (showGiftSheet) {
            ModalBottomSheet(
                onDismissRequest = { showGiftSheet = false },
                sheetState = giftSheetState,
                containerColor = AppSurface,
            ) {
                PkGiftSheet(
                    gifts = giftCatalog,
                    isForHost = giftTargetIsHost,
                    hostName = battle?.hostUserName ?: "Host",
                    guestName = battle?.guestUserName ?: "Opponent",
                    onSend = { gift, qty, forHost ->
                        val recipientId = if (forHost) battle?.hostUserId ?: "" else battle?.guestUserId ?: ""
                        viewModel.sendGiftToLiveBattler(recipientId, gift, qty)
                        scope.launch { giftSheetState.hide() }
                        showGiftSheet = false
                    },
                    onDismiss = { showGiftSheet = false },
                )
            }
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// PK SUPPORT BAR
// ──────────────────────────────────────────────────────────────────────────────

@Composable
private fun PkSupportBar(hostPercent: Float) {
    val animatedProgress by animateFloatAsState(
        targetValue = hostPercent,
        animationSpec = tween(500),
        label = "pk_bar",
    )

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(14.dp)
            .clip(RoundedCornerShape(7.dp))
            .background(BrandPurple.copy(0.4f)),
    ) {
        // Host side (left, pink)
        Box(
            modifier = Modifier
                .fillMaxWidth(animatedProgress)
                .fillMaxHeight()
                .background(
                    Brush.linearGradient(listOf(BrandPink, Color(0xFFFF6B6B))),
                )
        )
        // VS divider
        Box(
            modifier = Modifier
                .align(Alignment.Center)
                .size(22.dp)
                .background(Color.Black, CircleShape)
                .clip(CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text("VS", color = Color.White, fontSize = 7.sp, fontWeight = FontWeight.ExtraBold)
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// BATTLE RESULT OVERLAY
// ──────────────────────────────────────────────────────────────────────────────

@Composable
private fun BattleResultOverlay(battle: com.zipper.datingapp.data.Battle, currentUserId: String) {
    val iWon = battle.winnerId == currentUserId
    val winnerName = if (battle.winnerId == battle.hostUserId) battle.hostUserName
    else battle.guestUserName ?: "Opponent"

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black.copy(0.75f)),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Icon(
                Icons.Default.EmojiEvents,
                contentDescription = null,
                tint = Color(0xFFFFD700),
                modifier = Modifier.size(72.dp),
            )
            Text(
                if (iWon) "🎉 You Won!" else "Better Luck Next Time",
                style = MaterialTheme.typography.headlineSmall,
                color = Color.White,
                fontWeight = FontWeight.Bold,
            )
            Text(
                "$winnerName wins the PK Battle!",
                color = Color.White.copy(0.8f),
                fontSize = 14.sp,
            )
            val hostDiamonds = VirtualEconomyMath.formatCount(battle.hostDiamondSupport)
            val guestDiamonds = VirtualEconomyMath.formatCount(battle.guestDiamondSupport)
            Text(
                "${battle.hostUserName}: 💎$hostDiamonds  vs  ${battle.guestUserName ?: "Opponent"}: 💎$guestDiamonds",
                color = TextMuted,
                fontSize = 12.sp,
                textAlign = TextAlign.Center,
            )
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// PK GIFT SHEET
// ──────────────────────────────────────────────────────────────────────────────

@Composable
private fun PkGiftSheet(
    gifts: List<Gift>,
    isForHost: Boolean,
    hostName: String,
    guestName: String,
    onSend: (Gift, Int, Boolean) -> Unit,
    onDismiss: () -> Unit,
) {
    var forHost by remember { mutableStateOf(isForHost) }
    var selectedGift by remember { mutableStateOf<Gift?>(null) }
    var quantity by remember { mutableStateOf(1) }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .padding(bottom = 32.dp),
    ) {
        Text("Support with a Gift", style = MaterialTheme.typography.titleMedium, color = TextPrimary)
        Spacer(Modifier.height(12.dp))

        // Side toggle
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            listOf(true to hostName, false to guestName).forEach { (isHost, name) ->
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(10.dp))
                        .background(
                            if (forHost == isHost) {
                                Brush.linearGradient(if (isHost) listOf(BrandPink, Color(0xFFFF6B6B)) else listOf(BrandPurple, BrandPink))
                            } else {
                                Brush.linearGradient(listOf(AppSurface, AppSurface))
                            }
                        )
                        .clickable { forHost = isHost }
                        .padding(vertical = 10.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        "Support $name",
                        color = Color.White,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }

        Spacer(Modifier.height(12.dp))

        // Gift row
        androidx.compose.foundation.lazy.LazyRow(
            horizontalArrangement = Arrangement.spacedBy(10.dp),
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

        selectedGift?.let { gift ->
            Spacer(Modifier.height(12.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("💎 ${gift.effectivePrice() * quantity} diamonds", color = BrandPink, fontWeight = FontWeight.SemiBold)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf(1, 5, 10, 50).forEach { q ->
                        Box(
                            modifier = Modifier
                                .background(
                                    if (quantity == q) BrandPink else AppBackground,
                                    RoundedCornerShape(6.dp),
                                )
                                .clickable { quantity = q }
                                .padding(horizontal = 10.dp, vertical = 5.dp),
                        ) {
                            Text("×$q", color = if (quantity == q) Color.White else TextSecondary, fontSize = 11.sp)
                        }
                    }
                }
            }
            Spacer(Modifier.height(12.dp))
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(Brush.linearGradient(if (forHost) listOf(BrandPink, BrandPurple) else listOf(BrandPurple, BrandPink)))
                    .clickable { onSend(gift, quantity, forHost) }
                    .padding(vertical = 14.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "Send to ${if (forHost) hostName else guestName}",
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                )
            }
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Local GiftItem (mirrors the private one in LiveViewerScreen)
@Composable
private fun GiftItem(gift: com.zipper.datingapp.data.Gift, isSelected: Boolean, onClick: () -> Unit) {
    val borderColor = if (isSelected) BrandPink else Color.Transparent
    androidx.compose.foundation.layout.Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier
            .width(72.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(if (isSelected) BrandPink.copy(0.15f) else AppSurface)
            .border(1.dp, borderColor, RoundedCornerShape(12.dp))
            .clickable(onClick = onClick)
            .padding(8.dp),
    ) {
        coil.compose.AsyncImage(model = gift.thumbnailUrl.ifBlank { null }, contentDescription = gift.name, modifier = Modifier.size(36.dp))
        Text(gift.name, fontSize = 9.sp, color = TextPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
        Text("💎${gift.effectivePrice()}", fontSize = 9.sp, color = BrandPink)
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────────────────────────

private fun formatCountdown(seconds: Int): String {
    val m = seconds / 60
    val s = seconds % 60
    return "%02d:%02d".format(m, s)
}

private val AppSurface = Color(0xFF1A1A2E)
private val AppBackground = Color(0xFF0D0D12)

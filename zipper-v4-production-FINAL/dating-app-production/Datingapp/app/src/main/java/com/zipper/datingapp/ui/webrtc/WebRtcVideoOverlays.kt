package com.zipper.datingapp.ui.webrtc

import android.content.Intent
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.requiredHeight
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.requiredWidth
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.automirrored.filled.VolumeOff
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.CardGiftcard
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.FlipCameraAndroid
import androidx.compose.material.icons.filled.FlipCameraIos
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.ui.AbsoluteAlignment
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.VisualTransformation
import coil.compose.AsyncImage
import com.zipper.datingapp.ui.components.LiveStreamComplianceBanner
import com.zipper.datingapp.ui.components.LiveStreamComplianceBannerVariant
import com.zipper.datingapp.ui.LIVE_CHAT_STAGING_VISIBLE_MESSAGES
import com.zipper.datingapp.ui.components.LiveChatNewMessagesCue
import com.zipper.datingapp.ui.components.LiveChatOlderMessagesCue
import com.zipper.datingapp.ui.liveChatHistoryStripMaxHeight
import com.zipper.datingapp.ui.liveChatStagingViewportMaxHeight
import com.zipper.datingapp.ui.rollerAnimateScrollToLatest
import com.zipper.datingapp.ui.theme.GoldAccent
import com.zipper.datingapp.ui.theme.ItzoUiTokens
import com.zipper.datingapp.R
import com.zipper.datingapp.data.Gift
import com.zipper.datingapp.data.GiftCatalog
import com.zipper.datingapp.data.LiveStreamChatMessage
import com.zipper.datingapp.data.isLiveSystemMessage
import com.zipper.datingapp.webrtc.WebRTCManager
import java.util.Locale
import kotlin.math.abs
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.isActive

private val PkNeonPink = ItzoUiTokens.NeonAccent
private val PkNeonBlue = ItzoUiTokens.FrameTeal
private val PkNeonGold = GoldAccent

/** Glass / non-PK overlay chat: cap LazyColumn items for performance (newest tail). */
private const val LIVE_OVERLAY_CHAT_VISIBLE_COUNT = 100

/** Bottom padding inside PK neon transcript [verticalScroll] only. Rail clearance uses strip `padding(end = …)`, not a huge scroll inset (would dwarf [liveChatStagingViewportMaxHeight]). */
private val PkNeonChatScrollStripBottomPad = 10.dp

/** Gap between the bottom of the rail stack and the Host/Challenger chip row. */
private val PkNeonBattlerRailAboveChipsGap = 10.dp

/** Space between vertically stacked rail buttons. */
private val PkNeonBattlerRailStackSpacing = 12.dp

/** Host/challenger transcript strip horizontal inset (shared). */
private val PkNeonTranscriptHorizontalPad = 12.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PkNeonBattleBottomLayout(
    messages: List<LiveStreamChatMessage>,
    onSendMessage: (String) -> Unit,
    endCallLabel: String,
    onEndCall: (() -> Unit)?,
    isMicOn: Boolean,
    isSpeakerOn: Boolean,
    onToggleMic: ((Boolean) -> Unit)?,
    onToggleSpeaker: ((Boolean) -> Unit)?,
    onOpenGiftSheet: (() -> Unit)?,
    onOpenDiamondShop: (() -> Unit)? = null,
    giftActionInProgress: Boolean,
    onFlipCamera: (() -> Unit)?,
    flipCameraEnabled: Boolean,
    isModerationHost: Boolean,
    streamHostUserIdForModeration: String?,
    senderPhotoLookup: (String) -> String?,
    onGiftRowClick: ((LiveStreamChatMessage) -> Unit)?,
    onModerationRequest: (LiveStreamChatMessage) -> Unit,
    pkNeonStreamerSide: Boolean,
    /** PK host bottom panel: viewer count (top-left). */
    pkStreamerPanelViewersLabel: String? = null,
    /** PK host bottom panel: close (top-right); when set, hides duplicate end-call in the action column. */
    onPkStreamerPanelClose: (() -> Unit)? = null,
    /** PK battler panel: viewer breakdown chip (left) + mic/speaker (right), above the message field. */
    pkBottomViewerChipLabel: String? = null,
    onPkBottomViewerChipClick: (() -> Unit)? = null,
    /** When both labels are non-blank, shows two tappable chips (host vs challenger supporters). */
    pkHostSpectatorsLabel: String? = null,
    pkGuestSpectatorsLabel: String? = null,
    onPkHostSpectatorsClick: (() -> Unit)? = null,
    onPkGuestSpectatorsClick: (() -> Unit)? = null,
    pkAllSpectatorsSummaryLine: String? = null,
    onPkAllSpectatorsClick: (() -> Unit)? = null,
    /** PK audience (not battler): heart / like host stream. */
    onPkSpectatorLike: (() -> Unit)? = null,
    /** Opens AR / face-filter bottom sheet (host PK neon layout). */
    onOpenArFilters: (() -> Unit)? = null,
    /** Consolidated PK tools (diamond shop + filters); opens [PkToolsMenuSheet] from host. */
    onOpenPkToolsMenu: (() -> Unit)? = null,
    /** Live/PK chat: show static compliance copy above messages. */
    showComplianceBanner: Boolean = false,
    skipNavigationBarsInset: Boolean = false,
) {
    var draft by remember { mutableStateOf("") }
    val pkNeonChatTextStyle = remember {
        TextStyle(
            color = Color.White,
            fontSize = 15.sp,
            lineHeight = 20.sp,
            textAlign = TextAlign.Start,
            platformStyle = PlatformTextStyle(includeFontPadding = false),
        )
    }
    val pkNeonChatInteraction = remember { MutableInteractionSource() }
    val pkNeonChatFieldColors = OutlinedTextFieldDefaults.colors(
        focusedContainerColor = Color(0xFF0D0718).copy(alpha = 0.96f),
        unfocusedContainerColor = Color(0xFF0D0718).copy(alpha = 0.96f),
        focusedBorderColor = Color.Transparent,
        unfocusedBorderColor = Color.Transparent,
        cursorColor = PkNeonPink,
        focusedTextColor = Color.White,
        unfocusedTextColor = Color.White,
    )
    val ctx = LocalContext.current
    val isFrontCamera by WebRTCManager.globalIsFrontCamera.collectAsStateWithLifecycle()
    val showStreamerTopBar =
        pkNeonStreamerSide && (!pkStreamerPanelViewersLabel.isNullOrBlank() || onPkStreamerPanelClose != null)
    val contentTopPad = if (showStreamerTopBar) 52.dp else 4.dp
    /** End inset for chat + composer — one vertical column of round controls (~48dp + margin). */
    val pkNeonRailComposeInset = 72.dp
    val showEndCallInSideColumn = onEndCall != null && (onPkStreamerPanelClose == null || !pkNeonStreamerSide)

    var streamerChatHistoryMode by remember { mutableStateOf(false) }
    var pkNeonInitialSnapPending by remember(pkNeonStreamerSide) { mutableStateOf(true) }
    /** True while [rollerAnimateScrollToLatest] runs — avoids treating animated scroll as user leaving live tail. */
    var pkNeonSuppressHistoryFromScroll by remember { mutableStateOf(false) }
    var pkNeonHistoryBaselineCount by remember { mutableIntStateOf(0) }
    val chatScrollState = rememberScrollState()
    val spectatorScrollState = rememberScrollState()
    val pkNeonActionScope = rememberCoroutineScope()
    val pkNeonLiveChatCountRef = rememberUpdatedState(messages.size)
    val historyModeRef = rememberUpdatedState(streamerChatHistoryMode)
    val pkNeonInitialSnapPendingRef = rememberUpdatedState(pkNeonInitialSnapPending)
    val pkNeonSuppressHistoryFromScrollRef = rememberUpdatedState(pkNeonSuppressHistoryFromScroll)
    val openPkChatHistory = rememberUpdatedState({
        pkNeonHistoryBaselineCount = pkNeonLiveChatCountRef.value
        streamerChatHistoryMode = true
        pkNeonInitialSnapPending = false
    })
    /** PK neon (host, challenger, or spectator column): overscroll reveals older lines. */
    val revealPkChatHistoryScroll = remember {
        object : NestedScrollConnection {
            override fun onPostScroll(
                consumed: Offset,
                available: Offset,
                source: NestedScrollSource
            ): Offset {
                if (!historyModeRef.value && abs(available.y) > 18f) {
                    if (pkNeonInitialSnapPendingRef.value) return Offset.Zero
                    openPkChatHistory.value.invoke()
                }
                return Offset.Zero
            }
        }
    }
    LaunchedEffect(pkNeonStreamerSide) {
        streamerChatHistoryMode = false
        pkNeonInitialSnapPending = true
    }
    val messagesNewestFirst = remember(messages) { messages.asReversed() }
    /** Full chronological feed; staging shows last [LIVE_CHAT_STAGING_VISIBLE_MESSAGES] rows only (no TTL eviction). */
    val messagesChronologicalFull = remember(messagesNewestFirst) {
        messagesNewestFirst.asReversed()
    }
    val pkNeonDisplayedChronological = remember(
        messagesChronologicalFull,
        streamerChatHistoryMode,
    ) {
        if (streamerChatHistoryMode) messagesChronologicalFull
        else messagesChronologicalFull.takeLast(LIVE_CHAT_STAGING_VISIBLE_MESSAGES)
    }
    LaunchedEffect(pkNeonStreamerSide, chatScrollState, spectatorScrollState) {
        snapshotFlow {
            val scroll = if (pkNeonStreamerSide) chatScrollState else spectatorScrollState
            scroll.maxValue > 0 && scroll.value < scroll.maxValue - 8
        }
            .distinctUntilChanged()
            .collect { scrolledAway ->
                val scroll = if (pkNeonStreamerSide) chatScrollState else spectatorScrollState
                if (scrolledAway) {
                    if (scroll.maxValue <= 0) return@collect
                    if (pkNeonInitialSnapPendingRef.value) return@collect
                    if (pkNeonSuppressHistoryFromScrollRef.value) return@collect
                    openPkChatHistory.value.invoke()
                } else {
                    val countAtSchedule = messages.size
                    // Wait 5 seconds of inactivity before snapping back to newest messages
                    delay(5_000L)
                    if (messages.size > countAtSchedule) return@collect
                    val scroll = if (pkNeonStreamerSide) chatScrollState else spectatorScrollState
                    val stillAway = scroll.maxValue > 0 && scroll.value < scroll.maxValue - 8
                    if (!stillAway) {
                        streamerChatHistoryMode = false
                        pkNeonHistoryBaselineCount = pkNeonLiveChatCountRef.value
                        pkNeonInitialSnapPending = false
                        scroll.scrollTo(scroll.maxValue)
                    }
                }
            }
    }
    val feedNewestKey = messagesNewestFirst.firstOrNull()?.let { m ->
        "${m.id}_${m.timestamp}_${m.text.length}"
    }.orEmpty()

    val pkPanelTopRadius = 28.dp
    /** Keeps first bubble below rounded panel/video seam (matches radius-aware headroom). */
    val pkNeonChatScrollTopInset = (pkPanelTopRadius - 8.dp).coerceAtLeast(12.dp)
    val pkNeonChatScrollBottomReserve = PkNeonChatScrollStripBottomPad
    val configuration = LocalConfiguration.current
    val pkHistoryStripMaxH = liveChatHistoryStripMaxHeight(configuration.screenHeightDp)
    val pkStagingStripMaxH = liveChatStagingViewportMaxHeight()
    val pkChatStripMaxH =
        if (streamerChatHistoryMode) pkHistoryStripMaxH else pkStagingStripMaxH

    /** Staging: top-down transcript + explicit snap avoids viewport stuck at scroll=0 with content below fold. */
    LaunchedEffect(
        feedNewestKey,
        messages.size,
        streamerChatHistoryMode,
        pkNeonStreamerSide,
        pkNeonDisplayedChronological.size,
        pkChatStripMaxH,
    ) {
        if (streamerChatHistoryMode) return@LaunchedEffect
        if (pkNeonDisplayedChronological.isEmpty()) return@LaunchedEffect
        val scroll = if (pkNeonStreamerSide) chatScrollState else spectatorScrollState
        pkNeonSuppressHistoryFromScroll = true
        try {
            delay(24L)
            rollerAnimateScrollToLatest(scroll)
            if (pkNeonInitialSnapPending) pkNeonInitialSnapPending = false
        } finally {
            pkNeonSuppressHistoryFromScroll = false
        }
    }

    Column(Modifier.fillMaxSize()) {
    Box(
        modifier = Modifier
            .weight(1f)
            .fillMaxWidth()
            .clip(RoundedCornerShape(topStart = pkPanelTopRadius, topEnd = pkPanelTopRadius))
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(
                    Brush.verticalGradient(
                        colors = listOf(
                            Color(0xFF1F1538).copy(alpha = 0.92f),
                            Color(0xFF12081E).copy(alpha = 0.94f),
                            Color(0xFF07030F).copy(alpha = 0.97f)
                        )
                    )
                )
        )
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(
                    Brush.linearGradient(
                        colors = listOf(
                            PkNeonBlue.copy(alpha = 0.16f),
                            Color.Transparent,
                            PkNeonPink.copy(alpha = 0.12f)
                        ),
                        start = Offset(0f, 0f),
                        end = Offset(900f, 1400f)
                    )
                )
        )
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(
                    Brush.verticalGradient(
                        colors = listOf(
                            Color.Transparent,
                            Color.Transparent,
                            Color.Black.copy(alpha = 0.38f)
                        ),
                        startY = 0f,
                        endY = 1200f
                    )
                )
        )
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(
                    Brush.horizontalGradient(
                        colors = listOf(
                            Color.Black.copy(alpha = 0.22f),
                            Color.Transparent,
                            Color.Black.copy(alpha = 0.22f)
                        )
                    )
                )
        )
    Column(
        modifier = Modifier.fillMaxSize()
    ) {
        if (showStreamerTopBar) {
            Surface(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 8.dp, top = 4.dp, end = 8.dp),
                shape = RoundedCornerShape(12.dp),
                color = Color.Black.copy(alpha = 0.4f)
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 6.dp, vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text(
                        text = pkStreamerPanelViewersLabel.orEmpty(),
                        color = Color.White.copy(alpha = 0.92f),
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false)
                    )
                    if (onPkStreamerPanelClose != null) {
                        IconButton(
                            onClick = onPkStreamerPanelClose,
                            modifier = Modifier.size(40.dp)
                        ) {
                            Icon(
                                Icons.Default.Close,
                                contentDescription = stringResource(R.string.live_leave_stream_cd),
                                tint = Color.White,
                                modifier = Modifier.size(22.dp)
                            )
                        }
                    }
                }
            }
        }
        val pkActionIconDp = 48.dp
        /** Flex slot for transcript + rail; composer stays in sibling Column below (never clipped by strip growth). */
        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
        ) {
            Spacer(modifier = Modifier.weight(1f).fillMaxWidth())
            // Box + AbsoluteAlignment pins rail to physical screen right even under RTL (Row/order hacks alone won't).
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .wrapContentHeight(align = Alignment.Bottom)
                    /** Prevent transcript collapse: wrapContentHeight + inner fillMaxHeight measured ~0 without a floor. */
                    .heightIn(min = pkChatStripMaxH)
                    .padding(
                        start = 8.dp,
                        end = 8.dp,
                        top = contentTopPad
                    ),
            ) {
                val boxScope = this
            if (pkNeonStreamerSide) {
                val battlerChatModifier = with(boxScope) {
                    Modifier
                        .align(AbsoluteAlignment.BottomLeft)
                        .wrapContentHeight(align = Alignment.Bottom)
                        .fillMaxWidth()
                }
                Column(
                    modifier = battlerChatModifier,
                ) {
                    if (!streamerChatHistoryMode &&
                        messages.size > LIVE_CHAT_STAGING_VISIBLE_MESSAGES
                    ) {
                        LiveChatOlderMessagesCue(onOpenHistory = { openPkChatHistory.value.invoke() })
                    }
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = pkChatStripMaxH, max = pkChatStripMaxH)
                            .padding(start = PkNeonTranscriptHorizontalPad, end = pkNeonRailComposeInset)
                    ) {
                        if (streamerChatHistoryMode &&
                            messages.size > pkNeonHistoryBaselineCount
                        ) {
                            LiveChatNewMessagesCue(
                                modifier = Modifier
                                    .align(Alignment.BottomEnd)
                                    .padding(end = 8.dp, bottom = 8.dp)
                                    .zIndex(1f),
                                onJumpToLatest = {
                                    streamerChatHistoryMode = false
                                    pkNeonHistoryBaselineCount = messages.size
                                    pkNeonActionScope.launch {
                                        pkNeonSuppressHistoryFromScroll = true
                                        try {
                                            rollerAnimateScrollToLatest(chatScrollState)
                                        } finally {
                                            pkNeonSuppressHistoryFromScroll = false
                                        }
                                    }
                                },
                            )
                        }
                    BoxWithConstraints(
                        modifier = Modifier
                            .fillMaxWidth()
                            .fillMaxHeight()
                            .align(Alignment.BottomStart)
                    ) {
                        val stripMinHeight = maxHeight.coerceAtLeast(1.dp)
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .nestedScroll(revealPkChatHistoryScroll)
                                .verticalScroll(chatScrollState)
                                .padding(bottom = pkNeonChatScrollBottomReserve, top = pkNeonChatScrollTopInset),
                        ) {
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .heightIn(min = stripMinHeight),
                            ) {
                                if (messages.isEmpty()) {
                                    Text(
                                        stringResource(R.string.call_overlay_chat_empty),
                                        color = Color.White.copy(alpha = 0.45f),
                                        fontSize = 12.sp,
                                        modifier = Modifier
                                            .align(Alignment.BottomStart)
                                            .padding(8.dp)
                                    )
                                } else {
                                    Column(
                                        modifier = Modifier
                                            .align(Alignment.BottomStart)
                                            .fillMaxWidth(),
                                        verticalArrangement = Arrangement.spacedBy(5.dp),
                                        horizontalAlignment = Alignment.Start,
                                    ) {
                        pkNeonDisplayedChronological.forEach { m ->
                            key(m.id.ifBlank { "${m.timestamp}_${m.senderId}" }) {
                                val canModerate = isModerationHost &&
                                    !m.isLiveSystemMessage() &&
                                    m.type != "gift" &&
                                    m.senderId.isNotBlank() &&
                                    m.senderId != streamHostUserIdForModeration
                                when {
                                    m.isLiveSystemMessage() -> {
                                        val isJoin = m.text.contains("joined", ignoreCase = true)
                                        Surface(
                                            color = if (isJoin) Color(0xFF14532D).copy(alpha = 0.55f) else Color.Black.copy(alpha = 0.4f),
                                            shape = RoundedCornerShape(16.dp),
                                            border = BorderStroke(
                                                1.dp,
                                                if (isJoin) Color(0xFF4ADE80).copy(alpha = 0.55f) else Color.White.copy(alpha = 0.1f)
                                            ),
                                            modifier = Modifier.padding(vertical = 2.dp, horizontal = 2.dp)
                                        ) {
                                            Text(
                                                text = m.text,
                                                color = if (isJoin) Color(0xFF86EFAC) else Color.White.copy(alpha = 0.65f),
                                                fontSize = 11.sp,
                                                fontStyle = FontStyle.Italic,
                                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 7.dp),
                                                maxLines = 3,
                                                overflow = TextOverflow.Ellipsis
                                            )
                                        }
                                    }
                                    m.type == "gift" -> {
                                        Surface(
                                            color = Color.Black.copy(alpha = 0.38f),
                                            shape = RoundedCornerShape(16.dp),
                                            border = BorderStroke(1.dp, PkNeonGold.copy(alpha = 0.35f)),
                                            modifier = Modifier.padding(vertical = 2.dp, horizontal = 2.dp)
                                        ) {
                                            LiveStreamGiftChatRow(
                                                message = m,
                                                senderPhotoUrl = senderPhotoLookup(m.senderId),
                                                modifier = Modifier.padding(4.dp),
                                                onClick = onGiftRowClick?.let { { it(m) } }
                                            )
                                        }
                                    }
                                    else -> {
                                        Surface(
                                            color = Color.Black.copy(alpha = 0.42f),
                                            shape = RoundedCornerShape(18.dp),
                                            border = BorderStroke(1.dp, Color.White.copy(alpha = 0.12f)),
                                            modifier = Modifier
                                                .padding(vertical = 2.dp, horizontal = 2.dp)
                                                .then(
                                                    if (canModerate) Modifier.clickable { onModerationRequest(m) } else Modifier
                                                )
                                        ) {
                                            Text(
                                                "${m.senderName}: ${m.text}",
                                                color = Color.White,
                                                fontSize = 12.sp,
                                                maxLines = 3,
                                                overflow = TextOverflow.Ellipsis,
                                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)
                                            )
                                        }
                                    }
                                }
                            }
                        }
                                    }
                                }
                            }
                        }
                    }
                    }
                }
            } else {
                val spectatorChatModifier = with(boxScope) {
                    Modifier
                        .align(AbsoluteAlignment.BottomLeft)
                        .wrapContentHeight(align = Alignment.Bottom)
                        .fillMaxWidth()
                }
                Column(
                    modifier = spectatorChatModifier,
                ) {
                    if (!streamerChatHistoryMode &&
                        messages.size > LIVE_CHAT_STAGING_VISIBLE_MESSAGES
                    ) {
                        LiveChatOlderMessagesCue(onOpenHistory = { openPkChatHistory.value.invoke() })
                    }
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = PkNeonTranscriptHorizontalPad)
                            .heightIn(min = pkChatStripMaxH, max = pkChatStripMaxH)
                    ) {
                        if (streamerChatHistoryMode &&
                            messages.size > pkNeonHistoryBaselineCount
                        ) {
                            LiveChatNewMessagesCue(
                                modifier = Modifier
                                    .align(Alignment.BottomEnd)
                                    .padding(end = 8.dp, bottom = 8.dp)
                                    .zIndex(1f),
                                onJumpToLatest = {
                                    streamerChatHistoryMode = false
                                    pkNeonHistoryBaselineCount = messages.size
                                    pkNeonActionScope.launch {
                                        pkNeonSuppressHistoryFromScroll = true
                                        try {
                                            rollerAnimateScrollToLatest(spectatorScrollState)
                                        } finally {
                                            pkNeonSuppressHistoryFromScroll = false
                                        }
                                    }
                                },
                            )
                        }
                    BoxWithConstraints(
                        modifier = Modifier
                            .fillMaxWidth()
                            .fillMaxHeight()
                            .align(Alignment.BottomStart)
                    ) {
                        val stripMinHeight = maxHeight.coerceAtLeast(1.dp)
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .nestedScroll(revealPkChatHistoryScroll)
                                .verticalScroll(spectatorScrollState)
                                .padding(bottom = pkNeonChatScrollBottomReserve, top = pkNeonChatScrollTopInset),
                        ) {
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .heightIn(min = stripMinHeight),
                            ) {
                                if (messages.isEmpty()) {
                                    Text(
                                        stringResource(R.string.call_overlay_chat_empty),
                                        color = Color.White.copy(alpha = 0.45f),
                                        fontSize = 12.sp,
                                        modifier = Modifier
                                            .align(Alignment.BottomStart)
                                            .padding(8.dp)
                                    )
                                } else {
                                    Column(
                                        modifier = Modifier
                                            .align(Alignment.BottomStart)
                                            .fillMaxWidth(),
                                        verticalArrangement = Arrangement.spacedBy(5.dp),
                                        horizontalAlignment = Alignment.Start,
                                    ) {
                            pkNeonDisplayedChronological.forEach { m ->
                                key(m.id.ifBlank { "${m.timestamp}_${m.senderId}" }) {
                                    val canModerate = isModerationHost &&
                                        !m.isLiveSystemMessage() &&
                                        m.type != "gift" &&
                                        m.senderId.isNotBlank() &&
                                        m.senderId != streamHostUserIdForModeration
                                    when {
                                        m.isLiveSystemMessage() -> {
                                            val isJoin = m.text.contains("joined", ignoreCase = true)
                                            Surface(
                                                color = if (isJoin) Color(0xFF14532D).copy(alpha = 0.55f) else Color.Black.copy(alpha = 0.4f),
                                                shape = RoundedCornerShape(16.dp),
                                                border = BorderStroke(
                                                    1.dp,
                                                    if (isJoin) Color(0xFF4ADE80).copy(alpha = 0.55f) else Color.White.copy(alpha = 0.1f)
                                                ),
                                                modifier = Modifier.padding(vertical = 2.dp, horizontal = 2.dp)
                                            ) {
                                                Text(
                                                    text = m.text,
                                                    color = if (isJoin) Color(0xFF86EFAC) else Color.White.copy(alpha = 0.65f),
                                                    fontSize = 11.sp,
                                                    fontStyle = FontStyle.Italic,
                                                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 7.dp),
                                                    maxLines = 3,
                                                    overflow = TextOverflow.Ellipsis
                                                )
                                            }
                                        }
                                        m.type == "gift" -> {
                                            Surface(
                                                color = Color.Black.copy(alpha = 0.38f),
                                                shape = RoundedCornerShape(16.dp),
                                                border = BorderStroke(1.dp, PkNeonGold.copy(alpha = 0.35f)),
                                                modifier = Modifier.padding(vertical = 2.dp, horizontal = 2.dp)
                                            ) {
                                                LiveStreamGiftChatRow(
                                                    message = m,
                                                    senderPhotoUrl = senderPhotoLookup(m.senderId),
                                                    modifier = Modifier.padding(4.dp),
                                                    onClick = onGiftRowClick?.let { { it(m) } }
                                                )
                                            }
                                        }
                                        else -> {
                                            Surface(
                                                color = Color.Black.copy(alpha = 0.42f),
                                                shape = RoundedCornerShape(18.dp),
                                                border = BorderStroke(1.dp, Color.White.copy(alpha = 0.12f)),
                                                modifier = Modifier
                                                    .padding(vertical = 2.dp, horizontal = 2.dp)
                                                    .then(
                                                        if (canModerate) Modifier.clickable { onModerationRequest(m) } else Modifier
                                                    )
                                            ) {
                                                Text(
                                                    "${m.senderName}: ${m.text}",
                                                    color = Color.White,
                                                    fontSize = 12.sp,
                                                    maxLines = 3,
                                                    overflow = TextOverflow.Ellipsis,
                                                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)
                                                )
                                            }
                                        }
                                    }
                                }
                            }
                        }
                                    }
                                }
                            }
                        }
                    }
                    }
                }
            val pkRailModifier = with(boxScope) {
                Modifier
                    .align(AbsoluteAlignment.BottomRight)
                    .graphicsLayer(clip = false)
                    .wrapContentHeight()
                    .wrapContentWidth()
                    .padding(end = 6.dp, top = 6.dp)
                    .padding(bottom = PkNeonBattlerRailAboveChipsGap)
            }
            if (pkNeonStreamerSide) {
                // Single vertical rail (right, bottom-aligned): gift → more → mic → speaker → flip → end call.
                Column(
                    modifier = pkRailModifier,
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(PkNeonBattlerRailStackSpacing),
                ) {
                    if (onOpenGiftSheet != null) {
                        Box(
                            modifier = Modifier
                                .size(pkActionIconDp)
                                .shadow(2.dp, CircleShape, spotColor = PkNeonGold, ambientColor = Color(0x40FF9100))
                                .clip(CircleShape)
                                .background(
                                    Brush.radialGradient(
                                        colors = listOf(PkNeonGold, Color(0xFFFF9100).copy(alpha = 0.85f))
                                    )
                                )
                                .clickable(enabled = !giftActionInProgress) {
                                    if (!giftActionInProgress) onOpenGiftSheet()
                                },
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                Icons.Default.CardGiftcard,
                                contentDescription = stringResource(R.string.live_send_gift_action),
                                tint = Color.Black,
                                modifier = Modifier.size(22.dp)
                            )
                        }
                    }
                    if (onOpenPkToolsMenu != null) {
                        Box(
                            modifier = Modifier
                                .size(pkActionIconDp)
                                .clip(CircleShape)
                                .background(Color(0xFF1E293B).copy(alpha = 0.92f))
                                .border(1.dp, Color.White.copy(alpha = 0.22f), CircleShape)
                                .clickable(onClick = onOpenPkToolsMenu),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                imageVector = Icons.Default.MoreHoriz,
                                contentDescription = stringResource(R.string.pk_tools_menu_cd),
                                tint = Color.White,
                                modifier = Modifier.size(24.dp)
                            )
                        }
                    }
                    if (onToggleMic != null) {
                        Box(
                            modifier = Modifier
                                .size(pkActionIconDp)
                                .clip(CircleShape)
                                .background(
                                    if (isMicOn) Color(0xFF1E293B).copy(alpha = 0.9f) else Color(0xFFB91C1C).copy(alpha = 0.85f)
                                )
                                .clickable { onToggleMic(!isMicOn) },
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                imageVector = if (isMicOn) Icons.Default.Mic else Icons.Default.MicOff,
                                contentDescription = null,
                                tint = Color.White,
                                modifier = Modifier.size(20.dp)
                            )
                        }
                    }
                    if (onToggleSpeaker != null) {
                        Box(
                            modifier = Modifier
                                .size(pkActionIconDp)
                                .clip(CircleShape)
                                .background(
                                    if (isSpeakerOn) PkNeonBlue.copy(alpha = 0.35f) else Color(0xFF1E293B).copy(alpha = 0.9f)
                                )
                                .clickable { onToggleSpeaker(!isSpeakerOn) },
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                imageVector = if (isSpeakerOn) Icons.AutoMirrored.Filled.VolumeUp else Icons.AutoMirrored.Filled.VolumeOff,
                                contentDescription = null,
                                tint = Color.White,
                                modifier = Modifier.size(20.dp)
                            )
                        }
                    }
                    if (onFlipCamera != null) {
                        Box(
                            modifier = Modifier
                                .size(pkActionIconDp)
                                .shadow(2.dp, CircleShape, spotColor = PkNeonBlue.copy(alpha = 0.6f))
                                .clip(CircleShape)
                                .background(Color(0xFF1A1030).copy(alpha = 0.9f))
                                .border(1.dp, PkNeonBlue.copy(alpha = if (flipCameraEnabled) 0.85f else 0.25f), CircleShape)
                                .clickable(enabled = flipCameraEnabled, onClick = onFlipCamera),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                imageVector = if (isFrontCamera) Icons.Default.FlipCameraAndroid else Icons.Default.FlipCameraIos,
                                contentDescription = stringResource(R.string.call_flip_camera),
                                tint = if (flipCameraEnabled) Color.White else Color.White.copy(alpha = 0.35f),
                                modifier = Modifier.size(22.dp)
                            )
                        }
                    }
                    if (showEndCallInSideColumn) {
                        Box(
                            modifier = Modifier
                                .size(pkActionIconDp)
                                .shadow(2.dp, CircleShape, spotColor = Color(0xFFFF1744))
                                .clip(CircleShape)
                                .background(Color(0xFF3E0510).copy(alpha = 0.92f))
                                .border(1.dp, Color(0xFFFF4081).copy(alpha = 0.75f), CircleShape)
                                .clickable(onClick = onEndCall!!),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                Icons.Default.CallEnd,
                                contentDescription = endCallLabel,
                                tint = Color(0xFFFF8A80),
                                modifier = Modifier.size(22.dp)
                            )
                        }
                    }
                }
            }
        }
        }

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .then(if (!skipNavigationBarsInset) Modifier.navigationBarsPadding() else Modifier)
                .imePadding()
                .padding(horizontal = 8.dp, vertical = 8.dp),
            horizontalAlignment = Alignment.Start,
        ) {
            if (showComplianceBanner) {
                LiveStreamComplianceBanner(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(end = pkNeonRailComposeInset)
                        .padding(bottom = 3.dp),
                    variant = LiveStreamComplianceBannerVariant.DockedAboveComposer,
                )
            }
            val dualPkSpectatorChips = !pkHostSpectatorsLabel.isNullOrBlank() &&
                !pkGuestSpectatorsLabel.isNullOrBlank()
            val showTopBarRow = dualPkSpectatorChips ||
                !pkBottomViewerChipLabel.isNullOrBlank()
            if (showTopBarRow) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = 4.dp)
                        /** No-fly zone: right action rail — same inset as composer field. */
                        .padding(end = pkNeonRailComposeInset),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    if (dualPkSpectatorChips) {
                        Surface(
                            shape = RoundedCornerShape(14.dp),
                            color = Color.Black.copy(alpha = 0.38f),
                            border = BorderStroke(1.dp, PkNeonBlue.copy(alpha = 0.45f)),
                            modifier = Modifier
                                .weight(1f)
                                .then(
                                    if (onPkHostSpectatorsClick != null) {
                                        Modifier.clickable(onClick = onPkHostSpectatorsClick)
                                    } else {
                                        Modifier
                                    }
                                )
                        ) {
                            Text(
                                text = pkHostSpectatorsLabel!!,
                                color = Color.White,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.SemiBold,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)
                            )
                        }
                        Surface(
                            shape = RoundedCornerShape(14.dp),
                            color = Color.Black.copy(alpha = 0.38f),
                            border = BorderStroke(1.dp, PkNeonPink.copy(alpha = 0.45f)),
                            modifier = Modifier
                                .weight(1f)
                                .then(
                                    if (onPkGuestSpectatorsClick != null) {
                                        Modifier.clickable(onClick = onPkGuestSpectatorsClick)
                                    } else {
                                        Modifier
                                    }
                                )
                        ) {
                            Text(
                                text = pkGuestSpectatorsLabel!!,
                                color = Color.White,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.SemiBold,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)
                            )
                        }
                    } else if (!pkBottomViewerChipLabel.isNullOrBlank()) {
                        Surface(
                            shape = RoundedCornerShape(14.dp),
                            color = Color.Black.copy(alpha = 0.38f),
                            border = BorderStroke(1.dp, PkNeonBlue.copy(alpha = 0.45f)),
                            modifier = Modifier
                                .weight(1f)
                                .then(
                                    if (onPkBottomViewerChipClick != null) {
                                        Modifier.clickable(onClick = onPkBottomViewerChipClick)
                                    } else {
                                        Modifier
                                    }
                                )
                        ) {
                            Text(
                                text = pkBottomViewerChipLabel,
                                color = Color.White,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.SemiBold,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp)
                            )
                        }
                    }
                }
            }
            val showPkAllLine = dualPkSpectatorChips &&
                !pkAllSpectatorsSummaryLine.isNullOrBlank() &&
                onPkAllSpectatorsClick != null
            if (showPkAllLine) {
                Text(
                    text = pkAllSpectatorsSummaryLine!!,
                    color = Color.White.copy(alpha = 0.78f),
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = 4.dp, bottom = 4.dp, end = pkNeonRailComposeInset)
                        .clip(RoundedCornerShape(8.dp))
                        .clickable(onClick = onPkAllSpectatorsClick!!)
                        .padding(horizontal = 8.dp, vertical = 4.dp)
                )
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(IntrinsicSize.Min),
                verticalAlignment = Alignment.Bottom,
            ) {
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxHeight()
                        .defaultMinSize(minHeight = 52.dp)
                        .heightIn(max = 52.dp)
                        .padding(vertical = 0.dp)
                        .clip(RoundedCornerShape(24.dp))
                        .background(
                            Brush.horizontalGradient(
                                colors = listOf(PkNeonBlue, PkNeonPink)
                            )
                        )
                        .padding(horizontal = 2.dp),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    val pkNeonChatShape = RoundedCornerShape(24.dp)
                    BasicTextField(
                        value = draft,
                        onValueChange = { draft = it },
                        modifier = Modifier
                            .fillMaxWidth()
                            .fillMaxHeight()
                            .defaultMinSize(minHeight = 52.dp),
                        singleLine = true,
                        textStyle = pkNeonChatTextStyle,
                        interactionSource = pkNeonChatInteraction,
                        cursorBrush = SolidColor(PkNeonPink),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                        keyboardActions = KeyboardActions(
                            onSend = {
                                val t = draft.trim()
                                if (t.isNotEmpty()) {
                                    onSendMessage(t)
                                    draft = ""
                                }
                            }
                        ),
                        decorationBox = { innerTextField ->
                            OutlinedTextFieldDefaults.DecorationBox(
                                value = draft,
                                innerTextField = {
                                    Box(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .fillMaxHeight(),
                                        contentAlignment = Alignment.CenterStart,
                                    ) {
                                        innerTextField()
                                    }
                                },
                                enabled = true,
                                singleLine = true,
                                visualTransformation = VisualTransformation.None,
                                interactionSource = pkNeonChatInteraction,
                                colors = pkNeonChatFieldColors,
                                contentPadding = OutlinedTextFieldDefaults.contentPadding(
                                    start = 12.dp,
                                    end = 12.dp,
                                    top = 8.dp,
                                    bottom = 8.dp,
                                ),
                                placeholder = {
                                    Text(
                                        text = stringResource(R.string.pk_type_message_hint),
                                        style = pkNeonChatTextStyle.copy(
                                            color = Color.White.copy(alpha = 0.45f),
                                            textAlign = TextAlign.Start,
                                        ),
                                    )
                                },
                                trailingIcon = {
                                    TextButton(
                                        onClick = {
                                            val t = draft.trim()
                                            if (t.isNotEmpty()) {
                                                onSendMessage(t)
                                                draft = ""
                                            }
                                        }
                                    ) {
                                        Text(
                                            stringResource(R.string.live_send),
                                            color = PkNeonPink,
                                            fontWeight = FontWeight.Bold,
                                            fontSize = 14.sp
                                        )
                                    }
                                },
                                container = {
                                    OutlinedTextFieldDefaults.Container(
                                        enabled = true,
                                        isError = false,
                                        interactionSource = pkNeonChatInteraction,
                                        colors = pkNeonChatFieldColors,
                                        shape = pkNeonChatShape,
                                    )
                                },
                            )
                        },
                    )
                }
                if (pkNeonStreamerSide) {
                    Spacer(Modifier.width(pkNeonRailComposeInset))
                } else {
                    Column(
                        modifier = Modifier
                            .graphicsLayer(clip = false)
                            .wrapContentHeight()
                            .requiredWidth(68.dp)
                            .padding(bottom = 12.dp)
                            .padding(start = 6.dp, end = 2.dp),
                        /** Top → bottom: Message … Like; [Row] uses Bottom so the stack sits on the composer baseline. */
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        IconButton(
                            onClick = {
                                pkNeonActionScope.launch {
                                    pkNeonSuppressHistoryFromScroll = true
                                    try {
                                        rollerAnimateScrollToLatest(spectatorScrollState)
                                    } finally {
                                        pkNeonSuppressHistoryFromScroll = false
                                    }
                                }
                            },
                            modifier = Modifier
                                .graphicsLayer(clip = false)
                                .requiredSize(48.dp)
                                .clip(CircleShape)
                                .background(Color(0xFF1E293B).copy(alpha = 0.9f))
                        ) {
                            Icon(
                                imageVector = Icons.AutoMirrored.Filled.Chat,
                                contentDescription = stringResource(R.string.live_message),
                                tint = Color.White,
                                modifier = Modifier.size(22.dp)
                            )
                        }
                        if (onToggleSpeaker != null) {
                            IconButton(
                                onClick = { onToggleSpeaker(!isSpeakerOn) },
                                modifier = Modifier
                                    .graphicsLayer(clip = false)
                                    .requiredSize(48.dp)
                                    .clip(CircleShape)
                                    .background(
                                        if (isSpeakerOn) PkNeonBlue.copy(alpha = 0.35f) else Color(0xFF1E293B).copy(alpha = 0.9f)
                                    )
                            ) {
                                Icon(
                                    imageVector = if (isSpeakerOn) Icons.AutoMirrored.Filled.VolumeUp else Icons.AutoMirrored.Filled.VolumeOff,
                                    contentDescription = null,
                                    tint = Color.White,
                                    modifier = Modifier.size(20.dp)
                                )
                            }
                        }
                        if (onOpenGiftSheet != null) {
                            IconButton(
                                onClick = { if (!giftActionInProgress) onOpenGiftSheet() },
                                enabled = !giftActionInProgress,
                                modifier = Modifier
                                    .graphicsLayer(clip = false)
                                    .shadow(6.dp, CircleShape, spotColor = PkNeonGold)
                                    .requiredSize(48.dp)
                                    .clip(CircleShape)
                                    .background(
                                        Brush.radialGradient(
                                            colors = listOf(PkNeonGold, Color(0xFFFF9100).copy(alpha = 0.85f))
                                        )
                                    )
                            ) {
                                Icon(
                                    Icons.Default.CardGiftcard,
                                    contentDescription = stringResource(R.string.live_send_gift_action),
                                    tint = Color.Black,
                                    modifier = Modifier.size(22.dp)
                                )
                            }
                        }
                        if (onOpenDiamondShop != null) {
                            IconButton(
                                onClick = onOpenDiamondShop,
                                modifier = Modifier
                                    .graphicsLayer(clip = false)
                                    .requiredSize(48.dp)
                                    .clip(CircleShape)
                                    .background(
                                        Brush.linearGradient(
                                            listOf(Color(0xFF42A5F5), Color(0xFF1565C0))
                                        )
                                    )
                            ) {
                                Icon(
                                    painter = painterResource(R.drawable.ic_diamond),
                                    contentDescription = stringResource(R.string.call_diamond_shop_cd),
                                    tint = Color.White,
                                    modifier = Modifier.size(22.dp)
                                )
                            }
                        }
                        IconButton(
                            onClick = { onPkSpectatorLike?.invoke() },
                            enabled = onPkSpectatorLike != null,
                            modifier = Modifier
                                .graphicsLayer(clip = false)
                                .requiredSize(48.dp)
                                .clip(CircleShape)
                                .background(Color.Black.copy(alpha = 0.45f))
                        ) {
                            Icon(
                                painter = painterResource(R.drawable.ic_heart),
                                contentDescription = "Like",
                                tint = Color.Red.copy(alpha = if (onPkSpectatorLike != null) 1f else 0.4f),
                                modifier = Modifier.size(22.dp)
                            )
                        }
                    }
                }
            }
        }
    }
    }
    }
}

/**
 * Inline live chat row for [LiveStreamChatMessage.type] == `"gift"` — permanent public history + icon.
 */
@Composable
fun LiveStreamGiftChatRow(
    message: LiveStreamChatMessage,
    senderPhotoUrl: String?,
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    /** Shown before sender name when known (profile lookup). */
    senderDisplayLevel: Int? = null
) {
    val giftLabel = message.giftName.ifBlank {
        message.text.substringBefore("×").trim().ifBlank { message.text }
    }
    val catalogEntry = remember(message.giftId, giftLabel) {
        GiftCatalog.entryFor(Gift(id = message.giftId, name = giftLabel))
    }
    val displayGiftName = catalogEntry?.canonicalName ?: giftLabel.ifBlank { "Gift" }
    val rowModifier = modifier
        .fillMaxWidth()
        .clip(RoundedCornerShape(12.dp))
        .background(
            Brush.horizontalGradient(
                colors = listOf(
                    Color(0xFFFFD700).copy(alpha = 0.22f),
                    Color(0xFFFF4081).copy(alpha = 0.18f),
                    Color(0xFFFFD700).copy(alpha = 0.15f)
                )
            )
        )
        .border(1.dp, Color(0xFFFFD700).copy(alpha = 0.45f), RoundedCornerShape(12.dp))
        .then(if (onClick != null) Modifier.clickable { onClick() } else Modifier)
        .padding(horizontal = 10.dp, vertical = 8.dp)
    Row(
        modifier = rowModifier,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Surface(
            modifier = Modifier.size(32.dp),
            shape = CircleShape,
            color = Color.Black.copy(alpha = 0.25f)
        ) {
            when {
                !senderPhotoUrl.isNullOrBlank() -> {
                    AsyncImage(
                        model = senderPhotoUrl,
                        contentDescription = null,
                        modifier = Modifier.fillMaxSize().clip(CircleShape),
                        contentScale = ContentScale.Crop
                    )
                }
                else -> {
                    Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) {
                        Text(
                            message.senderName.take(1).uppercase().ifBlank { "?" },
                            color = Color.White,
                            fontWeight = FontWeight.Bold,
                            fontSize = 13.sp
                        )
                    }
                }
            }
        }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            val sendersName = message.senderName.ifBlank { "Someone" }
            val level = senderDisplayLevel?.coerceAtLeast(1)
            if (level != null) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Surface(
                        modifier = Modifier
                            .shadow(6.dp, RoundedCornerShape(5.dp), spotColor = Color(0xFFFFE082), ambientColor = Color(0x66FFD700)),
                        shape = RoundedCornerShape(5.dp),
                        color = Color(0xFF3E1C5C).copy(alpha = 0.92f),
                        border = BorderStroke(1.dp, Color(0xFFFFD700).copy(alpha = 0.65f))
                    ) {
                        Text(
                            text = "Lv. $level",
                            modifier = Modifier.padding(horizontal = 5.dp, vertical = 2.dp),
                            color = Color(0xFFFFE082),
                            fontSize = 9.sp,
                            fontWeight = FontWeight.Black
                        )
                    }
                    Spacer(Modifier.width(6.dp))
                    Text(
                        text = stringResource(R.string.live_gift_chat_inline, sendersName, displayGiftName),
                        color = Color.White,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false)
                    )
                }
            } else {
                Text(
                    text = stringResource(R.string.live_gift_chat_inline, sendersName, displayGiftName),
                    color = Color.White,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
        Spacer(Modifier.width(6.dp))
        if (!message.giftImageUrl.isNullOrBlank()) {
            AsyncImage(
                model = message.giftImageUrl,
                contentDescription = displayGiftName,
                modifier = Modifier.size(36.dp).clip(RoundedCornerShape(8.dp)),
                contentScale = ContentScale.Crop
            )
        } else {
            Icon(
                imageVector = catalogEntry?.fallbackVector ?: Icons.Default.CardGiftcard,
                contentDescription = displayGiftName,
                tint = Color(0xFFFFE082),
                modifier = Modifier.size(34.dp)
            )
        }
    }
}

/** Quick linear luma for theme-aware glass (0 = dark, 1 = light). */
private fun Color.quickLuma(): Float = 0.2126f * red + 0.7152f * green + 0.0722f * blue

private fun formatCallDurationClock(totalSeconds: Int): String {
    val s = totalSeconds.coerceAtLeast(0)
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = s % 60
    return if (h > 0) String.format(Locale.US, "%d:%02d:%02d", h, m, sec)
    else String.format(Locale.US, "%02d:%02d", m, sec)
}

/**
 * Top strip over WebRTC video: avatar, name, followers, live viewer count.
 * Kept as a compact bar so the majority of the screen stays free for video / system gestures.
 */
@Composable
fun WebRtcOverlayTopBar(
    displayName: String,
    avatarUrl: String,
    likeCount: Int,
    viewerCount: Int,
    modifier: Modifier = Modifier,
    /** Private 1:1 calls set false to hide like/viewer lines (no “live audience” chrome). */
    showBroadcastMetrics: Boolean = true,
    /** When false with [showBroadcastMetrics], hides only the live viewer count (e.g. PK battle). */
    showLiveViewerCount: Boolean = true,
    /** When ≥ 0, shows “Live · mm:ss” in the nameplate (moved from bottom metrics strip). */
    sessionElapsedSeconds: Int = -1,
    /** When non-null, shows a top-right Close control (live streams / WebRTC full-screen). */
    onLeaveStream: (() -> Unit)? = null,
    /**
     * Single-purpose 1:1 video call top bar: transparent full-bleed strip (video shows through),
     * back + minimize + centered title.
     */
    itzoVideoCallBar: Boolean = false,
    /** When [itzoVideoCallBar] is true, second-leading action (e.g. [android.app.Activity.moveTaskToBack]). */
    onMinimizeCall: (() -> Unit)? = null,
    /**
     * Payer's live coin balance shown in the top-right chip during [itzoVideoCallBar].
     * Pass -1 (default) to hide the chip (non-payer / receiver side).
     */
    payerDiamondBalance: Int = -1,
    /** Rate chip label: "💎 rate/min". Pass 0 to hide the rate part. */
    payerDiamondRatePerMinute: Int = 0,
    /** Like / heart button next to the partner name in [itzoVideoCallBar]. Null hides it. */
    onLikePartner: (() -> Unit)? = null,
    /** Whether the current user already liked this partner (fills the heart icon). */
    partnerIsLiked: Boolean = false,
) {
    if (itzoVideoCallBar && onLeaveStream != null) {
        // ── Chamet-style 1:1 call top bar ────────────────────────────────────────
        // Layout: [avatar] [name + timer column] [❤ like] [💎 balance chip]
        // No back button, no chevron/minimize button.
        Row(
            modifier = modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            // Partner avatar
            Surface(
                modifier = Modifier.size(44.dp),
                shape = CircleShape,
                color = Color.White.copy(alpha = 0.18f),
                border = BorderStroke(1.5.dp, Color.White.copy(alpha = 0.35f)),
            ) {
                if (avatarUrl.isNotBlank()) {
                    AsyncImage(
                        model = avatarUrl,
                        contentDescription = null,
                        modifier = Modifier.fillMaxSize().clip(CircleShape),
                        contentScale = ContentScale.Crop,
                    )
                }
            }
            // Name + elapsed timer — cap at 12 chars so the row never gets squashed
            val itzoCallDisplayName = displayName.ifBlank { stringResource(R.string.call_overlay_title) }
                .let { if (it.length > 12) it.take(12).trimEnd() + "…" else it }
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = itzoCallDisplayName,
                    color = Color.White,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (sessionElapsedSeconds >= 0) {
                    Text(
                        text = formatCallDurationClock(sessionElapsedSeconds),
                        color = Color(0xFF4ADE80),
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                    )
                }
            }
            // Like / heart button
            if (onLikePartner != null) {
                IconButton(
                    onClick = onLikePartner,
                    modifier = Modifier
                        .size(40.dp)
                        .background(
                            if (partnerIsLiked) Color(0x44FF6B9D) else Color.White.copy(alpha = 0.15f),
                            CircleShape,
                        ),
                ) {
                    Icon(
                        imageVector = if (partnerIsLiked) Icons.Default.Favorite else Icons.Default.FavoriteBorder,
                        contentDescription = "Like",
                        tint = Color(0xFFFF6B9D),
                        modifier = Modifier.size(22.dp),
                    )
                }
            }
            // Diamond balance chip — payer side only
            if (payerDiamondBalance >= 0) {
                Surface(
                    shape = RoundedCornerShape(50),
                    color = Color(0xFF1A1A2E).copy(alpha = 0.88f),
                    border = BorderStroke(1.dp, Color(0xFFFFC400).copy(alpha = 0.6f)),
                    modifier = Modifier.widthIn(min = 76.dp),
                ) {
                    Column(
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text(
                            text = "💎 $payerDiamondBalance",
                            color = Color(0xFFFFC400),
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Bold,
                            maxLines = 1,
                        )
                        if (payerDiamondRatePerMinute > 0) {
                            Text(
                                text = "$payerDiamondRatePerMinute/min",
                                color = Color.White.copy(alpha = 0.7f),
                                fontSize = 10.sp,
                                maxLines = 1,
                            )
                        }
                    }
                }
            }
        }
        return
    }
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp),
        color = ItzoUiTokens.LiveHostNameplateScrim,
        shape = RoundedCornerShape(14.dp)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Surface(
                modifier = Modifier.size(36.dp),
                shape = CircleShape,
                color = Color.White.copy(alpha = 0.12f)
            ) {
                if (avatarUrl.isNotBlank()) {
                    AsyncImage(
                        model = avatarUrl,
                        contentDescription = null,
                        modifier = Modifier.fillMaxSize().clip(CircleShape),
                        contentScale = ContentScale.Crop
                    )
                }
            }
            Spacer(Modifier.width(8.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    displayName.ifBlank { stringResource(R.string.call_overlay_title) },
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = 13.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                if (sessionElapsedSeconds >= 0) {
                    val clock = formatCallDurationClock(sessionElapsedSeconds)
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.padding(top = 1.dp)
                    ) {
                        Text(
                            "●",
                            color = Color(0xFF4ADE80),
                            fontSize = 8.sp,
                            modifier = Modifier.padding(end = 3.dp)
                        )
                        Text(
                            text = stringResource(R.string.call_in_call_with_timer, clock),
                            color = Color.White.copy(alpha = 0.92f),
                            fontSize = 11.sp,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                }
                if (showBroadcastMetrics) {
                    Text(
                        stringResource(R.string.live_followers_count, likeCount),
                        color = Color.White.copy(alpha = 0.72f),
                        fontSize = 10.sp
                    )
                    if (showLiveViewerCount) {
                        Text(
                            stringResource(R.string.live_viewers_count, viewerCount),
                            color = Color.White.copy(alpha = 0.72f),
                            fontSize = 10.sp
                        )
                    }
                }
            }
            if (onLeaveStream != null) {
                IconButton(
                    onClick = onLeaveStream,
                    modifier = Modifier
                        .size(36.dp)
                        .clip(CircleShape)
                        .background(Color.White.copy(alpha = 0.14f))
                ) {
                    Icon(
                        imageVector = Icons.Default.Close,
                        contentDescription = stringResource(R.string.live_leave_stream_cd),
                        tint = Color.White,
                        modifier = Modifier.size(20.dp)
                    )
                }
            }
        }
    }
}

/**
 * Bottom panel: scrollable messages (above controls, growing toward video), then the action icon row,
 * then the chat field + send and optional full-width end call (LiveStreamActivity / video calls).
 * Optional [onToggleMic] / [onToggleSpeaker] show compact icon buttons when non-null (1:1 calls / PK).
 *
 * @param audiencePanelFillHeight When true (PK audience half-screen), the message list expands with
 * [Modifier.weight] so chat + controls fill the panel instead of a fixed strip height.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WebRtcOverlayBottomChat(
    messages: List<LiveStreamChatMessage>,
    onSendMessage: (String) -> Unit,
    endCallLabel: String,
    onEndCall: (() -> Unit)?,
    modifier: Modifier = Modifier,
    isMicOn: Boolean = true,
    isSpeakerOn: Boolean = false,
    onToggleMic: ((Boolean) -> Unit)? = null,
    onToggleSpeaker: ((Boolean) -> Unit)? = null,
    /** Video 1:1: optional front/back switch wired to [WebRTCManager]. */
    isVideoCall: Boolean = false,
    onFlipCamera: (() -> Unit)? = null,
    flipCameraEnabled: Boolean = false,
    /** Opens full gift picker (host activity / screen provides sheet). */
    onOpenGiftSheet: (() -> Unit)? = null,
    /** Diamond shop as overlay (e.g. dialog) without leaving the call. */
    onOpenDiamondShop: (() -> Unit)? = null,
    giftActionInProgress: Boolean = false,
    audiencePanelFillHeight: Boolean = false,
    /** When set with [streamHostUserIdForModeration] == [currentUserIdForModeration], host can long-press chat rows to moderate. */
    liveStreamDocIdForModeration: String? = null,
    streamHostUserIdForModeration: String? = null,
    currentUserIdForModeration: String? = null,
    onKickLiveChatter: ((targetUserId: String) -> Unit)? = null,
    onBlockLiveChatter: ((targetUserId: String) -> Unit)? = null,
    /** Host: discovery-style like on chatter profile; toggles if already liked. */
    onLikeLiveChatter: ((targetUserId: String, senderDisplayName: String) -> Unit)? = null,
    /** Resolve sender profile photo for gift rows (live chat list may omit photo on the message doc). */
    senderPhotoLookup: (senderUserId: String) -> String? = { null },
    onGiftRowClick: ((LiveStreamChatMessage) -> Unit)? = null,
    /** PK arena audience panel: neon landscape-style chat + stacked action buttons. */
    pkNeonBattleChrome: Boolean = false,
    /** When false, action stack uses gift + like + share (spectator). When true, gift + flip + end PK (battler). */
    pkNeonStreamerSide: Boolean = true,
    pkStreamerPanelViewersLabel: String? = null,
    onPkStreamerPanelClose: (() -> Unit)? = null,
    pkBottomViewerChipLabel: String? = null,
    onPkBottomViewerChipClick: (() -> Unit)? = null,
    pkHostSpectatorsLabel: String? = null,
    pkGuestSpectatorsLabel: String? = null,
    onPkHostSpectatorsClick: (() -> Unit)? = null,
    onPkGuestSpectatorsClick: (() -> Unit)? = null,
    pkAllSpectatorsSummaryLine: String? = null,
    onPkAllSpectatorsClick: (() -> Unit)? = null,
    /** PK live overlay: like host (spectators only; battlers omit). */
    onPkSpectatorLike: (() -> Unit)? = null,
    onOpenArFilters: (() -> Unit)? = null,
    onOpenPkToolsMenu: (() -> Unit)? = null,
    /** Solo live host: messages sit on the video (no frosted chat panel), matching spectator floating bubbles. */
    floatingLiveChatOverlay: Boolean = false,
    /**
     * When true with docked (non-floating) chat — e.g. [LiveStreamActivity] 1:1 — skips frosted panel fill/border/shadow
     * behind messages + controls, and chat rows use [Modifier.wrapContentWidth] for width-by-text bubbles.
     */
    transparentDockPanel: Boolean = false,
    /**
     * Standard 1:1 video dock (e.g. [com.zipper.datingapp.LiveStreamActivity]): Itzo-style #E6000000 bar, spacing,
     * prominent circular end-call control in the icon row; [onEndCall] is omitted beside the composer when true.
     */
    itzoStandardCallDock: Boolean = false,
    /** Live/PK chat: show static compliance copy above messages. */
    showComplianceBanner: Boolean = false,
    /**
     * When false (default), pads for [WindowInsets.navigationBars].
     * Set true when the parent already consumed bottom inset (e.g. MainActivity [WindowInsets.safeDrawing]).
     */
    skipNavigationBarsInset: Boolean = false,
    /**
     * When true (non-[pkNeonBattleChrome] layouts), typing opens a Material bottom sheet like Itzo chat input sheet.
     * Messages stay on the overlay; [onSendMessage] and Firestore paths are unchanged.
     */
    bottomSheetComposer: Boolean = false,
) {
    var draft by remember { mutableStateOf("") }
    var composeSheetOpen by remember { mutableStateOf(false) }
    LaunchedEffect(bottomSheetComposer) {
        if (!bottomSheetComposer) composeSheetOpen = false
    }
    val liveChatComposeSheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var moderationTarget by remember { mutableStateOf<LiveStreamChatMessage?>(null) }
    val isFrontCamera by WebRTCManager.globalIsFrontCamera.collectAsStateWithLifecycle()
    val isModerationHost = !liveStreamDocIdForModeration.isNullOrBlank() &&
        !streamHostUserIdForModeration.isNullOrBlank() &&
        !currentUserIdForModeration.isNullOrBlank() &&
        currentUserIdForModeration == streamHostUserIdForModeration
    val scheme = MaterialTheme.colorScheme
    val isLightGlass = scheme.background.quickLuma() > 0.52f
    val useFloatingLiveChat = floatingLiveChatOverlay && !pkNeonBattleChrome
    val dockPanelTransparent =
        transparentDockPanel && !useFloatingLiveChat && !pkNeonBattleChrome
    val itzoDock = itzoStandardCallDock && dockPanelTransparent && !pkNeonBattleChrome && isVideoCall
    val endCallInItzoRow = itzoDock && onEndCall != null
    /** Non-PK floating chat over full-bleed video (1:1 + live glass): keep bubbles/chrome lighter than docked chat. */
    val floatingChatBubbleAlpha = 0.08f
    val floatingChatChromeAlpha = 0.22f
    val topPanelShape = when {
        itzoDock -> RoundedCornerShape(0.dp)
        useFloatingLiveChat -> RoundedCornerShape(0.dp)
        else -> RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp)
    }
    val panelBrush = when {
        itzoDock -> Brush.verticalGradient(
            colors = listOf(Color.Transparent, Color.Transparent),
        )
        useFloatingLiveChat || dockPanelTransparent -> Brush.verticalGradient(
            colors = listOf(Color.Transparent, Color.Transparent),
        )
        isLightGlass -> Brush.verticalGradient(
            colors = listOf(
                Color.White.copy(alpha = 0.14f),
                Color.White.copy(alpha = 0.24f),
                Color.White.copy(alpha = 0.32f)
            )
        )
        else -> {
            // Itzo video-call bottom dock (#E6000000 bars) instead of Material surface tints.
            Brush.verticalGradient(
                colors = listOf(
                    ItzoUiTokens.ChromeBarScrim.copy(alpha = 0.88f),
                    ItzoUiTokens.ChromeBarScrim,
                )
            )
        }
    }
    val panelBorder =
        if (useFloatingLiveChat || dockPanelTransparent) Color.Transparent
        else if (isLightGlass) Color.White.copy(alpha = 0.52f)
        else Color.White.copy(alpha = 0.12f)
    val panelShadow = when {
        itzoDock -> 0.dp
        useFloatingLiveChat || dockPanelTransparent -> 0.dp
        isLightGlass -> 8.dp
        else -> 0.dp
    }
    val dockChatBubbleWidth =
        if (dockPanelTransparent) Modifier.wrapContentWidth(align = Alignment.Start)
        else Modifier.fillMaxWidth()
    Box(
        modifier = when {
            audiencePanelFillHeight -> modifier.fillMaxSize()
            isVideoCall && onEndCall != null -> modifier.fillMaxWidth().fillMaxHeight()
            useFloatingLiveChat && isVideoCall -> modifier.fillMaxWidth().fillMaxHeight()
            else -> modifier.fillMaxWidth()
        }
    ) {
        if (pkNeonBattleChrome && audiencePanelFillHeight) {
            PkNeonBattleBottomLayout(
                messages = messages,
                onSendMessage = onSendMessage,
                endCallLabel = endCallLabel,
                onEndCall = onEndCall,
                isMicOn = isMicOn,
                isSpeakerOn = isSpeakerOn,
                onToggleMic = onToggleMic,
                onToggleSpeaker = onToggleSpeaker,
                onOpenGiftSheet = onOpenGiftSheet,
                onOpenDiamondShop = onOpenDiamondShop,
                giftActionInProgress = giftActionInProgress,
                onFlipCamera = onFlipCamera,
                flipCameraEnabled = flipCameraEnabled,
                isModerationHost = isModerationHost,
                streamHostUserIdForModeration = streamHostUserIdForModeration,
                senderPhotoLookup = senderPhotoLookup,
                onGiftRowClick = onGiftRowClick,
                onModerationRequest = { moderationTarget = it },
                pkNeonStreamerSide = pkNeonStreamerSide,
                pkStreamerPanelViewersLabel = pkStreamerPanelViewersLabel,
                onPkStreamerPanelClose = onPkStreamerPanelClose,
                pkBottomViewerChipLabel = pkBottomViewerChipLabel,
                onPkBottomViewerChipClick = onPkBottomViewerChipClick,
                pkHostSpectatorsLabel = pkHostSpectatorsLabel,
                pkGuestSpectatorsLabel = pkGuestSpectatorsLabel,
                onPkHostSpectatorsClick = onPkHostSpectatorsClick,
                onPkGuestSpectatorsClick = onPkGuestSpectatorsClick,
                pkAllSpectatorsSummaryLine = pkAllSpectatorsSummaryLine,
                onPkAllSpectatorsClick = onPkAllSpectatorsClick,
                onPkSpectatorLike = onPkSpectatorLike,
                onOpenArFilters = onOpenArFilters,
                onOpenPkToolsMenu = onOpenPkToolsMenu,
                showComplianceBanner = showComplianceBanner,
                skipNavigationBarsInset = skipNavigationBarsInset,
            )
        } else if (itzoDock) {
            // ─── Chamet-style 1:1 video call dock ──────────────────────────────────────
            // Three-section layout (bottom-anchored):
            //   1. Scrollable message list (grows to fill available height)
            //   2. Control button row: [mic][speaker][gift][flip][💎]  [🔴 end call]
            //   3. Inline WhatsApp-style composer: [Say something…] [Send ▶]
            val itzoDockListState = rememberLazyListState()
            val itzoDockMsgKey = messages.lastOrNull()?.let { m -> "${m.id}_${m.timestamp}" }.orEmpty()
            val itzoDockScope = rememberCoroutineScope()
            LaunchedEffect(itzoDockMsgKey, messages.size) {
                if (messages.isNotEmpty()) {
                    itzoDockScope.launch {
                        itzoDockListState.animateScrollToItem(messages.size - 1)
                    }
                }
            }
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .fillMaxHeight()
                    .then(if (!skipNavigationBarsInset) Modifier.navigationBarsPadding() else Modifier)
                    .imePadding(),
            ) {
                // ── 1a. Compliance / safety banner — always visible above messages ────────
                // Stays pinned at the top of the chat area; messages scroll beneath it.
                if (showComplianceBanner) {
                    LiveStreamComplianceBanner(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 10.dp, vertical = 4.dp),
                        variant = LiveStreamComplianceBannerVariant.Floating,
                    )
                }

                // ── 1b. Messages ─────────────────────────────────────────────────────────
                // Dark-background bubbles ensure text is readable over any video brightness.
                LazyColumn(
                    state = itzoDockListState,
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f)
                        .padding(horizontal = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp, Alignment.Bottom),
                    contentPadding = PaddingValues(vertical = 6.dp),
                ) {
                    if (messages.isEmpty()) {
                        item {
                            Text(
                                text = stringResource(R.string.call_overlay_chat_empty),
                                color = Color.White.copy(alpha = 0.45f),
                                fontSize = 13.sp,
                                textAlign = TextAlign.Center,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .background(Color.Black.copy(alpha = 0.35f), RoundedCornerShape(8.dp))
                                    .padding(horizontal = 12.dp, vertical = 8.dp),
                            )
                        }
                    }
                    items(
                        items = messages,
                        key = { m -> m.id.ifBlank { "${m.timestamp}_${m.senderId}" } },
                    ) { m ->
                        when {
                            m.isLiveSystemMessage() -> {
                                // Billing / system alert: amber pill, full-width, always on dark bg
                                Box(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(vertical = 3.dp)
                                        .background(Color(0xCC1A1200), RoundedCornerShape(10.dp))
                                        .border(1.dp, Color(0xFFFBBF24).copy(alpha = 0.45f), RoundedCornerShape(10.dp))
                                        .padding(horizontal = 14.dp, vertical = 8.dp),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(
                                        text = m.text,
                                        color = Color(0xFFFFE082),
                                        fontSize = 12.sp,
                                        fontStyle = FontStyle.Italic,
                                        textAlign = TextAlign.Center,
                                        modifier = Modifier.fillMaxWidth(),
                                    )
                                }
                            }
                            m.type == "gift" -> {
                                LiveStreamGiftChatRow(
                                    message = m,
                                    senderPhotoUrl = senderPhotoLookup(m.senderId),
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(vertical = 2.dp),
                                    onClick = onGiftRowClick?.let { { it(m) } },
                                )
                            }
                            else -> {
                                // Chat bubbles with solid dark backgrounds — readable on any video.
                                // Self  → right-aligned, deep purple
                                // Other → left-aligned, near-black charcoal
                                val isSelf = !currentUserIdForModeration.isNullOrBlank() &&
                                    m.senderId == currentUserIdForModeration
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = if (isSelf) Arrangement.End else Arrangement.Start,
                                ) {
                                    Surface(
                                        shape = RoundedCornerShape(
                                            topStart    = if (isSelf) 18.dp else 4.dp,
                                            topEnd      = if (isSelf) 4.dp  else 18.dp,
                                            bottomStart = 18.dp,
                                            bottomEnd   = 18.dp,
                                        ),
                                        // Both sides use fully-opaque dark colours so white text is
                                        // always legible regardless of the video frame behind them.
                                        color = if (isSelf)
                                            Color(0xEE6A1B9A)   // deep purple, ~93 % opaque
                                        else
                                            Color(0xEE1C1C2E),  // dark charcoal-navy, ~93 % opaque
                                        modifier = Modifier.widthIn(max = 260.dp),
                                    ) {
                                        Column(
                                            modifier = Modifier.padding(
                                                horizontal = 12.dp,
                                                vertical = 7.dp,
                                            ),
                                        ) {
                                            if (!isSelf && m.senderName.isNotBlank()) {
                                                Text(
                                                    text = m.senderName,
                                                    color = Color(0xFFCE93D8),
                                                    fontSize = 11.sp,
                                                    fontWeight = FontWeight.SemiBold,
                                                )
                                            }
                                            Text(
                                                text = m.text,
                                                color = Color.White,
                                                fontSize = 14.sp,
                                                lineHeight = 19.sp,
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // ── 2. Control buttons row ────────────────────────────────────────────────
                val ctrlSize = 48.dp
                val ctrlIcSz = 22.dp
                val ctrlGhost = Color(0x66FFFFFF)
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceEvenly,
                ) {
                    // Mic
                    if (onToggleMic != null) {
                        IconButton(
                            onClick = { onToggleMic(!isMicOn) },
                            modifier = Modifier
                                .size(ctrlSize)
                                .background(
                                    if (isMicOn) ctrlGhost else Color.Red.copy(alpha = 0.82f),
                                    CircleShape,
                                ),
                        ) {
                            Icon(
                                imageVector = if (isMicOn) Icons.Default.Mic else Icons.Default.MicOff,
                                contentDescription = if (isMicOn) "Mute" else "Unmute",
                                tint = Color.White,
                                modifier = Modifier.size(ctrlIcSz),
                            )
                        }
                    }
                    // Speaker / earpiece
                    if (onToggleSpeaker != null) {
                        IconButton(
                            onClick = { onToggleSpeaker(!isSpeakerOn) },
                            modifier = Modifier
                                .size(ctrlSize)
                                .background(
                                    if (isSpeakerOn) Color(0xFF4ADE80).copy(alpha = 0.72f) else ctrlGhost,
                                    CircleShape,
                                ),
                        ) {
                            Icon(
                                imageVector = if (isSpeakerOn)
                                    Icons.AutoMirrored.Filled.VolumeUp
                                else
                                    Icons.AutoMirrored.Filled.VolumeOff,
                                contentDescription = if (isSpeakerOn) "Switch to earpiece" else "Switch to loudspeaker",
                                tint = Color.White,
                                modifier = Modifier.size(ctrlIcSz),
                            )
                        }
                    }
                    // Gift
                    if (onOpenGiftSheet != null) {
                        IconButton(
                            onClick = { if (!giftActionInProgress) onOpenGiftSheet() },
                            enabled = !giftActionInProgress,
                            modifier = Modifier
                                .size(ctrlSize)
                                .background(
                                    brush = Brush.linearGradient(
                                        listOf(Color(0xFFFFD54F), Color(0xFFFF6B9D), Color(0xFFFF9100)),
                                    ),
                                    shape = CircleShape,
                                ),
                        ) {
                            Icon(
                                imageVector = Icons.Default.CardGiftcard,
                                contentDescription = stringResource(R.string.live_send_gift_action),
                                tint = Color.White,
                                modifier = Modifier.size(ctrlIcSz),
                            )
                        }
                    }
                    // Flip camera
                    if (onFlipCamera != null) {
                        IconButton(
                            onClick = onFlipCamera,
                            enabled = flipCameraEnabled,
                            modifier = Modifier
                                .size(ctrlSize)
                                .background(
                                    if (flipCameraEnabled) ctrlGhost else ctrlGhost.copy(alpha = 0.38f),
                                    CircleShape,
                                ),
                        ) {
                            Icon(
                                imageVector = if (isFrontCamera)
                                    Icons.Default.FlipCameraAndroid
                                else
                                    Icons.Default.FlipCameraIos,
                                contentDescription = stringResource(R.string.call_flip_camera),
                                tint = Color.White.copy(alpha = if (flipCameraEnabled) 1f else 0.4f),
                                modifier = Modifier.size(ctrlIcSz),
                            )
                        }
                    }
                    // Diamond shop
                    if (onOpenDiamondShop != null) {
                        IconButton(
                            onClick = onOpenDiamondShop,
                            modifier = Modifier
                                .size(ctrlSize)
                                .background(
                                    brush = Brush.linearGradient(
                                        listOf(Color(0xFF42A5F5), Color(0xFF1565C0)),
                                    ),
                                    shape = CircleShape,
                                ),
                        ) {
                            Icon(
                                painter = painterResource(R.drawable.ic_diamond),
                                contentDescription = stringResource(R.string.call_diamond_shop_cd),
                                tint = Color.White,
                                modifier = Modifier.size(ctrlIcSz),
                            )
                        }
                    }
                    // Big red end-call button — most prominent element in the row
                    if (onEndCall != null) {
                        IconButton(
                            onClick = onEndCall,
                            modifier = Modifier
                                .size(64.dp)
                                .shadow(8.dp, CircleShape)
                                .clip(CircleShape)
                                .background(ItzoUiTokens.CallDecline),
                        ) {
                            Icon(
                                imageVector = Icons.Default.CallEnd,
                                contentDescription = endCallLabel,
                                tint = Color.White,
                                modifier = Modifier.size(30.dp),
                            )
                        }
                    }
                }

                // ── 3. Inline WhatsApp-style composer ────────────────────────────────────
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = 12.dp, end = 12.dp, bottom = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    val composerInteraction = remember { MutableInteractionSource() }
                    BasicTextField(
                        value = draft,
                        onValueChange = { draft = it },
                        modifier = Modifier
                            .weight(1f)
                            .height(46.dp)
                            .background(Color.White.copy(alpha = 0.15f), RoundedCornerShape(23.dp))
                            .border(1.dp, Color.White.copy(alpha = 0.32f), RoundedCornerShape(23.dp)),
                        singleLine = true,
                        textStyle = TextStyle(
                            color = Color.White,
                            fontSize = 15.sp,
                            lineHeight = 20.sp,
                        ),
                        interactionSource = composerInteraction,
                        cursorBrush = SolidColor(Color.White),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                        keyboardActions = KeyboardActions(
                            onSend = {
                                val t = draft.trim()
                                if (t.isNotEmpty()) {
                                    onSendMessage(t)
                                    draft = ""
                                }
                            },
                        ),
                        decorationBox = { innerTextField ->
                            Box(
                                modifier = Modifier
                                    .fillMaxSize()
                                    .padding(horizontal = 16.dp),
                                contentAlignment = Alignment.CenterStart,
                            ) {
                                if (draft.isEmpty()) {
                                    Text(
                                        text = stringResource(R.string.live_chat_hint),
                                        color = Color.White.copy(alpha = 0.45f),
                                        fontSize = 15.sp,
                                    )
                                }
                                innerTextField()
                            }
                        },
                    )
                    // Send button — pink circle
                    IconButton(
                        onClick = {
                            val t = draft.trim()
                            if (t.isNotEmpty()) {
                                onSendMessage(t)
                                draft = ""
                            }
                        },
                        modifier = Modifier
                            .size(46.dp)
                            .background(Color(0xFFE91E63), CircleShape),
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.Send,
                            contentDescription = stringResource(R.string.live_send),
                            tint = Color.White,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
            }
        } else {
            val glassStagingMaxH = liveChatStagingViewportMaxHeight()
            /** 1:1 video + end call: stretch message stack so [weight] steals slack instead of squishing the composer. */
            val glassChatStretchMessages =
                audiencePanelFillHeight || (isVideoCall && onEndCall != null)
            val splitFloatingVideoMessages =
                useFloatingLiveChat && isVideoCall && !audiencePanelFillHeight
            var glassFloatingInitialSnapPending by remember { mutableStateOf(true) }
            val glassFloatingScroll = rememberScrollState()
            var glassFloatingHistoryMode by remember { mutableStateOf(false) }
            var glassFloatingHistoryBaselineCount by remember { mutableIntStateOf(0) }
            val glassFloatingCountRef = rememberUpdatedState(messages.size)
            val glassFloatingJumpScope = rememberCoroutineScope()
            val glassFloatingHistoryRef = rememberUpdatedState(glassFloatingHistoryMode)
            val openGlassFloatingHistory = rememberUpdatedState({
                glassFloatingHistoryBaselineCount = glassFloatingCountRef.value
                glassFloatingHistoryMode = true
                glassFloatingInitialSnapPending = false
            })
            val revealGlassFloatingOverscroll = remember {
                object : NestedScrollConnection {
                    override fun onPostScroll(
                        consumed: Offset,
                        available: Offset,
                        source: NestedScrollSource,
                    ): Offset {
                        if (!glassFloatingHistoryRef.value && kotlin.math.abs(available.y) > 18f) {
                            openGlassFloatingHistory.value.invoke()
                        }
                        return Offset.Zero
                    }
                }
            }
            val glassFloatingCfg = LocalConfiguration.current
            val glassFloatingHistoryStripH =
                liveChatHistoryStripMaxHeight(glassFloatingCfg.screenHeightDp)
            val glassFloatingStagingStripH = liveChatStagingViewportMaxHeight()
            val glassFloatingChronoFull = remember(
                messages.size,
                messages.lastOrNull()?.id,
                messages.lastOrNull()?.timestamp,
            ) {
                messages
            }
            val glassFloatingDisplayed = remember(
                glassFloatingChronoFull,
                glassFloatingHistoryMode,
            ) {
                if (glassFloatingHistoryMode) {
                    glassFloatingChronoFull
                } else {
                    glassFloatingChronoFull.takeLast(LIVE_CHAT_STAGING_VISIBLE_MESSAGES)
                }
            }
            val glassFloatingFeedKey = messages.lastOrNull()?.let { m ->
                "${m.id}_${m.timestamp}_${m.text.length}"
            }.orEmpty()
            if (splitFloatingVideoMessages) {
                LaunchedEffect(glassFloatingScroll) {
                    snapshotFlow {
                        glassFloatingScroll.maxValue > 0 &&
                            glassFloatingScroll.value < glassFloatingScroll.maxValue - 8
                    }
                        .distinctUntilChanged()
                        .collect { scrolledAway ->
                            if (scrolledAway) {
                                openGlassFloatingHistory.value.invoke()
                            } else {
                                val countAtSchedule = messages.size
                                delay(7_000L)
                                if (messages.size > countAtSchedule) return@collect
                                val stillAway =
                                    glassFloatingScroll.maxValue > 0 &&
                                        glassFloatingScroll.value < glassFloatingScroll.maxValue - 8
                                if (!stillAway) {
                                    glassFloatingHistoryMode = false
                                    glassFloatingHistoryBaselineCount = glassFloatingCountRef.value
                                    glassFloatingInitialSnapPending = false
                                    glassFloatingScroll.scrollTo(glassFloatingScroll.maxValue)
                                }
                            }
                        }
                }
            }
            if (splitFloatingVideoMessages) {
                LaunchedEffect(
                    glassFloatingFeedKey,
                    glassFloatingHistoryMode,
                    messages.size,
                    glassFloatingDisplayed.size,
                ) {
                    if (glassFloatingHistoryMode) return@LaunchedEffect
                    val atBottom =
                        glassFloatingScroll.maxValue <= 0 ||
                            glassFloatingScroll.value >= glassFloatingScroll.maxValue - 8
                    val needsInitialLiveEdgeSnap =
                        glassFloatingInitialSnapPending &&
                            glassFloatingScroll.maxValue > 0 &&
                            glassFloatingDisplayed.isNotEmpty()
                    if (glassFloatingFeedKey.isNotBlank() && (atBottom || needsInitialLiveEdgeSnap)) {
                        rollerAnimateScrollToLatest(glassFloatingScroll)
                        if (needsInitialLiveEdgeSnap) {
                            glassFloatingInitialSnapPending = false
                        }
                    }
                }
            }
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .then(
                        when {
                            audiencePanelFillHeight -> Modifier.fillMaxSize()
                            isVideoCall && onEndCall != null -> Modifier.fillMaxWidth().fillMaxHeight()
                            else -> Modifier.wrapContentHeight()
                        }
                    )
                    .then(if (!skipNavigationBarsInset) Modifier.navigationBarsPadding() else Modifier)
                    .imePadding()
            ) {
                if (splitFloatingVideoMessages && glassChatStretchMessages) {
                    Spacer(Modifier.weight(1f))
                }
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .then(
                            when {
                                splitFloatingVideoMessages -> Modifier.wrapContentHeight()
                                glassChatStretchMessages -> Modifier.weight(1f)
                                else -> Modifier.wrapContentHeight()
                            },
                        )
                    .then(
                        if (panelShadow > 0.dp) {
                            Modifier.shadow(panelShadow, topPanelShape, ambientColor = Color.Black.copy(alpha = 0.18f))
                        } else {
                            Modifier
                        }
                    )
                    .clip(topPanelShape)
                    .background(panelBrush)
                    .then(
                        if (!useFloatingLiveChat && !dockPanelTransparent) {
                            Modifier.border(BorderStroke(1.dp, panelBorder), topPanelShape)
                        } else {
                            Modifier
                        }
                    )
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .then(
                            if (glassChatStretchMessages && !splitFloatingVideoMessages) {
                                Modifier.fillMaxSize()
                            } else {
                                Modifier.wrapContentHeight()
                            },
                        )
                        .padding(
                            start = 12.dp,
                            top = if (splitFloatingVideoMessages) 4.dp else 10.dp,
                            end = 12.dp,
                            bottom = when {
                                splitFloatingVideoMessages && showComplianceBanner -> 4.dp
                                splitFloatingVideoMessages -> 6.dp
                                showComplianceBanner -> 6.dp
                                else -> 10.dp
                            },
                        )
                ) {
                    val controlSize = 44.dp
                    val iconInCircle = 20.dp
                    val showArFiltersButton =
                        isVideoCall && onOpenArFilters != null && !useFloatingLiveChat
                    val hasTopActionRow = onToggleMic != null ||
                        onToggleSpeaker != null ||
                        onOpenGiftSheet != null ||
                        (isVideoCall && onFlipCamera != null && !pkNeonBattleChrome) ||
                        onOpenDiamondShop != null ||
                        showArFiltersButton ||
                        endCallInItzoRow
                    if (!splitFloatingVideoMessages) {
                    val glassChatChrono = remember(
                        messages.size,
                        messages.lastOrNull()?.id,
                        messages.lastOrNull()?.timestamp
                    ) {
                        if (messages.size <= LIVE_OVERLAY_CHAT_VISIBLE_COUNT) {
                            messages
                        } else {
                            messages.takeLast(LIVE_OVERLAY_CHAT_VISIBLE_COUNT)
                        }
                    }
                    val glassChatNewestFirst = remember(glassChatChrono) {
                        glassChatChrono.asReversed()
                    }
                    val messagesAreaModifier = if (glassChatStretchMessages) {
                        Modifier
                            .fillMaxWidth()
                            .weight(1f)
                            // Avoid a zero-height strip when parent vertical space is tight (LiveStreamActivity slot).
                            .heightIn(min = 104.dp)
                    } else {
                        Modifier
                            .fillMaxWidth()
                            .heightIn(max = glassStagingMaxH)
                    }
                    val listModifier = if (glassChatStretchMessages) {
                        Modifier.fillMaxSize()
                    } else {
                        Modifier
                            .fillMaxWidth()
                            .heightIn(max = glassStagingMaxH)
                    }
                    val glassListState = rememberLazyListState()
                    var liveChatAutoScroll by remember { mutableStateOf(true) }
                    var liveChatLastScrollMs by remember { mutableStateOf(0L) }

                    // Detect when user scrolls away from the newest message
                    LaunchedEffect(glassListState) {
                        snapshotFlow { glassListState.firstVisibleItemIndex }
                            .distinctUntilChanged()
                            .collect { index ->
                                if (index > 0) {
                                    liveChatAutoScroll = false
                                    liveChatLastScrollMs = System.currentTimeMillis()
                                } else {
                                    liveChatAutoScroll = true
                                }
                            }
                    }
                    // Re-enable auto-scroll after 5 seconds of no scroll interaction
                    LaunchedEffect(glassListState) {
                        while (isActive) {
                            delay(1_000L)
                            if (!liveChatAutoScroll &&
                                System.currentTimeMillis() - liveChatLastScrollMs > 5_000L
                            ) {
                                liveChatAutoScroll = true
                            }
                        }
                    }
                    /** Newest row is index 0 ([reverseLayout] = true); animate there on new messages. */
                    LaunchedEffect(messages.size) {
                        if (liveChatAutoScroll && messages.isNotEmpty()) {
                            glassListState.animateScrollToItem(0)
                        }
                    }
                    // Messages above the action row: only this region uses [weight] when the panel fills height (IME shrinks this, not the composer).
                    Box(modifier = messagesAreaModifier) {
                    if (messages.isEmpty()) {
                        Text(
                            text = stringResource(R.string.call_overlay_chat_empty),
                            color = if (useFloatingLiveChat) {
                                Color.White.copy(alpha = 0.45f)
                            } else {
                                scheme.onSurfaceVariant.copy(alpha = 0.92f)
                            },
                            fontSize = 13.sp,
                            modifier = Modifier
                                .fillMaxWidth()
                                .then(
                                    when {
                                        useFloatingLiveChat ->
                                            Modifier.align(Alignment.BottomStart)
                                        glassChatStretchMessages ->
                                            Modifier.align(Alignment.TopStart)
                                        else -> Modifier
                                    }
                                )
                                .padding(top = 2.dp, bottom = 6.dp),
                        )
                    } else {
                        LazyColumn(
                            modifier = listModifier,
                            state = glassListState,
                            reverseLayout = true,
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                            horizontalAlignment = Alignment.Start,
                            contentPadding = PaddingValues(bottom = 0.dp),
                        ) {
                            items(
                                items = glassChatNewestFirst,
                                key = { m -> m.id.ifBlank { "${m.timestamp}_${m.senderId}" } },
                            ) { m ->
                                val canModerate = isModerationHost &&
                                    !m.isLiveSystemMessage() &&
                                    m.type != "gift" &&
                                    m.senderId.isNotBlank() &&
                                    m.senderId != streamHostUserIdForModeration
                                when {
                                    m.isLiveSystemMessage() -> {
                                        Text(
                                            text = m.text,
                                            color = if (useFloatingLiveChat) {
                                                Color.White.copy(alpha = 0.5f)
                                            } else {
                                                scheme.onSurfaceVariant.copy(alpha = 0.9f)
                                            },
                                            fontSize = 11.sp,
                                            fontStyle = FontStyle.Italic,
                                            textAlign = when {
                                                useFloatingLiveChat -> TextAlign.Start
                                                dockPanelTransparent -> TextAlign.Start
                                                else -> TextAlign.Center
                                            },
                                            maxLines = 3,
                                            overflow = TextOverflow.Ellipsis,
                                            modifier = dockChatBubbleWidth
                                                .padding(horizontal = 6.dp, vertical = 3.dp)
                                        )
                                    }
                                    m.type == "gift" -> {
                                        LiveStreamGiftChatRow(
                                            message = m,
                                            senderPhotoUrl = senderPhotoLookup(m.senderId),
                                            modifier = Modifier.padding(vertical = 2.dp),
                                            onClick = onGiftRowClick?.let { { it(m) } }
                                        )
                                    }
                                    else -> {
                                        Text(
                                            "${m.senderName}: ${m.text}",
                                            color = if (useFloatingLiveChat) Color.White else scheme.onSurface,
                                            fontSize = 12.sp,
                                            maxLines = if (useFloatingLiveChat) 3 else 2,
                                            overflow = TextOverflow.Ellipsis,
                                            modifier = dockChatBubbleWidth
                                                .then(
                                                    if (canModerate) {
                                                        Modifier.clickable { moderationTarget = m }
                                                    } else {
                                                        Modifier
                                                    }
                                                )
                                                .background(
                                                    when {
                                                        useFloatingLiveChat ->
                                                            Color.Black.copy(alpha = floatingChatBubbleAlpha)
                                                        isLightGlass -> Color.White.copy(alpha = 0.30f)
                                                        else -> scheme.surfaceVariant.copy(alpha = 0.55f)
                                                    },
                                                    RoundedCornerShape(8.dp)
                                                )
                                                .then(
                                                    if (isLightGlass && !useFloatingLiveChat) {
                                                        Modifier.border(
                                                            1.dp,
                                                            Color.White.copy(alpha = 0.38f),
                                                            RoundedCornerShape(8.dp)
                                                        )
                                                    } else {
                                                        Modifier
                                                    }
                                                )
                                                .padding(horizontal = 8.dp, vertical = 4.dp)
                                        )
                                    }
                                }
                            }
                        }
                    }
                    }
                    }
                    if (hasTopActionRow) {
                        Spacer(Modifier.height(4.dp))
                        val sz = if (itzoDock) 48.dp else controlSize
                        val icSz = if (itzoDock) 22.dp else (iconInCircle - 2.dp)
                        val ghostNeutral = when {
                            useFloatingLiveChat -> Color.Black.copy(alpha = floatingChatChromeAlpha)
                            itzoDock -> Color(0x66FFFFFF)
                            else -> scheme.surfaceVariant.copy(alpha = 0.9f)
                        }
                        val micOnTint = when {
                            isMicOn && useFloatingLiveChat -> Color.White
                            isMicOn && itzoDock -> Color.White
                            isMicOn -> scheme.onSurface
                            else -> Color.White
                        }
                        val giftIconSz = if (itzoDock) icSz else iconInCircle
                        @Composable
                        fun RowScope.LiveCallControlCluster() {
                            if (onToggleMic != null) {
                                IconButton(
                                    onClick = { onToggleMic(!isMicOn) },
                                    modifier = Modifier
                                        .size(sz)
                                        .background(
                                            if (isMicOn) ghostNeutral else Color.Red.copy(alpha = 0.82f),
                                            CircleShape
                                        )
                                ) {
                                    Icon(
                                        imageVector = if (isMicOn) Icons.Default.Mic else Icons.Default.MicOff,
                                        contentDescription = if (isMicOn) "Mute microphone" else "Unmute microphone",
                                        tint = micOnTint,
                                        modifier = Modifier.size(icSz)
                                    )
                                }
                            }
                            if (onToggleSpeaker != null) {
                                IconButton(
                                    onClick = { onToggleSpeaker(!isSpeakerOn) },
                                    modifier = Modifier
                                        .size(sz)
                                        .background(
                                            if (isSpeakerOn) {
                                                Color(0xFF4ADE80).copy(alpha = if (useFloatingLiveChat) 0.55f else 0.72f)
                                            } else {
                                                ghostNeutral
                                            },
                                            CircleShape
                                        )
                                ) {
                                    Icon(
                                        imageVector = if (isSpeakerOn) Icons.AutoMirrored.Filled.VolumeUp else Icons.AutoMirrored.Filled.VolumeOff,
                                        contentDescription = if (isSpeakerOn) "Switch to earpiece" else "Switch to loudspeaker",
                                        tint = if (isSpeakerOn || useFloatingLiveChat || itzoDock) Color.White else scheme.onSurface,
                                        modifier = Modifier.size(icSz)
                                    )
                                }
                            }
                            if (onOpenGiftSheet != null) {
                                IconButton(
                                    onClick = { if (!giftActionInProgress) onOpenGiftSheet() },
                                    enabled = !giftActionInProgress,
                                    modifier = Modifier
                                        .size(sz)
                                        .background(
                                            brush = Brush.linearGradient(
                                                listOf(Color(0xFFFFD54F), Color(0xFFFF6B9D), Color(0xFFFF9100))
                                            ),
                                            shape = CircleShape
                                        )
                                ) {
                                    Icon(
                                        imageVector = Icons.Default.CardGiftcard,
                                        contentDescription = stringResource(R.string.live_send_gift_action),
                                        tint = Color.White,
                                        modifier = Modifier.size(giftIconSz)
                                    )
                                }
                            }
                            if (isVideoCall && onFlipCamera != null && !pkNeonBattleChrome) {
                                val flipBg = when {
                                    useFloatingLiveChat ->
                                        Color.Black.copy(
                                            alpha = if (flipCameraEnabled) floatingChatChromeAlpha else 0.14f
                                        )
                                    itzoDock ->
                                        if (flipCameraEnabled) Color(0x66FFFFFF) else Color(0x33FFFFFF)
                                    else ->
                                        scheme.surfaceVariant.copy(alpha = if (flipCameraEnabled) 0.95f else 0.45f)
                                }
                                IconButton(
                                    onClick = onFlipCamera,
                                    enabled = flipCameraEnabled,
                                    modifier = Modifier
                                        .size(sz)
                                        .background(flipBg, CircleShape)
                                ) {
                                    Icon(
                                        imageVector = if (isFrontCamera) Icons.Default.FlipCameraAndroid else Icons.Default.FlipCameraIos,
                                        contentDescription = stringResource(R.string.call_flip_camera),
                                        tint = when {
                                            useFloatingLiveChat -> Color.White.copy(alpha = if (flipCameraEnabled) 1f else 0.45f)
                                            itzoDock -> Color.White.copy(alpha = if (flipCameraEnabled) 1f else 0.45f)
                                            else -> scheme.onSurface.copy(alpha = if (flipCameraEnabled) 1f else 0.45f)
                                        },
                                        modifier = Modifier.size(icSz)
                                    )
                                }
                            }
                            if (onOpenDiamondShop != null) {
                                IconButton(
                                    onClick = onOpenDiamondShop,
                                    modifier = Modifier
                                        .size(sz)
                                        .background(
                                            Brush.linearGradient(
                                                listOf(Color(0xFF42A5F5), Color(0xFF1565C0))
                                            ),
                                            shape = CircleShape
                                        )
                                ) {
                                    Icon(
                                        painter = painterResource(R.drawable.ic_diamond),
                                        contentDescription = stringResource(R.string.call_diamond_shop_cd),
                                        tint = Color.White,
                                        modifier = Modifier.size(giftIconSz)
                                    )
                                }
                            }
                            if (showArFiltersButton) {
                                IconButton(
                                    onClick = { onOpenArFilters?.invoke() },
                                    modifier = Modifier
                                        .size(sz)
                                        .background(
                                            when {
                                                useFloatingLiveChat ->
                                                    Color.Black.copy(alpha = floatingChatChromeAlpha)
                                                isLightGlass -> scheme.surfaceVariant.copy(alpha = 0.55f)
                                                else -> Color.Black.copy(alpha = 0.4f)
                                            },
                                            CircleShape
                                        )
                                ) {
                                    Icon(
                                        imageVector = Icons.Default.AutoAwesome,
                                        contentDescription = "AR face filters",
                                        tint = Color.White,
                                        modifier = Modifier.size(icSz)
                                    )
                                }
                            }
                        }
                        if (itzoDock) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 24.dp, vertical = 20.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Row(
                                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    LiveCallControlCluster()
                                }
                                Spacer(Modifier.weight(1f))
                                val end = onEndCall
                                if (end != null) {
                                    IconButton(
                                        onClick = end,
                                        modifier = Modifier
                                            .size(64.dp)
                                            .shadow(8.dp, CircleShape)
                                            .clip(CircleShape)
                                            .background(ItzoUiTokens.CallDecline),
                                    ) {
                                        Icon(
                                            imageVector = Icons.Default.CallEnd,
                                            contentDescription = endCallLabel,
                                            tint = Color.White,
                                            modifier = Modifier.size(36.dp)
                                        )
                                    }
                                }
                            }
                        } else {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 4.dp),
                                horizontalArrangement = Arrangement.SpaceEvenly,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                LiveCallControlCluster()
                            }
                        }
                        Spacer(Modifier.height(if (itzoDock) 12.dp else 10.dp))
                    }
                }
            }
            if (splitFloatingVideoMessages) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .wrapContentHeight()
                        .padding(start = 12.dp, top = 4.dp, end = 12.dp, bottom = 0.dp),
                ) {
                    if (!glassFloatingHistoryMode &&
                        messages.size > LIVE_CHAT_STAGING_VISIBLE_MESSAGES
                    ) {
                        LiveChatOlderMessagesCue(onOpenHistory = { openGlassFloatingHistory.value.invoke() })
                    }
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .wrapContentHeight(align = Alignment.Bottom)
                            .heightIn(
                                max = if (glassFloatingHistoryMode) {
                                    glassFloatingHistoryStripH
                                } else {
                                    glassFloatingStagingStripH
                                },
                            )
                            .nestedScroll(revealGlassFloatingOverscroll),
                    ) {
                        if (glassFloatingHistoryMode &&
                            messages.size > glassFloatingHistoryBaselineCount
                        ) {
                            LiveChatNewMessagesCue(
                                modifier = Modifier
                                    .align(Alignment.BottomEnd)
                                    .padding(end = 6.dp, bottom = 6.dp)
                                    .zIndex(1f),
                                onJumpToLatest = {
                                    glassFloatingHistoryMode = false
                                    glassFloatingHistoryBaselineCount = messages.size
                                    glassFloatingJumpScope.launch {
                                        rollerAnimateScrollToLatest(glassFloatingScroll)
                                    }
                                },
                            )
                        }
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .verticalScroll(glassFloatingScroll),
                            verticalArrangement = Arrangement.spacedBy(4.dp, Alignment.Bottom),
                            horizontalAlignment = Alignment.Start,
                        ) {
                            if (messages.isEmpty()) {
                                Text(
                                    text = stringResource(R.string.call_overlay_chat_empty),
                                    color = Color.White.copy(alpha = 0.45f),
                                    fontSize = 13.sp,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(top = 2.dp, bottom = 6.dp),
                                )
                            } else {
                                glassFloatingDisplayed.forEach { m ->
                                    key(m.id.ifBlank { "${m.timestamp}_${m.senderId}" }) {
                                        val canModerate = isModerationHost &&
                                            !m.isLiveSystemMessage() &&
                                            m.type != "gift" &&
                                            m.senderId.isNotBlank() &&
                                            m.senderId != streamHostUserIdForModeration
                                        when {
                                            m.isLiveSystemMessage() -> {
                                                Text(
                                                    text = m.text,
                                                    color = Color.White.copy(alpha = 0.5f),
                                                    fontSize = 11.sp,
                                                    fontStyle = FontStyle.Italic,
                                                    textAlign = TextAlign.Start,
                                                    maxLines = 3,
                                                    overflow = TextOverflow.Ellipsis,
                                                    modifier = Modifier
                                                        .fillMaxWidth()
                                                        .padding(horizontal = 6.dp, vertical = 3.dp),
                                                )
                                            }
                                            m.type == "gift" -> {
                                                LiveStreamGiftChatRow(
                                                    message = m,
                                                    senderPhotoUrl = senderPhotoLookup(m.senderId),
                                                    modifier = Modifier.padding(vertical = 2.dp),
                                                    onClick = onGiftRowClick?.let { { it(m) } },
                                                )
                                            }
                                            else -> {
                                                Text(
                                                    "${m.senderName}: ${m.text}",
                                                    color = Color.White,
                                                    fontSize = 12.sp,
                                                    maxLines = 3,
                                                    overflow = TextOverflow.Ellipsis,
                                                    modifier = Modifier
                                                        .fillMaxWidth()
                                                        .then(
                                                            if (canModerate) {
                                                                Modifier.clickable { moderationTarget = m }
                                                            } else {
                                                                Modifier
                                                            },
                                                        )
                                                        .background(
                                                            Color.Black.copy(alpha = floatingChatBubbleAlpha),
                                                            RoundedCornerShape(8.dp),
                                                        )
                                                        .padding(horizontal = 8.dp, vertical = 4.dp),
                                                )
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(
                        start = 12.dp,
                        top = if (showComplianceBanner) 0.dp else 4.dp,
                        end = 12.dp,
                        bottom = 10.dp,
                    )
            ) {
                    val glassLiveComposerRailInset = 76.dp
                    if (showComplianceBanner) {
                        LiveStreamComplianceBanner(
                            modifier = Modifier
                                .fillMaxWidth()
                                .then(
                                    if (onEndCall == null || endCallInItzoRow) {
                                        Modifier.padding(end = glassLiveComposerRailInset)
                                    } else {
                                        Modifier
                                    },
                                )
                                .padding(bottom = 2.dp),
                            variant = LiveStreamComplianceBannerVariant.DockedAboveComposer,
                        )
                    }
                    val chatFieldShape = RoundedCornerShape(26.dp)
                    val fieldOutlineFocused = when {
                        useFloatingLiveChat -> Color.White.copy(alpha = 0.5f)
                        isLightGlass -> scheme.primary
                        else -> Color.White.copy(alpha = 0.72f)
                    }
                    val fieldOutlineUnfocused = when {
                        useFloatingLiveChat -> Color.White.copy(alpha = 0.3f)
                        isLightGlass -> scheme.outlineVariant
                        else -> Color.White.copy(alpha = 0.45f)
                    }
                    /** Dark glass: onSurfaceVariant is too low-contrast; keep "Say something…" readable. */
                    val glassPlaceholderColor = when {
                        useFloatingLiveChat -> Color.White.copy(alpha = 0.6f)
                        isLightGlass -> scheme.onSurfaceVariant.copy(alpha = 0.88f)
                        else -> Color.White.copy(alpha = 0.62f)
                    }
                    val chatFieldColors = OutlinedTextFieldDefaults.colors(
                        focusedContainerColor = if (useFloatingLiveChat) {
                            Color.Black.copy(alpha = floatingChatChromeAlpha)
                        } else {
                            scheme.surface.copy(alpha = if (isLightGlass) 0.65f else 0.72f)
                        },
                        unfocusedContainerColor = if (useFloatingLiveChat) {
                            Color.Black.copy(alpha = floatingChatChromeAlpha)
                        } else {
                            scheme.surface.copy(alpha = if (isLightGlass) 0.55f else 0.62f)
                        },
                        focusedBorderColor = fieldOutlineFocused,
                        unfocusedBorderColor = fieldOutlineUnfocused,
                        cursorColor = if (useFloatingLiveChat) Color.White else scheme.primary,
                        focusedTextColor = if (useFloatingLiveChat) Color.White else scheme.onSurface,
                        unfocusedTextColor = if (useFloatingLiveChat) Color.White else scheme.onSurface,
                        focusedPlaceholderColor = glassPlaceholderColor,
                        unfocusedPlaceholderColor = glassPlaceholderColor,
                        disabledPlaceholderColor = glassPlaceholderColor.copy(alpha = glassPlaceholderColor.alpha * 0.5f),
                    )
                    val glassChatInteraction = remember { MutableInteractionSource() }
                    val glassComposerTextStyle =
                        TextStyle(
                            color = if (useFloatingLiveChat) Color.White else scheme.onSurface,
                            fontSize = 15.sp,
                            lineHeight = 20.sp
                        )
                    val composerMinHeight = 52.dp
                    val tapBarBorder = BorderStroke(1.dp, fieldOutlineUnfocused)
                    val tapBarFill = when {
                        useFloatingLiveChat -> Color.Black.copy(alpha = floatingChatChromeAlpha)
                        else -> scheme.surface.copy(alpha = if (isLightGlass) 0.55f else 0.62f)
                    }
                    when {
                        bottomSheetComposer -> {
                            @Composable
                            fun ComposerTapBar(modifier: Modifier) {
                                Surface(
                                    modifier = modifier
                                        .clip(chatFieldShape)
                                        .clickable { composeSheetOpen = true },
                                    shape = chatFieldShape,
                                    color = tapBarFill,
                                    border = tapBarBorder,
                                ) {
                                    Row(
                                        Modifier
                                            .fillMaxWidth()
                                            .padding(horizontal = 16.dp, vertical = 14.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                                    ) {
                                        Icon(
                                            imageVector = Icons.AutoMirrored.Filled.Chat,
                                            contentDescription = null,
                                            tint = glassPlaceholderColor,
                                            modifier = Modifier.size(22.dp),
                                        )
                                        Text(
                                            text = stringResource(R.string.live_chat_hint),
                                            color = glassPlaceholderColor,
                                            fontSize = 15.sp,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                    }
                                }
                            }
                            if (onEndCall != null && !endCallInItzoRow) {
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .wrapContentHeight(),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                                ) {
                                    ComposerTapBar(
                                        modifier = Modifier
                                            .weight(1f)
                                            .requiredHeight(composerMinHeight),
                                    )
                                    Button(
                                        onClick = { onEndCall?.invoke() },
                                        modifier = Modifier
                                            .defaultMinSize(minWidth = 72.dp, minHeight = 52.dp)
                                            .requiredHeight(52.dp)
                                            .width(72.dp),
                                        shape = RoundedCornerShape(50),
                                        colors = ButtonDefaults.buttonColors(
                                            containerColor = Color(0xFFC62828),
                                            contentColor = Color.White,
                                        ),
                                        elevation = ButtonDefaults.buttonElevation(
                                            defaultElevation = 3.dp,
                                            pressedElevation = 5.dp,
                                        ),
                                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
                                    ) {
                                        Text(
                                            endCallLabel,
                                            fontSize = 13.sp,
                                            fontWeight = FontWeight.SemiBold,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                    }
                                }
                            } else {
                                ComposerTapBar(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .height(composerMinHeight)
                                        .padding(end = glassLiveComposerRailInset),
                                )
                            }
                        }
                        onEndCall != null && !endCallInItzoRow -> {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .wrapContentHeight(),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                BasicTextField(
                                    value = draft,
                                    onValueChange = { draft = it },
                                    modifier = Modifier
                                        .weight(1f)
                                        .requiredHeight(52.dp),
                                    singleLine = false,
                                    maxLines = 2,
                                    textStyle = glassComposerTextStyle,
                                    interactionSource = glassChatInteraction,
                                    cursorBrush = SolidColor(scheme.primary),
                                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                                    keyboardActions = KeyboardActions(
                                        onSend = {
                                            val t = draft.trim()
                                            if (t.isNotEmpty()) {
                                                onSendMessage(t)
                                                draft = ""
                                            }
                                        }
                                    ),
                                    decorationBox = { innerTextField ->
                                        OutlinedTextFieldDefaults.DecorationBox(
                                            value = draft,
                                            innerTextField = {
                                                Box(
                                                    modifier = Modifier
                                                        .fillMaxWidth()
                                                        .fillMaxHeight(),
                                                    contentAlignment = Alignment.CenterStart,
                                                ) {
                                                    innerTextField()
                                                }
                                            },
                                            enabled = true,
                                            singleLine = false,
                                            visualTransformation = VisualTransformation.None,
                                            interactionSource = glassChatInteraction,
                                            colors = chatFieldColors,
                                            contentPadding = OutlinedTextFieldDefaults.contentPadding(
                                                start = 16.dp,
                                                end = 12.dp,
                                                top = 8.dp,
                                                bottom = 8.dp,
                                            ),
                                            placeholder = {
                                                Text(
                                                    stringResource(R.string.live_chat_hint),
                                                    color = glassPlaceholderColor,
                                                    fontSize = 15.sp,
                                                    lineHeight = 20.sp,
                                                )
                                            },
                                            trailingIcon = {
                                                IconButton(
                                                    onClick = {
                                                        val t = draft.trim()
                                                        if (t.isNotEmpty()) {
                                                            onSendMessage(t)
                                                            draft = ""
                                                        }
                                                    },
                                                    modifier = Modifier.size(44.dp)
                                                ) {
                                                    Icon(
                                                        Icons.AutoMirrored.Filled.Send,
                                                        contentDescription = stringResource(R.string.live_send),
                                                        tint = Color(0xFFFF4081),
                                                        modifier = Modifier.size(22.dp)
                                                    )
                                                }
                                            },
                                            container = {
                                                OutlinedTextFieldDefaults.Container(
                                                    enabled = true,
                                                    isError = false,
                                                    interactionSource = glassChatInteraction,
                                                    colors = chatFieldColors,
                                                    shape = chatFieldShape,
                                                )
                                            },
                                        )
                                    },
                                )
                                Button(
                                    onClick = { onEndCall?.invoke() },
                                    modifier = Modifier
                                        .defaultMinSize(minWidth = 72.dp, minHeight = 52.dp)
                                        .requiredHeight(52.dp)
                                        .width(72.dp),
                                    shape = RoundedCornerShape(50),
                                    colors = ButtonDefaults.buttonColors(
                                        containerColor = Color(0xFFC62828),
                                        contentColor = Color.White,
                                    ),
                                    elevation = ButtonDefaults.buttonElevation(
                                        defaultElevation = 3.dp,
                                        pressedElevation = 5.dp,
                                    ),
                                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
                                ) {
                                    Text(
                                        endCallLabel,
                                        fontSize = 13.sp,
                                        fontWeight = FontWeight.SemiBold,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                            }
                        }
                        else -> {
                            BasicTextField(
                                value = draft,
                                onValueChange = { draft = it },
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height(composerMinHeight)
                                    .padding(end = glassLiveComposerRailInset),
                                singleLine = false,
                                maxLines = 2,
                                textStyle = glassComposerTextStyle,
                                interactionSource = glassChatInteraction,
                                cursorBrush = SolidColor(scheme.primary),
                                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                                keyboardActions = KeyboardActions(
                                    onSend = {
                                        val t = draft.trim()
                                        if (t.isNotEmpty()) {
                                            onSendMessage(t)
                                            draft = ""
                                        }
                                    }
                                ),
                                decorationBox = { innerTextField ->
                                    OutlinedTextFieldDefaults.DecorationBox(
                                        value = draft,
                                        innerTextField = {
                                            Box(
                                                modifier = Modifier
                                                    .fillMaxWidth()
                                                    .fillMaxHeight(),
                                                contentAlignment = Alignment.CenterStart,
                                            ) {
                                                innerTextField()
                                            }
                                        },
                                        enabled = true,
                                        singleLine = false,
                                        visualTransformation = VisualTransformation.None,
                                        interactionSource = glassChatInteraction,
                                        colors = chatFieldColors,
                                        contentPadding = OutlinedTextFieldDefaults.contentPadding(
                                            start = 16.dp,
                                            end = 12.dp,
                                            top = 8.dp,
                                            bottom = 8.dp,
                                        ),
                                        placeholder = {
                                            Text(
                                                stringResource(R.string.live_chat_hint),
                                                color = glassPlaceholderColor,
                                                fontSize = 15.sp,
                                                lineHeight = 20.sp,
                                            )
                                        },
                                        trailingIcon = {
                                            IconButton(
                                                onClick = {
                                                    val t = draft.trim()
                                                    if (t.isNotEmpty()) {
                                                        onSendMessage(t)
                                                        draft = ""
                                                    }
                                                },
                                                modifier = Modifier.size(44.dp)
                                            ) {
                                                Icon(
                                                    Icons.AutoMirrored.Filled.Send,
                                                    contentDescription = stringResource(R.string.live_send),
                                                    tint = Color(0xFFFF4081),
                                                    modifier = Modifier.size(22.dp)
                                                )
                                            }
                                        },
                                        container = {
                                            OutlinedTextFieldDefaults.Container(
                                                enabled = true,
                                                isError = false,
                                                interactionSource = glassChatInteraction,
                                                colors = chatFieldColors,
                                                shape = chatFieldShape,
                                            )
                                        },
                                    )
                                },
                            )
                        }
                    }
            }
            }
        }

        if (bottomSheetComposer && composeSheetOpen) {
            ModalBottomSheet(
                onDismissRequest = { composeSheetOpen = false },
                sheetState = liveChatComposeSheetState,
                dragHandle = { BottomSheetDefaults.DragHandle() },
            ) {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .navigationBarsPadding()
                        .imePadding()
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                ) {
                    Text(
                        text = stringResource(R.string.live_chat_sheet_title),
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(bottom = 12.dp),
                    )
                    OutlinedTextField(
                        value = draft,
                        onValueChange = { draft = it },
                        modifier = Modifier.fillMaxWidth(),
                        placeholder = {
                            Text(stringResource(R.string.live_chat_hint))
                        },
                        maxLines = 6,
                        trailingIcon = {
                            IconButton(
                                onClick = {
                                    val t = draft.trim()
                                    if (t.isNotEmpty()) {
                                        onSendMessage(t)
                                        draft = ""
                                        composeSheetOpen = false
                                    }
                                },
                            ) {
                                Icon(
                                    Icons.AutoMirrored.Filled.Send,
                                    contentDescription = stringResource(R.string.live_send),
                                    tint = scheme.primary,
                                )
                            }
                        },
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                        keyboardActions = KeyboardActions(
                            onSend = {
                                val t = draft.trim()
                                if (t.isNotEmpty()) {
                                    onSendMessage(t)
                                    draft = ""
                                    composeSheetOpen = false
                                }
                            },
                        ),
                    )
                    Spacer(Modifier.height(16.dp))
                }
            }
        }
    moderationTarget?.let { target ->
        AlertDialog(
            onDismissRequest = { moderationTarget = null },
            title = {
                Text(stringResource(R.string.live_manage_user_title, target.senderName.ifBlank { target.senderId }))
            },
            text = {
                Column {
                    TextButton(
                        onClick = {
                            onKickLiveChatter?.invoke(target.senderId)
                            moderationTarget = null
                        },
                        enabled = onKickLiveChatter != null
                    ) {
                        Text(stringResource(R.string.live_action_kick))
                    }
                    TextButton(
                        onClick = {
                            onBlockLiveChatter?.invoke(target.senderId)
                            moderationTarget = null
                        },
                        enabled = onBlockLiveChatter != null
                    ) {
                        Text(stringResource(R.string.live_action_block))
                    }
                    TextButton(
                        onClick = {
                            onLikeLiveChatter?.invoke(target.senderId, target.senderName)
                            moderationTarget = null
                        },
                        enabled = onLikeLiveChatter != null
                    ) {
                        Text(stringResource(R.string.live_action_like_profile))
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { moderationTarget = null }) {
                    Text(stringResource(R.string.action_cancel))
                }
            }
        )
    }
    }
}

/** Sync line for battle / debug (optional). */
@Composable
fun WebRtcGameSyncHint(version: Long, phase: String, modifier: Modifier = Modifier) {
    if (version <= 0L && phase.isBlank()) return
    Text(
        text = stringResource(R.string.call_overlay_sync, version, phase.ifBlank { "—" }),
        color = Color.White.copy(alpha = 0.55f),
        fontSize = 10.sp,
        modifier = modifier.padding(horizontal = 12.dp)
    )
}

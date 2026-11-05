package com.zipper.app.ui.screens.messages

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.CardGiftcard
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Flag
import androidx.compose.material.icons.filled.LockOpen
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.VideocamOff
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import com.zipper.app.data.model.ChatMessage
import com.zipper.app.ui.components.*
import com.zipper.app.ui.screens.profile.OtherUserViewModel
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import com.zipper.app.util.ChatParse
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/*
 * Chat — Figma "06 Profile & Social / 02 Chat" (65:11).
 *
 *   App bar 64 on bg/raised: back, 36 avatar (mint ring online), name
 *   Semi Bold 16, "● Online" caption, ⋮ (profile · block · report — O5).
 *   Thread padding 12, gap 8. Their bubble: glass gradient, hairline, r16
 *   (tail corner r4), text 14, time 11 in ink/500. My bubble: brand gradient.
 *   Composer: photo · gift · text pill · mic (empty) / send (typed) — O5.
 *   While recording: ● 0:07 · Cancel · Send.
 */
@Composable
fun ChatScreen(
    otherUid: String,
    convoId: String,
    onBack: () -> Unit,
    onJoinLive: (roomId: String) -> Unit = {},
    onOpenProfile: (uid: String) -> Unit = {},
    onRecharge: () -> Unit = {},
    /** O5b (5 Nov 2026): call this person from the chat — the same paid call the profile starts. */
    onStartCall: (callId: String) -> Unit = {},
    prefilledMessage: String = "",
    viewModel: ChatViewModel = hiltViewModel(),
    /** O5: the same block, report and gift actions the profile offers, for the same person. */
    peer: OtherUserViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val peerState by peer.uiState.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    val context = LocalContext.current
    val listState = rememberLazyListState()
    val snackbar = remember { SnackbarHostState() }
    val myUid = viewModel.myUid
    val name = state.otherUserName.ifBlank { "User" }

    var menuOpen by remember { mutableStateOf(false) }
    var showGifts by remember { mutableStateOf(false) }
    var showReport by remember { mutableStateOf(false) }
    var confirmBlock by remember { mutableStateOf(false) }
    var viewing by remember { mutableStateOf<String?>(null) }
    var showCallConfirm by remember { mutableStateOf(false) }

    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) viewModel.sendPhoto(uri)
    }
    val scope = rememberCoroutineScope()
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) viewModel.startRecording()
        else scope.launch { snackbar.showSnackbar("Allow the microphone to send voice messages.") }
    }
    fun startVoice() {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            viewModel.startRecording()
        } else micPermission.launch(Manifest.permission.RECORD_AUDIO)
    }

    LaunchedEffect(prefilledMessage) { if (prefilledMessage.isNotBlank()) viewModel.onInput(prefilledMessage) }
    // Read on opening, and again whenever their newest message arrives while the chat is open — the unread count
    // used to keep counting messages the person had already seen here.
    val newestFromThem = state.messages.lastOrNull { it.senderUid != myUid }?.id
    LaunchedEffect(newestFromThem) { viewModel.markRead() }
    // O10: follow the NEWEST message (a page of older ones loaded above must not jump the view to the bottom).
    val newestId = state.messages.lastOrNull()?.id
    LaunchedEffect(newestId) {
        if (state.messages.isNotEmpty()) listState.animateScrollToItem(state.messages.size - 1 + (if (state.hasEarlier) 1 else 0))
    }
    LaunchedEffect(state.notice) { state.notice?.let { snackbar.showSnackbar(it); viewModel.consumeNotice() } }
    LaunchedEffect(peerState.toastMessage) { peerState.toastMessage?.let { snackbar.showSnackbar(it); peer.clearToast() } }
    // O5b: the server rang them (`startCall` priced it and checked blocks, the host's calls switch and the balance).
    LaunchedEffect(peerState.navigateToCall) {
        val id = peerState.navigateToCall ?: return@LaunchedEffect
        peer.consumeCallNavigation()
        onStartCall(id)
    }

    Box(Modifier.fillMaxSize().background(c.bgBase)) {
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding()) {
            // App bar
            Row(
                Modifier.fillMaxWidth().height(64.dp).background(c.bgRaised).padding(start = Space.xs, end = Space.xs),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm),
            ) {
                IconButtonCircle(Icons.AutoMirrored.Filled.ArrowBack, "Back", onBack, background = Color.Transparent)
                Row(Modifier.weight(1f).clickableNoRipple { onOpenProfile(otherUid) }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    Avatar(state.otherUserPhotoUrl, size = AvatarSize.SM, initial = state.otherUserName, ring = if (state.otherUserOnline) AvatarRing.Online else AvatarRing.None, decorUid = otherUid)
                    Column {
                        Text(name, style = ZipperTheme.type.labelL, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                            Box(Modifier.size(7.dp).background(if (state.otherUserOnline) c.statusOnline else c.textMuted, CircleShape))
                            Text(if (state.otherUserOnline) "Online" else "Offline", style = ZipperTheme.type.caption, color = c.textSecondary)
                        }
                    }
                }
                // O5b: call them from the chat. Not offered to a person this viewer blocked (the server refuses it too).
                // WP2: it follows their calls switch — "Calls off" while they broadcast or host a party with calls off,
                // "Busy" on another call — and says why on a tap instead of ringing.
                if (!peerState.isBlocked) {
                    val callable = peerState.callAvailability.canCall
                    IconButtonCircle(
                        if (callable) Icons.Default.Videocam else Icons.Default.VideocamOff,
                        if (callable) "Call $name" else "$name: ${peerState.callAvailability.label}",
                        { peer.onCallTapped { if (peerState.callCostDiamonds > 0L) showCallConfirm = true else peer.initiateCall() } },
                        background = Color.Transparent,
                        tint = if (callable) c.textPrimary else c.textMuted,
                    )
                }
                Box {
                    IconButtonCircle(Icons.Default.MoreVert, "More", { menuOpen = true }, background = Color.Transparent)
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }, containerColor = c.bgElevated) {
                        DropdownMenuItem(
                            text = { Text("View profile", color = c.textPrimary) },
                            leadingIcon = { Icon(Icons.Default.Person, null, tint = c.textSecondary) },
                            onClick = { menuOpen = false; onOpenProfile(otherUid) },
                        )
                        if (peerState.isBlocked) DropdownMenuItem(
                            text = { Text("Unblock $name", color = c.textPrimary) },
                            leadingIcon = { Icon(Icons.Default.LockOpen, null, tint = c.textSecondary) },
                            onClick = { menuOpen = false; peer.unblockUser() },
                        ) else DropdownMenuItem(
                            text = { Text("Block $name", color = c.statusDanger) },
                            leadingIcon = { Icon(Icons.Default.Block, null, tint = c.statusDanger) },
                            onClick = { menuOpen = false; confirmBlock = true },
                        )
                        DropdownMenuItem(
                            text = { Text("Report $name", color = c.statusDanger) },
                            leadingIcon = { Icon(Icons.Default.Flag, null, tint = c.statusDanger) },
                            onClick = { menuOpen = false; showReport = true },
                        )
                    }
                }
            }
            HairlineDivider()

            // Thread
            Box(Modifier.weight(1f)) {
                when {
                    state.isLoading -> LoadingState()
                    state.loadFailed && state.messages.isEmpty() -> EmptyState(
                        Icons.Outlined.ChatBubbleOutline, "This chat could not be loaded",
                        "Check your connection, then open it again.",
                    )
                    state.messages.isEmpty() -> EmptyState(
                        Icons.Outlined.ChatBubbleOutline, "Say hi to ${state.otherUserName.ifBlank { "them" }}",
                        "Messages are private between the two of you. Keep payments to verified resellers only.",
                    )
                    else -> LazyColumn(
                        state = listState, modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(Space.md), verticalArrangement = Arrangement.spacedBy(Space.sm),
                    ) {
                        if (state.hasEarlier) item(key = "earlier") {
                            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                                TextButton(viewModel::showEarlier) { Text("Show earlier messages", color = c.textBrand) }
                            }
                        }
                        items(state.messages, key = { it.id }) { msg ->
                            MessageRow(
                                msg, msg.senderUid == myUid, onJoinLive,
                                playing = state.playingId == msg.id,
                                onTogglePlay = { viewModel.togglePlay(msg) },
                                onOpenImage = { viewing = it },
                            )
                        }
                    }
                }
            }

            state.uploading?.let { what ->
                Text(what, style = ZipperTheme.type.caption, color = c.textSecondary,
                    modifier = Modifier.fillMaxWidth().background(c.bgRaised).padding(horizontal = Space.lg, vertical = Space.xs))
            }

            // Composer
            when {
                peerState.isBlocked -> Row(
                    Modifier.fillMaxWidth().background(c.bgRaised).padding(horizontal = Space.lg, vertical = Space.md),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md),
                ) {
                    Text("You blocked $name. Unblock to send messages.", style = ZipperTheme.type.bodyS, color = c.textSecondary, modifier = Modifier.weight(1f))
                    ZipperButton("Unblock", { peer.unblockUser() }, size = ButtonSize.Small, style = ButtonStyle.Secondary)
                }
                state.recording -> Row(
                    Modifier.fillMaxWidth().background(c.bgRaised).padding(horizontal = Space.md, vertical = Space.sm),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm),
                ) {
                    IconButtonCircle(Icons.Default.Close, "Cancel recording", viewModel::cancelRecording, background = c.bgElevated)
                    Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                        Box(Modifier.size(10.dp).background(c.statusLive, CircleShape))
                        Text(
                            "${ChatParse.clock(state.recordingMs)} / ${ChatParse.clock(ChatParse.VOICE_MAX_MS)}  Recording…",
                            style = ZipperTheme.type.labelM, color = c.textPrimary,
                        )
                    }
                    Box(
                        Modifier.size(48.dp).background(Brush.linearGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), CircleShape)
                            .clickableNoRipple { viewModel.stopRecordingAndSend() },
                        contentAlignment = Alignment.Center,
                    ) { Icon(Icons.AutoMirrored.Filled.Send, "Send voice message", tint = Color.White, modifier = Modifier.size(22.dp)) }
                }
                else -> Row(
                    Modifier.fillMaxWidth().background(c.bgRaised).padding(horizontal = Space.sm, vertical = Space.sm),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.xs),
                ) {
                    val busy = state.uploading != null
                    IconButtonCircle(Icons.Outlined.Image, "Send a photo", { photoPicker.launch("image/*") },
                        background = Color.Transparent, tint = c.textSecondary, enabled = !busy)
                    IconButtonCircle(Icons.Default.CardGiftcard, "Send a gift", { showGifts = true },
                        background = Color.Transparent, tint = c.currencyDiamond)
                    // WP2 (Owner): a call button beside the gift and photo buttons, following the same switch as the top bar.
                    val canRing = peerState.callAvailability.canCall
                    IconButtonCircle(
                        if (canRing) Icons.Default.Videocam else Icons.Default.VideocamOff,
                        if (canRing) "Call $name" else "$name: ${peerState.callAvailability.label}",
                        { peer.onCallTapped { if (peerState.callCostDiamonds > 0L) showCallConfirm = true else peer.initiateCall() } },
                        background = Color.Transparent, tint = if (canRing) c.statusSuccess else c.textMuted,
                    )
                    TextComposer(
                        input = viewModel.input, onInput = viewModel::onInput, onSend = viewModel::sendMessage,
                        onVoice = { if (!busy) startVoice() }, modifier = Modifier.weight(1f),
                    )
                }
            }
        }

        // Spec §11: the server's lucky roll, if a lucky gift is ever sent from here.
        peerState.luckyWin?.let { win ->
            LaunchedEffect(win) { kotlinx.coroutines.delay(4_000); peer.clearLuckyWin() }
            LuckyWinBanner(win, Modifier.align(Alignment.Center).padding(Space.xl))
        }

        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 72.dp)) { data ->
            Snackbar(snackbarData = data, containerColor = c.bgElevated, contentColor = c.textPrimary)
        }
    }

    if (showCallConfirm) {
        com.zipper.app.ui.screens.profile.CallConfirmDialog(
            name = name,
            perMinuteDiamonds = peerState.callCostDiamonds,
            balanceDiamonds = peerState.currentUserDiamonds,
            onCall = { showCallConfirm = false; peer.initiateCall() },
            onRecharge = { showCallConfirm = false; onRecharge() },
            onDismiss = { showCallConfirm = false },
        )
    }

    if (showGifts) {
        GiftDrawer(
            gifts = peerState.catalogue,
            balanceDiamonds = peerState.currentUserDiamonds,
            recipientName = name,
            recipientPhotoUrl = state.otherUserPhotoUrl,
            sending = peerState.giftSending,
            loading = peerState.catalogueLoading,
            loadError = peerState.catalogueError,
            onRetry = peer::retryGiftCatalogue,
            // A `dm` gift: settleGift charges, credits and writes the gift into this chat, all in one transaction.
            onSend = { g, q -> peer.sendGift(g, q); showGifts = false },
            onRecharge = { showGifts = false; onRecharge() },
            onDismiss = { showGifts = false },
        )
    }

    if (showReport) {
        val reasons = listOf("Inappropriate content", "Harassment or abuse", "Scam or fraud", "Underage", "Fake profile", "Something else")
        AlertDialog(
            onDismissRequest = { showReport = false },
            containerColor = c.bgElevated,
            title = { Text("Report $name", style = ZipperTheme.type.headingS, color = c.textPrimary) },
            text = {
                Column {
                    reasons.forEach { r ->
                        Text(
                            r, style = ZipperTheme.type.bodyM, color = c.textPrimary,
                            modifier = Modifier.fillMaxWidth().clickableNoRipple { showReport = false; peer.report(r) }.padding(vertical = 10.dp),
                        )
                    }
                }
            },
            confirmButton = {},
            dismissButton = { TextButton({ showReport = false }) { Text("Cancel", color = c.textSecondary) } },
        )
    }

    if (confirmBlock) {
        AlertDialog(
            onDismissRequest = { confirmBlock = false },
            containerColor = c.bgElevated,
            title = { Text("Block $name?", style = ZipperTheme.type.headingS, color = c.textPrimary) },
            text = { Text("They can no longer call or message you. You can unblock them here or from Settings.", style = ZipperTheme.type.bodyM, color = c.textSecondary) },
            confirmButton = { TextButton({ confirmBlock = false; peer.blockUser() }) { Text("Block", color = c.statusDanger) } },
            dismissButton = { TextButton({ confirmBlock = false }) { Text("Cancel", color = c.textSecondary) } },
        )
    }

    viewing?.let { url ->
        Dialog(onDismissRequest = { viewing = null }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
            Box(Modifier.fillMaxSize().background(Color.Black).clickableNoRipple { viewing = null }, contentAlignment = Alignment.Center) {
                AsyncImage(url, "Photo", contentScale = ContentScale.Fit, modifier = Modifier.fillMaxWidth())
            }
        }
    }
}

@Composable
private fun MessageRow(
    msg: ChatMessage,
    isMe: Boolean,
    onJoinLive: (String) -> Unit,
    playing: Boolean = false,
    onTogglePlay: () -> Unit = {},
    onOpenImage: (String) -> Unit = {},
) {
    val c = ZipperTheme.colors
    val shape = if (isMe) RoundedCornerShape(Radius.lg, Radius.lg, Radius.xs, Radius.lg) else RoundedCornerShape(Radius.lg, Radius.lg, Radius.lg, Radius.xs)
    // O9 (5 Nov 2026): the chat bubble the SENDER wears (their public profile — what they own now, not a field they
    // wrote on the message), in its colours; the plain bubbles otherwise.
    val worn = rememberDecorBrush("chat_bubble", rememberUserDecor(msg.senderUid.ifBlank { null })?.bubbleId)
    val onBubble = if (isMe || worn != null) Color.White else c.textPrimary
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (isMe) Arrangement.End else Arrangement.Start) {
        Column(
            Modifier.widthIn(max = 260.dp)
                .then(
                    when {
                        worn != null -> Modifier.background(worn, shape)
                        isMe -> Modifier.background(Brush.linearGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), shape)
                        else -> Modifier.background(Brush.verticalGradient(listOf(Color(0x12FFFFFF), Color(0x05FFFFFF))), shape).border(1.dp, c.borderSubtle, shape)
                    }
                )
                .clip(shape)
                .padding(horizontal = Space.md, vertical = Space.sm),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            when (msg.type) {
                "image" -> AsyncImage(
                    msg.imageUrl, "Photo", contentScale = ContentScale.Crop,
                    modifier = Modifier.size(200.dp).clip(RoundedCornerShape(Radius.md)).clickableNoRipple { if (msg.imageUrl.isNotBlank()) onOpenImage(msg.imageUrl) },
                )
                "voice" -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    Box(
                        Modifier.size(36.dp).background(if (isMe) Color.White.copy(alpha = 0.2f) else c.bgElevated, CircleShape).clickableNoRipple(onTogglePlay),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(if (playing) Icons.Default.Pause else Icons.Default.PlayArrow, if (playing) "Pause" else "Play", tint = onBubble, modifier = Modifier.size(22.dp))
                    }
                    Column {
                        Text("Voice message", style = ZipperTheme.type.labelM, color = onBubble)
                        Text(ChatParse.clock(msg.durationMs), style = ZipperTheme.type.caption, color = if (isMe) Color.White.copy(0.8f) else c.textSecondary)
                    }
                }
                "gift" -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    if (msg.giftImageUrl.isNotBlank()) AsyncImage(msg.giftImageUrl, msg.giftName, modifier = Modifier.size(44.dp))
                    else HoppingEmoji(msg.giftEmoji.ifBlank { "🎁" }, msg.id)
                    Column {
                        Text(if (isMe) "You sent a gift" else "Sent you a gift", style = ZipperTheme.type.caption, color = if (isMe) Color.White.copy(0.8f) else c.textSecondary)
                        Text(msg.giftName + if (msg.quantity > 1) " ×${msg.quantity}" else "", style = ZipperTheme.type.labelL, color = onBubble)
                    }
                }
                "invite" -> {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                        Box(Modifier.size(32.dp).background(c.tintDangerSubtle, CircleShape), contentAlignment = Alignment.Center) { Icon(Icons.Default.Videocam, null, tint = c.statusLive, modifier = Modifier.size(18.dp)) }
                        Column {
                            Text("${msg.inviteHostName.ifBlank { "Someone" }} is live!", style = ZipperTheme.type.labelM, color = onBubble)
                            Text("Tap to join the room", style = ZipperTheme.type.caption, color = if (isMe) Color.White.copy(0.8f) else c.textSecondary)
                        }
                    }
                    Spacer(Modifier.height(Space.xs))
                    ZipperButton("Join live", { onJoinLive(msg.inviteRoomId) }, size = ButtonSize.Small, style = if (isMe) ButtonStyle.Secondary else ButtonStyle.Primary)
                }
                else -> Text(msg.text, style = ZipperTheme.type.bodyM, color = onBubble)
            }
            Text(timeOf(msg.timestamp), style = ZipperTheme.type.caption, color = if (isMe) Color.White.copy(0.85f) else c.textMuted, modifier = Modifier.align(Alignment.End))
        }
    }
}

// QA #54: message times in IST, whatever the handset's zone.
private val timeFmt = SimpleDateFormat("h:mm a", Locale.getDefault()).apply { timeZone = com.zipper.app.util.IstTime.ZONE }
private fun timeOf(ms: Long): String = if (ms <= 0) "" else timeFmt.format(Date(ms))


/**
 * The text field and the send / voice button. O10 (5 Nov 2026), speed: its own composable reading its own flow, so a
 * keystroke recomposes this row and nothing else — the thread above it used to recompose on every letter typed.
 */
@Composable
private fun TextComposer(
    input: kotlinx.coroutines.flow.StateFlow<String>,
    onInput: (String) -> Unit,
    onSend: () -> Unit,
    onVoice: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = ZipperTheme.colors
    val text by input.collectAsStateWithLifecycle()
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
        Row(
            Modifier.weight(1f).heightIn(min = 48.dp).background(c.bgBase, RoundedCornerShape(24.dp)).border(1.dp, c.borderDefault, RoundedCornerShape(24.dp)).padding(start = Space.lg, end = Space.md, top = 12.dp, bottom = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BasicTextField(
                value = text, onValueChange = onInput, maxLines = 4,
                textStyle = ZipperTheme.type.bodyM.copy(color = c.textPrimary), cursorBrush = SolidColor(c.brandPrimary),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { onSend() }),
                modifier = Modifier.weight(1f),
                decorationBox = { inner -> if (text.isEmpty()) Text("Type a message…", style = ZipperTheme.type.bodyS, color = c.textMuted); inner() },
            )
        }
        val canSend = text.isNotBlank()
        Box(
            Modifier.size(48.dp)
                .background(Brush.linearGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), CircleShape)
                .clickableNoRipple { if (canSend) onSend() else onVoice() },
            contentAlignment = Alignment.Center,
        ) {
            if (canSend) Icon(Icons.AutoMirrored.Filled.Send, "Send", tint = Color.White, modifier = Modifier.size(22.dp))
            else Icon(Icons.Default.Mic, "Record a voice message", tint = Color.White, modifier = Modifier.size(22.dp))
        }
    }
}


/** O9: an emoji gift in the chat hops when it appears — a few bounces, then it rests. */
@Composable
private fun HoppingEmoji(emoji: String, key: String) {
    val hop = remember(key) { androidx.compose.animation.core.Animatable(0f) }
    LaunchedEffect(key) {
        repeat(3) {
            hop.animateTo(1f, androidx.compose.animation.core.tween(180))
            hop.animateTo(0f, androidx.compose.animation.core.tween(220))
        }
    }
    Text(
        emoji, style = ZipperTheme.type.headingL,
        modifier = Modifier.graphicsLayer {
            translationY = -hop.value * 18.dp.toPx()
            val s = 1f + hop.value * 0.25f
            scaleX = s; scaleY = s
        },
    )
}

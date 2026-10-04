package com.zipper.app.ui.screens.messages

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
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import com.zipper.app.data.model.ChatMessage
import com.zipper.app.ui.components.*
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/*
 * Chat — Figma "06 Profile & Social / 02 Chat" (65:11).
 *
 *   App bar 64 on bg/raised: back, 36 avatar (mint ring online), name
 *   Semi Bold 16, "● Online" caption. Thread padding 12, gap 8.
 *   Their bubble: glass gradient, hairline, r16 (tail corner r4), text 14,
 *   time 11 in ink/500. My bubble: brand gradient, white time.
 *   Composer 64: 48h pill input on bg/base + 48 gradient send disc.
 */
@Composable
fun ChatScreen(
    otherUid: String,
    convoId: String,
    onBack: () -> Unit,
    onJoinLive: (roomId: String) -> Unit = {},
    onOpenProfile: (uid: String) -> Unit = {},
    prefilledMessage: String = "",
    viewModel: ChatViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    val listState = rememberLazyListState()
    val myUid = viewModel.myUid

    LaunchedEffect(prefilledMessage) { if (prefilledMessage.isNotBlank()) viewModel.onInput(prefilledMessage) }
    LaunchedEffect(Unit) { viewModel.markRead() }
    LaunchedEffect(state.messages.size) { if (state.messages.isNotEmpty()) listState.animateScrollToItem(state.messages.size - 1) }

    Column(Modifier.fillMaxSize().background(c.bgBase).statusBarsPadding().navigationBarsPadding().imePadding()) {
        // App bar
        Row(
            Modifier.fillMaxWidth().height(64.dp).background(c.bgRaised).padding(start = Space.xs, end = Space.md),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            IconButtonCircle(Icons.AutoMirrored.Filled.ArrowBack, "Back", onBack, background = Color.Transparent)
            Row(Modifier.weight(1f).clickableNoRipple { onOpenProfile(otherUid) }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                Avatar(state.otherUserPhotoUrl, size = AvatarSize.SM, initial = state.otherUserName, ring = if (state.otherUserOnline) AvatarRing.Online else AvatarRing.None)
                Column {
                    Text(state.otherUserName.ifBlank { "User" }, style = ZipperTheme.type.labelL, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                        Box(Modifier.size(7.dp).background(if (state.otherUserOnline) c.statusOnline else c.textMuted, CircleShape))
                        Text(if (state.otherUserOnline) "Online" else "Offline", style = ZipperTheme.type.caption, color = c.textSecondary)
                    }
                }
            }
        }
        HairlineDivider()

        // Thread
        Box(Modifier.weight(1f)) {
            when {
                state.isLoading -> LoadingState()
                state.messages.isEmpty() -> EmptyState(
                    Icons.Outlined.ChatBubbleOutline, "Say hi to ${state.otherUserName.ifBlank { "them" }}",
                    "Messages are private between the two of you. Keep payments to verified resellers only.",
                )
                else -> LazyColumn(
                    state = listState, modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(Space.md), verticalArrangement = Arrangement.spacedBy(Space.sm),
                ) {
                    items(state.messages, key = { it.id }) { msg -> MessageRow(msg, msg.senderUid == myUid, onJoinLive) }
                }
            }
        }

        // Composer
        Row(
            Modifier.fillMaxWidth().background(c.bgRaised).padding(horizontal = Space.md, vertical = Space.sm),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            Row(
                Modifier.weight(1f).heightIn(min = 48.dp).background(c.bgBase, RoundedCornerShape(24.dp)).border(1.dp, c.borderDefault, RoundedCornerShape(24.dp)).padding(start = Space.lg, end = Space.md, top = 12.dp, bottom = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BasicTextField(
                    value = state.messageInput, onValueChange = viewModel::onInput, maxLines = 4,
                    textStyle = ZipperTheme.type.bodyM.copy(color = c.textPrimary), cursorBrush = SolidColor(c.brandPrimary),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { viewModel.sendMessage() }),
                    modifier = Modifier.weight(1f),
                    decorationBox = { inner -> if (state.messageInput.isEmpty()) Text("Type a message…", style = ZipperTheme.type.bodyS, color = c.textMuted); inner() },
                )
            }
            val canSend = state.messageInput.isNotBlank()
            Box(
                Modifier.size(48.dp)
                    .background(if (canSend) Brush.linearGradient(listOf(c.brandGradientFrom, c.brandGradientTo)) else Brush.linearGradient(listOf(c.bgElevated, c.bgElevated)), CircleShape)
                    .clickableNoRipple { if (canSend) viewModel.sendMessage() },
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.AutoMirrored.Filled.Send, "Send", tint = if (canSend) Color.White else c.textMuted, modifier = Modifier.size(22.dp)) }
        }
    }
}

@Composable
private fun MessageRow(msg: ChatMessage, isMe: Boolean, onJoinLive: (String) -> Unit) {
    val c = ZipperTheme.colors
    val shape = if (isMe) RoundedCornerShape(Radius.lg, Radius.lg, Radius.xs, Radius.lg) else RoundedCornerShape(Radius.lg, Radius.lg, Radius.lg, Radius.xs)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (isMe) Arrangement.End else Arrangement.Start) {
        Column(
            Modifier.widthIn(max = 260.dp)
                .then(
                    if (isMe) Modifier.background(Brush.linearGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), shape)
                    else Modifier.background(Brush.verticalGradient(listOf(Color(0x12FFFFFF), Color(0x05FFFFFF))), shape).border(1.dp, c.borderSubtle, shape)
                )
                .clip(shape)
                .padding(horizontal = Space.md, vertical = Space.sm),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            when (msg.type) {
                "image" -> AsyncImage(msg.imageUrl, null, contentScale = ContentScale.Crop, modifier = Modifier.size(200.dp).clip(RoundedCornerShape(Radius.md)))
                "invite" -> {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                        Box(Modifier.size(32.dp).background(c.tintDangerSubtle, CircleShape), contentAlignment = Alignment.Center) { Icon(Icons.Default.Videocam, null, tint = c.statusLive, modifier = Modifier.size(18.dp)) }
                        Column {
                            Text("${msg.inviteHostName.ifBlank { "Someone" }} is live!", style = ZipperTheme.type.labelM, color = if (isMe) Color.White else c.textPrimary)
                            Text("Tap to join the room", style = ZipperTheme.type.caption, color = if (isMe) Color.White.copy(0.8f) else c.textSecondary)
                        }
                    }
                    Spacer(Modifier.height(Space.xs))
                    ZipperButton("Join live", { onJoinLive(msg.inviteRoomId) }, size = ButtonSize.Small, style = if (isMe) ButtonStyle.Secondary else ButtonStyle.Primary)
                }
                else -> Text(msg.text, style = ZipperTheme.type.bodyM, color = if (isMe) Color.White else c.textPrimary)
            }
            Text(timeOf(msg.timestamp), style = ZipperTheme.type.caption, color = if (isMe) Color.White.copy(0.85f) else c.textMuted, modifier = Modifier.align(Alignment.End))
        }
    }
}

private val timeFmt = SimpleDateFormat("h:mm a", Locale.getDefault())
private fun timeOf(ms: Long): String = if (ms <= 0) "" else timeFmt.format(Date(ms))

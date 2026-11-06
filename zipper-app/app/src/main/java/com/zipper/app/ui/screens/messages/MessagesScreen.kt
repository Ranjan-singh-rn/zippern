package com.zipper.app.ui.screens.messages

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Campaign
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.SupportAgent
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import com.zipper.app.data.model.BroadcastMessage
import com.zipper.app.data.model.Conversation
import com.zipper.app.data.model.SupportTicket
import com.zipper.app.data.model.UserNotification
import com.zipper.app.ui.components.*
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/*
 * Messages — Figma "06 Profile & Social / 01 Messages" (64:26).
 *
 *   App bar: "Messages" Bold 24 + "4 new" brand pill.
 *   Segmented control (38h, bg/raised, 2dp inset): Official · Feedback ·
 *   Chats — the selected segment is the brand gradient.
 *   Conversation rows 68h: 44 avatar (ring by presence), name Semi Bold 16,
 *   preview (bold white when unread, ink/500 regular when read), "2m ago"
 *   (brand when unread) and a brand unread pill.
 */
@Composable
fun MessagesScreen(
    onNavigateToChat: (otherUid: String, convoId: String) -> Unit = { _, _ -> },
    onNavigateToFeedback: () -> Unit = {},
    /** "official" / "feedback" / "chats" — a caller asking for one tab (a deep link). */
    initialTab: String? = null,
    viewModel: MessagesViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    /*
     * QA (3 Nov 2026): this was always Chats, so somebody just warned, banned
     * or told an appeal's outcome landed on an empty chat list. The first tab
     * is now decided once, when the lists have loaded (`MessagesTabs`), and is
     * the person's own choice from then on — it never flips under them while
     * they read.
     */
    // O5: saveable — coming back from a chat lands on the tab the person was on, not on Official again.
    var tab by rememberSaveable { mutableIntStateOf(-1) }
    // Both lists, not just the chats: they arrive separately, and a tab decided
    // before the notices had come counted none of them.
    LaunchedEffect(state.isLoading, state.notificationsLoaded) {
        if (!state.isLoading && state.notificationsLoaded && tab < 0) {
            tab = com.zipper.app.util.MessagesTabs.initialTab(initialTab, state.unreadOfficial, state.totalUnread)
        }
    }
    val shown = if (tab >= 0) tab else com.zipper.app.util.MessagesTabs.initialTab(initialTab, state.unreadOfficial, state.totalUnread)
    // O5: opening Official marks what is in it as seen (the server never marks a notice read).
    LaunchedEffect(shown, state.notificationsLoaded, state.notifications.size) {
        if (shown == com.zipper.app.util.MessagesTabs.OFFICIAL && state.notificationsLoaded) viewModel.officialOpened()
    }
    val tabs = listOf("Official", "Feedback", "Chats")

    val snackbar = remember { SnackbarHostState() }
    var confirmDelete by remember { mutableStateOf(false) }
    LaunchedEffect(state.notice) { state.notice?.let { snackbar.showSnackbar(it); viewModel.consumeNotice() } }
    val selecting = state.selected.isNotEmpty()
    // Back leaves selection first, as every phone's own lists do.
    androidx.activity.compose.BackHandler(enabled = selecting) { viewModel.clearSelection() }

    Box(Modifier.fillMaxSize().background(c.bgBase)) {
    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        if (selecting) {
            // O5: "delete chat" — the selection bar replaces the title while chats are ticked.
            Row(Modifier.fillMaxWidth().padding(horizontal = Space.sm, vertical = Space.xs).height(38.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButtonCircle(Icons.Default.Close, "Cancel selection", viewModel::clearSelection, background = Color.Transparent)
                Text("${state.selected.size} selected", style = ZipperTheme.type.labelL, color = c.textPrimary, modifier = Modifier.weight(1f))
                if (state.selected.size < state.conversations.size) {
                    TextButton(viewModel::selectAll) { Text("Select all", color = c.textBrand) }
                }
                IconButtonCircle(Icons.Default.Delete, "Delete selected chats", { confirmDelete = true },
                    background = Color.Transparent, tint = c.statusDanger, enabled = !state.deleting)
            }
        } else Row(Modifier.fillMaxWidth().padding(horizontal = Space.lg, vertical = Space.sm).height(30.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Messages", style = ZipperTheme.type.headingL, color = c.textPrimary)
            Spacer(Modifier.weight(1f))
            if (state.totalUnread > 0) {
                Box(Modifier.background(c.brandPrimary, CircleShape).padding(horizontal = 8.dp, vertical = 2.dp)) {
                    Text("${state.totalUnread} new", style = ZipperTheme.type.labelS, color = Color.White)
                }
            }
        }

        // Segmented control
        Row(
            Modifier.padding(start = Space.lg, end = Space.lg, bottom = Space.sm).fillMaxWidth().height(38.dp).background(c.bgRaised, CircleShape).padding(2.dp),
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            tabs.forEachIndexed { i, t ->
                val on = shown == i
                // An unread Official notice is said on its segment too.
                val label = if (i == com.zipper.app.util.MessagesTabs.OFFICIAL && state.unreadOfficial > 0) "$t · ${state.unreadOfficial}" else t
                Box(
                    Modifier.weight(1f).fillMaxHeight()
                        .then(if (on) Modifier.background(Brush.horizontalGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), CircleShape) else Modifier)
                        .clickableNoRipple { tab = i; viewModel.clearSelection() },
                    contentAlignment = Alignment.Center,
                ) { Text(label, style = ZipperTheme.type.labelM, color = if (on) Color.White else c.textMuted) }
            }
        }

        when {
            state.isLoading -> LoadingState()
            shown == 0 -> OfficialTab(state.broadcasts, state.notifications, state.officialNewSince)
            shown == 1 -> TicketsTab(state.tickets, onNavigateToFeedback)
            state.chatsFailed && state.conversations.isEmpty() -> EmptyState(
                Icons.Outlined.CloudOff, "Chats could not be loaded",
                "Check your connection. Your messages are safe — they show again once the app reaches the server.",
            )
            else -> ConversationsTab(
                convos = state.conversations, myUid = viewModel.myUid(), selected = state.selected,
                onOpen = { convo -> onNavigateToChat(convo.otherUserUid, convo.id) },
                onToggle = viewModel::toggleSelected,
            )
        }
    }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(bottom = Space.lg)) { data ->
            Snackbar(snackbarData = data, containerColor = c.bgElevated, contentColor = c.textPrimary)
        }
    }

    if (confirmDelete) {
        val chosen = state.conversations.filter { it.id in state.selected }
        val one = chosen.singleOrNull()
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            containerColor = c.bgElevated,
            title = {
                Text(if (one != null) "Delete this chat?" else "Delete ${chosen.size} chats?", style = ZipperTheme.type.headingS, color = c.textPrimary)
            },
            text = {
                Text(
                    (if (one != null) "Your chat with ${one.otherUserName.ifBlank { "this person" }} is removed from your Messages. "
                    else "These chats are removed from your Messages. ") +
                        "The other person keeps their copy. A new message starts the chat again.",
                    style = ZipperTheme.type.bodyM, color = c.textSecondary,
                )
            },
            confirmButton = { TextButton({ confirmDelete = false; viewModel.deleteSelected() }) { Text("Delete", color = c.statusDanger) } },
            dismissButton = { TextButton({ confirmDelete = false }) { Text("Cancel", color = c.textSecondary) } },
        )
    }
}

/**
 * The chat list. O5: a long press starts selecting; while anything is selected a tap ticks
 * or unticks a chat instead of opening it, and the bar at the top deletes the ticked ones.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ConversationsTab(
    convos: List<Conversation>,
    myUid: String,
    selected: Set<String>,
    onOpen: (Conversation) -> Unit,
    onToggle: (String) -> Unit,
) {
    val c = ZipperTheme.colors
    if (convos.isEmpty()) {
        EmptyState(Icons.Outlined.ChatBubbleOutline, "No chats yet", "Open someone's profile and tap Message, or reply to a reseller from the Diamond Shop.")
        return
    }
    val selecting = selected.isNotEmpty()
    LazyColumn(contentPadding = PaddingValues(bottom = Space.xl)) {
        if (!selecting) item(key = "select-hint") {
            Text(
                "Long-press a chat to select it — then delete one or several.",
                style = ZipperTheme.type.caption, color = c.textMuted,
                modifier = Modifier.fillMaxWidth().padding(horizontal = Space.lg, vertical = Space.xs),
            )
        }
        items(convos, key = { it.id }) { convo ->
            val unread = convo.unreadCount[myUid] ?: 0L
            val fromThem = convo.lastMessageSenderUid != myUid
            val ticked = convo.id in selected
            Row(
                Modifier.fillMaxWidth()
                    .then(if (ticked) Modifier.background(c.tintBrandSubtle) else Modifier)
                    .combinedClickable(
                        interactionSource = remember { MutableInteractionSource() }, indication = null,
                        onClick = { if (selecting) onToggle(convo.id) else onOpen(convo) },
                        onLongClick = { onToggle(convo.id) },
                    )
                    .padding(horizontal = Space.lg, vertical = Space.md),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md),
            ) {
                if (selecting) {
                    Box(Modifier.size(22.dp).then(if (ticked) Modifier else Modifier.border(2.dp, c.borderDefault, CircleShape)), contentAlignment = Alignment.Center) {
                        if (ticked) Icon(Icons.Default.CheckCircle, "Selected", tint = c.brandPrimary, modifier = Modifier.size(22.dp))
                    }
                }
                Avatar(convo.otherUserPhotoUrl, size = AvatarSize.MD, initial = convo.otherUserName, decorUid = convo.otherUserUid)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(convo.otherUserName.ifBlank { "User" }, style = ZipperTheme.type.labelL, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        (if (!fromThem && convo.lastMessage.isNotBlank()) "You: " else "") + convo.lastMessage.ifBlank { "Say hi!" },
                        style = if (unread > 0) ZipperTheme.type.labelM else ZipperTheme.type.bodyS,
                        color = if (unread > 0) c.textPrimary else c.textMuted,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
                Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(timeAgo(convo.lastMessageAt), style = ZipperTheme.type.caption, color = if (unread > 0) c.brandPrimary else c.textMuted)
                    if (unread > 0) {
                        Box(Modifier.height(18.dp).background(c.brandPrimary, CircleShape).padding(horizontal = 8.dp), contentAlignment = Alignment.Center) {
                            Text(if (unread > 99) "99+" else unread.toString(), style = ZipperTheme.type.caption, color = Color.White)
                        }
                    }
                }
            }
            HairlineDivider()
        }
    }
}

/**
 * One row of the Official tab. Two sources, one list.
 *
 * A broadcast goes to everybody; a notification is addressed to this user
 * alone. The user has no reason to care which collection a message came out
 * of, so they are interleaved by time — but a warning is marked, because a
 * moderation decision read as an announcement is a moderation decision missed.
 */
private sealed interface OfficialItem {
    val key: String
    val at: Long

    data class Announcement(val b: BroadcastMessage) : OfficialItem {
        // Prefixed: a broadcast id and a notification id come from different
        // collections and could collide, and a duplicate key crashes LazyColumn.
        override val key get() = "b:${b.id}"
        override val at get() = b.createdAt
    }

    data class Personal(val n: UserNotification) : OfficialItem {
        override val key get() = "n:${n.id}"
        override val at get() = n.createdAt
    }
}

@Composable
private fun OfficialTab(broadcasts: List<BroadcastMessage>, notifications: List<UserNotification>, newSince: Long = 0L) {
    val items: List<OfficialItem> = remember(broadcasts, notifications) {
        (broadcasts.map { OfficialItem.Announcement(it) } +
            notifications.map { OfficialItem.Personal(it) })
            .sortedByDescending { it.at }
    }

    if (items.isEmpty()) { EmptyState(Icons.Outlined.Campaign, "Nothing from Zipper yet", "Announcements, events and rewards from the team show up here."); return }

    LazyColumn(contentPadding = PaddingValues(horizontal = Space.lg, vertical = Space.sm), verticalArrangement = Arrangement.spacedBy(Space.md)) {
        items(items, key = { it.key }) { item ->
            when (item) {
                is OfficialItem.Announcement -> AnnouncementCard(item.b)
                is OfficialItem.Personal -> PersonalNoticeCard(item.n, isNew = !item.n.isRead && item.n.createdAt > newSince)
            }
        }
        item { Spacer(Modifier.height(Space.sm)) }
    }
}

@Composable
private fun AnnouncementCard(b: BroadcastMessage) {
    val c = ZipperTheme.colors
    Column(
        Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color(0x12FFFFFF), Color(0x05FFFFFF))), RoundedCornerShape(Radius.lg)).border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.lg)).clip(RoundedCornerShape(Radius.lg)),
    ) {
        if (b.imageUrl.isNotBlank()) AsyncImage(b.imageUrl, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxWidth().height(140.dp))
        Column(Modifier.padding(Space.lg), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                Chip("OFFICIAL", tint = c.tintDiamondSubtle, contentColor = c.currencyDiamond)
                Spacer(Modifier.weight(1f))
                Text(timeAgo(b.createdAt), style = ZipperTheme.type.caption, color = c.textMuted)
            }
            Text(b.title, style = ZipperTheme.type.labelL, color = c.textPrimary)
            Text(b.body, style = ZipperTheme.type.bodyM, color = c.textSecondary)
            // QA: who sent it, as typed in the CRM.
            com.zipper.app.util.MessagesTabs.senderLine(b.senderName)?.let {
                Text(it, style = ZipperTheme.type.caption, color = c.textMuted)
            }
        }
    }
}

/**
 * A notice addressed to this user. A warning is drawn in the warning colour
 * with its own label, so it does not read as news alongside a rewards
 * announcement — it is a decision about their account, and the body is the
 * reason the reviewer wrote.
 */
@Composable
private fun PersonalNoticeCard(n: UserNotification, isNew: Boolean = !n.isRead) {
    val c = ZipperTheme.colors
    val tint = if (n.isWarning) c.statusWarning else c.currencyDiamond
    val label = if (n.isWarning) "WARNING" else "OFFICIAL"
    Column(
        Modifier.fillMaxWidth()
            .background(Brush.verticalGradient(listOf(Color(0x12FFFFFF), Color(0x05FFFFFF))), RoundedCornerShape(Radius.lg))
            .border(1.dp, if (n.isWarning) tint.copy(alpha = 0.45f) else c.borderSubtle, RoundedCornerShape(Radius.lg))
            .clip(RoundedCornerShape(Radius.lg))
            .padding(Space.lg),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
            Chip(label, tint = tint.copy(alpha = 0.14f), contentColor = tint)
            // An unread dot rather than a count: there is one message per card,
            // so a number would always read "1".
            if (isNew) Box(Modifier.size(6.dp).background(c.brandPrimary, CircleShape))
            Spacer(Modifier.weight(1f))
            Text(timeAgo(n.createdAt), style = ZipperTheme.type.caption, color = c.textMuted)
        }
        if (n.title.isNotBlank()) Text(n.title, style = ZipperTheme.type.labelL, color = c.textPrimary)
        Text(n.body, style = ZipperTheme.type.bodyM, color = c.textSecondary)
        // QA: the decision's reason (a ban, a suspension, a rejection) — written
        // by the server as its own field, and the line people most need.
        com.zipper.app.util.MessagesTabs.reasonLine(n.body, n.reason)?.let {
            Text(it, style = ZipperTheme.type.bodyM, color = c.textPrimary)
        }
    }
}

@Composable
private fun TicketsTab(tickets: List<SupportTicket>, onNew: () -> Unit) {
    val c = ZipperTheme.colors
    if (tickets.isEmpty()) { EmptyState(Icons.Outlined.SupportAgent, "No feedback sent", "Report a problem or suggest something — we read every ticket.", actionLabel = "Write feedback", onAction = onNew); return }
    LazyColumn(contentPadding = PaddingValues(horizontal = Space.lg, vertical = Space.sm), verticalArrangement = Arrangement.spacedBy(Space.md)) {
        items(tickets, key = { it.id }) { t ->
            val (tint, label) = when (t.status) {
                "open" -> c.statusWarning to "Open"
                // B2: the CRM's support page moves a claimed ticket to `assigned`.
                "assigned" -> c.currencyDiamond to "Assigned"
                "in_progress" -> c.currencyDiamond to "In progress"
                // What the CRM stamps when support answers — it was falling to
                // the `else` branch and showing the raw word "replied" in grey,
                // beside a reply block that is the whole point of the row.
                "replied" -> c.statusSuccess to "Replied"
                "resolved" -> c.statusSuccess to "Resolved"
                "closed" -> c.textMuted to "Closed"
                else -> c.textMuted to t.status
            }
            Column(
                Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color(0x12FFFFFF), Color(0x05FFFFFF))), RoundedCornerShape(Radius.lg)).border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.lg)).padding(Space.lg),
                verticalArrangement = Arrangement.spacedBy(Space.xs),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(t.subject, style = ZipperTheme.type.labelL, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Chip(label, tint = tint.copy(alpha = 0.14f), contentColor = tint)
                }
                Text(t.body, style = ZipperTheme.type.bodyS, color = c.textSecondary, maxLines = 3, overflow = TextOverflow.Ellipsis)
                if (t.statusMessage.isNotBlank()) {
                    Column(Modifier.fillMaxWidth().padding(top = Space.xs).background(c.bgRaised, RoundedCornerShape(Radius.md)).padding(Space.md)) {
                        Text("Reply from Zipper", style = ZipperTheme.type.caption, color = c.textBrand)
                        Text(t.statusMessage, style = ZipperTheme.type.bodyS, color = c.textPrimary)
                    }
                }
                Text(timeAgo(t.updatedAt.takeIf { it > 0 } ?: t.createdAt), style = ZipperTheme.type.caption, color = c.textMuted)
            }
        }
        item { Spacer(Modifier.height(Space.sm)); ZipperButton("Write feedback", onNew, style = ButtonStyle.Secondary, fullWidth = true, size = ButtonSize.Medium) }
    }
}

/** "2m ago" · "1h ago" · "Yesterday" · "12 Mar". */
fun timeAgo(ms: Long): String {
    if (ms <= 0) return ""
    val diff = System.currentTimeMillis() - ms
    val m = diff / 60_000; val h = m / 60; val d = h / 24
    return when {
        m < 1 -> "now"
        m < 60 -> "${m}m ago"
        h < 24 -> "${h}h ago"
        d < 2 -> "Yesterday"
        d < 7 -> "${d}d ago"
        // QA #54: IST, whatever the handset's zone.
        else -> SimpleDateFormat("d MMM", Locale.getDefault()).apply { timeZone = com.zipper.app.util.IstTime.ZONE }.format(Date(ms))
    }
}

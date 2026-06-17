package com.zipper.datingapp.ui.screens

import androidx.activity.compose.BackHandler
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.ChatBubbleOutline
import androidx.compose.material.icons.filled.Image
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.TabRowDefaults
import androidx.compose.material3.TabRowDefaults.tabIndicatorOffset
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import coil.compose.SubcomposeAsyncImage
import com.zipper.datingapp.data.ChatMessage
import com.zipper.datingapp.data.ChatThread
import com.zipper.datingapp.data.CrmAnnouncement
import com.zipper.datingapp.ui.DatingViewModel
import com.zipper.datingapp.ui.theme.AppBackground
import com.zipper.datingapp.ui.theme.AppSurface
import com.zipper.datingapp.ui.theme.BrandPink
import com.zipper.datingapp.ui.theme.OutlineDefault
import com.zipper.datingapp.ui.theme.TextMuted
import com.zipper.datingapp.ui.theme.TextPrimary
import com.zipper.datingapp.ui.theme.TextSecondary
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// ─────────────────────────────────────────────────────────────────────────────
// MessagesScreen — Tab index 2
// Shows CRM announcements + 1:1 chat threads.
// Tapping a thread navigates inline to ChatDetailScreen.
// ─────────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MessagesScreen(
    viewModel: DatingViewModel,
    onOpenProfile: (userId: String) -> Unit,
) {
    val currentUser by viewModel.currentUser.collectAsState()
    val chatThreads by viewModel.chatThreads.collectAsState()
    val crmAnnouncements by viewModel.crmAnnouncements.collectAsState()

    // Load CRM announcements and start chat thread listener on first composition
    LaunchedEffect(Unit) {
        viewModel.loadCrmAnnouncements()
        viewModel.refreshMessageInbox()
    }

    // Tracks which thread (if any) is open for detail view
    var openedThread by remember { mutableStateOf<ChatThread?>(null) }

    // Intercept system back when a detail is open
    BackHandler(enabled = openedThread != null) {
        viewModel.closeChatThread()
        openedThread = null
    }

    val myUid = currentUser?.id ?: ""

    if (openedThread != null) {
        val thread = openedThread!!
        val otherUserId = thread.participants.firstOrNull { it != myUid } ?: ""
        val otherUserName = thread.participantNames[otherUserId] ?: "User"
        val otherUserPhotoUrl = thread.participantPhotos[otherUserId] ?: ""

        ChatDetailScreen(
            viewModel = viewModel,
            otherUserId = otherUserId,
            otherUserName = otherUserName,
            otherUserPhotoUrl = otherUserPhotoUrl,
            onBack = {
                viewModel.closeChatThread()
                openedThread = null
            },
            onOpenProfile = { onOpenProfile(otherUserId) },
        )
    } else {
        MessagesThreadList(
            myUid = myUid,
            chatThreads = chatThreads,
            crmAnnouncements = crmAnnouncements,
            onThreadClick = { thread ->
                val otherId = thread.participants.firstOrNull { it != myUid } ?: return@MessagesThreadList
                viewModel.openChatWith(otherId)
                openedThread = thread
            },
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Thread list with tabs: Chats | Announcements
// ─────────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MessagesThreadList(
    myUid: String,
    chatThreads: List<ChatThread>,
    crmAnnouncements: List<CrmAnnouncement>,
    onThreadClick: (ChatThread) -> Unit,
) {
    var selectedTab by remember { mutableStateOf(0) }
    var isRefreshing by remember { mutableStateOf(false) }
    val pullToRefreshState = rememberPullToRefreshState()
    val scope = rememberCoroutineScope()

    // Sort threads newest-first
    val sortedThreads = remember(chatThreads) {
        chatThreads.sortedByDescending { it.lastMessageAt }
    }

    // Total unread across all threads (for badge on Chats tab)
    val totalUnread = remember(chatThreads, myUid) {
        chatThreads.sumOf { it.unreadCounts[myUid] ?: 0 }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(AppBackground),
    ) {
        // ── Header ──────────────────────────────────────────────────────────
        Text(
            text = "Messages",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
            color = TextPrimary,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
        )

        // ── Tab row ─────────────────────────────────────────────────────────
        TabRow(
            selectedTabIndex = selectedTab,
            containerColor = AppSurface,
            contentColor = BrandPink,
            indicator = { tabPositions ->
                TabRowDefaults.SecondaryIndicator(
                    modifier = Modifier.tabIndicatorOffset(tabPositions[selectedTab]),
                    height = 2.dp,
                    color = BrandPink,
                )
            },
            divider = { HorizontalDivider(color = OutlineDefault, thickness = 0.5.dp) },
        ) {
            // Chats tab — with unread badge
            Tab(
                selected = selectedTab == 0,
                onClick = { selectedTab = 0 },
                text = {
                    BadgedBox(
                        badge = {
                            if (totalUnread > 0) {
                                Badge(containerColor = BrandPink) {
                                    Text(
                                        text = if (totalUnread > 99) "99+" else totalUnread.toString(),
                                        style = MaterialTheme.typography.labelSmall,
                                        color = Color.White,
                                    )
                                }
                            }
                        }
                    ) {
                        Text(
                            "Chats",
                            color = if (selectedTab == 0) BrandPink else TextSecondary,
                            fontWeight = if (selectedTab == 0) FontWeight.SemiBold else FontWeight.Normal,
                        )
                    }
                }
            )
            // Announcements tab
            Tab(
                selected = selectedTab == 1,
                onClick = { selectedTab = 1 },
                icon = {
                    Icon(
                        imageVector = Icons.Default.Campaign,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp),
                        tint = if (selectedTab == 1) BrandPink else TextSecondary,
                    )
                },
                text = {
                    Text(
                        "Announcements",
                        color = if (selectedTab == 1) BrandPink else TextSecondary,
                        fontWeight = if (selectedTab == 1) FontWeight.SemiBold else FontWeight.Normal,
                    )
                },
            )
        }

        // ── Tab content ─────────────────────────────────────────────────────
        when (selectedTab) {
            0 -> {
                PullToRefreshBox(
                    isRefreshing = isRefreshing,
                    state = pullToRefreshState,
                    onRefresh = {
                        scope.launch {
                            isRefreshing = true
                            // Threads refresh automatically via real-time listener;
                            // brief delay makes the indicator visible to the user.
                            kotlinx.coroutines.delay(600L)
                            isRefreshing = false
                        }
                    },
                    modifier = Modifier.fillMaxSize(),
                ) {
                    if (sortedThreads.isEmpty()) {
                        MessagesEmptyState()
                    } else {
                        LazyColumn(
                            modifier = Modifier.fillMaxSize(),
                            contentPadding = PaddingValues(bottom = 80.dp),
                        ) {
                            itemsIndexed(
                                items = sortedThreads,
                                key = { _, thread -> thread.id },
                            ) { _, thread ->
                                ChatThreadRow(
                                    thread = thread,
                                    myUid = myUid,
                                    onClick = { onThreadClick(thread) },
                                )
                                HorizontalDivider(
                                    color = OutlineDefault,
                                    thickness = 0.5.dp,
                                    modifier = Modifier.padding(start = 84.dp, end = 16.dp),
                                )
                            }
                        }
                    }
                }
            }
            1 -> {
                CrmAnnouncementsList(announcements = crmAnnouncements)
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Single chat thread row
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun ChatThreadRow(
    thread: ChatThread,
    myUid: String,
    onClick: () -> Unit,
) {
    val otherUserId = thread.participants.firstOrNull { it != myUid } ?: ""
    val otherName = thread.participantNames[otherUserId] ?: "User"
    val otherPhotoUrl = thread.participantPhotos[otherUserId] ?: ""
    val unreadCount = thread.unreadCounts[myUid] ?: 0
    val lastMessageTime = remember(thread.lastMessageAt) {
        if (thread.lastMessageAt > 0L) {
            val now = System.currentTimeMillis()
            val diff = now - thread.lastMessageAt
            val oneDayMs = 86_400_000L
            if (diff < oneDayMs) {
                SimpleDateFormat("h:mm a", Locale.getDefault()).format(Date(thread.lastMessageAt))
            } else {
                SimpleDateFormat("MMM d", Locale.getDefault()).format(Date(thread.lastMessageAt))
            }
        } else ""
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Avatar
        Box(modifier = Modifier.size(52.dp)) {
            if (otherPhotoUrl.isNotBlank()) {
                AsyncImage(
                    model = otherPhotoUrl,
                    contentDescription = otherName,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier
                        .fillMaxSize()
                        .clip(CircleShape),
                )
            } else {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    shape = CircleShape,
                    color = BrandPink.copy(alpha = 0.18f),
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Text(
                            text = otherName.take(1).uppercase(),
                            color = BrandPink,
                            fontWeight = FontWeight.Bold,
                            style = MaterialTheme.typography.titleMedium,
                        )
                    }
                }
            }
        }

        Spacer(modifier = Modifier.width(12.dp))

        // Name + last message
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = otherName,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = if (unreadCount > 0) FontWeight.Bold else FontWeight.Normal,
                color = TextPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(modifier = Modifier.height(2.dp))
            Text(
                text = thread.lastMessage.ifBlank { "Start a conversation" },
                style = MaterialTheme.typography.bodySmall,
                color = if (unreadCount > 0) TextSecondary else TextMuted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                fontWeight = if (unreadCount > 0) FontWeight.Medium else FontWeight.Normal,
            )
        }

        Spacer(modifier = Modifier.width(8.dp))

        // Timestamp + unread badge
        Column(
            horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            if (lastMessageTime.isNotBlank()) {
                Text(
                    text = lastMessageTime,
                    style = MaterialTheme.typography.labelSmall,
                    color = if (unreadCount > 0) BrandPink else TextMuted,
                )
            }
            if (unreadCount > 0) {
                Badge(containerColor = BrandPink) {
                    Text(
                        text = if (unreadCount > 99) "99+" else unreadCount.toString(),
                        style = MaterialTheme.typography.labelSmall,
                        color = Color.White,
                    )
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Empty state — no chat threads
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun MessagesEmptyState() {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Icon(
                imageVector = Icons.Default.ChatBubbleOutline,
                contentDescription = null,
                tint = TextMuted,
                modifier = Modifier.size(72.dp),
            )
            Text(
                text = "No conversations yet",
                style = MaterialTheme.typography.titleMedium,
                color = TextSecondary,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = "Visit someone's profile and tap\nMessage to start chatting.",
                style = MaterialTheme.typography.bodyMedium,
                color = TextMuted,
                textAlign = TextAlign.Center,
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// CRM Announcements list
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun CrmAnnouncementsList(announcements: List<CrmAnnouncement>) {
    if (announcements.isEmpty()) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(32.dp),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Icon(
                    imageVector = Icons.Default.Campaign,
                    contentDescription = null,
                    tint = TextMuted,
                    modifier = Modifier.size(64.dp),
                )
                Text(
                    text = "No announcements yet",
                    style = MaterialTheme.typography.titleMedium,
                    color = TextSecondary,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = "Check back later for updates\nfrom the Zipper team.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = TextMuted,
                    textAlign = TextAlign.Center,
                )
            }
        }
        return
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        itemsIndexed(
            items = announcements,
            key = { index, ann -> ann.id.ifBlank { "ann_$index" } },
        ) { _, announcement ->
            CrmAnnouncementCard(announcement = announcement)
        }
    }
}

@Composable
private fun CrmAnnouncementCard(announcement: CrmAnnouncement) {
    val dateFmt = remember { SimpleDateFormat("MMM d, yyyy · h:mm a", Locale.getDefault()) }
    Card(
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = AppSurface,
        ),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            // Sender row — styled as "Zipper" system message
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                // Zipper logo placeholder
                Surface(
                    shape = CircleShape,
                    color = BrandPink.copy(alpha = 0.15f),
                    modifier = Modifier.size(36.dp),
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Text(
                            text = "Z",
                            color = BrandPink,
                            fontWeight = FontWeight.ExtraBold,
                            style = MaterialTheme.typography.titleSmall,
                        )
                    }
                }

                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "Zipper",
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.Bold,
                        color = BrandPink,
                    )
                    if (announcement.createdAtMs > 0L) {
                        Text(
                            text = dateFmt.format(Date(announcement.createdAtMs)),
                            style = MaterialTheme.typography.labelSmall,
                            color = TextMuted,
                        )
                    }
                }

                Icon(
                    imageVector = Icons.Default.Campaign,
                    contentDescription = null,
                    tint = BrandPink.copy(alpha = 0.7f),
                    modifier = Modifier.size(20.dp),
                )
            }

            if (announcement.title.isNotBlank()) {
                Spacer(modifier = Modifier.height(10.dp))
                Text(
                    text = announcement.title,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = TextPrimary,
                )
            }

            // Optional image
            if (!announcement.imageUrl.isNullOrBlank()) {
                Spacer(modifier = Modifier.height(10.dp))
                AsyncImage(
                    model = announcement.imageUrl,
                    contentDescription = announcement.title,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(180.dp)
                        .clip(RoundedCornerShape(12.dp)),
                )
            }

            if (announcement.body.isNotBlank()) {
                Spacer(modifier = Modifier.height(10.dp))
                Text(
                    text = announcement.body,
                    style = MaterialTheme.typography.bodyMedium,
                    color = TextSecondary,
                )
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ChatDetailScreen — full 1:1 chat UI
// ─────────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatDetailScreen(
    viewModel: DatingViewModel,
    otherUserId: String,
    otherUserName: String,
    otherUserPhotoUrl: String,
    onBack: () -> Unit,
    onOpenProfile: () -> Unit,
) {
    val currentUser by viewModel.currentUser.collectAsState()
    val messages by viewModel.activeChatMessages.collectAsState()

    val myUid = currentUser?.id ?: ""

    var inputText by remember { mutableStateOf("") }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }

    // Auto-scroll to latest message (reverseLayout = true, so newest is at index 0)
    val sortedMessages = remember(messages) {
        messages.sortedByDescending { it.timestamp }
    }

    LaunchedEffect(sortedMessages.size) {
        if (sortedMessages.isNotEmpty()) {
            listState.animateScrollToItem(0)
        }
    }

    // "New messages" cue when user has scrolled up
    var userScrolledUp by remember { mutableStateOf(false) }

    LaunchedEffect(listState) {
        snapshotFlow { listState.firstVisibleItemIndex }
            .distinctUntilChanged()
            .collect { index ->
                userScrolledUp = index > 2
            }
    }

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        containerColor = AppBackground,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        snackbarHost = { SnackbarHost(hostState = snackbarHostState) },
        topBar = {
            ChatDetailTopBar(
                otherUserName = otherUserName,
                otherUserPhotoUrl = otherUserPhotoUrl,
                onBack = onBack,
                onOpenProfile = onOpenProfile,
            )
        },
        bottomBar = {
            ChatInputBar(
                inputText = inputText,
                onInputChange = { inputText = it },
                onSend = {
                    val text = inputText.trim()
                    if (text.isNotEmpty()) {
                        viewModel.sendMessage(otherUserId, text)
                        inputText = ""
                        scope.launch {
                            if (sortedMessages.isNotEmpty()) listState.animateScrollToItem(0)
                        }
                    }
                },
            )
        },
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
        ) {
            if (sortedMessages.isEmpty()) {
                ChatEmptyState(otherUserName = otherUserName)
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(horizontal = 12.dp),
                    reverseLayout = true,
                    contentPadding = PaddingValues(top = 8.dp, bottom = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    items(
                        items = sortedMessages,
                        key = { msg -> msg.id.ifBlank { msg.timestamp.toString() } },
                    ) { message ->
                        ChatMessageBubble(
                            message = message,
                            isMe = message.senderId == myUid,
                        )
                    }
                }
            }

            // "Scroll to latest" pill — appears when user scrolls up and new messages arrive
            AnimatedVisibility(
                visible = userScrolledUp,
                enter = slideInVertically(initialOffsetY = { it }) + fadeIn(),
                exit = slideOutVertically(targetOffsetY = { it }) + fadeOut(),
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 8.dp),
            ) {
                Surface(
                    onClick = {
                        userScrolledUp = false
                        scope.launch {
                            if (sortedMessages.isNotEmpty()) listState.animateScrollToItem(0)
                        }
                    },
                    shape = RoundedCornerShape(20.dp),
                    color = BrandPink,
                    shadowElevation = 4.dp,
                ) {
                    Text(
                        text = "Latest messages ↓",
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 7.dp),
                        color = Color.White,
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat detail top bar
// ─────────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatDetailTopBar(
    otherUserName: String,
    otherUserPhotoUrl: String,
    onBack: () -> Unit,
    onOpenProfile: () -> Unit,
) {
    TopAppBar(
        navigationIcon = {
            IconButton(onClick = onBack) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = "Back",
                    tint = TextPrimary,
                )
            }
        },
        title = {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.clickable(onClick = onOpenProfile),
            ) {
                // Avatar
                if (otherUserPhotoUrl.isNotBlank()) {
                    AsyncImage(
                        model = otherUserPhotoUrl,
                        contentDescription = otherUserName,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier
                            .size(36.dp)
                            .clip(CircleShape),
                    )
                } else {
                    Surface(
                        shape = CircleShape,
                        color = BrandPink.copy(alpha = 0.2f),
                        modifier = Modifier.size(36.dp),
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            Text(
                                text = otherUserName.take(1).uppercase(),
                                color = BrandPink,
                                fontWeight = FontWeight.Bold,
                                style = MaterialTheme.typography.titleSmall,
                            )
                        }
                    }
                }
                Spacer(modifier = Modifier.width(10.dp))
                Column {
                    Text(
                        text = otherUserName,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = TextPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        text = "Tap to view profile",
                        style = MaterialTheme.typography.labelSmall,
                        color = TextMuted,
                    )
                }
            }
        },
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = AppSurface,
            navigationIconContentColor = TextPrimary,
            titleContentColor = TextPrimary,
        ),
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat input bar at the bottom
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun ChatInputBar(
    inputText: String,
    onInputChange: (String) -> Unit,
    onSend: () -> Unit,
) {
    Surface(
        color = AppSurface,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .imePadding()
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextField(
                value = inputText,
                onValueChange = onInputChange,
                modifier = Modifier.weight(1f),
                placeholder = {
                    Text(
                        "Type a message…",
                        color = TextMuted,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                },
                maxLines = 4,
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = OutlineDefault.copy(alpha = 0.5f),
                    unfocusedContainerColor = OutlineDefault.copy(alpha = 0.3f),
                    focusedTextColor = TextPrimary,
                    unfocusedTextColor = TextPrimary,
                    cursorColor = BrandPink,
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                ),
                shape = RoundedCornerShape(24.dp),
                textStyle = MaterialTheme.typography.bodyMedium.copy(color = TextPrimary),
            )

            Spacer(modifier = Modifier.width(8.dp))

            IconButton(
                onClick = onSend,
                enabled = inputText.isNotBlank(),
                colors = IconButtonDefaults.iconButtonColors(
                    containerColor = if (inputText.isNotBlank()) BrandPink else OutlineDefault,
                    contentColor = Color.White,
                    disabledContainerColor = OutlineDefault,
                    disabledContentColor = TextMuted,
                ),
                modifier = Modifier.size(46.dp),
            ) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.Send,
                    contentDescription = "Send",
                )
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual chat message bubble
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun ChatMessageBubble(
    message: ChatMessage,
    isMe: Boolean,
) {
    val timeFmt = remember { SimpleDateFormat("h:mm a", Locale.getDefault()) }
    val timeLabel = remember(message.timestamp) {
        if (message.timestamp > 0L) timeFmt.format(Date(message.timestamp)) else ""
    }

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (isMe) Arrangement.End else Arrangement.Start,
    ) {
        Column(
            horizontalAlignment = if (isMe) Alignment.End else Alignment.Start,
            modifier = Modifier.widthIn(max = 280.dp),
        ) {
            Surface(
                shape = RoundedCornerShape(
                    topStart = 18.dp,
                    topEnd = 18.dp,
                    bottomStart = if (isMe) 18.dp else 4.dp,
                    bottomEnd = if (isMe) 4.dp else 18.dp,
                ),
                color = if (isMe) BrandPink else AppSurface,
            ) {
                when {
                    // Image message
                    message.type == "IMAGE" && !message.imageUrl.isNullOrBlank() -> {
                        ImageMessageContent(imageUrl = message.imageUrl!!)
                    }
                    // Text message (also fallback for unknown types)
                    else -> {
                        Text(
                            text = message.text.ifBlank { "…" },
                            modifier = Modifier.padding(
                                horizontal = 14.dp,
                                vertical = 9.dp,
                            ),
                            color = if (isMe) Color.White else TextPrimary,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
            }

            if (timeLabel.isNotBlank()) {
                Spacer(modifier = Modifier.height(2.dp))
                Text(
                    text = timeLabel,
                    style = MaterialTheme.typography.labelSmall,
                    color = TextMuted,
                    fontSize = 10.sp,
                )
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Image thumbnail inside a chat bubble
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun ImageMessageContent(imageUrl: String) {
    SubcomposeAsyncImage(
        model = imageUrl,
        contentDescription = "Image message",
        contentScale = ContentScale.Crop,
        modifier = Modifier
            .size(200.dp)
            .clip(RoundedCornerShape(14.dp)),
        loading = {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(OutlineDefault),
                contentAlignment = Alignment.Center,
            ) {
                CircularProgressIndicator(
                    modifier = Modifier.size(28.dp),
                    strokeWidth = 2.dp,
                    color = BrandPink,
                )
            }
        },
        error = {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(OutlineDefault),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = Icons.Default.Image,
                    contentDescription = "Failed to load image",
                    tint = TextMuted,
                    modifier = Modifier.size(36.dp),
                )
            }
        },
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// Empty state inside an open chat (no messages yet)
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun ChatEmptyState(otherUserName: String) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Surface(
                shape = CircleShape,
                color = BrandPink.copy(alpha = 0.12f),
                modifier = Modifier.size(72.dp),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Text(
                        text = otherUserName.take(1).uppercase(),
                        color = BrandPink,
                        fontWeight = FontWeight.Bold,
                        fontSize = 30.sp,
                    )
                }
            }
            Text(
                text = "Say hi to $otherUserName!",
                style = MaterialTheme.typography.titleMedium,
                color = TextSecondary,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = "This is the start of your conversation.",
                style = MaterialTheme.typography.bodySmall,
                color = TextMuted,
                textAlign = TextAlign.Center,
            )
        }
    }
}

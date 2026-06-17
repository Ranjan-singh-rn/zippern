package com.zipper.datingapp.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.MeetingRoom
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PlayCircleFilled
import androidx.compose.material.icons.filled.VideoCall
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.TabRowDefaults.SecondaryIndicator
import androidx.compose.material3.TabRowDefaults.tabIndicatorOffset
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.zipper.datingapp.data.LiveStream
import com.zipper.datingapp.data.PartyRoom
import com.zipper.datingapp.ui.DatingViewModel
import com.zipper.datingapp.ui.theme.AppBackground
import com.zipper.datingapp.ui.theme.AppSurface
import com.zipper.datingapp.ui.theme.BrandPink
import com.zipper.datingapp.ui.theme.BrandPurple
import com.zipper.datingapp.ui.theme.OutlineDefault
import com.zipper.datingapp.ui.theme.TextMuted
import com.zipper.datingapp.ui.theme.TextPrimary
import com.zipper.datingapp.ui.theme.TextSecondary

// ──────────────────────────────────────────────────────────────────────────────
// LIVE SCREEN — two sub-tabs: Live | Party
// ──────────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LiveScreen(
    viewModel: DatingViewModel,
    onJoinLive: (streamId: String) -> Unit,
    onJoinParty: (roomId: String) -> Unit,
    onGoLive: () -> Unit,
    onGoParty: () -> Unit,
) {
    val uiState by viewModel.uiState.collectAsState()
    val myId = uiState.currentUser?.id.orEmpty()
    // Filter out the current user's own live/party so they don't see themselves in the grid
    val liveStreams by viewModel.activeLiveStreams.collectAsState()
    val partyRooms by viewModel.activePartyRooms.collectAsState()
    val visibleLiveStreams = remember(liveStreams, myId) { liveStreams.filter { it.hostId != myId } }
    val visiblePartyRooms = remember(partyRooms, myId) { partyRooms.filter { it.ownerId != myId } }

    var selectedTab by remember { mutableIntStateOf(0) }
    val tabs = listOf("Live", "Party Rooms")

    val liveRefreshState = rememberPullToRefreshState()
    val partyRefreshState = rememberPullToRefreshState()

    // Start real-time listeners when screen is visible
    LaunchedEffect(Unit) {
        viewModel.startLiveStreamsListener()
        viewModel.startPartyRoomsListener()
    }
    DisposableEffect(Unit) {
        onDispose {
            viewModel.stopLiveStreamsListener()
            viewModel.stopPartyRoomsListener()
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(AppBackground),
    ) {
        Column(modifier = Modifier.fillMaxSize()) {

            // ── Header ────────────────────────────────────────────────────────
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .statusBarsPadding()
                    .padding(horizontal = 16.dp, vertical = 12.dp),
            ) {
                Text(
                    "Live",
                    style = MaterialTheme.typography.titleLarge.copy(
                        fontWeight = FontWeight.Bold,
                        brush = Brush.linearGradient(listOf(BrandPink, BrandPurple)),
                    ),
                )
            }

            // ── Tab row ───────────────────────────────────────────────────────
            TabRow(
                selectedTabIndex = selectedTab,
                containerColor = AppSurface,
                contentColor = BrandPink,
                indicator = { tabPositions ->
                    SecondaryIndicator(
                        modifier = Modifier.tabIndicatorOffset(tabPositions[selectedTab]),
                        color = BrandPink,
                    )
                },
            ) {
                tabs.forEachIndexed { index, title ->
                    Tab(
                        selected = selectedTab == index,
                        onClick = { selectedTab = index },
                        text = {
                            Text(
                                title,
                                fontWeight = if (selectedTab == index) FontWeight.SemiBold else FontWeight.Normal,
                                color = if (selectedTab == index) BrandPink else TextSecondary,
                            )
                        },
                    )
                }
            }

            // ── Content ───────────────────────────────────────────────────────
            Box(modifier = Modifier.weight(1f)) {
                when (selectedTab) {
                    0 -> {
                        // Live streams grid
                        PullToRefreshBox(
                            isRefreshing = false,
                            onRefresh = { viewModel.startLiveStreamsListener() },
                            state = liveRefreshState,
                            modifier = Modifier.fillMaxSize(),
                        ) {
                            if (visibleLiveStreams.isEmpty()) {
                                LiveEmptyState("No one is live right now")
                            } else {
                                LazyVerticalGrid(
                                    columns = GridCells.Fixed(2),
                                    contentPadding = PaddingValues(12.dp),
                                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                                    verticalArrangement = Arrangement.spacedBy(10.dp),
                                    modifier = Modifier.fillMaxSize(),
                                ) {
                                    items(visibleLiveStreams, key = { it.id }) { stream ->
                                        LiveStreamCard(stream = stream, onClick = { onJoinLive(stream.id) })
                                    }
                                }
                            }
                        }
                    }
                    1 -> {
                        // Party rooms list
                        PullToRefreshBox(
                            isRefreshing = false,
                            onRefresh = { viewModel.startPartyRoomsListener() },
                            state = partyRefreshState,
                            modifier = Modifier.fillMaxSize(),
                        ) {
                            if (visiblePartyRooms.isEmpty()) {
                                LiveEmptyState("No party rooms active")
                            } else {
                                LazyColumn(
                                    contentPadding = PaddingValues(12.dp),
                                    verticalArrangement = Arrangement.spacedBy(10.dp),
                                    modifier = Modifier.fillMaxSize(),
                                ) {
                                    items(visiblePartyRooms, key = { it.id }) { room ->
                                        PartyRoomCard(room = room, onClick = { onJoinParty(room.id) })
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // ── Floating Action Button (per tab) ──────────────────────────────────
        Box(
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(20.dp)
                .navigationBarsPadding(),
        ) {
            when (selectedTab) {
                0 -> GoLiveFab(onClick = onGoLive)
                1 -> GoPartyFab(onClick = onGoParty)
            }
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// LIVE STREAM CARD
// ──────────────────────────────────────────────────────────────────────────────

@Composable
fun LiveStreamCard(stream: LiveStream, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(0.72f)
            .clip(RoundedCornerShape(14.dp))
            .clickable(onClick = onClick),
    ) {
        // Thumbnail / host photo
        AsyncImage(
            model = stream.thumbnailUrl?.ifBlank { stream.hostPhotoUrl }?.ifBlank { null },
            contentDescription = stream.hostName,
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize(),
        )

        // Gradient placeholder when no thumbnail
        if (stream.thumbnailUrl.isNullOrBlank() && stream.hostPhotoUrl.isBlank()) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Brush.linearGradient(listOf(BrandPurple, BrandPink))),
            )
        }

        // Bottom gradient scrim
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(90.dp)
                .align(Alignment.BottomCenter)
                .background(
                    Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(0.85f)))
                )
        )

        // Bottom info
        Column(
            modifier = Modifier.align(Alignment.BottomStart).padding(8.dp),
        ) {
            Text(
                stream.hostName,
                style = MaterialTheme.typography.bodySmall,
                fontWeight = FontWeight.SemiBold,
                color = Color.White,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (stream.title.isNotBlank()) {
                Text(
                    stream.title,
                    style = MaterialTheme.typography.labelSmall,
                    color = Color.White.copy(0.7f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }

        // Top badges
        Row(
            modifier = Modifier
                .align(Alignment.TopStart)
                .padding(6.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            // LIVE badge
            Box(
                modifier = Modifier
                    .background(BrandPink, RoundedCornerShape(4.dp))
                    .padding(horizontal = 5.dp, vertical = 2.dp),
            ) {
                Text("LIVE", color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Bold)
            }
            // Category
            if (stream.category.isNotBlank()) {
                Box(
                    modifier = Modifier
                        .background(Color.Black.copy(0.5f), RoundedCornerShape(4.dp))
                        .padding(horizontal = 5.dp, vertical = 2.dp),
                ) {
                    Text(stream.category, color = Color.White, fontSize = 9.sp)
                }
            }
        }

        // Viewer count
        Row(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(6.dp)
                .background(Color.Black.copy(0.5f), RoundedCornerShape(4.dp))
                .padding(horizontal = 5.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Icon(Icons.Default.Person, contentDescription = null, tint = Color.White, modifier = Modifier.size(10.dp))
            Text(
                viewerCountLabel(stream.viewerCount),
                color = Color.White,
                fontSize = 9.sp,
                fontWeight = FontWeight.Medium,
            )
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// PARTY ROOM CARD
// ──────────────────────────────────────────────────────────────────────────────

@Composable
fun PartyRoomCard(room: PartyRoom, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(AppSurface)
            .border(1.dp, OutlineDefault, RoundedCornerShape(14.dp))
            .clickable(onClick = onClick)
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // Owner avatar
        Box(
            modifier = Modifier
                .size(56.dp)
                .clip(RoundedCornerShape(12.dp)),
        ) {
            AsyncImage(
                model = room.ownerPhotoUrl.ifBlank { null },
                contentDescription = room.ownerName,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
            if (room.ownerPhotoUrl.isBlank()) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(Brush.linearGradient(listOf(BrandPurple, BrandPink))),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        room.ownerName.take(1).uppercase(),
                        color = Color.White,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
        }

        Column(modifier = Modifier.weight(1f)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    room.ownerName,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = TextPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                // Consent / Free badge
                val modeLabel = room.mode.ifBlank { "FREE" }
                Box(
                    modifier = Modifier
                        .background(
                            if (modeLabel == "CONSENT") BrandPurple.copy(0.2f) else BrandPink.copy(0.15f),
                            RoundedCornerShape(4.dp),
                        )
                        .padding(horizontal = 5.dp, vertical = 2.dp),
                ) {
                    Text(
                        modeLabel,
                        fontSize = 9.sp,
                        fontWeight = FontWeight.Bold,
                        color = if (modeLabel == "CONSENT") BrandPurple else BrandPink,
                    )
                }
            }

            if (room.title.isNotBlank()) {
                Text(
                    room.title,
                    style = MaterialTheme.typography.bodySmall,
                    color = TextSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            Spacer(Modifier.height(4.dp))

            // Seats and participants
            Row(
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    Icon(Icons.Default.Groups, contentDescription = null, tint = TextMuted, modifier = Modifier.size(14.dp))
                    Text(
                        "${room.participantCount}/${room.maxSeats}",
                        style = MaterialTheme.typography.labelSmall,
                        color = TextMuted,
                    )
                }
                if (room.mode == "CONSENT") {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(3.dp),
                    ) {
                        Icon(Icons.Default.Lock, contentDescription = null, tint = TextMuted, modifier = Modifier.size(12.dp))
                        Text("Consent", style = MaterialTheme.typography.labelSmall, color = TextMuted)
                    }
                }
            }
        }

        // Join arrow
        Icon(
            Icons.Default.MeetingRoom,
            contentDescription = "Join",
            tint = BrandPink,
            modifier = Modifier.size(22.dp),
        )
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// FABs
// ──────────────────────────────────────────────────────────────────────────────

@Composable
private fun GoLiveFab(onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(28.dp))
            .background(Brush.linearGradient(listOf(BrandPink, BrandPurple)))
            .clickable(onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 14.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(Icons.Default.VideoCall, contentDescription = null, tint = Color.White, modifier = Modifier.size(20.dp))
            Text("Go Live", color = Color.White, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun GoPartyFab(onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(28.dp))
            .background(Brush.linearGradient(listOf(BrandPurple, BrandPink)))
            .clickable(onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 14.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(Icons.Default.Groups, contentDescription = null, tint = Color.White, modifier = Modifier.size(20.dp))
            Text("Go Party", color = Color.White, fontWeight = FontWeight.Bold)
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────────────────────────

@Composable
private fun LiveEmptyState(message: String) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(
                Icons.Default.PlayCircleFilled,
                contentDescription = null,
                tint = BrandPink.copy(0.3f),
                modifier = Modifier.size(64.dp),
            )
            Spacer(Modifier.height(16.dp))
            Text(message, style = MaterialTheme.typography.bodyMedium, color = TextMuted)
        }
    }
}

private fun viewerCountLabel(count: Int): String = when {
    count >= 100_000 -> "${count / 100_000}.${(count % 100_000) / 10_000}L"
    count >= 1_000   -> "${count / 1_000}K"
    else             -> count.toString()
}

/**
 * Compact live preview widget used inside a user's profile card.
 * Shows a thumbnail-style frame with viewer count + a tap hint.
 */
@Composable
fun MiniLivePreview(
    stream: LiveStream,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(10.dp))
            .background(Color.Black)
            .clickable(onClick = onClick),
    ) {
        AsyncImage(
            model = stream.thumbnailUrl?.ifBlank { stream.hostPhotoUrl }?.ifBlank { null },
            contentDescription = "Live preview",
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize(),
        )
        // Overlay scrim
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black.copy(0.25f)),
        )
        // LIVE pill
        Row(
            modifier = Modifier
                .align(Alignment.TopStart)
                .padding(6.dp)
                .background(BrandPink, RoundedCornerShape(4.dp))
                .padding(horizontal = 5.dp, vertical = 2.dp),
            horizontalArrangement = Arrangement.spacedBy(3.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(modifier = Modifier.size(5.dp).background(Color.White, CircleShape))
            Text("LIVE", color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Bold)
        }
        // Viewer count
        Row(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(6.dp)
                .background(Color.Black.copy(0.5f), RoundedCornerShape(4.dp))
                .padding(horizontal = 5.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Icon(Icons.Default.Person, contentDescription = null, tint = Color.White, modifier = Modifier.size(9.dp))
            Text(viewerCountLabel(stream.viewerCount), color = Color.White, fontSize = 9.sp)
        }
        // Tap to join
        Box(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 6.dp)
                .background(Color.Black.copy(0.5f), RoundedCornerShape(20.dp))
                .padding(horizontal = 10.dp, vertical = 4.dp),
        ) {
            Text("Tap to join", color = Color.White, fontSize = 10.sp)
        }
    }
}

package com.zipper.app.ui.screens.live

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.outlined.LiveTv
import androidx.compose.material.icons.outlined.People
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import com.zipper.app.R
import com.zipper.app.data.model.LiveRoom
import com.zipper.app.data.model.User
import com.zipper.app.ui.components.*
import com.zipper.app.ui.screens.party.PartyListViewModel
import com.zipper.app.ui.screens.party.PartyRoomsPane
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Size
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import com.zipper.app.util.HostSuspension
import kotlinx.coroutines.launch

/*
 * The Live tab — two top tabs (owner's request, 3 Nov 2026):
 *
 *   Live  · every live stream, with "Go Live"      ([LiveRoomsPane])
 *   Party · every open party room, with "Start Party" ([PartyRoomsPane])
 *
 * Party rooms used to be reached from a banner on Home; they live here now,
 * next to the other "join people in a room" product. Swipe or tap to switch.
 * Who may use each button is unchanged: Go Live is checked by GoLiveViewModel
 * and the liveRooms rules (verified hosts), Start Party by `createPartyRoom`
 * (anyone signed in who is not restricted).
 *
 * Live browse page — Figma "01 Live browse" (45:39).
 *
 *   Category rail: 32h pills, gradient when selected, glass otherwise.
 *   Grid: 2 columns, 8dp gutters, 168×220 room cards — LIVE badge + viewer
 *   chip on top, name / title / gifts · CATEGORY at the bottom.
 *   "Go Live" gradient FAB (56h) bottom-right.
 */

private val categories = listOf("all", "general", "music", "dance", "gaming", "talk")

private const val PAGE_LIVE = 0
private const val PAGE_PARTY = 1

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun LiveBrowseScreen(
    currentUser: User? = null,
    onWatchLive: (String) -> Unit = {},
    onGoLive: () -> Unit = {},
    onOpenPartyRoom: (String) -> Unit = {},
    /** "Become a partner" — where a non-host applies to host. */
    onBecomeHost: () -> Unit = {},
    /** The liveness capture, for a host who has not completed it. */
    onVerifyFace: (gender: String) -> Unit = {},
    viewModel: LiveBrowseViewModel = hiltViewModel(),
    partyViewModel: PartyListViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val partyState by partyViewModel.state.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    val pager = rememberPagerState(initialPage = PAGE_LIVE) { 2 }
    val scope = rememberCoroutineScope()

    Column(Modifier.fillMaxSize().background(c.bgBase).statusBarsPadding()) {
        // App bar: the two top tabs, and what the selected one is showing.
        Row(
            Modifier.fillMaxWidth().height(Size.Bar.top).background(c.bgRaised).padding(horizontal = Space.lg),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.xl),
        ) {
            TopTab("Live", isSelected = pager.currentPage == PAGE_LIVE) {
                scope.launch { pager.animateScrollToPage(PAGE_LIVE) }
            }
            TopTab("Party", isSelected = pager.currentPage == PAGE_PARTY) {
                scope.launch { pager.animateScrollToPage(PAGE_PARTY) }
            }
            Spacer(Modifier.weight(1f))
            if (pager.currentPage == PAGE_LIVE) {
                GlassChip(Icons.Outlined.People, "${compactCount(state.rooms.size.toLong())} live")
            } else {
                // One mode's public rooms (the query is per mode, capped at 60).
                GlassChip(Icons.Outlined.People, "${compactCount(partyState.visibleRooms.size.toLong())} open")
            }
        }
        HairlineDivider()

        HorizontalPager(state = pager, modifier = Modifier.fillMaxSize(), key = { it }) { page ->
            when (page) {
                PAGE_LIVE -> LiveRoomsPane(
                    currentUser = currentUser,
                    onWatchLive = onWatchLive,
                    onGoLive = onGoLive,
                    viewModel = viewModel,
                    onBecomeHost = onBecomeHost,
                    onVerifyFace = onVerifyFace,
                    onStartPartyInstead = { scope.launch { pager.animateScrollToPage(PAGE_PARTY) } },
                )
                else -> PartyRoomsPane(onOpenRoom = onOpenPartyRoom, viewModel = partyViewModel)
            }
        }
    }
}

/** One of the Live tab's two top tabs: title text with a gradient underline when selected. */
@Composable
private fun TopTab(label: String, isSelected: Boolean, onClick: () -> Unit) {
    val c = ZipperTheme.colors
    Column(
        Modifier.fillMaxHeight()
            .semantics { role = Role.Tab; selected = isSelected }
            .clickableNoRipple(onClick),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        // One style for both states — only the colour and the underline move, so
        // switching tabs does not nudge the other tab sideways.
        Text(label, style = ZipperTheme.type.headingS, color = if (isSelected) c.textPrimary else c.textMuted)
        Spacer(Modifier.height(4.dp))
        Box(
            Modifier.size(width = 20.dp, height = 3.dp)
                .background(
                    if (isSelected) Brush.horizontalGradient(listOf(c.brandGradientFrom, c.brandGradientTo))
                    else SolidColor(Color.Transparent),
                    CircleShape,
                ),
        )
    }
}

/**
 * Why this account cannot go live yet, decided BEFORE the Go Live screen opens.
 *
 * GoLiveViewModel.startLive makes the same three checks (and the liveRooms rules
 * make them binding), but only after the camera and microphone have been asked
 * for and the set-up sheet filled in — so a regular user who tapped "Go Live"
 * granted two permissions, typed a title and only then read "Going live is for
 * hosts" in a snackbar (QA, 3 Nov 2026). Saying it on the tap, with the next step
 * as a button, costs one dialog.
 */
private sealed interface GoLiveGate {
    data object NotHost : GoLiveGate
    data class Suspended(val message: String) : GoLiveGate
    data class NotVerified(val gender: String) : GoLiveGate
}

private fun goLiveGateFor(user: User?): GoLiveGate? {
    if (user == null) return null   // still loading: let GoLiveViewModel decide
    if (!user.isHost) return GoLiveGate.NotHost
    HostSuspension.messageFor(user.isHost, user.hostSuspended, user.hostSuspendedUntil, user.hostSuspendedReason)
        ?.let { return GoLiveGate.Suspended(it) }
    if (!user.isVerifiedHost) return GoLiveGate.NotVerified(user.gender)
    return null
}

/** The Live page: category rail, the grid of live rooms and the "Go Live" button. */
@Composable
fun LiveRoomsPane(
    currentUser: User?,
    onWatchLive: (String) -> Unit,
    onGoLive: () -> Unit,
    viewModel: LiveBrowseViewModel,
    onBecomeHost: () -> Unit = {},
    onVerifyFace: (gender: String) -> Unit = {},
    onStartPartyInstead: () -> Unit = {},
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors

    val rooms = if (state.selectedCategory == "all") state.rooms
    else state.rooms.filter { it.category.equals(state.selectedCategory, ignoreCase = true) }
    val me = currentUser ?: state.currentUser
    val showGoLiveButton = me != null
    var gate by remember { mutableStateOf<GoLiveGate?>(null) }
    val tryGoLive: () -> Unit = {
        val g = goLiveGateFor(me)
        if (g == null) onGoLive() else gate = g
    }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            // Category rail
            LazyRow(
                contentPadding = PaddingValues(horizontal = Space.md, vertical = Space.sm),
                horizontalArrangement = Arrangement.spacedBy(Space.sm),
            ) {
                items(categories) { cat ->
                    val on = state.selectedCategory == cat
                    Box(
                        Modifier.height(32.dp)
                            .then(
                                if (on) Modifier.background(Brush.horizontalGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), CircleShape)
                                else Modifier.background(c.glassLow, CircleShape).border(1.dp, c.borderDefault, CircleShape)
                            )
                            .clickableNoRipple { viewModel.selectCategory(cat) }
                            .padding(horizontal = Space.lg),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(cat.replaceFirstChar { it.uppercase() }, style = ZipperTheme.type.labelS, color = if (on) Color.White else c.textSecondary)
                    }
                }
            }

            when {
                state.isLoading -> LoadingState()
                rooms.isEmpty() -> EmptyState(
                    Icons.Outlined.LiveTv,
                    if (state.selectedCategory == "all") "No one is live right now" else "Nothing in ${state.selectedCategory} right now",
                    "Be the first — go live and people will find you here.",
                    // The floating "Go Live" is already on screen; a second,
                    // identical button in the middle only competes with it.
                    actionLabel = if (showGoLiveButton) null else "Go Live",
                    onAction = if (showGoLiveButton) null else tryGoLive,
                )
                else -> LazyVerticalGrid(
                    columns = GridCells.Fixed(2),
                    contentPadding = PaddingValues(start = Space.sm, end = Space.sm, top = Space.sm, bottom = 96.dp),
                    horizontalArrangement = Arrangement.spacedBy(Space.sm),
                    verticalArrangement = Arrangement.spacedBy(Space.sm),
                    modifier = Modifier.fillMaxSize(),
                ) {
                    items(rooms, key = { it.roomId }) { room -> LiveRoomCard(room) { onWatchLive(room.roomId) } }
                }
            }
        }

        // Go Live FAB
        if (showGoLiveButton) {
            Row(
                Modifier.align(Alignment.BottomEnd).navigationBarsPadding().padding(end = Space.lg, bottom = Space.xxl)
                    .height(56.dp)
                    .background(Brush.horizontalGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), CircleShape)
                    .clickableNoRipple(tryGoLive)
                    .padding(start = 20.dp, end = 24.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm),
            ) {
                Icon(Icons.Default.Videocam, null, tint = Color.White, modifier = Modifier.size(20.dp))
                Text("Go Live", style = ZipperTheme.type.labelL, color = Color.White)
            }
        }
    }

    gate?.let { g ->
        val dismiss = { gate = null }
        val (title, body) = when (g) {
            GoLiveGate.NotHost -> "Going live is for hosts" to
                "Apply as a host from \"Become a partner\" — you will need an agency's referral code. " +
                "Anyone can start a party room right now, no application needed."
            is GoLiveGate.Suspended -> "Your host role is paused" to g.message
            is GoLiveGate.NotVerified -> "One step left: face verification" to
                "Hosts verify their face once before their first live. It takes about a minute."
        }
        AlertDialog(
            onDismissRequest = dismiss,
            containerColor = c.bgElevated,
            title = { Text(title, style = ZipperTheme.type.headingS, color = c.textPrimary) },
            text = { Text(body, style = ZipperTheme.type.bodyM, color = c.textSecondary) },
            confirmButton = {
                when (g) {
                    GoLiveGate.NotHost -> TextButton({ dismiss(); onBecomeHost() }) {
                        Text("Become a host", color = c.textBrand)
                    }
                    is GoLiveGate.NotVerified -> TextButton({ dismiss(); onVerifyFace(g.gender) }) {
                        Text("Verify now", color = c.textBrand)
                    }
                    is GoLiveGate.Suspended -> TextButton(dismiss) { Text("OK", color = c.textBrand) }
                }
            },
            dismissButton = {
                if (g == GoLiveGate.NotHost) {
                    TextButton({ dismiss(); onStartPartyInstead() }) {
                        Text("Start a party", color = c.textSecondary)
                    }
                } else if (g !is GoLiveGate.Suspended) {
                    TextButton(dismiss) { Text("Not now", color = c.textSecondary) }
                }
            },
        )
    }
}

@Composable
fun LiveRoomCard(room: LiveRoom, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val c = ZipperTheme.colors
    Box(
        modifier.aspectRatio(168f / 220f).clip(RoundedCornerShape(Radius.lg))
            .background(placeholderBrush(room.hostUid)).clickableNoRipple(onClick),
    ) {
        if (room.hostPhotoUrl.isNotBlank()) {
            AsyncImage(room.hostPhotoUrl, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        } else {
            Text(room.hostName.take(1).uppercase(), style = ZipperTheme.type.displayXl, color = Color.White.copy(0.16f), modifier = Modifier.align(Alignment.Center))
        }
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0f to Color.Transparent, 0.5f to Color(0x59070812), 1f to Color(0xE5070812))))

        Row(Modifier.fillMaxWidth().padding(8.dp).align(Alignment.TopStart), horizontalArrangement = Arrangement.SpaceBetween) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                LiveBadge(LiveBadgeKind.Live)
                if (room.pkActive) Chip("PK", tint = c.tintVioletSubtle, contentColor = c.brandSecondary)
            }
            GlassChip(Icons.Outlined.Visibility, compactCount(room.viewerCount.toLong()))
        }

        Column(Modifier.fillMaxWidth().padding(8.dp).align(Alignment.BottomStart), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(room.hostName, style = ZipperTheme.type.labelM, color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (room.title.isNotBlank()) Text(room.title, style = ZipperTheme.type.caption, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(Modifier.fillMaxWidth().padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Icon(painterResource(R.drawable.ic_gift), null, tint = c.brandVip, modifier = Modifier.size(14.dp))
                Text(compactCount(room.totalGiftsReceived), style = ZipperTheme.type.overline, color = c.brandVip)
                Spacer(Modifier.weight(1f))
                Text(room.category.uppercase(), style = ZipperTheme.type.overline, color = c.textMuted)
            }
        }
    }
}

/** 18h glass chip with a 14dp icon — viewer counts, "128 live". */
@Composable
fun GlassChip(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String, modifier: Modifier = Modifier) {
    val c = ZipperTheme.colors
    Row(
        modifier.height(18.dp).background(c.scrimMedium, CircleShape).border(1.dp, c.glassMid, CircleShape).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(icon, null, tint = c.textPrimary, modifier = Modifier.size(14.dp))
        Text(text, style = ZipperTheme.type.caption, color = c.textPrimary, maxLines = 1)
    }
}

package com.zipper.app.ui.screens.live

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
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
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import com.zipper.app.R
import com.zipper.app.data.model.LiveRoom
import com.zipper.app.data.model.User
import com.zipper.app.ui.components.*
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Size
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme

/*
 * Live browse — Figma "01 Live browse" (45:39).
 *
 *   App bar 56: "Live" heading + LIVE badge, "128 live" chip on the right.
 *   Category rail: 32h pills, gradient when selected, glass otherwise.
 *   Grid: 2 columns, 8dp gutters, 168×220 room cards — LIVE badge + viewer
 *   chip on top, name / title / gifts · CATEGORY at the bottom.
 *   "Go Live" gradient FAB (56h) bottom-right.
 */

private val categories = listOf("all", "general", "music", "dance", "gaming", "talk")

@Composable
fun LiveBrowseScreen(
    currentUser: User? = null,
    onWatchLive: (String) -> Unit = {},
    onGoLive: () -> Unit = {},
    viewModel: LiveBrowseViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors

    val rooms = if (state.selectedCategory == "all") state.rooms
    else state.rooms.filter { it.category.equals(state.selectedCategory, ignoreCase = true) }

    Box(Modifier.fillMaxSize().background(c.bgBase)) {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            // App bar
            Row(
                Modifier.fillMaxWidth().height(Size.Bar.top).background(c.bgRaised).padding(horizontal = Space.lg),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm),
            ) {
                Text("Live", style = ZipperTheme.type.headingS, color = c.textPrimary)
                LiveBadge(LiveBadgeKind.Live)
                Spacer(Modifier.weight(1f))
                GlassChip(Icons.Outlined.People, "${compactCount(state.rooms.size.toLong())} live")
            }
            HairlineDivider()

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
                    actionLabel = "Go Live", onAction = onGoLive,
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
        if (currentUser != null || state.currentUser != null) {
            Row(
                Modifier.align(Alignment.BottomEnd).navigationBarsPadding().padding(end = Space.lg, bottom = Space.xxl)
                    .height(56.dp)
                    .background(Brush.horizontalGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), CircleShape)
                    .clickableNoRipple(onGoLive)
                    .padding(start = 20.dp, end = 24.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm),
            ) {
                Icon(Icons.Default.Videocam, null, tint = Color.White, modifier = Modifier.size(20.dp))
                Text("Go Live", style = ZipperTheme.type.labelL, color = Color.White)
            }
        }
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

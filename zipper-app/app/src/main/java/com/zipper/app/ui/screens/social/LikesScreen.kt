package com.zipper.app.ui.screens.social

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.outlined.FavoriteBorder
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.zipper.app.data.model.LikeEntry
import com.zipper.app.data.repository.ProfileRepository
import com.zipper.app.ui.components.*
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
import javax.inject.Inject

// ── ViewModel ─────────────────────────────────────────────────────────────────

@HiltViewModel
class LikesViewModel @Inject constructor(
    repo: ProfileRepository,
) : ViewModel() {
    val iLike = repo.iLikeFlow()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    val likedMe = repo.likedByFlow()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
}

// ── Screen ────────────────────────────────────────────────────────────────────

/*
 * Likes — Figma "03 Likes" (42:189).
 *
 *   TopBar "Likes". Two full-width tabs "I Like (n)" / "Liked Me (n)" with a
 *   2dp brand underline under the active one. Rows are 80h glass cards:
 *   56 avatar (online ring), name Semi Bold 16, "City • Gender" caption,
 *   LevelChip, chevron.
 */
@Composable
fun LikesScreen(
    initialTab: Int = 0,
    onBack: () -> Unit = {},
    onViewProfile: (String) -> Unit = {},
    viewModel: LikesViewModel = hiltViewModel(),
) {
    var selectedTab by remember { mutableIntStateOf(initialTab) }
    val iLike by viewModel.iLike.collectAsStateWithLifecycle()
    val likedMe by viewModel.likedMe.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors

    ZipperScreen(topBar = { TopBar("Likes", onBack = onBack) }) { _ ->
        Column(Modifier.fillMaxSize()) {
            Row(Modifier.fillMaxWidth().height(44.dp)) {
                listOf("I Like (${iLike.size})", "Liked Me (${likedMe.size})").forEachIndexed { i, t ->
                    val on = selectedTab == i
                    Box(Modifier.weight(1f).fillMaxHeight().clickableNoRipple { selectedTab = i }, contentAlignment = Alignment.Center) {
                        Text(t, style = ZipperTheme.type.labelM, color = if (on) c.textPrimary else c.textMuted)
                        Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(2.dp).background(if (on) c.brandPrimary else Color.Transparent))
                    }
                }
            }
            HairlineDivider()

            val currentList = if (selectedTab == 0) iLike else likedMe
            if (currentList.isEmpty()) {
                if (selectedTab == 0) EmptyState(Icons.Outlined.FavoriteBorder, "You haven't liked anyone yet", "Tap the heart on a profile you enjoy and they'll show up here.")
                else EmptyState(Icons.Outlined.FavoriteBorder, "No likes yet", "Complete your profile and go live to get noticed.")
                return@Column
            }
            LazyColumn(contentPadding = PaddingValues(horizontal = Space.lg, vertical = Space.md), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                items(currentList, key = { it.uid }) { entry -> LikeEntryRow(entry) { onViewProfile(entry.uid) } }
                item { Spacer(Modifier.navigationBarsPadding()) }
            }
        }
    }
}

// ── Like Entry Row ─────────────────────────────────────────────────────────────

@Composable
private fun LikeEntryRow(entry: LikeEntry, onClick: () -> Unit) {
    val c = ZipperTheme.colors
    Row(
        Modifier.fillMaxWidth().height(80.dp)
            .background(Brush.verticalGradient(listOf(Color(0x12FFFFFF), Color(0x05FFFFFF))), RoundedCornerShape(Radius.lg))
            .border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.lg))
            .clickableNoRipple(onClick)
            .padding(horizontal = Space.md),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Avatar(entry.photoUrl, size = AvatarSize.LG, ring = if (entry.isOnline) AvatarRing.Online else AvatarRing.None, initial = entry.name)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(entry.name.ifBlank { "User" }, style = ZipperTheme.type.labelL, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val meta = listOf(entry.city, entry.gender.replaceFirstChar { it.uppercase() }).filter { it.isNotBlank() }.joinToString(" • ")
            if (meta.isNotBlank()) Text(meta, style = ZipperTheme.type.caption, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (entry.level > 0) LevelChip(entry.level)
        }
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = c.textMuted, modifier = Modifier.size(22.dp))
    }
}

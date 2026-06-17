package com.zipper.datingapp.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.FavoriteBorder
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.foundation.selection.selectable
import coil.compose.SubcomposeAsyncImage
import coil.request.ImageRequest
import com.zipper.datingapp.data.UserProfile
import com.zipper.datingapp.economy.VirtualEconomyMath
import com.zipper.datingapp.ui.DatingUiState
import com.zipper.datingapp.ui.DatingViewModel
import com.zipper.datingapp.ui.components.GiftSelectionSheet
import com.zipper.datingapp.ui.components.VerifiedBadge
import com.zipper.datingapp.ui.theme.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UserProfileScreen(
    profile: UserProfile,
    uiState: DatingUiState,
    viewModel: DatingViewModel,
    onBack: () -> Unit,
    onStartChat: () -> Unit,
    onStartCall: (isVideo: Boolean) -> Unit,
    onJoinLive: () -> Unit = {},
) {
    BackHandler(onBack = onBack)

    val ctx = LocalContext.current

    val isLiked by remember(uiState.iLikedProfiles, profile.id) {
        mutableStateOf(uiState.iLikedProfiles.any { it.id == profile.id })
    }
    var localLiked by remember(isLiked) { mutableStateOf(isLiked) }
    var showGiftSheet   by remember { mutableStateOf(false) }
    var showReportSheet by remember { mutableStateOf(false) }
    var reportReason    by remember { mutableStateOf("") }

    val level = remember(profile.totalDiamondsSpent) {
        VirtualEconomyMath.userLevelFromDiamondsSpent(profile.totalDiamondsSpent)
    }

    val allMedia = (profile.galleryPhotos + profile.galleryUrls)
        .distinct().filter { it.isNotBlank() }
    val coverUrl = allMedia.firstOrNull().orEmpty()

    var showGallery     by remember { mutableStateOf(false) }
    var galleryStartIdx by remember { mutableIntStateOf(0) }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
        contentPadding = PaddingValues(bottom = 48.dp)
    ) {

        // ── HERO ─────────────────────────────────────────────────────────────
        item {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(320.dp)
            ) {
                // Cover photo or gradient fallback
                if (coverUrl.isNotBlank()) {
                    SubcomposeAsyncImage(
                        model = ImageRequest.Builder(ctx).data(coverUrl).crossfade(400).build(),
                        contentDescription = null,
                        modifier = Modifier.fillMaxSize(),
                        contentScale = ContentScale.Crop,
                        loading = { ShimmerBox(Modifier.fillMaxSize()) }
                    )
                } else {
                    Box(
                        modifier = Modifier.fillMaxSize().background(
                            Brush.linearGradient(
                                listOf(Color(0xFF1A0533), Color(0xFF6A1B9A), Color(0xFFE91E63))
                            )
                        )
                    )
                }

                // Dark gradient scrim (same as MyProfileScreen)
                Box(
                    modifier = Modifier.fillMaxSize().background(
                        Brush.verticalGradient(
                            0f   to Color.Black.copy(alpha = 0.10f),
                            0.5f to Color.Black.copy(alpha = 0.25f),
                            1f   to Color.Black.copy(alpha = 0.75f)
                        )
                    )
                )

                // Back button top-left
                IconButton(
                    onClick = onBack,
                    modifier = Modifier
                        .align(Alignment.TopStart)
                        .statusBarsPadding()
                        .padding(8.dp)
                        .background(Color.Black.copy(alpha = 0.35f), CircleShape)
                ) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Color.White)
                }

                // Top-right: LIVE badge (if live) + 3-dot menu (always shown)
                Column(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .statusBarsPadding()
                        .padding(8.dp),
                    horizontalAlignment = Alignment.End,
                    verticalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    if (profile.isLive) {
                        Surface(
                            shape = RoundedCornerShape(6.dp),
                            color = Color(0xFFE91E63)
                        ) {
                            Row(
                                modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(4.dp)
                            ) {
                                Box(Modifier.size(6.dp).background(Color.White, CircleShape))
                                Text("LIVE", color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                            }
                        }
                    }
                    var menuExpanded by remember { mutableStateOf(false) }
                    Box {
                        IconButton(
                            onClick = { menuExpanded = true },
                            modifier = Modifier.background(Color.Black.copy(alpha = 0.35f), CircleShape)
                        ) {
                            Icon(Icons.Default.MoreVert, "More", tint = Color.White)
                        }
                        DropdownMenu(
                            expanded = menuExpanded,
                            onDismissRequest = { menuExpanded = false }
                        ) {
                            DropdownMenuItem(
                                text = { Text("Block user") },
                                leadingIcon = { Icon(Icons.Default.Block, null) },
                                onClick = {
                                    menuExpanded = false
                                    viewModel.blockUserFromProfile(profile.id)
                                }
                            )
                            DropdownMenuItem(
                                text = { Text("Report user", color = MaterialTheme.colorScheme.error) },
                                leadingIcon = { Icon(Icons.Default.Flag, null, tint = MaterialTheme.colorScheme.error) },
                                onClick = {
                                    menuExpanded = false
                                    showReportSheet = true
                                }
                            )
                        }
                    }
                }

                // Avatar + name/id/pills at bottom of hero
                Row(
                    modifier = Modifier
                        .align(Alignment.BottomStart)
                        .padding(start = 20.dp, bottom = 20.dp),
                    verticalAlignment = Alignment.Bottom
                ) {
                    // Avatar with rainbow glow border (same as MyProfileScreen)
                    Box(
                        modifier = Modifier
                            .size(90.dp)
                            .shadow(12.dp, CircleShape)
                            .border(
                                3.dp,
                                Brush.sweepGradient(listOf(BrandPink, BrandPurple, GoldAccent, BrandPink)),
                                CircleShape
                            )
                            .clip(CircleShape),
                        contentAlignment = Alignment.Center
                    ) {
                        if (profile.photoUrl.isNotBlank()) {
                            SubcomposeAsyncImage(
                                model = ImageRequest.Builder(ctx)
                                    .data(profile.photoUrl).crossfade(300).build(),
                                contentDescription = null,
                                modifier = Modifier.fillMaxSize(),
                                contentScale = ContentScale.Crop,
                                loading = { ShimmerBox(Modifier.fillMaxSize()) }
                            )
                        } else {
                            Box(
                                modifier = Modifier.fillMaxSize().background(
                                    Brush.linearGradient(listOf(BrandPurple, BrandPink))
                                ),
                                contentAlignment = Alignment.Center
                            ) {
                                Text(
                                    profile.name.take(1).uppercase(),
                                    fontSize = 32.sp, fontWeight = FontWeight.Bold, color = Color.White
                                )
                            }
                        }
                        // Online dot
                        if (profile.isOnline) {
                            Box(
                                modifier = Modifier
                                    .size(14.dp)
                                    .align(Alignment.BottomEnd)
                                    .border(2.dp, Color.Black, CircleShape)
                                    .clip(CircleShape)
                                    .background(Color(0xFF4CAF50))
                            )
                        }
                    }

                    Spacer(Modifier.width(14.dp))

                    Column(modifier = Modifier.padding(bottom = 4.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                profile.name,
                                color = Color.White,
                                fontWeight = FontWeight.Bold,
                                fontSize = 20.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                            if (profile.hasBlueTick) {
                                Spacer(Modifier.width(6.dp))
                                VerifiedBadge(showLabel = false, size = 18.dp)
                            }
                            // Level badge directly beside name
                            if (level > 0) {
                                Spacer(Modifier.width(6.dp))
                                UpsLevelPill(level)
                            }
                        }
                        if (profile.profileNumber.isNotBlank()) {
                            Text(
                                "ID: ${profile.profileNumber}",
                                color = Color.White.copy(alpha = 0.7f),
                                fontSize = 12.sp
                            )
                        }
                        Spacer(Modifier.height(4.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            val genderIcon = when (profile.genderText.lowercase()) {
                                "female"      -> Icons.Default.Female
                                "male"        -> Icons.Default.Male
                                "transgender" -> Icons.Default.Transgender
                                else          -> Icons.Default.Person
                            }
                            UpsHeroPill(
                                icon = genderIcon,
                                text = profile.genderText.replaceFirstChar { it.uppercaseChar() }
                            )
                            if (profile.age > 0) {
                                UpsHeroPill(icon = Icons.Default.Cake, text = "${profile.age}")
                            }
                            if (profile.city.isNotBlank()) {
                                UpsHeroPill(icon = Icons.Default.LocationOn, text = profile.city)
                            }
                        }
                    }
                }
            }
        }

        // ── WATCH LIVE CTA (shown only when profile.isLive) ─────────────────
        if (profile.isLive) {
            item {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 20.dp, vertical = 12.dp)
                        .clip(RoundedCornerShape(14.dp))
                        .background(
                            Brush.linearGradient(listOf(Color(0xFFE91E63), Color(0xFF9C27B0)))
                        )
                        .clickable { onJoinLive() }
                        .padding(vertical = 14.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Box(Modifier.size(8.dp).background(Color.White, CircleShape))
                        Text(
                            "Watch Live Stream",
                            color = Color.White,
                            fontWeight = FontWeight.Bold,
                            fontSize = 15.sp
                        )
                    }
                }
            }
        }

        // ── ACTION ROW: Like · Video · Message · Gift ────────────────────────
        item {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 16.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically
            ) {
                // Like / Unlike
                UpsActionButton(
                    icon = if (localLiked) Icons.Default.Favorite else Icons.Outlined.FavoriteBorder,
                    label = if (localLiked) "Unlike" else "Like",
                    tint = if (localLiked) BrandPink else MaterialTheme.colorScheme.onSurface,
                    background = if (localLiked) BrandPink.copy(alpha = 0.15f)
                                 else MaterialTheme.colorScheme.surfaceVariant,
                    enabled = true,
                    size = 50.dp,
                    onClick = {
                        localLiked = !localLiked
                        viewModel.likeProfile(profile)
                    }
                )

                // Video Call — active only when person is online
                UpsActionButton(
                    icon = Icons.Default.Videocam,
                    label = "Video",
                    tint = if (profile.isOnline) MaterialTheme.colorScheme.onSurface
                           else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.35f),
                    background = if (profile.isOnline) MaterialTheme.colorScheme.surfaceVariant
                                 else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
                    enabled = profile.isOnline,
                    size = 50.dp,
                    onClick = { onStartCall(true) }
                )

                // Message
                UpsActionButton(
                    icon = Icons.Default.Message,
                    label = "Message",
                    tint = MaterialTheme.colorScheme.onSurface,
                    background = MaterialTheme.colorScheme.surfaceVariant,
                    enabled = true,
                    size = 50.dp,
                    onClick = onStartChat
                )

                // Gift
                UpsActionButton(
                    icon = Icons.Default.CardGiftcard,
                    label = "Gift",
                    tint = GoldAccent,
                    background = GoldAccent.copy(alpha = 0.15f),
                    enabled = true,
                    size = 50.dp,
                    onClick = { showGiftSheet = true }
                )
            }
        }

        // ── BIO ───────────────────────────────────────────────────────────────
        if (profile.bio.isNotBlank()) {
            item {
                PremiumSection(icon = Icons.Default.FormatQuote, title = "About") {
                    Text(
                        '"' + profile.bio + '"',
                        fontSize = 14.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.85f),
                        lineHeight = 22.sp,
                        fontStyle = FontStyle.Italic
                    )
                }
            }
        }

        // ── PERSONAL INFO ─────────────────────────────────────────────────────
        item {
            PremiumSection(icon = Icons.Default.Person, title = "Personal Info") {
                Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    UpsInfoLine(Icons.Default.Badge, "Name", profile.name.ifBlank { "—" })
                    if (profile.age > 0) UpsInfoLine(Icons.Default.Cake, "Age", "${profile.age} years old")
                    val genderIcon = when (profile.genderText.lowercase()) {
                        "female" -> Icons.Default.Female; "male" -> Icons.Default.Male
                        "transgender" -> Icons.Default.Transgender; else -> Icons.Default.Person
                    }
                    if (profile.genderText.isNotBlank()) {
                        UpsInfoLine(genderIcon, "Gender", profile.genderText.replaceFirstChar { it.uppercaseChar() })
                    }
                    if (profile.city.isNotBlank()) UpsInfoLine(Icons.Default.LocationOn, "City", profile.city)
                    if (profile.totalLiveMinutes > 0) {
                        UpsInfoLine(
                            Icons.Default.Timer, "Streamed",
                            "${profile.totalLiveMinutes / 60}h ${profile.totalLiveMinutes % 60}m"
                        )
                    }
                }
            }
        }

        // ── MEDIA GRID (3×3, max 9) — no private info ─────────────────────────
        if (allMedia.isNotEmpty()) {
            item {
                PremiumSection(
                    icon = Icons.Default.PhotoLibrary,
                    title = "Photos  •  ${minOf(allMedia.size, 9)}"
                ) {
                    val preview = allMedia.take(9)
                    val cols = 3
                    val rows = (preview.size + cols - 1) / cols
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        repeat(rows) { row ->
                            Row(
                                horizontalArrangement = Arrangement.spacedBy(4.dp),
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                repeat(cols) { col ->
                                    val idx = row * cols + col
                                    if (idx < preview.size) {
                                        Box(
                                            modifier = Modifier
                                                .weight(1f)
                                                .aspectRatio(1f)
                                                .clip(RoundedCornerShape(8.dp))
                                                .clickable {
                                                    galleryStartIdx = idx
                                                    showGallery = true
                                                }
                                        ) {
                                            SubcomposeAsyncImage(
                                                model = ImageRequest.Builder(ctx)
                                                    .data(preview[idx]).crossfade(300).build(),
                                                contentDescription = null,
                                                modifier = Modifier.fillMaxSize(),
                                                contentScale = ContentScale.Crop,
                                                loading = { ShimmerBox(Modifier.fillMaxSize()) }
                                            )
                                        }
                                    } else {
                                        Spacer(Modifier.weight(1f))
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // ── INTERESTS / HOBBIES ───────────────────────────────────────────────
        val tags = (profile.hobbies + profile.interests)
            .distinct().filter { it.isNotBlank() }
        if (tags.isNotEmpty()) {
            item {
                UpsTagSection(
                    icon = Icons.Default.Interests,
                    title = "Hobbies & Interests",
                    tags = tags,
                    chipColor = BrandPurple
                )
            }
        }

        // ── LIKES ─────────────────────────────────────────────────────────────
        if (profile.likes.isNotEmpty()) {
            item {
                UpsTagSection(
                    icon = Icons.Default.Favorite,
                    title = "Likes",
                    tags = profile.likes,
                    chipColor = BrandPink
                )
            }
        }

        // ── DISLIKES ──────────────────────────────────────────────────────────
        if (profile.dislikes.isNotEmpty()) {
            item {
                UpsTagSection(
                    icon = Icons.Default.HeartBroken,
                    title = "Dislikes",
                    tags = profile.dislikes,
                    chipColor = Color(0xFF757575)
                )
            }
        }

        // ── LANGUAGES ─────────────────────────────────────────────────────────
        if (profile.languages.isNotEmpty()) {
            item {
                UpsTagSection(
                    icon = Icons.Default.Language,
                    title = "Languages",
                    tags = profile.languages,
                    chipColor = GoldAccent
                )
            }
        }

    }

    // ── GIFT SHEET ────────────────────────────────────────────────────────────
    if (showGiftSheet) {
        GiftSelectionSheet(
            gifts = uiState.availableGifts,
            coinBalance = uiState.coinBalance,
            luckyGiftReceiverId = profile.id,
            onTopUpCoins = { showGiftSheet = false },
            onDismiss = { showGiftSheet = false },
            onSend = { gift, count ->
                viewModel.sendPrivateGiftToUser(profile.id, gift, count)
                showGiftSheet = false
            }
        )
    }

    // ── GALLERY LIGHTBOX ──────────────────────────────────────────────────────
    if (showGallery && allMedia.isNotEmpty()) {
        UpsGalleryViewer(
            urls = allMedia,
            startIndex = galleryStartIdx,
            onDismiss = { showGallery = false }
        )
    }

    // ── REPORT DIALOG ─────────────────────────────────────────────────────────
    if (showReportSheet) {
        val reasons = listOf("Fake profile", "Inappropriate content", "Spam", "Harassment", "Underage", "Other")
        AlertDialog(
            onDismissRequest = { showReportSheet = false },
            title = { Text("Report User") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Select a reason:", color = TextSecondary, fontSize = 13.sp)
                    Spacer(Modifier.height(4.dp))
                    reasons.forEach { reason ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { reportReason = reason }
                                .padding(vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            RadioButton(
                                selected = reportReason == reason,
                                onClick = { reportReason = reason }
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(reason, fontSize = 14.sp)
                        }
                    }
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        if (reportReason.isNotBlank()) {
                            viewModel.reportUserFromProfile(profile.id, reportReason)
                            showReportSheet = false
                            reportReason = ""
                        }
                    },
                    enabled = reportReason.isNotBlank(),
                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)
                ) { Text("Submit Report") }
            },
            dismissButton = {
                TextButton(onClick = { showReportSheet = false; reportReason = "" }) { Text("Cancel") }
            }
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers — mirror MyProfileScreen design tokens exactly
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun UpsLevelPill(level: Int) {
    val colors = when {
        level >= 10 -> listOf(Color(0xFFFFD700), Color(0xFFFF6B00))
        level >= 7  -> listOf(Color(0xFFE040FB), Color(0xFF7C4DFF))
        level >= 5  -> listOf(Color(0xFFFF2D78), Color(0xFF7B2FBE))
        level >= 3  -> listOf(Color(0xFF40C4FF), Color(0xFF00B0FF))
        else        -> listOf(Color(0xFF69F0AE), Color(0xFF00E676))
    }
    Box(
        modifier = Modifier
            .background(
                Brush.linearGradient(colors),
                RoundedCornerShape(6.dp)
            )
            .padding(horizontal = 6.dp, vertical = 2.dp)
    ) {
        Text("Lv.$level", color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.Bold)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun UpsTagSection(
    icon: ImageVector,
    title: String,
    tags: List<String>,
    chipColor: Color,
) {
    PremiumSection(icon = icon, title = title) {
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            tags.forEach { tag ->
                Surface(
                    shape = RoundedCornerShape(20.dp),
                    color = chipColor.copy(alpha = 0.12f),
                    border = BorderStroke(1.dp, chipColor.copy(alpha = 0.35f))
                ) {
                    Text(
                        tag,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 5.dp),
                        fontSize = 12.sp,
                        color = chipColor
                    )
                }
            }
        }
    }
}

@Composable
private fun UpsHeroPill(icon: ImageVector, text: String) {
    Surface(
        shape = RoundedCornerShape(20.dp),
        color = Color.White.copy(alpha = 0.20f)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(3.dp)
        ) {
            Icon(icon, null, tint = Color.White, modifier = Modifier.size(12.dp))
            Text(text, color = Color.White, fontSize = 11.sp, maxLines = 1)
        }
    }
}

@Composable
private fun UpsInfoLine(icon: ImageVector, label: String, value: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = TextSecondary, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(12.dp))
        Text(label, fontSize = 12.sp, color = TextSecondary, modifier = Modifier.width(90.dp))
        Text(value, fontSize = 14.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f), maxLines = 2)
    }
}

@Composable
private fun UpsActionButton(
    icon: ImageVector,
    label: String,
    tint: Color,
    background: Color,
    enabled: Boolean,
    onClick: () -> Unit,
    size: Dp = 56.dp
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier
            .clickable(enabled = enabled, onClick = onClick)
    ) {
        Box(
            modifier = Modifier
                .size(size)
                .background(background, CircleShape),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                icon,
                contentDescription = label,
                tint = tint,
                modifier = Modifier.size(26.dp)
            )
        }
        Spacer(Modifier.height(5.dp))
        Text(
            label,
            fontSize = 11.sp,
            color = if (enabled)
                MaterialTheme.colorScheme.onSurface.copy(alpha = 0.75f)
            else
                MaterialTheme.colorScheme.onSurface.copy(alpha = 0.30f)
        )
    }
}

@Composable
private fun UpsGalleryViewer(
    urls: List<String>,
    startIndex: Int,
    onDismiss: () -> Unit
) {
    BackHandler(onBack = onDismiss)
    val ctx = LocalContext.current
    var current by remember { mutableIntStateOf(startIndex) }
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black)
                .clickable { onDismiss() },
            contentAlignment = Alignment.Center
        ) {
            SubcomposeAsyncImage(
                model = ImageRequest.Builder(ctx).data(urls[current]).crossfade(300).build(),
                contentDescription = null,
                modifier = Modifier.fillMaxWidth(),
                contentScale = ContentScale.Fit
            )
            if (current > 0) {
                IconButton(
                    onClick = { current-- },
                    modifier = Modifier.align(Alignment.CenterStart).padding(8.dp)
                ) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, "Previous", tint = Color.White)
                }
            }
            if (current < urls.lastIndex) {
                IconButton(
                    onClick = { current++ },
                    modifier = Modifier.align(Alignment.CenterEnd).padding(8.dp)
                ) {
                    Icon(Icons.Default.ArrowForward, "Next", tint = Color.White)
                }
            }
            Text(
                "${current + 1} / ${urls.size}",
                color = Color.White.copy(alpha = 0.8f),
                fontSize = 12.sp,
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 24.dp)
            )
            IconButton(
                onClick = onDismiss,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .statusBarsPadding()
                    .padding(8.dp)
            ) {
                Icon(Icons.Default.Close, "Close", tint = Color.White)
            }
        }
    }
}

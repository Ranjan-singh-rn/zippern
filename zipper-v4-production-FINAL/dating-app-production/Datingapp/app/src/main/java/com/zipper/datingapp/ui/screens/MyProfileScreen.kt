package com.zipper.datingapp.ui.screens

import android.graphics.Bitmap
import androidx.activity.compose.BackHandler
import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.FavoriteBorder
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.*
import androidx.compose.foundation.Image
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.viewinterop.AndroidView
import coil.compose.SubcomposeAsyncImage
import coil.request.ImageRequest
import com.zipper.datingapp.data.SentGiftHistoryEntry
import com.zipper.datingapp.ui.DatingUiState
import com.zipper.datingapp.ui.components.VerifiedBadge
import com.zipper.datingapp.ui.theme.*
import com.zipper.datingapp.util.buildVideoPlayer
import com.zipper.datingapp.util.extractVideoThumbnail
import com.zipper.datingapp.util.isVideoUrl

private const val GIFT_PREVIEW = 3

// ─────────────────────────────────────────────────────────────────────────────
// MyProfileScreen
// ─────────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun MyProfileScreen(
    uiState: DatingUiState,
    onBack: () -> Unit,
    onEditProfile: () -> Unit,
    onEnterOwnLive: () -> Unit = {},
    onEnterOwnParty: () -> Unit = {}
) {
    BackHandler(onBack = onBack)

    val user = uiState.currentUser ?: run { onBack(); return }
    val isFemale = user.genderText.lowercase() == "female"
    val coverUrl = user.galleryPhotos.firstOrNull().orEmpty()
    val ctx = LocalContext.current

    var galleryStartIndex by remember { mutableIntStateOf(0) }
    var showGallery by remember { mutableStateOf(false) }
    var showAllGifts by remember { mutableStateOf(false) }
    var showAvatarViewer by remember { mutableStateOf(false) }

    if (showAllGifts) {
        AllGiftsScreen(
            title = if (isFemale) "Gifts Received" else "Gifts Sent",
            gifts = uiState.mySentGiftHistory,
            isLoading = uiState.isMySentGiftHistoryLoading,
            isFemale = isFemale,
            onBack = { showAllGifts = false }
        )
        return
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background),
        contentPadding = PaddingValues(bottom = 40.dp)
    ) {

        // ── Own Live / Party Banner ───────────────────────────────────────────
        if (uiState.isLive) {
            item {
                Surface(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 10.dp)
                        .clickable { onEnterOwnLive() },
                    shape = RoundedCornerShape(16.dp),
                    color = Color(0xFFE91E63).copy(.12f),
                    border = androidx.compose.foundation.BorderStroke(1.5.dp, Color(0xFFE91E63).copy(.5f))
                ) {
                    Row(
                        modifier = Modifier.padding(14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        Box(
                            modifier = Modifier
                                .size(10.dp)
                                .background(Color(0xFFE91E63), CircleShape)
                        )
                        Text(
                            "You are LIVE — tap to return to your stream",
                            fontWeight = FontWeight.Bold,
                            color = Color(0xFFE91E63),
                            fontSize = 14.sp,
                            modifier = Modifier.weight(1f)
                        )
                        Icon(Icons.Default.PlayCircleFilled, null, tint = Color(0xFFE91E63), modifier = Modifier.size(24.dp))
                    }
                }
            }
        }

        if (uiState.isAudioPartyLive) {
            item {
                Surface(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 6.dp)
                        .clickable { onEnterOwnParty() },
                    shape = RoundedCornerShape(16.dp),
                    color = Color(0xFF7C4DFF).copy(.12f),
                    border = androidx.compose.foundation.BorderStroke(1.5.dp, Color(0xFF7C4DFF).copy(.5f))
                ) {
                    Row(
                        modifier = Modifier.padding(14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        Box(
                            modifier = Modifier
                                .size(10.dp)
                                .background(Color(0xFF7C4DFF), CircleShape)
                        )
                        Text(
                            "Your Party Room is LIVE — tap to return",
                            fontWeight = FontWeight.Bold,
                            color = Color(0xFF7C4DFF),
                            fontSize = 14.sp,
                            modifier = Modifier.weight(1f)
                        )
                        Icon(Icons.Default.MicNone, null, tint = Color(0xFF7C4DFF), modifier = Modifier.size(24.dp))
                    }
                }
            }
        }

        // ── Hero ─────────────────────────────────────────────────────────────
        item {
            Box(modifier = Modifier.fillMaxWidth().height(320.dp)) {

                // Cover photo / gradient
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

                // Heavy scrim so text stays readable
                Box(
                    modifier = Modifier.fillMaxSize().background(
                        Brush.verticalGradient(
                            0f to Color.Black.copy(.1f),
                            .5f to Color.Black.copy(.25f),
                            1f to Color.Black.copy(.75f)
                        )
                    )
                )

                // Back button
                IconButton(
                    onClick = onBack,
                    modifier = Modifier
                        .align(Alignment.TopStart)
                        .statusBarsPadding()
                        .padding(8.dp)
                        .background(Color.Black.copy(.35f), CircleShape)
                ) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Color.White)
                }

                // Edit button
                IconButton(
                    onClick = onEditProfile,
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .statusBarsPadding()
                        .padding(8.dp)
                        .background(Color.Black.copy(.35f), CircleShape)
                ) {
                    Icon(Icons.Default.Edit, "Edit", tint = Color.White)
                }

                // Avatar + name overlay at bottom
                Row(
                    modifier = Modifier
                        .align(Alignment.BottomStart)
                        .padding(start = 20.dp, bottom = 20.dp),
                    verticalAlignment = Alignment.Bottom
                ) {
                    // Avatar with glow
                    Box(
                        modifier = Modifier
                            .size(90.dp)
                            .shadow(12.dp, CircleShape)
                            .border(
                                3.dp,
                                Brush.sweepGradient(listOf(BrandPink, BrandPurple, GoldAccent, BrandPink)),
                                CircleShape
                            )
                            .clip(CircleShape)
                            .clickable { showAvatarViewer = true },
                        contentAlignment = Alignment.Center
                    ) {
                        if (user.photoUrl.isNotBlank()) {
                            SubcomposeAsyncImage(
                                model = ImageRequest.Builder(ctx).data(user.photoUrl).crossfade(300).build(),
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
                                Text(user.name.take(1).uppercase(), fontSize = 32.sp, fontWeight = FontWeight.Bold, color = Color.White)
                            }
                        }
                        // Online dot
                        if (user.isOnline) {
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
                                user.name,
                                color = Color.White,
                                fontWeight = FontWeight.Bold,
                                fontSize = 20.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                            if (user.hasBlueTick) {
                                Spacer(Modifier.width(6.dp))
                                VerifiedBadge(showLabel = false, size = 18.dp)
                            }
                        }
                        Text("ID: ${user.profileNumber}", color = Color.White.copy(.7f), fontSize = 12.sp)
                        Spacer(Modifier.height(4.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            HeroPill(
                                icon = when (user.genderText.lowercase()) {
                                    "female" -> Icons.Default.Female; "male" -> Icons.Default.Male
                                    "transgender" -> Icons.Default.Transgender; else -> Icons.Default.Person
                                },
                                text = user.genderText.replaceFirstChar { it.uppercaseChar() }
                            )
                            if (user.city.isNotBlank()) {
                                HeroPill(icon = Icons.Default.LocationOn, text = user.city)
                            }
                        }
                    }
                }
            }
        }

        // ── Stats Row ─────────────────────────────────────────────────────────
        item {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                val likeMeCount = uiState.likedMeProfiles.filter { it.id != user.id }.size
                val iLikeCount  = uiState.iLikedProfiles.filter { it.id != user.id }.size
                PremiumStatCard("Liked Me",  compactNumber(likeMeCount.toLong()),  Icons.Default.Favorite,         BrandPink,           Modifier.weight(1f))
                PremiumStatCard("I Liked",  compactNumber(iLikeCount.toLong()),   Icons.Outlined.FavoriteBorder,  BrandPurple,         Modifier.weight(1f))
                PremiumStatCard("Level",    "Lv${user.displayProfileLevel}",           Icons.Default.WorkspacePremium, GoldAccent,          Modifier.weight(1f))
                PremiumStatCard("Diamonds", compactNumber(uiState.coinBalance.toLong()),Icons.Default.Diamond,          Color(0xFF29B6F6),   Modifier.weight(1f))
            }
        }

        // ── Bio ───────────────────────────────────────────────────────────────
        if (user.bio.isNotBlank()) {
            item {
                PremiumSection(icon = Icons.Default.FormatQuote, title = "About Me") {
                    Text(
                        '"' + user.bio + '"',
                        fontSize = 14.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(.85f),
                        lineHeight = 22.sp,
                        fontStyle = androidx.compose.ui.text.font.FontStyle.Italic
                    )
                }
            }
        }

        // ── Media Gallery (3×3 grid, max 9) ──────────────────────────────────
        if (user.galleryPhotos.isNotEmpty()) {
            item {
                PremiumSection(
                    icon = Icons.Default.PhotoLibrary,
                    title = "Media  •  ${user.galleryPhotos.size}/9"
                ) {
                    val cols = 3
                    val previewMedia = user.galleryPhotos.take(9)
                    val rows = (previewMedia.size + cols - 1) / cols
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        repeat(rows) { row ->
                            Row(
                                horizontalArrangement = Arrangement.spacedBy(4.dp),
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                repeat(cols) { col ->
                                    val index = row * cols + col
                                    if (index < previewMedia.size) {
                                        val mediaUrl = previewMedia[index]
                                        val isVideo = isVideoUrl(mediaUrl)
                                        Box(
                                            modifier = Modifier
                                                .weight(1f)
                                                .aspectRatio(1f)
                                                .clip(RoundedCornerShape(8.dp))
                                                .clickable {
                                                    galleryStartIndex = index
                                                    showGallery = true
                                                }
                                        ) {
                                            if (isVideo) {
                                                VideoThumbnailCell(url = mediaUrl)
                                            } else {
                                                SubcomposeAsyncImage(
                                                    model = ImageRequest.Builder(ctx)
                                                        .data(mediaUrl)
                                                        .crossfade(200)
                                                        .build(),
                                                    contentDescription = null,
                                                    modifier = Modifier.fillMaxSize(),
                                                    contentScale = ContentScale.Crop,
                                                    loading = { ShimmerBox(Modifier.fillMaxSize()) },
                                                    error = {
                                                        Box(
                                                            Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceVariant),
                                                            contentAlignment = Alignment.Center
                                                        ) {
                                                            Icon(Icons.Default.Image, null, tint = TextSecondary, modifier = Modifier.size(28.dp))
                                                        }
                                                    }
                                                )
                                            }
                                            // Cover badge
                                            if (index == 0) {
                                                Surface(
                                                    modifier = Modifier.align(Alignment.BottomStart).padding(3.dp),
                                                    shape = RoundedCornerShape(4.dp),
                                                    color = BrandPink.copy(.9f)
                                                ) {
                                                    Text("Cover", fontSize = 8.sp, color = Color.White, fontWeight = FontWeight.Bold,
                                                        modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp))
                                                }
                                            }
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

        // ── Personal Info ─────────────────────────────────────────────────────
        item {
            PremiumSection(icon = Icons.Default.Person, title = "Personal Info") {
                Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    InfoLine(Icons.Default.Badge,      "Name",   user.name.ifBlank { "—" })
                    InfoLine(Icons.Default.Cake,       "Age",    "${user.currentAge} years old")
                    InfoLine(
                        when (user.genderText.lowercase()) {
                            "female" -> Icons.Default.Female; "male" -> Icons.Default.Male
                            "transgender" -> Icons.Default.Transgender; else -> Icons.Default.Person
                        },
                        "Gender", user.genderText.replaceFirstChar { it.uppercaseChar() }.ifBlank { "—" }
                    )
                    if (user.city.isNotBlank()) InfoLine(Icons.Default.LocationOn, "Area", user.city)
                    // Private fields — owner only
                    if (user.email.isNotBlank()) PrivateLine(Icons.Default.Email, "Email", user.email)
                    if (user.mobile.isNotBlank()) PrivateLine(Icons.Default.Phone, "Mobile", user.mobile)
                    if (!user.referralCode.isNullOrBlank()) PrivateLine(Icons.Default.Tag, "Referral Code", user.referralCode.orEmpty())
                    InfoLine(Icons.Default.Timer, "Streamed", "${user.totalLiveMinutes / 60}h ${user.totalLiveMinutes % 60}m")
                }
            }
        }

        // ── Interests ─────────────────────────────────────────────────────────
        val allHobbies = (user.hobbies + user.interests).distinct()
        if (allHobbies.isNotEmpty()) {
            item {
                PremiumSection(icon = Icons.Default.Stars, title = "Hobbies & Interests") {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        allHobbies.forEach { tag ->
                            Surface(
                                shape = RoundedCornerShape(50),
                                color = BrandPink.copy(.1f),
                                border = BorderStroke(1.dp, BrandPink.copy(.3f))
                            ) {
                                Text(
                                    tag,
                                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp),
                                    fontSize = 13.sp,
                                    color = BrandPink,
                                    fontWeight = FontWeight.Medium
                                )
                            }
                        }
                    }
                }
            }
        }

        if (user.likes.isNotEmpty()) {
            item {
                PremiumSection(icon = Icons.Default.Favorite, title = "Likes") {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        user.likes.forEach { tag ->
                            Surface(
                                shape = RoundedCornerShape(50),
                                color = BrandPurple.copy(.1f),
                                border = BorderStroke(1.dp, BrandPurple.copy(.3f))
                            ) {
                                Text(
                                    tag,
                                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp),
                                    fontSize = 13.sp,
                                    color = BrandPurple,
                                    fontWeight = FontWeight.Medium
                                )
                            }
                        }
                    }
                }
            }
        }

        if (user.dislikes.isNotEmpty()) {
            item {
                PremiumSection(icon = Icons.Default.HeartBroken, title = "Dislikes") {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        user.dislikes.forEach { tag ->
                            Surface(
                                shape = RoundedCornerShape(50),
                                color = Color(0xFF757575).copy(.1f),
                                border = BorderStroke(1.dp, Color(0xFF757575).copy(.3f))
                            ) {
                                Text(
                                    tag,
                                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp),
                                    fontSize = 13.sp,
                                    color = Color(0xFF757575),
                                    fontWeight = FontWeight.Medium
                                )
                            }
                        }
                    }
                }
            }
        }

        if (user.languages.isNotEmpty()) {
            item {
                PremiumSection(icon = Icons.Default.Language, title = "Languages") {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        user.languages.forEach { tag ->
                            Surface(
                                shape = RoundedCornerShape(50),
                                color = GoldAccent.copy(.1f),
                                border = BorderStroke(1.dp, GoldAccent.copy(.3f))
                            ) {
                                Text(
                                    tag,
                                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp),
                                    fontSize = 13.sp,
                                    color = GoldAccent,
                                    fontWeight = FontWeight.Medium
                                )
                            }
                        }
                    }
                }
            }
        }

        // ── Gifts Sent ────────────────────────────────────────────────────────
        item {
            val sentGifts = uiState.mySentGiftHistory
            val isLoading = uiState.isMySentGiftHistoryLoading
            PremiumSection(
                icon = Icons.Default.CardGiftcard,
                title = "Gifts Sent",
                trailingContent = if (sentGifts.size > GIFT_PREVIEW) {
                    {
                        TextButton(onClick = { showAllGifts = true }) {
                            Text("See all", color = BrandPink, fontSize = 13.sp)
                            Icon(Icons.AutoMirrored.Filled.ArrowForward, null, tint = BrandPink, modifier = Modifier.size(14.dp))
                        }
                    }
                } else null
            ) {
                when {
                    isLoading -> Box(Modifier.fillMaxWidth().padding(20.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(color = BrandPink, modifier = Modifier.size(28.dp), strokeWidth = 2.dp)
                    }
                    sentGifts.isEmpty() -> Column(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp),
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Icon(Icons.Default.CardGiftcard, null, tint = TextSecondary.copy(.5f), modifier = Modifier.size(36.dp))
                        Spacer(Modifier.height(8.dp))
                        Text("No gifts sent yet", color = TextSecondary, fontSize = 13.sp)
                    }
                    else -> {
                        LazyRow(
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            contentPadding = PaddingValues(vertical = 4.dp)
                        ) {
                            items(sentGifts.take(GIFT_PREVIEW), key = { "sent_${it.giftName}" }) { g ->
                                GiftChip(g, false)
                            }
                            if (sentGifts.size > GIFT_PREVIEW) {
                                item {
                                    Surface(
                                        modifier = Modifier.height(72.dp).clickable { showAllGifts = true },
                                        shape = RoundedCornerShape(14.dp),
                                        color = BrandPink.copy(.08f),
                                        border = BorderStroke(1.dp, BrandPink.copy(.2f))
                                    ) {
                                        Box(modifier = Modifier.padding(horizontal = 16.dp), contentAlignment = Alignment.Center) {
                                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                                Text("+${sentGifts.size - GIFT_PREVIEW}", fontWeight = FontWeight.Bold, color = BrandPink, fontSize = 16.sp)
                                                Text("more", color = BrandPink, fontSize = 11.sp)
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

        // ── Gifts Received ────────────────────────────────────────────────────
        item {
            val receivedGifts = uiState.myReceivedGiftHistory
            val isLoading = uiState.isMyReceivedGiftHistoryLoading
            PremiumSection(
                icon = Icons.Default.Redeem,
                title = "Gifts Received"
            ) {
                when {
                    isLoading -> Box(Modifier.fillMaxWidth().padding(20.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(color = GoldAccent, modifier = Modifier.size(28.dp), strokeWidth = 2.dp)
                    }
                    receivedGifts.isEmpty() -> Column(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp),
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Icon(Icons.Default.Redeem, null, tint = TextSecondary.copy(.5f), modifier = Modifier.size(36.dp))
                        Spacer(Modifier.height(8.dp))
                        Text("No gifts received yet", color = TextSecondary, fontSize = 13.sp)
                    }
                    else -> {
                        LazyRow(
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            contentPadding = PaddingValues(vertical = 4.dp)
                        ) {
                            items(receivedGifts.take(GIFT_PREVIEW), key = { "recv_${it.giftName}" }) { g ->
                                GiftChip(g, true)
                            }
                        }
                    }
                }
            }
        }
    }

    // ── Avatar full-screen viewer ─────────────────────────────────────────────
    if (showAvatarViewer && user.photoUrl.isNotBlank()) {
        AvatarViewer(url = user.photoUrl, onDismiss = { showAvatarViewer = false })
    }

    // ── Gallery viewer ────────────────────────────────────────────────────────
    if (showGallery && user.galleryPhotos.isNotEmpty()) {
        GalleryViewer(
            urls = user.galleryPhotos,
            startIndex = galleryStartIndex,
            onDismiss = { showGallery = false }
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// All Gifts Screen
// ─────────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AllGiftsScreen(
    title: String,
    gifts: List<SentGiftHistoryEntry>,
    isLoading: Boolean,
    isFemale: Boolean,
    onBack: () -> Unit
) {
    BackHandler(onBack = onBack)
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title, fontWeight = FontWeight.Bold) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } }
            )
        }
    ) { pad ->
        when {
            isLoading -> Box(Modifier.fillMaxSize().padding(pad), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = BrandPink)
            }
            gifts.isEmpty() -> Box(Modifier.fillMaxSize().padding(pad), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Default.CardGiftcard, null, tint = TextSecondary.copy(.4f), modifier = Modifier.size(48.dp))
                    Spacer(Modifier.height(12.dp))
                    Text(if (isFemale) "No gifts received yet" else "No gifts sent yet", color = TextSecondary)
                }
            }
            else -> LazyColumn(
                modifier = Modifier.fillMaxSize().padding(pad),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                itemsIndexed(gifts, key = { _, e -> e.giftName }) { _, entry ->
                    GiftListRow(entry, isFemale)
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gallery full-screen pager  (zoom + swipe fixed)
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun GalleryViewer(urls: List<String>, startIndex: Int, onDismiss: () -> Unit) {
    // Per-page scale hoisted OUTSIDE the pager so HorizontalPager can read it
    val scales  = remember(urls.size) { SnapshotStateList<Float>().also { list -> repeat(urls.size) { list.add(1f) } } }
    val offsets = remember(urls.size) { SnapshotStateList<Offset>().also { list -> repeat(urls.size) { list.add(Offset.Zero) } } }

    val pager = rememberPagerState(initialPage = startIndex, pageCount = { urls.size })

    // Disable pager swipe while any page is zoomed in
    val currentScale = scales.getOrElse(pager.currentPage) { 1f }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnBackPress = true)
    ) {
        Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
            HorizontalPager(
                state = pager,
                modifier = Modifier.fillMaxSize(),
                userScrollEnabled = currentScale <= 1.01f   // KEY: let pager swipe only at 1× zoom
            ) { page ->
                val url = urls[page]
                if (isVideoUrl(url)) {
                    CachedVideoPlayer(url = url)
                } else {
                    ZoomableImagePage(
                        url = url,
                        scale = scales.getOrElse(page) { 1f },
                        offset = offsets.getOrElse(page) { Offset.Zero },
                        onTransform = { zoom, pan ->
                            val ns = (scales.getOrElse(page) { 1f } * zoom).coerceIn(1f, 6f)
                            scales[page] = ns
                            offsets[page] = if (ns > 1f) offsets.getOrElse(page) { Offset.Zero } + pan else Offset.Zero
                        },
                        onResetZoom = { scales[page] = 1f; offsets[page] = Offset.Zero }
                    )
                }
            }
            // Close
            IconButton(
                onClick = onDismiss,
                modifier = Modifier.align(Alignment.TopStart).padding(16.dp).statusBarsPadding()
                    .background(Color.Black.copy(.55f), CircleShape)
            ) { Icon(Icons.Default.Close, null, tint = Color.White) }
            // Counter
            Surface(
                modifier = Modifier.align(Alignment.TopCenter).padding(top = 16.dp).statusBarsPadding(),
                shape = RoundedCornerShape(16.dp),
                color = Color.Black.copy(.5f)
            ) {
                Text(
                    "${pager.currentPage + 1} / ${urls.size}",
                    color = Color.White,
                    fontSize = 13.sp,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp)
                )
            }
            if (urls.size > 1 && currentScale <= 1.01f) {
                Text(
                    "Swipe to browse",
                    color = Color.White.copy(.35f),
                    fontSize = 11.sp,
                    modifier = Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 16.dp)
                )
            }
        }
    }
}

/**
 * Zoomable image page.
 * Uses [androidx.compose.foundation.gestures.rememberTransformableState] +
 * [Modifier.transformable] which cooperates with nested scrollables (the pager)
 * instead of consuming all touch like [detectTransformGestures].
 */
@Composable
private fun ZoomableImagePage(
    url: String,
    scale: Float,
    offset: Offset,
    onTransform: (zoom: Float, pan: Offset) -> Unit,
    onResetZoom: () -> Unit
) {
    val transformState = rememberTransformableState { zoom, panChange, _ ->
        onTransform(zoom, panChange)
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            // Only attach transformable when zoomed in — at scale=1 the pager owns horizontal swipes
            .let { if (scale > 1.01f) it.transformable(state = transformState) else it },
        contentAlignment = Alignment.Center
    ) {
        SubcomposeAsyncImage(
            model = url,
            contentDescription = null,
            modifier = Modifier
                .fillMaxSize()
                .graphicsLayer(
                    scaleX = scale,
                    scaleY = scale,
                    translationX = offset.x,
                    translationY = offset.y
                ),
            contentScale = ContentScale.Fit,
            loading = {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = BrandPink, modifier = Modifier.size(36.dp))
                }
            }
        )
        if (scale > 1.05f) {
            Surface(
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 48.dp),
                shape = RoundedCornerShape(50),
                color = Color.Black.copy(.55f)
            ) {
                Text(
                    "Pinch to zoom out",
                    color = Color.White.copy(.7f),
                    fontSize = 11.sp,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp)
                )
            }
        }
    }
}

/** ExoPlayer-backed cached video player. */
@Composable
private fun CachedVideoPlayer(url: String) {
    val ctx = LocalContext.current
    val exoPlayer = remember(url) { buildVideoPlayer(ctx, url) }
    DisposableEffect(exoPlayer) { onDispose { exoPlayer.release() } }

    Box(modifier = Modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
        AndroidView(
            factory = { context ->
                androidx.media3.ui.PlayerView(context).apply {
                    player = exoPlayer
                    useController = true
                    setShowBuffering(androidx.media3.ui.PlayerView.SHOW_BUFFERING_ALWAYS)
                }
            },
            modifier = Modifier.fillMaxSize()
        )
    }
}

/**
 * Grid thumbnail for a video — extracts the first frame via [MediaMetadataRetriever]
 * on a background thread and shows a shimmer + play icon while loading.
 */
@Composable
private fun VideoThumbnailCell(url: String) {
    var bitmap by remember(url) { mutableStateOf<Bitmap?>(null) }
    var loading by remember(url) { mutableStateOf(true) }

    LaunchedEffect(url) {
        bitmap = extractVideoThumbnail(url)
        loading = false
    }

    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        when {
            loading -> ShimmerBox(Modifier.fillMaxSize())
            bitmap != null -> {
                androidx.compose.foundation.Image(
                    bitmap = bitmap!!.asImageBitmap(),
                    contentDescription = null,
                    modifier = Modifier.fillMaxSize(),
                    contentScale = ContentScale.Crop
                )
            }
            else -> {
                Box(
                    Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceVariant),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(Icons.Default.PlayCircleFilled, null, tint = TextSecondary, modifier = Modifier.size(28.dp))
                }
            }
        }
        // Play icon overlay
        Box(
            modifier = Modifier.fillMaxSize().background(Color.Black.copy(.28f)),
            contentAlignment = Alignment.Center
        ) {
            Icon(Icons.Default.PlayCircleFilled, null, tint = Color.White, modifier = Modifier.size(30.dp))
        }
    }
}

@Composable
private fun AvatarViewer(url: String, onDismiss: () -> Unit) {
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnBackPress = true)
    ) {
        Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
            SubcomposeAsyncImage(
                model = url,
                contentDescription = null,
                modifier = Modifier.fillMaxSize()
                    .pointerInput(Unit) {
                        detectTransformGestures { _, pan, zoom, _ ->
                            scale = (scale * zoom).coerceIn(1f, 6f)
                            offset = if (scale == 1f) Offset.Zero else offset + pan
                        }
                    }
                    .graphicsLayer(scaleX = scale, scaleY = scale, translationX = offset.x, translationY = offset.y),
                contentScale = ContentScale.Fit,
                loading = { Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = BrandPink) } }
            )
            IconButton(
                onClick = onDismiss,
                modifier = Modifier.align(Alignment.TopStart).padding(16.dp).statusBarsPadding()
                    .background(Color.Black.copy(.55f), CircleShape)
            ) { Icon(Icons.Default.Close, null, tint = Color.White) }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-composables
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun HeroPill(icon: ImageVector, text: String) {
    Surface(
        shape = RoundedCornerShape(50),
        color = Color.Black.copy(.35f),
        border = BorderStroke(1.dp, Color.White.copy(.25f))
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(icon, null, tint = Color.White, modifier = Modifier.size(12.dp))
            Spacer(Modifier.width(4.dp))
            Text(text, color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Medium)
        }
    }
}

@Composable
private fun PremiumStatCard(label: String, value: String, icon: ImageVector, color: Color, modifier: Modifier) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(16.dp),
        color = color.copy(.08f),
        border = BorderStroke(1.dp, color.copy(.2f)),
        shadowElevation = 2.dp
    ) {
        Column(
            modifier = Modifier.padding(vertical = 16.dp, horizontal = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Box(
                modifier = Modifier.size(36.dp).background(color.copy(.15f), CircleShape),
                contentAlignment = Alignment.Center
            ) {
                Icon(icon, null, tint = color, modifier = Modifier.size(20.dp))
            }
            Spacer(Modifier.height(8.dp))
            Text(value, fontWeight = FontWeight.ExtraBold, fontSize = 18.sp, color = MaterialTheme.colorScheme.onSurface)
            Text(label, fontSize = 11.sp, color = TextSecondary, maxLines = 1)
        }
    }
}

@Composable
internal fun PremiumSection(
    icon: ImageVector,
    title: String,
    trailingContent: (@Composable () -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit
) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                modifier = Modifier.size(32.dp).background(BrandPink.copy(.12f), RoundedCornerShape(8.dp)),
                contentAlignment = Alignment.Center
            ) {
                Icon(icon, null, tint = BrandPink, modifier = Modifier.size(18.dp))
            }
            Spacer(Modifier.width(10.dp))
            Text(title, fontWeight = FontWeight.Bold, fontSize = 15.sp, modifier = Modifier.weight(1f))
            trailingContent?.invoke()
        }
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(18.dp),
            color = MaterialTheme.colorScheme.surfaceVariant.copy(.4f),
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(.1f)),
            shadowElevation = 1.dp
        ) {
            Column(modifier = Modifier.padding(16.dp), content = content)
        }
    }
}

@Composable
private fun InfoLine(icon: ImageVector, label: String, value: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = TextSecondary, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(12.dp))
        Text(label, fontSize = 12.sp, color = TextSecondary, modifier = Modifier.width(90.dp))
        Text(value, fontSize = 14.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f), maxLines = 2)
    }
}

@Composable
private fun PrivateLine(icon: ImageVector, label: String, value: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = BrandPurple.copy(.7f), modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(12.dp))
        Text(label, fontSize = 12.sp, color = TextSecondary, modifier = Modifier.width(90.dp))
        Text(value, fontSize = 14.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f), maxLines = 1)
        Icon(Icons.Default.Lock, null, tint = TextSecondary.copy(.4f), modifier = Modifier.size(12.dp))
    }
}

/** Compact horizontal gift card — shows icon + name + quantity, no price. */
@Composable
private fun GiftChip(entry: SentGiftHistoryEntry, isFemale: Boolean) {
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = GoldAccent.copy(.08f),
        border = BorderStroke(1.dp, GoldAccent.copy(.2f))
    ) {
        Column(
            modifier = Modifier.width(80.dp).padding(12.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Box(
                modifier = Modifier.size(40.dp).background(GoldAccent.copy(.15f), RoundedCornerShape(10.dp)),
                contentAlignment = Alignment.Center
            ) {
                Icon(Icons.Default.CardGiftcard, null, tint = GoldAccent, modifier = Modifier.size(22.dp))
            }
            Spacer(Modifier.height(6.dp))
            Text(entry.giftName, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
            Text("×${entry.count}", fontSize = 12.sp, color = TextSecondary, fontWeight = FontWeight.Medium)
        }
    }
}

/** Full-width gift row for the dedicated All Gifts screen — name + quantity only, no price. */
@Composable
private fun GiftListRow(entry: SentGiftHistoryEntry, isFemale: Boolean) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(.45f),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(.1f))
    ) {
        Row(
            modifier = Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                modifier = Modifier.size(48.dp).background(GoldAccent.copy(.12f), RoundedCornerShape(12.dp)),
                contentAlignment = Alignment.Center
            ) {
                Icon(Icons.Default.CardGiftcard, null, tint = GoldAccent, modifier = Modifier.size(26.dp))
            }
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(entry.giftName, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    "${if (isFemale) "Received" else "Sent"} ×${entry.count}",
                    fontSize = 13.sp,
                    color = TextSecondary
                )
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Compact number formatter
// ─────────────────────────────────────────────────────────────────────────────

internal fun compactNumber(n: Long): String = when {
    n >= 10_000_000L -> "${n / 10_000_000L}Cr"
    n >= 1_000_000L  -> "${n / 1_000_000L}M"
    n >= 100_000L    -> "${n / 100_000L}L"
    n >= 10_000L     -> "${n / 1_000L}K"
    n >= 1_000L      -> "${n / 1_000L}K"
    else             -> n.toString()
}

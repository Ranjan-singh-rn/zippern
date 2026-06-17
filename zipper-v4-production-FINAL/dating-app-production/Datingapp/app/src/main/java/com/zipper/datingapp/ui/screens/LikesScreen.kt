package com.zipper.datingapp.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.FavoriteBorder
import androidx.compose.material3.*
import androidx.compose.material3.TabRowDefaults.tabIndicatorOffset
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.SubcomposeAsyncImage
import com.zipper.datingapp.data.UserProfile
import com.zipper.datingapp.ui.DatingUiState
import com.zipper.datingapp.ui.theme.*
import kotlinx.coroutines.launch

/**
 * Full-screen Likes screen with two tabs:
 *  - Tab 0: "I Like"  (profiles this user has liked)
 *  - Tab 1: "Like Me" (profiles that liked this user)
 *
 * [initialTab] 0 = I Like, 1 = Like Me.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LikesScreen(
    uiState: DatingUiState,
    initialTab: Int = 0,
    onBack: () -> Unit,
    onProfileClick: (UserProfile) -> Unit = {}
) {
    BackHandler(onBack = onBack)

    val user = uiState.currentUser ?: run { onBack(); return }
    val pager = rememberPagerState(initialPage = initialTab, pageCount = { 2 })
    val scope = rememberCoroutineScope()

    // I Like — profiles the current user has liked (fetched via ViewModel.loadILikedProfiles)
    // Filter out own profile just in case
    val iLikeProfiles = uiState.iLikedProfiles.filter { it.id != user.id }

    // Like Me — profiles that liked the current user (fetched via ViewModel.loadLikedMeProfiles)
    // Filter out own profile just in case
    val likeMeProfiles = uiState.likedMeProfiles.filter { it.id != user.id }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Likes", fontWeight = FontWeight.Bold, fontSize = 20.sp) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background
                )
            )
        }
    ) { pad ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(pad)
        ) {
            // Tab row
            TabRow(
                selectedTabIndex = pager.currentPage,
                containerColor = MaterialTheme.colorScheme.background,
                contentColor = BrandPink,
                indicator = { tabPositions ->
                    TabRowDefaults.SecondaryIndicator(
                        modifier = Modifier.tabIndicatorOffset(tabPositions[pager.currentPage]),
                        color = BrandPink
                    )
                }
            ) {
                Tab(
                    selected = pager.currentPage == 0,
                    onClick = { scope.launch { pager.animateScrollToPage(0) } },
                    text = {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp)
                        ) {
                            Icon(Icons.Outlined.FavoriteBorder, null, modifier = Modifier.size(16.dp))
                            Text("I Like  •  ${iLikeProfiles.size}", fontWeight = FontWeight.SemiBold)
                        }
                    }
                )
                Tab(
                    selected = pager.currentPage == 1,
                    onClick = { scope.launch { pager.animateScrollToPage(1) } },
                    text = {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp)
                        ) {
                            Icon(Icons.Default.Favorite, null, tint = BrandPink, modifier = Modifier.size(16.dp))
                            Text("Like Me  •  ${likeMeProfiles.size}", fontWeight = FontWeight.SemiBold)
                        }
                    }
                )
            }

            HorizontalPager(state = pager, modifier = Modifier.fillMaxSize()) { page ->
                val profiles = if (page == 0) iLikeProfiles else likeMeProfiles
                val emptyMsg = if (page == 0) "You haven't liked anyone yet" else "No one has liked you yet"
                val emptyIcon = if (page == 0) Icons.Outlined.FavoriteBorder else Icons.Default.Favorite

                if (profiles.isEmpty()) {
                    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Icon(
                                emptyIcon,
                                null,
                                tint = TextSecondary.copy(.35f),
                                modifier = Modifier.size(56.dp)
                            )
                            Spacer(Modifier.height(12.dp))
                            Text(emptyMsg, color = TextSecondary, fontSize = 15.sp)
                            Spacer(Modifier.height(6.dp))
                            Text(
                                if (page == 0) "Profiles you like will appear here"
                                else "People who like you will appear here",
                                color = TextSecondary.copy(.6f),
                                fontSize = 13.sp
                            )
                        }
                    }
                } else {
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        items(profiles, key = { it.id }) { profile ->
                            LikeUserCard(
                                profile = profile,
                                isLikedByMe = page == 0,
                                onClick = { onProfileClick(profile) }
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun LikeUserCard(
    profile: UserProfile,
    isLikedByMe: Boolean,
    onClick: () -> Unit
) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(18.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(.45f),
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(.1f)),
        shadowElevation = 2.dp
    ) {
        Row(
            modifier = Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Avatar
            Box(modifier = Modifier.size(58.dp)) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .border(
                            2.dp,
                            Brush.sweepGradient(listOf(BrandPink, BrandPurple, BrandPink)),
                            CircleShape
                        )
                        .clip(CircleShape)
                ) {
                    if (profile.photoUrl.isNotBlank()) {
                        SubcomposeAsyncImage(
                            model = profile.photoUrl,
                            contentDescription = null,
                            modifier = Modifier.fillMaxSize().clip(CircleShape),
                            contentScale = ContentScale.Crop,
                            loading = { ShimmerBox(Modifier.fillMaxSize()) }
                        )
                    } else {
                        Box(
                            Modifier.fillMaxSize().background(
                                Brush.linearGradient(listOf(BrandPurple, BrandPink))
                            ),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(profile.name.take(1).uppercase(), color = Color.White, fontWeight = FontWeight.Bold, fontSize = 22.sp)
                        }
                    }
                }
                // Online dot
                if (profile.isOnline) {
                    Box(
                        modifier = Modifier
                            .size(12.dp)
                            .align(Alignment.BottomEnd)
                            .border(2.dp, MaterialTheme.colorScheme.surface, CircleShape)
                            .clip(CircleShape)
                            .background(Color(0xFF4CAF50))
                    )
                }
            }

            Spacer(Modifier.width(14.dp))

            Column(modifier = Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        profile.name,
                        fontWeight = FontWeight.Bold,
                        fontSize = 16.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f)
                    )
                    if (profile.hasBlueTick) {
                        Spacer(Modifier.width(4.dp))
                        Icon(Icons.Default.Verified, null, tint = Color(0xFF1DA1F2), modifier = Modifier.size(14.dp))
                    }
                }
                Spacer(Modifier.height(2.dp))
                Row(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(
                        when (profile.genderText.lowercase()) {
                            "female" -> Icons.Default.Female
                            "male"   -> Icons.Default.Male
                            else     -> Icons.Default.Person
                        },
                        null,
                        tint = TextSecondary,
                        modifier = Modifier.size(13.dp)
                    )
                    Text("${profile.currentAge} yrs", fontSize = 13.sp, color = TextSecondary)
                    if (profile.city.isNotBlank()) {
                        Icon(Icons.Default.LocationOn, null, tint = TextSecondary, modifier = Modifier.size(13.dp))
                        Text(profile.city, fontSize = 13.sp, color = TextSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }

            // Like badge
            Surface(
                shape = RoundedCornerShape(50),
                color = if (isLikedByMe) BrandPurple.copy(.12f) else BrandPink.copy(.12f),
                border = androidx.compose.foundation.BorderStroke(1.dp, if (isLikedByMe) BrandPurple.copy(.3f) else BrandPink.copy(.3f))
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(
                        if (isLikedByMe) Icons.Outlined.FavoriteBorder else Icons.Default.Favorite,
                        null,
                        tint = if (isLikedByMe) BrandPurple else BrandPink,
                        modifier = Modifier.size(14.dp)
                    )
                    Spacer(Modifier.width(4.dp))
                    Text(
                        if (isLikedByMe) "Liked" else "Likes you",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = if (isLikedByMe) BrandPurple else BrandPink
                    )
                }
            }
        }
    }
}

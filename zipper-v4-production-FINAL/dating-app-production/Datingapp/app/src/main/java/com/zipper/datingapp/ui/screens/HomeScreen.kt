package com.zipper.datingapp.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.FilterList
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Verified
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.material3.RangeSlider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.zipper.datingapp.data.UserProfile
import com.zipper.datingapp.economy.VirtualEconomyMath
import com.zipper.datingapp.ui.DatingViewModel
import com.zipper.datingapp.ui.theme.AppBackground
import com.zipper.datingapp.ui.theme.AppSurface
import com.zipper.datingapp.ui.theme.BrandPink
import com.zipper.datingapp.ui.theme.BrandPurple
import com.zipper.datingapp.ui.theme.OutlineDefault
import com.zipper.datingapp.ui.theme.TextMuted
import com.zipper.datingapp.ui.theme.TextPrimary
import com.zipper.datingapp.ui.theme.TextSecondary
import kotlinx.coroutines.delay

// ──────────────────────────────────────────────────────────────────────────────
// Common hobby and language options for filters
// ──────────────────────────────────────────────────────────────────────────────

private val HOBBIES = listOf(
    "Dancing", "Singing", "Gaming", "Cooking", "Art", "Fitness",
    "Music", "Travel", "Reading", "Fashion", "Sports", "Comedy"
)
private val LANGUAGES = listOf(
    "Hindi", "English", "Gujarati", "Marathi", "Tamil", "Telugu",
    "Kannada", "Bengali", "Punjabi", "Malayalam"
)

// ──────────────────────────────────────────────────────────────────────────────
// HOME SCREEN
// ──────────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    viewModel: DatingViewModel,
    onProfileClick: (String) -> Unit,
    onNotificationClick: () -> Unit = {},
) {
    val currentUser by viewModel.currentUser.collectAsState()
    val discoveryProfiles by viewModel.discoveryProfiles.collectAsState()
    val searchResults by viewModel.searchResults.collectAsState()
    val isLoading by viewModel.isLoadingFeed.collectAsState()

    var searchQuery by remember { mutableStateOf("") }
    var isSearchActive by remember { mutableStateOf(false) }
    var activeTab by remember { mutableStateOf(0) }  // 0=All, 1=Online, 2=Live, 3=Following
    var showFilterSheet by remember { mutableStateOf(false) }

    // Filter state
    var filterCity by remember { mutableStateOf("") }
    var filterLanguage by remember { mutableStateOf("") }
    var filterHobbies by remember { mutableStateOf<Set<String>>(emptySet()) }
    var filterAgeMin by remember { mutableStateOf(18f) }
    var filterAgeMax by remember { mutableStateOf(60f) }
    var filterGender by remember { mutableStateOf("") }  // "" = All, "Male", "Female"
    val hasActiveFilter by remember {
        derivedStateOf {
            filterCity.isNotBlank() || filterLanguage.isNotBlank() || filterHobbies.isNotEmpty() ||
            filterGender.isNotBlank() || filterAgeMin > 18f || filterAgeMax < 60f
        }
    }

    val focusManager = LocalFocusManager.current
    val focusRequester = remember { FocusRequester() }
    val gridState = rememberLazyGridState()
    val refreshState = rememberPullToRefreshState()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    // Initial load
    LaunchedEffect(Unit) {
        viewModel.loadDiscoveryFeed()
    }

    // Re-filter when tab changes
    LaunchedEffect(activeTab) {
        if (activeTab == 3) {
            // Followed — handled client-side below
        } else {
            viewModel.loadDiscoveryFeed()
        }
    }

    LaunchedEffect(isSearchActive) {
        if (isSearchActive) {
            delay(50)
            runCatching { focusRequester.requestFocus() }
        }
    }

    BackHandler(enabled = isSearchActive) {
        isSearchActive = false
        searchQuery = ""
        focusManager.clearFocus()
    }

    val followingIds = remember(currentUser) { currentUser?.followingIds?.toSet() ?: emptySet() }

    val displayList: List<UserProfile> = remember(
        discoveryProfiles, searchResults, isSearchActive, activeTab, followingIds,
        filterAgeMin, filterAgeMax, filterGender
    ) {
        val base = if (isSearchActive && searchQuery.isNotBlank()) searchResults else discoveryProfiles
        val tabFiltered = when (activeTab) {
            1 -> base.filter { it.isOnline }
            2 -> base.filter { it.isLive }
            3 -> base.filter { it.id in followingIds }
            else -> base
        }
        tabFiltered.filter { p ->
            val ageOk = if (p.age > 0) p.age >= filterAgeMin.toInt() && p.age <= filterAgeMax.toInt() else true
            val genderOk = filterGender.isBlank() || p.gender.equals(filterGender, ignoreCase = true)
            ageOk && genderOk
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(AppBackground)
    ) {
        Column(modifier = Modifier.fillMaxSize()) {

            // ── Top bar ──────────────────────────────────────────────────────
            HomeTopBar(
                currentUser = currentUser,
                isSearchActive = isSearchActive,
                searchQuery = searchQuery,
                focusRequester = focusRequester,
                hasActiveFilter = hasActiveFilter,
                onSearchClick = {
                    isSearchActive = true
                },
                onSearchQueryChange = { q ->
                    searchQuery = q
                    viewModel.searchUsers(q)
                },
                onSearchClose = {
                    isSearchActive = false
                    searchQuery = ""
                    focusManager.clearFocus()
                },
                onFilterClick = { showFilterSheet = true },
                onNotificationClick = onNotificationClick,
            )

            // ── Filter tabs ──────────────────────────────────────────────────
            if (!isSearchActive) {
                HomeFilterTabs(
                    activeTab = activeTab,
                    onTabSelected = { activeTab = it },
                )
            }

            // ── Grid ─────────────────────────────────────────────────────────
            PullToRefreshBox(
                isRefreshing = isLoading,
                onRefresh = { viewModel.loadDiscoveryFeed() },
                state = refreshState,
                modifier = Modifier.weight(1f),
            ) {
                if (displayList.isEmpty() && !isLoading) {
                    EmptyState(isSearch = isSearchActive && searchQuery.isNotBlank())
                } else {
                    LazyVerticalGrid(
                        columns = GridCells.Fixed(2),
                        state = gridState,
                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 12.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        items(displayList, key = { it.id }) { profile ->
                            UserCard(
                                profile = profile,
                                onClick = { onProfileClick(profile.id) },
                            )
                        }
                    }
                }
            }
        }

        // ── Filter bottom sheet ───────────────────────────────────────────────
        if (showFilterSheet) {
            FilterBottomSheet(
                sheetState = sheetState,
                currentCity = filterCity,
                currentLanguage = filterLanguage,
                currentHobbies = filterHobbies,
                currentAgeMin = filterAgeMin,
                currentAgeMax = filterAgeMax,
                currentGender = filterGender,
                onApply = { city, lang, hobbies, ageMin, ageMax, gender ->
                    filterCity = city
                    filterLanguage = lang
                    filterHobbies = hobbies
                    filterAgeMin = ageMin
                    filterAgeMax = ageMax
                    filterGender = gender
                    viewModel.setDiscoveryFilters(
                        city.ifBlank { null },
                        hobbies.toList(),
                        lang.ifBlank { null },
                        ageMin,
                        ageMax,
                        gender,
                    )
                    showFilterSheet = false
                },
                onDismiss = { showFilterSheet = false },
            )
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// TOP BAR
// ──────────────────────────────────────────────────────────────────────────────

@Composable
private fun HomeTopBar(
    currentUser: UserProfile?,
    isSearchActive: Boolean,
    searchQuery: String,
    focusRequester: FocusRequester,
    hasActiveFilter: Boolean,
    onSearchClick: () -> Unit,
    onSearchQueryChange: (String) -> Unit,
    onSearchClose: () -> Unit,
    onFilterClick: () -> Unit,
    onNotificationClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (isSearchActive) {
            // Expanded search field
            Box(
                modifier = Modifier
                    .weight(1f)
                    .height(42.dp)
                    .clip(RoundedCornerShape(21.dp))
                    .background(AppSurface)
                    .border(1.dp, OutlineDefault, RoundedCornerShape(21.dp))
                    .padding(horizontal = 14.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                BasicTextField(
                    value = searchQuery,
                    onValueChange = onSearchQueryChange,
                    singleLine = true,
                    textStyle = MaterialTheme.typography.bodyMedium.copy(color = TextPrimary),
                    cursorBrush = SolidColor(BrandPink),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = { /* already reactive */ }),
                    modifier = Modifier
                        .fillMaxWidth()
                        .focusRequester(focusRequester),
                    decorationBox = { inner ->
                        if (searchQuery.isEmpty()) {
                            Text("Search people…", color = TextMuted, style = MaterialTheme.typography.bodyMedium)
                        }
                        inner()
                    }
                )
            }
            IconButton(onClick = onSearchClose) {
                Icon(Icons.Default.Close, contentDescription = "Close search", tint = TextSecondary)
            }
        } else {
            // App branding
            Text(
                text = "Zipper",
                style = MaterialTheme.typography.titleLarge.copy(
                    brush = Brush.linearGradient(listOf(BrandPink, BrandPurple)),
                    fontWeight = FontWeight.Bold,
                ),
                modifier = Modifier.weight(1f),
            )
            // Filter button (highlighted when active)
            IconButton(onClick = onFilterClick) {
                Icon(
                    Icons.Default.FilterList,
                    contentDescription = "Filter",
                    tint = if (hasActiveFilter) BrandPink else TextSecondary,
                )
            }
            // Search button
            IconButton(onClick = onSearchClick) {
                Icon(Icons.Default.Search, contentDescription = "Search", tint = TextSecondary)
            }
            // Notifications
            IconButton(onClick = onNotificationClick) {
                Icon(Icons.Default.Notifications, contentDescription = "Notifications", tint = TextSecondary)
            }
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// FILTER TABS (All / Online / Live / Following)
// ──────────────────────────────────────────────────────────────────────────────

@Composable
private fun HomeFilterTabs(activeTab: Int, onTabSelected: (Int) -> Unit) {
    val tabs = listOf("All", "Online", "🔴 Live", "Following")
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        tabs.forEachIndexed { index, label ->
            FilterChip(
                selected = activeTab == index,
                onClick = { onTabSelected(index) },
                label = { Text(label, style = MaterialTheme.typography.labelMedium) },
                colors = FilterChipDefaults.filterChipColors(
                    selectedContainerColor = BrandPink,
                    selectedLabelColor = Color.White,
                    containerColor = AppSurface,
                    labelColor = TextSecondary,
                ),
                border = FilterChipDefaults.filterChipBorder(
                    enabled = true,
                    selected = activeTab == index,
                    borderColor = OutlineDefault,
                    selectedBorderColor = BrandPink,
                ),
            )
        }
    }
    Spacer(Modifier.height(8.dp))
}

// ──────────────────────────────────────────────────────────────────────────────
// USER CARD (2-column grid item)
// ──────────────────────────────────────────────────────────────────────────────

@Composable
fun UserCard(profile: UserProfile, onClick: () -> Unit) {
    val level = VirtualEconomyMath.userLevelFromDiamondsSpent(profile.totalDiamondsSpent)
    val ringColors = levelRingColors(level)

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(0.72f)
            .clip(RoundedCornerShape(16.dp))
            .clickable(onClick = onClick),
    ) {
        // Avatar
        AsyncImage(
            model = profile.photoUrl.ifBlank { null },
            contentDescription = profile.name,
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize(),
        )
        // Default gradient placeholder when no photo
        if (profile.photoUrl.isBlank()) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(
                        Brush.linearGradient(listOf(BrandPurple.copy(alpha = 0.6f), BrandPink.copy(alpha = 0.4f)))
                    ),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = profile.name.take(1).uppercase(),
                    style = MaterialTheme.typography.displaySmall,
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                )
            }
        }

        // Gradient scrim at bottom
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(100.dp)
                .align(Alignment.BottomCenter)
                .background(
                    Brush.verticalGradient(
                        listOf(Color.Transparent, Color.Black.copy(alpha = 0.85f))
                    )
                )
        )

        // Bottom info
        Column(
            modifier = Modifier
                .align(Alignment.BottomStart)
                .padding(10.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = profile.name,
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color.White,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (profile.faceVerificationStatus == "APPROVED") {
                    Spacer(Modifier.width(3.dp))
                    Icon(
                        Icons.Default.Verified,
                        contentDescription = "Verified",
                        tint = Color(0xFF00C8FF),
                        modifier = Modifier.size(14.dp),
                    )
                }
            }
            val subtitle = buildString {
                if (profile.age > 0) append(profile.age)
                if (profile.age > 0 && profile.city.isNotBlank()) append(", ")
                if (profile.city.isNotBlank()) append(profile.city)
            }
            if (subtitle.isNotBlank()) {
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.labelSmall,
                    color = Color.White.copy(alpha = 0.7f),
                    maxLines = 1,
                )
            }
        }

        // Top-right badges
        Column(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(6.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
            horizontalAlignment = Alignment.End,
        ) {
            if (profile.isLive) {
                LiveBadge()
            } else if (profile.isOnline) {
                OnlineDot()
            }
            if (level > 0) {
                LevelBadge(level)
            }
        }

        // Level ring border
        if (level > 0) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .border(
                        width = 2.dp,
                        brush = Brush.linearGradient(ringColors),
                        shape = RoundedCornerShape(16.dp),
                    )
            )
        }
    }
}

@Composable
private fun LiveBadge() {
    Box(
        modifier = Modifier
            .background(BrandPink, RoundedCornerShape(4.dp))
            .padding(horizontal = 5.dp, vertical = 2.dp),
    ) {
        Text("LIVE", color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun OnlineDot() {
    Box(
        modifier = Modifier
            .size(10.dp)
            .background(Color(0xFF00E676), CircleShape)
            .border(1.dp, Color.Black.copy(alpha = 0.3f), CircleShape)
    )
}

@Composable
private fun LevelBadge(level: Int) {
    val colors = levelRingColors(level)
    Box(
        modifier = Modifier
            .background(
                Brush.linearGradient(colors),
                RoundedCornerShape(4.dp),
            )
            .padding(horizontal = 5.dp, vertical = 2.dp),
    ) {
        Text("Lv.$level", color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Bold)
    }
}

private fun levelRingColors(level: Int): List<Color> = when {
    level >= 10 -> listOf(Color(0xFFFFD700), Color(0xFFFF6B00))   // Gold
    level >= 7  -> listOf(Color(0xFFE040FB), Color(0xFF7C4DFF))   // Purple
    level >= 5  -> listOf(Color(0xFFFF2D78), Color(0xFF7B2FBE))   // Pink-purple
    level >= 3  -> listOf(Color(0xFF40C4FF), Color(0xFF00B0FF))   // Blue
    level >= 1  -> listOf(Color(0xFF69F0AE), Color(0xFF00E676))   // Green
    else        -> listOf(Color.Transparent, Color.Transparent)
}

// ──────────────────────────────────────────────────────────────────────────────
// EMPTY STATE
// ──────────────────────────────────────────────────────────────────────────────

@Composable
private fun EmptyState(isSearch: Boolean) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                if (isSearch) "No results found" else "No users yet",
                style = MaterialTheme.typography.titleMedium,
                color = TextSecondary,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                if (isSearch) "Try a different name" else "Check back soon!",
                style = MaterialTheme.typography.bodySmall,
                color = TextMuted,
            )
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// FILTER BOTTOM SHEET
// ──────────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun FilterBottomSheet(
    sheetState: androidx.compose.material3.SheetState,
    currentCity: String,
    currentLanguage: String,
    currentHobbies: Set<String>,
    currentAgeMin: Float = 18f,
    currentAgeMax: Float = 60f,
    currentGender: String = "",
    onApply: (city: String, language: String, hobbies: Set<String>, ageMin: Float, ageMax: Float, gender: String) -> Unit,
    onDismiss: () -> Unit,
) {
    var city by remember { mutableStateOf(currentCity) }
    var language by remember { mutableStateOf(currentLanguage) }
    var hobbies by remember { mutableStateOf(currentHobbies) }
    var ageRange by remember { mutableStateOf(currentAgeMin..currentAgeMax) }
    var gender by remember { mutableStateOf(currentGender) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = AppSurface,
        dragHandle = { BottomSheetDefaults.DragHandle() },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .padding(bottom = 32.dp),
        ) {
            Text("Filter", style = MaterialTheme.typography.titleMedium, color = TextPrimary)
            Spacer(Modifier.height(20.dp))

            // Age range
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Age Range", style = MaterialTheme.typography.labelMedium, color = TextMuted)
                Text(
                    "${ageRange.start.toInt()} – ${ageRange.endInclusive.toInt()}",
                    style = MaterialTheme.typography.labelMedium,
                    color = BrandPink,
                )
            }
            Spacer(Modifier.height(4.dp))
            RangeSlider(
                value = ageRange,
                onValueChange = { ageRange = it },
                valueRange = 18f..60f,
                steps = 0,
                modifier = Modifier.fillMaxWidth(),
                colors = SliderDefaults.colors(
                    thumbColor = BrandPink,
                    activeTrackColor = BrandPink,
                    inactiveTrackColor = OutlineDefault,
                ),
            )

            Spacer(Modifier.height(16.dp))

            // Gender chips
            Text("Gender", style = MaterialTheme.typography.labelMedium, color = TextMuted)
            Spacer(Modifier.height(6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("" to "All", "Male" to "Male", "Female" to "Female").forEach { (value, label) ->
                    FilterChip(
                        selected = gender == value,
                        onClick = { gender = value },
                        label = { Text(label, style = MaterialTheme.typography.labelSmall) },
                        colors = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = BrandPink,
                            selectedLabelColor = Color.White,
                            containerColor = AppBackground,
                            labelColor = TextSecondary,
                        ),
                    )
                }
            }

            Spacer(Modifier.height(16.dp))

            // City
            Text("City", style = MaterialTheme.typography.labelMedium, color = TextMuted)
            Spacer(Modifier.height(6.dp))
            BasicTextField(
                value = city,
                onValueChange = { city = it },
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyMedium.copy(color = TextPrimary),
                cursorBrush = SolidColor(BrandPink),
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(10.dp))
                    .background(AppBackground)
                    .border(1.dp, OutlineDefault, RoundedCornerShape(10.dp))
                    .padding(12.dp),
                decorationBox = { inner ->
                    if (city.isEmpty()) Text("Any city", color = TextMuted)
                    inner()
                }
            )

            Spacer(Modifier.height(16.dp))

            // Language chips
            Text("Language", style = MaterialTheme.typography.labelMedium, color = TextMuted)
            Spacer(Modifier.height(6.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                LANGUAGES.forEach { lang ->
                    FilterChip(
                        selected = language == lang,
                        onClick = { language = if (language == lang) "" else lang },
                        label = { Text(lang, style = MaterialTheme.typography.labelSmall) },
                        colors = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = BrandPink,
                            selectedLabelColor = Color.White,
                            containerColor = AppBackground,
                            labelColor = TextSecondary,
                        ),
                    )
                }
            }

            Spacer(Modifier.height(16.dp))

            // Hobby chips
            Text("Hobbies", style = MaterialTheme.typography.labelMedium, color = TextMuted)
            Spacer(Modifier.height(6.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                HOBBIES.forEach { hobby ->
                    FilterChip(
                        selected = hobby in hobbies,
                        onClick = {
                            hobbies = if (hobby in hobbies) hobbies - hobby else hobbies + hobby
                        },
                        label = { Text(hobby, style = MaterialTheme.typography.labelSmall) },
                        colors = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = BrandPurple,
                            selectedLabelColor = Color.White,
                            containerColor = AppBackground,
                            labelColor = TextSecondary,
                        ),
                    )
                }
            }

            Spacer(Modifier.height(24.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                TextButton(
                    onClick = {
                        city = ""; language = ""; hobbies = emptySet()
                        ageRange = 18f..60f; gender = ""
                        onApply("", "", emptySet(), 18f, 60f, "")
                    },
                    modifier = Modifier.weight(1f),
                ) {
                    Text("Clear All", color = TextMuted)
                }
                Box(
                    modifier = Modifier
                        .weight(2f)
                        .clip(RoundedCornerShape(12.dp))
                        .background(Brush.linearGradient(listOf(BrandPink, BrandPurple)))
                        .clickable { onApply(city, language, hobbies, ageRange.start, ageRange.endInclusive, gender) }
                        .padding(vertical = 14.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("Apply Filters", color = Color.White, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

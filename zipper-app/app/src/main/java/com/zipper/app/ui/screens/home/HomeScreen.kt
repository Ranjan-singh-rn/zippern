package com.zipper.app.ui.screens.home

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
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
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.FilterList
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.Explore
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.PersonSearch
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.zipper.app.ui.components.*
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Size
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import com.zipper.app.util.ALL_LANGUAGES

/*
 * Home / Discover — Figma "01 Home" (41:2).
 *
 *   Top bar 56 on bg/raised: "Zipper" wordmark (Bold 24, brand), diamond
 *   pill, filter (with an 8dp brand dot when active), search.
 *   Grid: 2 columns, 12dp gutters and padding, cards 162×220.
 *
 * The feed reads `publicProfiles` (the projection), never `users`.
 */

private val HOBBY_OPTIONS = listOf(
    "Travelling", "Dancing", "Singing", "Gaming", "Reading",
    "Fitness", "Cooking", "Photography", "Movies", "Sports",
    "Music", "Art", "Fashion", "Tech", "Yoga",
)
private val LIKE_OPTIONS = listOf(
    "Friendship", "Dating", "Long Talks", "Video Calls", "Live Streaming",
    "Music", "Party Rooms", "Gaming", "Shopping", "Travel",
)

@Composable
fun HomeScreen(
    onNavigateToProfile: (uid: String) -> Unit = {},
    onWatchLive: (roomId: String) -> Unit = {},
    onNavigateToDiamondShop: () -> Unit = {},
    onNavigateToPartyRooms: () -> Unit = {},
    viewModel: HomeViewModel = hiltViewModel(),
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    val focusManager = LocalFocusManager.current

    ZipperScreen(
        topBar = {
            Column {
                HomeTopBar(
                    showSearch = state.showSearchBar,
                    query = state.searchQuery,
                    filterActive = state.filters.isActive,
                    diamonds = state.currentUserDiamonds,
                    onSearchToggle = viewModel::toggleSearchBar,
                    onQueryChange = viewModel::onSearchQueryChange,
                    onSearchSubmit = { focusManager.clearFocus(); viewModel.searchByUid(state.searchQuery) },
                    onClearSearch = viewModel::clearSearch,
                    onFilterTap = viewModel::toggleFilterSheet,
                    onDiamondsTap = onNavigateToDiamondShop,
                )
                // Party rooms have no tab of their own, and "Party Rooms" in the
                // interests filter is a thing to be matched on rather than a way
                // in. Discover is where people already are, so the way in lives
                // here — one row, no media, above the feed.
                if (!state.showSearchBar) PartyRoomsEntry(onNavigateToPartyRooms)
            }
        },
    ) { _ ->
        when {
            state.isLoading -> LoadingState()

            state.searchResult != null -> {
                val user = state.searchResult!!
                Column(Modifier.fillMaxSize().padding(Space.md)) {
                    Text("Search result", style = ZipperTheme.type.caption, color = c.textSecondary, modifier = Modifier.padding(bottom = Space.sm))
                    UserCard(user, Modifier.width(162.dp)) { onNavigateToProfile(user.uid) }
                }
            }

            state.searchNotFound -> EmptyState(
                icon = Icons.Outlined.PersonSearch,
                title = "No one has that ID",
                body = "Check the Zipper ID and try again — it's on their profile under the name.",
                actionLabel = "Clear search", onAction = viewModel::clearSearch,
            )

            state.users.isEmpty() -> EmptyState(
                icon = Icons.Outlined.Explore,
                title = if (state.filters.isActive) "Nobody matches these filters" else "Nobody's around yet",
                body = if (state.filters.isActive) "Loosen a filter or two to see more people." else "Pull down in a moment — people come online all day.",
                actionLabel = if (state.filters.isActive) "Clear filters" else null,
                onAction = if (state.filters.isActive) viewModel::clearFilters else null,
            )

            else -> DiscoverGrid(state, viewModel::loadMore) { user ->
                if (user.isLive && user.liveRoomId.isNotBlank()) onWatchLive(user.liveRoomId)
                else onNavigateToProfile(user.uid)
            }
        }
    }

    if (state.showFilterSheet) {
        FilterSheet(
            filters = state.filters,
            onDismiss = viewModel::toggleFilterSheet,
            onCountryChange = viewModel::setCountryFilter,
            onLanguageChange = viewModel::setLanguageFilter,
            onToggleHobby = viewModel::toggleHobbyFilter,
            onToggleLike = viewModel::toggleLikeFilter,
            onVerifiedOnly = viewModel::setVerifiedHostsOnly,
            onClearAll = viewModel::clearFilters,
        )
    }
}

// ── Grid ─────────────────────────────────────────────────────────────────────

@Composable
private fun DiscoverGrid(
    state: HomeUiState,
    onLoadMore: () -> Unit,
    onOpen: (com.zipper.app.data.model.PublicProfile) -> Unit,
) {
    val c = ZipperTheme.colors
    val gridState = rememberLazyGridState()
    val nearEnd by remember {
        derivedStateOf {
            val info = gridState.layoutInfo
            (info.visibleItemsInfo.lastOrNull()?.index ?: 0) >= info.totalItemsCount - 4
        }
    }
    LaunchedEffect(nearEnd) { if (nearEnd) onLoadMore() }

    LazyVerticalGrid(
        state = gridState,
        columns = GridCells.Fixed(2),
        contentPadding = PaddingValues(Space.md),
        horizontalArrangement = Arrangement.spacedBy(Space.md),
        verticalArrangement = Arrangement.spacedBy(Space.md),
        modifier = Modifier.fillMaxSize(),
    ) {
        items(state.users, key = { it.uid }) { user -> UserCard(user) { onOpen(user) } }
        if (state.isLoadingMore) {
            item(span = { GridItemSpan(2) }) {
                Box(Modifier.fillMaxWidth().padding(Space.lg), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = c.brandPrimary, modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
                }
            }
        }
        if (!state.hasMore && state.users.isNotEmpty()) {
            item(span = { GridItemSpan(2) }) {
                Text(
                    "You've seen everyone online",
                    style = ZipperTheme.type.caption, color = c.textMuted,
                    modifier = Modifier.fillMaxWidth().padding(vertical = Space.lg),
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
            }
        }
    }
}

// ── Party rooms entry ────────────────────────────────────────────────────────

@Composable
private fun PartyRoomsEntry(onClick: () -> Unit) {
    val c = ZipperTheme.colors
    Column(Modifier.fillMaxWidth().background(c.bgRaised)) {
        Row(
            Modifier.fillMaxWidth().clickableNoRipple(onClick)
                .padding(start = Space.lg, end = Space.lg, top = Space.sm, bottom = Space.sm),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            Box(
                Modifier.size(36.dp).background(c.tintVioletSubtle, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Outlined.Groups, null, tint = c.brandSecondary, modifier = Modifier.size(Size.Icon.md))
            }
            Column(Modifier.weight(1f)) {
                Text("Party Rooms", style = ZipperTheme.type.labelM, color = c.textPrimary)
                Text(
                    "Audio and video rooms you can join and take a seat in",
                    style = ZipperTheme.type.caption, color = c.textSecondary,
                    maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                )
            }
            Icon(Icons.Default.ChevronRight, null, tint = c.textMuted, modifier = Modifier.size(Size.Icon.md))
        }
        HairlineDivider()
    }
}

// ── Top bar ──────────────────────────────────────────────────────────────────

@Composable
private fun HomeTopBar(
    showSearch: Boolean,
    query: String,
    filterActive: Boolean,
    diamonds: Long,
    onSearchToggle: () -> Unit,
    onQueryChange: (String) -> Unit,
    onSearchSubmit: () -> Unit,
    onClearSearch: () -> Unit,
    onFilterTap: () -> Unit,
    onDiamondsTap: () -> Unit,
) {
    val c = ZipperTheme.colors
    val focus = remember { FocusRequester() }

    Column(Modifier.fillMaxWidth().background(c.bgRaised)) {
        Row(
            Modifier.fillMaxWidth().height(Size.Bar.top).padding(start = Space.lg, end = Space.sm),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            if (showSearch) {
                LaunchedEffect(Unit) { focus.requestFocus() }
                Row(
                    Modifier.weight(1f).height(40.dp).background(c.bgElevated, CircleShape)
                        .border(1.dp, c.borderSubtle, CircleShape).padding(start = 14.dp, end = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Default.Search, null, tint = c.textMuted, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    BasicTextField(
                        value = query, onValueChange = onQueryChange, singleLine = true,
                        textStyle = ZipperTheme.type.bodyM.copy(color = c.textPrimary),
                        cursorBrush = SolidColor(c.brandPrimary),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Search),
                        keyboardActions = KeyboardActions(onSearch = { onSearchSubmit() }),
                        modifier = Modifier.weight(1f).focusRequester(focus),
                        decorationBox = { inner ->
                            if (query.isEmpty()) Text("Search by Zipper ID", style = ZipperTheme.type.bodyM, color = c.textMuted)
                            inner()
                        },
                    )
                    IconButtonCircle(Icons.Default.Close, "Close search", { onClearSearch(); onSearchToggle() }, size = 28.dp, background = androidx.compose.ui.graphics.Color.Transparent, tint = c.textSecondary)
                }
            } else {
                Text("Zipper", style = ZipperTheme.type.headingL, color = c.brandPrimary)
                Spacer(Modifier.weight(1f))
                CurrencyPill(Currency.Diamond, diamonds, onClick = onDiamondsTap)
                Box {
                    IconButtonCircle(Icons.Default.FilterList, "Filter", onFilterTap, background = androidx.compose.ui.graphics.Color.Transparent)
                    if (filterActive) {
                        Box(Modifier.align(Alignment.TopEnd).padding(top = 10.dp, end = 10.dp).size(8.dp).background(c.brandPrimary, CircleShape))
                    }
                }
                IconButtonCircle(Icons.Default.Search, "Search", onSearchToggle, background = androidx.compose.ui.graphics.Color.Transparent)
            }
        }
        HairlineDivider()
    }
}

// ── Filter sheet ─────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun FilterSheet(
    filters: HomeFilters,
    onDismiss: () -> Unit,
    onCountryChange: (String) -> Unit,
    onLanguageChange: (String) -> Unit,
    onToggleHobby: (String) -> Unit,
    onToggleLike: (String) -> Unit,
    onVerifiedOnly: (Boolean) -> Unit,
    onClearAll: () -> Unit,
) {
    val c = ZipperTheme.colors
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var countryInput by remember { mutableStateOf(filters.country) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = c.bgElevated,
        dragHandle = null,
        shape = RoundedCornerShape(topStart = Radius.xl, topEnd = Radius.xl),
    ) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
            Box(Modifier.padding(top = 6.dp).size(36.dp, 4.dp).background(c.borderDefault, CircleShape).align(Alignment.CenterHorizontally))
            Row(
                Modifier.fillMaxWidth().padding(horizontal = Space.lg, vertical = Space.md),
                horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Filters", style = ZipperTheme.type.headingS, color = c.textPrimary)
                Row(horizontalArrangement = Arrangement.spacedBy(Space.lg)) {
                    AnimatedVisibility(filters.isActive) {
                        Text("Clear all", style = ZipperTheme.type.labelM, color = c.statusDanger, modifier = Modifier.clickableNoRipple(onClearAll))
                    }
                    Text("Done", style = ZipperTheme.type.labelM, color = c.textBrand, modifier = Modifier.clickableNoRipple(onDismiss))
                }
            }
            HairlineDivider()

            LazyColumn(
                Modifier.fillMaxWidth().weight(1f, fill = false),
                contentPadding = PaddingValues(horizontal = Space.lg, vertical = Space.md),
                verticalArrangement = Arrangement.spacedBy(Space.xl),
            ) {
                item {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("Verified hosts only", style = ZipperTheme.type.labelM, color = c.textPrimary)
                            Text("Identity-checked hosts you can call", style = ZipperTheme.type.caption, color = c.textSecondary)
                        }
                        Switch(
                            checked = filters.verifiedHostsOnly, onCheckedChange = onVerifiedOnly,
                            colors = SwitchDefaults.colors(checkedThumbColor = c.textOnBrand, checkedTrackColor = c.brandPrimary),
                        )
                    }
                }
                item {
                    FilterLabel("Country")
                    Row(
                        Modifier.fillMaxWidth().height(44.dp).background(c.bgRaised, RoundedCornerShape(Radius.md))
                            .border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.md)).padding(horizontal = Space.md),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        BasicTextField(
                            value = countryInput,
                            onValueChange = { countryInput = it; onCountryChange(it) },
                            singleLine = true,
                            textStyle = ZipperTheme.type.bodyM.copy(color = c.textPrimary),
                            cursorBrush = SolidColor(c.brandPrimary),
                            modifier = Modifier.weight(1f),
                            decorationBox = { inner ->
                                if (countryInput.isEmpty()) Text("e.g. India", style = ZipperTheme.type.bodyM, color = c.textMuted)
                                inner()
                            },
                        )
                        if (countryInput.isNotBlank()) {
                            Icon(Icons.Default.Close, "Clear", tint = c.textSecondary,
                                modifier = Modifier.size(16.dp).clickableNoRipple { countryInput = ""; onCountryChange("") })
                        }
                    }
                }
                item {
                    FilterLabel("Language")
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                        ALL_LANGUAGES.take(20).forEach { lang ->
                            val on = filters.languageCode == lang.code
                            SelectChip(lang.name, on) { onLanguageChange(if (on) "" else lang.code) }
                        }
                    }
                }
                item {
                    FilterLabel("Hobbies")
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                        HOBBY_OPTIONS.forEach { h -> SelectChip(h, h in filters.hobbies) { onToggleHobby(h) } }
                    }
                }
                item {
                    FilterLabel("Interests")
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                        LIKE_OPTIONS.forEach { l -> SelectChip(l, l in filters.likes) { onToggleLike(l) } }
                    }
                }
                item { Spacer(Modifier.height(Space.sm)) }
            }
        }
    }
}

@Composable
private fun FilterLabel(text: String) {
    Text(text, style = ZipperTheme.type.labelM, color = ZipperTheme.colors.textPrimary, modifier = Modifier.padding(bottom = Space.sm))
}

/** Selectable chip: 32h, full radius; brand tint + brand border when on. */
@Composable
fun SelectChip(text: String, selected: Boolean, onClick: () -> Unit) {
    val c = ZipperTheme.colors
    Box(
        Modifier.height(32.dp)
            .background(if (selected) c.tintBrandMedium else c.bgRaised, CircleShape)
            .border(1.dp, if (selected) c.brandPrimary else c.borderSubtle, CircleShape)
            .clickableNoRipple(onClick)
            .padding(horizontal = 14.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, style = ZipperTheme.type.labelS, color = if (selected) c.textPrimary else c.textSecondary, maxLines = 1)
    }
}

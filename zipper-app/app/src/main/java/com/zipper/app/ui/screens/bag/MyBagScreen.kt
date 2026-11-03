package com.zipper.app.ui.screens.bag

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import coil.request.ImageRequest
import com.airbnb.lottie.compose.LottieAnimation
import com.airbnb.lottie.compose.LottieCompositionSpec
import com.airbnb.lottie.compose.LottieConstants
import com.airbnb.lottie.compose.animateLottieCompositionAsState
import com.airbnb.lottie.compose.rememberLottieComposition
import com.zipper.app.data.model.BagItem
import com.zipper.app.ui.components.*
import com.zipper.app.ui.screens.home.SelectChip
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme

/*
 * My bag — Figma "07 My bag", "02 My Bag — Avatar frames", "03 Entrance effects".
 *
 *   Top bar: back, "My Bag", diamond balance pill.
 *   Category chip rail (frames, chat bubbles, profile cards, ID frames,
 *   entrances, video cards).
 *   3-column grid of glass tiles: preview, name, price / Owned / Equipped.
 *   Tapping a tile opens the detail sheet: large preview, description,
 *   duration, Buy (gradient) / Equip (secondary).
 *
 * The catalog, ownership and equip state all come from MyBagViewModel; the
 * per-item art below (tier rings, gradients, bundled Lottie) is the fallback
 * when an item has no animationUrl.
 */

// ── Frame tier colour system ──────────────────────────────────────────────────

private enum class FrameTier { SILVER, BRONZE, GOLD, PURPLE, ROYAL, NEON, GALAXY, COSMIC }

private data class TierPalette(val ring1: Color, val ring2: Color, val glow: Color)

private val TIER: Map<FrameTier, TierPalette> = mapOf(
    FrameTier.SILVER to TierPalette(Color(0xFF4A4A4A), Color(0xFFA8A8A8), Color(0xFFDCDCDC)),
    FrameTier.BRONZE to TierPalette(Color(0xFF6B3A2A), Color(0xFFCD7F32), Color(0xFFE8A867)),
    FrameTier.GOLD   to TierPalette(Color(0xFF8B6914), Color(0xFFFFD700), Color(0xFFFFF176)),
    FrameTier.PURPLE to TierPalette(Color(0xFF4B0082), Color(0xFF9400D3), Color(0xFFDA70D6)),
    FrameTier.ROYAL  to TierPalette(Color(0xFF7B0000), Color(0xFFFFD700), Color(0xFFFF4500)),
    FrameTier.NEON   to TierPalette(Color(0xFF006080), Color(0xFF00CED1), Color(0xFFFF69B4)),
    FrameTier.GALAXY to TierPalette(Color(0xFF0D0D3D), Color(0xFF6A0DAD), Color(0xFF1E90FF)),
    FrameTier.COSMIC to TierPalette(Color(0xFF0A3300), Color(0xFF00CC44), Color(0xFF80FF00)),
)

private fun tierOf(id: String) = when (id) {
    "af_basic"  -> FrameTier.SILVER
    "af_bronze" -> FrameTier.BRONZE
    "af_silver" -> FrameTier.SILVER
    "af_gold"   -> FrameTier.GOLD
    "af_royal"  -> FrameTier.ROYAL
    "af_dragon" -> FrameTier.COSMIC
    "af_neon"   -> FrameTier.NEON
    "af_galaxy" -> FrameTier.GALAXY
    "af_event1" -> FrameTier.PURPLE
    else        -> FrameTier.SILVER
}

// ── Bundled Lottie asset map (fallback when animationUrl is empty) ────────────
// Entrances ship with bundled JSON. Frames/bubbles/cards/banners are served from
// Firebase Storage (animationUrl) — add bundled fallbacks here once assets are added.

/*
 * Decode sizes for the two places bag art is shown, in pixels.
 *
 * Coil decodes to the size it is given rather than to the file's own
 * resolution. The entrance stills are up to 212 KB of full-portrait WebP, and
 * decoded at native size a screenful of them is tens of megabytes of bitmap
 * for art that occupies a 54 dp box.
 */
private const val THUMB_PX = 192
private const val PREVIEW_PX = 512

/**
 * How near an expiry has to be before the screen says so unprompted.
 *
 * A timed cosmetic that lapses silently is indistinguishable from one the app
 * lost, and the user's next move is a support ticket rather than a renewal.
 */
private const val EXPIRY_WARNING_DAYS = 3

private val LOTTIE: Map<String, String> = mapOf(
    "en_bike"   to "lottie/entries/entry_level6_bike.json",
    "en_sports" to "lottie/entries/entry_level8_sports.json",
    "en_lambo"  to "lottie/entries/entry_level10_lambo.json",
    "en_tiger"  to "lottie/entries/entry_tiger.json",
    "en_king"   to "lottie/entries/entry_king.json",
    "en_horse"  to "lottie/entries/entry_horse.json",
    "en_ship"   to "lottie/entries/entry_ship.json",
    "en_jet"    to "lottie/entries/entry_jet.json",
    "en_rocket" to "lottie/entries/entry_rocket.json",
    "en_yamraj" to "lottie/entries/entry_special_yamraj.json",
    "en_vip"    to "lottie/entries/entry_vip_plane.json",
)

/**
 * A **bundled** Lottie for this item, or null.
 *
 * ## Why the remote `animationUrl` is deliberately not playable here
 *
 * The entrance animations in Firebase Storage are image-sequence Lotties:
 * `en_jet.json` is 22.3 MB, and 22.26 MB of that is 237 base64-embedded WebP
 * frames at 1082×1912. Lottie has to decode those into Android bitmaps to draw
 * them, and 1082 × 1912 × 4 bytes is 8.3 MB per frame — so ONE of these
 * entrances asks the device for roughly two gigabytes of bitmap. The grid used
 * to start eleven of them at once, each looping forever, each on its own frame
 * clock.
 *
 * That is the freeze. It is not a rendering-tuning problem that a cache or a
 * lower frame rate would soften: the device is being asked to allocate more
 * memory than it has, and a flagship stalls on it exactly like a budget phone
 * does. Chamet and HiClub feel smooth here for two reasons — their grids show
 * a still image and never an animation, and their entrance format (SVGA, and
 * lately PAG) stores each sprite once and moves it with a transform per frame
 * instead of storing a full-screen picture per frame, so a comparable entrance
 * is one or two megabytes rather than twenty-two.
 *
 * Until those assets are re-encoded (see `FONTS.md`'s sibling note and the
 * TODO in `GiftAnimationOverlay.kt`), anything remote is shown as its still
 * `previewUrl`. The bundled assets are a different matter — they are 28 KB to
 * 284 KB of real vector Lottie, which is what the format is for, and one of
 * them playing alone in a sheet costs nothing.
 */
private fun bundledLottieSpecFor(item: BagItem): LottieCompositionSpec? = when {
    item.animationAsset.isNotBlank() && !item.animationAsset.endsWith(".svga") ->
        LottieCompositionSpec.Asset(item.animationAsset)
    LOTTIE[item.id] != null -> LottieCompositionSpec.Asset(LOTTIE[item.id]!!)
    else -> null
}

// ── Tab data ──────────────────────────────────────────────────────────────────

private data class TabInfo(val label: String, val category: String)

private val TABS = listOf(
    TabInfo("Avatar frames", "frame"),
    TabInfo("Chat bubbles",  "chat_bubble"),
    TabInfo("Profile cards", "profile_card"),
    TabInfo("ID frames",     "id_frame"),
    TabInfo("Entrances",     "entrance"),
    TabInfo("Video cards",   "video_card"),
)

// ── Screen ────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MyBagScreen(
    videoCards: Int = 0,
    onBack: () -> Unit = {},
    onEquip: (BagItem) -> Unit = {},
    onBuy: (BagItem) -> Unit = {},
    viewModel: MyBagViewModel = hiltViewModel(),
) {
    val vmState by viewModel.state.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    var selectedTabIdx by remember { mutableIntStateOf(0) }
    var selectedItemId by remember { mutableStateOf<String?>(null) }

    // Toast — consumed and cleared after read
    val toastMsg = vmState.toastMessage
    LaunchedEffect(toastMsg) { if (toastMsg != null) viewModel.clearToast() }
    val loadError = vmState.loadError

    val tab = TABS[selectedTabIdx]
    val isVideoCardTab = tab.category == "video_card"

    /*
     * One clock reading for the whole screen.
     *
     * `isOwned`, the expiring-soon notice and every "N days left" are three
     * answers to the same question, and three separate calls to
     * currentTimeMillis() can disagree — across midnight, by a whole day. Re-read
     * when ownership changes, which is when a renewal has just landed.
     */
    val nowMs = remember(vmState.ownedById) { System.currentTimeMillis() }

    /*
     * Merge the Firestore catalogue with what this account owns.
     *
     * Remembered on the things it actually depends on. It used to filter the
     * whole catalogue and allocate a fresh copy of every item on EVERY
     * recomposition — including the ones a chip press or a sheet opening
     * causes — which meant the grid's `key` lambdas saw new instances and
     * Compose re-diffed a list that had not changed.
     *
     * Merged for every category at once rather than per tab, because the
     * expiring-soon notice is about the whole bag and computing it a second time
     * would be a second pass that could disagree with this one.
     */
    val merged = remember(vmState.catalogItems, vmState.ownedById, vmState.equippedByCategory, nowMs) {
        vmState.catalogItems.map { item ->
            val owned = vmState.ownedById[item.id]
            val lapsed = owned?.isExpiredAt(nowMs) == true
            item.copy(
                expiresAt         = owned?.expiresAt ?: 0L,
                expired           = lapsed,
                durationDaysTotal = owned?.durationDaysTotal ?: 0,
                // Owned means owned AND still valid. It used to mean "a row with
                // this id exists", and `expireCosmetics` never deletes the row —
                // so a lapsed cosmetic read as owned for ever, which hid the
                // Buy button and with it every route to the server's renewal.
                //
                // A `level` item with no gate is granted by having an account at
                // all and has no row to lapse.
                isOwned    = (item.source == "level" && item.unlockLevel == 0) || (owned != null && !lapsed),
                isEquipped = vmState.equippedByCategory[item.category] == item.id,
            )
        }
    }
    val items = remember(merged, tab.category, isVideoCardTab) {
        if (isVideoCardTab) emptyList() else merged.filter { it.category == tab.category }
    }
    val expiringSoon = remember(merged, nowMs) {
        merged.filter { it.isOwned && it.isTimed && it.daysLeftAt(nowMs) <= EXPIRY_WARNING_DAYS }
            .sortedBy { it.expiresAt }
    }
    val equippedId = vmState.equippedByCategory[tab.category]
    val selectedItem = selectedItemId?.let { sid -> items.find { it.id == sid } }

    ZipperScreen(
        topBar = {
            TopBar("My Bag", onBack = onBack) {
                // TODO(design): MyBagViewModel does not expose the diamond balance; add it to MyBagUiState and show CurrencyPill(Currency.Diamond, balance) here.
            }
        },
    ) { _ ->
        if (vmState.isLoading) { LoadingState(); return@ZipperScreen }
        Column(Modifier.fillMaxSize()) {
            if (expiringSoon.isNotEmpty()) {
                Notice(
                    title = if (expiringSoon.size == 1) "${expiringSoon.first().name} expires soon"
                            else "${expiringSoon.size} items expire soon",
                    body = expiringSoon.joinToString(" · ") { "${it.name} — ${it.daysLeftAt(nowMs)}d" } +
                        ". Open one to renew it; the days you have left are added to the new term, not replaced.",
                    tint = c.statusDanger,
                    // `horizontal` and `top` are not the same overload — Compose
                    // offers (all), (horizontal, vertical) and (start, top, end,
                    // bottom), and mixing a name from the second with one from the
                    // third resolves to nothing.
                    modifier = Modifier.padding(start = Space.lg, end = Space.lg, top = Space.sm),
                )
            }
            LazyRow(
                contentPadding = PaddingValues(horizontal = Space.lg, vertical = Space.sm),
                horizontalArrangement = Arrangement.spacedBy(Space.sm),
            ) {
                items(TABS.size) { idx ->
                    SelectChip(TABS[idx].label, selectedTabIdx == idx) { selectedTabIdx = idx; selectedItemId = null }
                }
            }
            when {
                isVideoCardTab -> Box(Modifier.fillMaxWidth().weight(1f).padding(Space.xxl), contentAlignment = Alignment.Center) { VideoCardSection(videoCards) }
                // An honest failure, with a way out of it. The alternative used
                // to be 33 invented items at invented prices, none of which
                // exists in `bagItems` — so every tap came back from the server
                // as "That item no longer exists."
                items.isEmpty() && loadError != null -> EmptyState(
                    Icons.Outlined.ErrorOutline, "Couldn't load the shop", loadError,
                    actionLabel = "Try again", onAction = viewModel::retry,
                )
                items.isEmpty() -> EmptyState(Icons.Outlined.Inventory2, "Nothing here yet", "Level up or visit the shop to unlock ${tab.label.lowercase()}.")
                else -> LazyVerticalGrid(
                    columns = GridCells.Fixed(3),
                    modifier = Modifier.fillMaxWidth().weight(1f),
                    contentPadding = PaddingValues(horizontal = Space.lg, vertical = Space.sm),
                    horizontalArrangement = Arrangement.spacedBy(Space.sm),
                    verticalArrangement = Arrangement.spacedBy(Space.sm),
                ) {
                    // `contentType` lets the grid reuse a scrolled-off tile's
                    // node instead of building a new one: every tile in a tab
                    // has the same shape, so they are all interchangeable.
                    items(items, key = { it.id }, contentType = { it.category }) { item ->
                        BagTile(item, isEquipped = item.id == equippedId, nowMs = nowMs) { selectedItemId = item.id }
                    }
                    item(span = { GridItemSpan(3) }) { Spacer(Modifier.navigationBarsPadding()) }
                }
            }
        }
    }

    selectedItem?.let { item ->
        val isWearing = item.id == equippedId
        val isEventLocked = !item.isOwned && item.source == "event"
        val isLevelLocked = !item.isOwned && item.source == "level"
        val daysLeft = item.daysLeftAt(nowMs)

        // The term the user picked, defaulting to the shortest the CRM offers.
        // Keyed on the item so opening a second sheet does not inherit the first
        // one's choice — `remember` alone is positional and this lambda is one
        // position for every item in the grid.
        var chosenDays by remember(item.id) { mutableStateOf(item.durations.firstOrNull()?.days) }
        val chosenDuration = item.durations.find { it.days == chosenDays }
        val priceNow = chosenDuration?.priceDiamonds ?: item.price

        /*
         * Can this be bought right now?
         *
         * Three cases, where only the first used to exist: never owned, owned
         * with an expiry — a renewal, which `purchaseBagItem` implements by
         * extending from the later of now and the current expiry — and lapsed.
         * Gating on `!isOwned` alone made the server's whole extension path
         * unreachable from the app, because the Buy button was the only call
         * site of `purchase` and it vanished the moment the item was owned.
         *
         * `level` items are excluded: they carry a price for display and the
         * server refuses to sell them ("This item unlocks with your level").
         */
        val isRenewal = item.expired || (item.isOwned && item.isTimed)
        val showBuy = (priceNow > 0 || item.durations.isNotEmpty()) &&
            item.source != "event" && item.source != "level" &&
            (!item.isOwned || item.isTimed)

        ModalBottomSheet(
            onDismissRequest = { selectedItemId = null },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = c.bgElevated, dragHandle = null,
            shape = RoundedCornerShape(topStart = Radius.xl, topEnd = Radius.xl),
        ) {
            Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = Space.lg), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(Modifier.padding(top = 6.dp).size(36.dp, 4.dp).background(c.borderDefault, CircleShape))
                Box(
                    Modifier.padding(top = Space.lg).fillMaxWidth().height(200.dp)
                        .background(Brush.verticalGradient(listOf(c.tintVioletSubtle, Color.Transparent))),
                    contentAlignment = Alignment.Center,
                ) { ItemPreviewLarge(item) }
                Column(Modifier.fillMaxWidth().padding(horizontal = Space.lg), verticalArrangement = Arrangement.spacedBy(Space.xs)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                        Text(item.name, style = ZipperTheme.type.headingS, color = c.textPrimary, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        when {
                            item.expired -> Chip("Expired", tint = c.tintDangerSubtle, contentColor = c.statusDanger)
                            isWearing -> Chip("Equipped", tint = c.tintSuccessSubtle, contentColor = c.statusSuccess, icon = Icons.Default.Check)
                            item.isOwned -> Chip("Owned")
                        }
                    }
                    Text(
                        when {
                            item.expired -> "This has expired and is no longer worn. Renew it to get it back — nothing else was lost."
                            isEventLocked -> "Event exclusive — earned by taking part in a Zipper event."
                            isLevelLocked -> "Unlocks automatically at level ${item.unlockLevel}."
                            item.source == "event" -> "Earned in a Zipper event."
                            else -> "${TABS.first { it.category == item.category }.label.dropLast(1)} that shows on your profile and in rooms."
                        },
                        style = ZipperTheme.type.bodyS, color = c.textSecondary,
                    )
                    Row(Modifier.padding(top = Space.xs), horizontalArrangement = Arrangement.spacedBy(Space.lg)) {
                        Column {
                            Text("Duration", style = ZipperTheme.type.caption, color = c.textMuted)
                            /*
                             * The item's real term, not a guess.
                             *
                             * This said `if (source == "event") "28 days" else
                             * "Eternal"`, which told every buyer of a timed
                             * cosmetic that what they were buying was permanent
                             * — the one claim the purchase could not keep.
                             */
                            Text(
                                when {
                                    chosenDuration != null -> "${chosenDuration.days} days"
                                    item.durationDaysTotal > 0 -> "${item.durationDaysTotal} days"
                                    // Owned, timed, but bought before the term
                                    // was recorded on the row.
                                    item.isTimed -> "Timed"
                                    else -> "Permanent"
                                },
                                style = ZipperTheme.type.labelM, color = c.textPrimary,
                            )
                        }
                        if (showBuy) Column { Text("Price", style = ZipperTheme.type.caption, color = c.textMuted); Price(Currency.Diamond, priceNow.toLong(), color = c.currencyDiamond) }
                        if (item.isOwned && item.isTimed) Column {
                            Text("Remaining", style = ZipperTheme.type.caption, color = c.textMuted)
                            Text(
                                "$daysLeft day${if (daysLeft == 1) "" else "s"}",
                                style = ZipperTheme.type.labelM,
                                color = if (daysLeft <= EXPIRY_WARNING_DAYS) c.statusWarning else c.textPrimary,
                            )
                        }
                    }

                    // A term to choose, when the CRM offers more than one. The
                    // chosen `days` goes to the server, which prices that row
                    // itself and refuses a term it does not list — so the picker
                    // cannot invent a cheap fortnight.
                    if (item.durations.size > 1) {
                        Column(Modifier.padding(top = Space.xs), verticalArrangement = Arrangement.spacedBy(Space.xs)) {
                            Text("Choose a term", style = ZipperTheme.type.caption, color = c.textMuted)
                            Row(
                                Modifier.horizontalScroll(rememberScrollState()),
                                horizontalArrangement = Arrangement.spacedBy(Space.sm),
                            ) {
                                item.durations.forEach { d ->
                                    SelectChip("${d.days}d · ${indianGrouping(d.priceDiamonds.toLong())}", d.days == chosenDays) {
                                        chosenDays = d.days
                                    }
                                }
                            }
                        }
                    }
                }
                HairlineDivider(Modifier.padding(vertical = Space.lg))
                Row(Modifier.fillMaxWidth().padding(horizontal = Space.lg), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    when {
                        isEventLocked -> Chip("Event exclusive", tint = c.tintBrandSubtle, contentColor = c.textBrand, icon = Icons.Default.Lock)
                        isLevelLocked -> Chip("Reach level ${item.unlockLevel}", tint = c.tintGoldSubtle, contentColor = c.brandVip, icon = Icons.Default.Lock)
                        else -> {
                            if (showBuy) {
                                ZipperButton(
                                    "${if (isRenewal) "Renew" else "Buy"} for ${indianGrouping(priceNow.toLong())}",
                                    { viewModel.purchase(item, chosenDays); onBuy(item) },
                                    modifier = Modifier.weight(1f), size = ButtonSize.Medium, gradient = true,
                                    // One purchase at a time: each tap mints its
                                    // own idempotency key, so two taps are two
                                    // charges the server has no way to collapse.
                                    enabled = vmState.purchasingItemId == null,
                                    loading = vmState.purchasingItemId == item.id,
                                )
                            }
                            if (item.isOwned) {
                                ZipperButton(
                                    if (isWearing) "Equipped" else "Equip",
                                    { viewModel.equip(item); onEquip(item); selectedItemId = null },
                                    modifier = Modifier.weight(1f), style = ButtonStyle.Secondary, size = ButtonSize.Medium, enabled = !isWearing,
                                )
                                // TODO(design): "Unequip" secondary button — MyBagViewModel has no unequip(); add one before wiring.
                            }
                        }
                    }
                }
            }
        }
    }
}

// ── Grid tile ─────────────────────────────────────────────────────────────────

@Composable
private fun BagTile(item: BagItem, isEquipped: Boolean, nowMs: Long, onClick: () -> Unit) {
    val c = ZipperTheme.colors
    val shape = RoundedCornerShape(Radius.lg)
    Column(
        Modifier.aspectRatio(0.86f)
            .background(Brush.verticalGradient(listOf(Color(0x12FFFFFF), Color(0x05FFFFFF))), shape)
            .border(1.dp, if (isEquipped) c.brandPrimary else c.borderSubtle, shape)
            .clip(shape).clickableNoRipple(onClick).padding(Space.sm),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.xs),
    ) {
        Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
            ItemThumbnail(item)
            if (!item.isOwned && item.source != "marketplace") {
                Box(Modifier.matchParentSize().background(c.scrimMedium, RoundedCornerShape(Radius.md)), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(Icons.Default.Lock, null, tint = if (item.source == "event") c.brandPrimary else Color.White, modifier = Modifier.size(16.dp))
                        Text(if (item.source == "event") "Event" else "Lv.${item.unlockLevel}", style = ZipperTheme.type.overline, color = if (item.source == "event") c.brandPrimary else Color.White)
                    }
                }
            }
        }
        Text(item.name, style = ZipperTheme.type.caption, color = if (item.isOwned) c.textPrimary else c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
        when {
            // Expiry first, and before "Equipped": a lapsed item is not being
            // worn — `expireCosmetics` cleared the pointer — and a tile that
            // still said "Equipped" would be describing the pointer this app
            // used to write back.
            item.expired -> Chip("Expired", tint = c.tintDangerSubtle, contentColor = c.statusDanger)
            item.isOwned && item.isTimed -> {
                val left = item.daysLeftAt(nowMs)
                val soon = left <= EXPIRY_WARNING_DAYS
                Chip(
                    "${left}d left",
                    tint = if (soon) c.statusWarning.copy(0.14f) else c.tintSuccessSubtle,
                    contentColor = if (soon) c.statusWarning else c.statusSuccess,
                )
            }
            isEquipped -> Chip("Equipped", tint = c.tintSuccessSubtle, contentColor = c.statusSuccess)
            item.isOwned -> Chip("Owned")
            item.source == "marketplace" && item.price > 0 -> Price(Currency.Diamond, item.price.toLong(), color = c.currencyDiamond)
            else -> Spacer(Modifier.height(22.dp))
        }
    }
}

// ── Notice ────────────────────────────────────────────────────────────────────

/**
 * A tinted callout. Same shape as the one in BuyCoinScreen, which is private to
 * that file; when a third screen needs it, it should move to ui/components.
 */
@Composable
private fun Notice(title: String, body: String, tint: Color, modifier: Modifier = Modifier) {
    val c = ZipperTheme.colors
    Column(
        modifier.fillMaxWidth()
            .background(tint.copy(0.12f), RoundedCornerShape(Radius.md))
            .border(1.dp, tint.copy(0.5f), RoundedCornerShape(Radius.md))
            .padding(Space.md),
        verticalArrangement = Arrangement.spacedBy(Space.xs),
    ) {
        Text(title, style = ZipperTheme.type.labelM, color = tint)
        Text(body, style = ZipperTheme.type.bodyS, color = c.textSecondary)
    }
}

// ── Large sheet preview ───────────────────────────────────────────────────────

@Composable
private fun ItemPreviewLarge(item: BagItem) {
    // B13: an SVGA item previews as itself — a frame loops, an entrance plays with a sample name.
    if (item.svgaUrl.isNotBlank()) {
        com.zipper.app.ui.components.Svga(
            source = item.svgaUrl,
            modifier = Modifier.fillMaxHeight().aspectRatio(if (item.category == "entrance") 750f / 1334f else 1f),
            loops = 0,
            dynamicTexts = mapOf("name" to "You"),
        )
        return
    }
    /*
     * The sheet is the one place an entrance actually animates, and it is
     * exactly one at a time — which is what makes a decoder session affordable
     * here and never affordable in the grid.
     */
    if (item.videoUrl.isNotBlank()) {
        EntranceVideo(
            videoUrl = item.videoUrl,
            posterUrl = item.previewUrl,
            contentDescription = item.name,
            modifier = Modifier.fillMaxHeight().aspectRatio(540f / 954f),
        )
        return
    }
    /*
     * No MP4 yet: a bundled Lottie is real vector art at 28-284 KB, which is
     * what the format is for and costs nothing to play alone. A remote one is
     * the 22 MB image sequence, so it falls through to the still.
     */
    val spec = bundledLottieSpecFor(item)
    if (spec != null) {
        val composition by rememberLottieComposition(spec)
        val progress by animateLottieCompositionAsState(composition, iterations = LottieConstants.IterateForever)
        LottieAnimation(composition = composition, progress = { progress }, modifier = Modifier.size(170.dp))
        return
    }
    if (item.previewUrl.isNotBlank()) {
        AsyncImage(
            model = ImageRequest.Builder(LocalContext.current)
                .data(item.previewUrl)
                .size(PREVIEW_PX)
                .crossfade(true)
                .build(),
            contentDescription = item.name,
            contentScale = ContentScale.Fit,
            modifier = Modifier.size(170.dp),
        )
        return
    }
    when (item.category) {
        "frame" -> {
            val t = TIER[tierOf(item.id)]!!
            Box(contentAlignment = Alignment.Center) {
                Box(
                    Modifier.size(154.dp)
                        .border(10.dp, Brush.sweepGradient(listOf(t.ring1, t.ring2, t.glow, t.ring1)), CircleShape)
                        .padding(12.dp)
                        .border(3.dp, Brush.sweepGradient(listOf(t.glow, t.ring2, t.glow)), CircleShape),
                )
                Box(Modifier.size(116.dp).clip(CircleShape).background(Brush.radialGradient(listOf(Color(0xFF5C2090), Color(0xFF180040)))), contentAlignment = Alignment.Center) {
                    Text("👤", fontSize = 44.sp)
                }
            }
        }
        "chat_bubble" -> {
            val colors = bubbleGradient(item.id)
            Box(
                Modifier.fillMaxWidth(0.75f).height(52.dp)
                    .background(Brush.horizontalGradient(colors), RoundedCornerShape(26.dp))
                    .border(2.dp, Brush.horizontalGradient(colors.map { it.copy(0.4f) }), RoundedCornerShape(26.dp))
                    .padding(horizontal = 22.dp),
                contentAlignment = Alignment.Center,
            ) { Text("Hello everyone! 👋", style = ZipperTheme.type.labelL, color = Color.White) }
        }
        "profile_card" -> {
            val colors = cardGradient(item.id)
            Box(Modifier.width(210.dp).height(88.dp).background(Brush.horizontalGradient(colors), RoundedCornerShape(14.dp)).padding(12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Box(Modifier.size(46.dp).background(Color.White.copy(0.2f), CircleShape), contentAlignment = Alignment.Center) { Text("👤", fontSize = 22.sp) }
                    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text("Username", style = ZipperTheme.type.labelS, color = Color.White)
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            listOf("TOP3", "Lv.5", "India").forEach { tag ->
                                Box(Modifier.background(Color.White.copy(0.25f), RoundedCornerShape(4.dp)).padding(horizontal = 5.dp, vertical = 2.dp)) {
                                    Text(tag, color = Color.White, fontSize = 9.sp)
                                }
                            }
                        }
                    }
                }
            }
        }
        "id_frame" -> {
            val colors = bannerGradient(item.id)
            Box(
                Modifier.fillMaxWidth(0.82f).height(40.dp)
                    .background(Brush.horizontalGradient(colors), RoundedCornerShape(20.dp))
                    .border(1.5.dp, Brush.horizontalGradient(colors.map { it.copy(0.4f) }), RoundedCornerShape(20.dp))
                    .padding(horizontal = 16.dp),
                contentAlignment = Alignment.Center,
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("⭐", fontSize = 12.sp)
                    Text("Username joined the room", style = ZipperTheme.type.labelS, color = Color.White)
                }
            }
        }
        "entrance" -> Box(
            Modifier.size(100.dp).background(Brush.radialGradient(listOf(Color(0xFF6B00A8), Color(0xFF1A0040))), RoundedCornerShape(14.dp)),
            contentAlignment = Alignment.Center,
        ) { Text("🚀", fontSize = 40.sp) }
    }
}

// ── Item thumbnail (small, inside grid tile) ──────────────────────────────────

@Composable
private fun ItemThumbnail(item: BagItem) {
    /*
     * A GRID TILE NEVER ANIMATES. It used to run a full looping Lottie per
     * tile, which is what froze the device on the Entrances tab — see
     * `bundledLottieSpecFor` for the arithmetic.
     *
     * `previewUrl` is the still the upload script already generated and wrote
     * to Firestore (`upload-entry-thumbnails.mjs`); the screen simply never
     * read it. Coil is told the pixel size to decode to, so a 212 KB WebP
     * becomes a bitmap sized for this tile instead of a full-resolution one —
     * without that, thirty tiles of full-size art is its own memory problem.
     */
    if (item.previewUrl.isNotBlank()) {
        AsyncImage(
            model = ImageRequest.Builder(LocalContext.current)
                .data(item.previewUrl)
                .size(THUMB_PX)
                .crossfade(true)
                .build(),
            contentDescription = item.name,
            contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxSize(),
        )
        return
    }
    when (item.category) {
        "frame" -> { val t = TIER[tierOf(item.id)]!!; RingFrameThumb(t.ring1, t.ring2, t.glow, size = 64.dp) }
        "chat_bubble" -> Box(
            Modifier.fillMaxWidth(0.78f).height(30.dp).background(Brush.horizontalGradient(bubbleGradient(item.id)), RoundedCornerShape(15.dp)),
            contentAlignment = Alignment.Center,
        ) { Text("hi", style = ZipperTheme.type.labelS, color = Color.White) }
        "profile_card" -> Box(Modifier.fillMaxWidth(0.88f).height(52.dp).background(Brush.horizontalGradient(cardGradient(item.id)), RoundedCornerShape(8.dp)).padding(7.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                Box(Modifier.size(26.dp).background(Color.White.copy(0.22f), CircleShape), contentAlignment = Alignment.Center) { Text("👤", fontSize = 13.sp) }
                Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Box(Modifier.width(36.dp).height(5.dp).background(Color.White.copy(0.7f), RoundedCornerShape(3.dp)))
                    Box(Modifier.width(26.dp).height(4.dp).background(Color.White.copy(0.4f), RoundedCornerShape(2.dp)))
                }
            }
        }
        "id_frame" -> Box(
            Modifier.fillMaxWidth(0.88f).height(22.dp).background(Brush.horizontalGradient(bannerGradient(item.id)), RoundedCornerShape(11.dp)),
            contentAlignment = Alignment.Center,
        ) { Text("• joined •", color = Color.White, fontSize = 8.sp) }
        "entrance" -> Box(
            Modifier.size(54.dp).background(Brush.radialGradient(listOf(Color(0xFF3D007A), Color(0xFF180030))), RoundedCornerShape(8.dp)),
            contentAlignment = Alignment.Center,
        ) { Text("🚀", fontSize = 26.sp) }
    }
}

// ── Circular frame ring (original design) ────────────────────────────────────

@Composable
private fun RingFrameThumb(ring1: Color, ring2: Color, glow: Color, size: Dp) {
    val c = ZipperTheme.colors
    Box(contentAlignment = Alignment.Center) {
        Box(
            Modifier.size(size)
                .border((size.value * 0.085f).dp, Brush.sweepGradient(listOf(ring1, ring2, glow, ring1)), CircleShape)
                .padding((size.value * 0.087f).dp)
                .border((size.value * 0.03f).dp, Brush.sweepGradient(listOf(glow, ring2, glow)), CircleShape),
        )
        Box(Modifier.size(size * 0.63f).clip(CircleShape).background(c.bgElevated), contentAlignment = Alignment.Center) {
            Text("👤", fontSize = (size.value * 0.26f).sp)
        }
    }
}

// ── Video card count section ──────────────────────────────────────────────────

@Composable
private fun VideoCardSection(count: Int) {
    val c = ZipperTheme.colors
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.lg)) {
        Box(
            Modifier.size(140.dp)
                .background(Brush.radialGradient(listOf(Color(0xFF1565C0), Color(0xFF0D003A))), RoundedCornerShape(Radius.xl))
                .border(2.dp, Brush.sweepGradient(listOf(Color(0xFF42A5F5), Color(0xFF7E57C2), Color(0xFF42A5F5))), RoundedCornerShape(Radius.xl)),
            contentAlignment = Alignment.Center,
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.xs)) {
                Text("📹", fontSize = 44.sp)
                Text("×$count", style = ZipperTheme.type.headingM.copy(fontWeight = FontWeight.ExtraBold), color = Color.White)
            }
        }
        Text("Video call cards", style = ZipperTheme.type.headingS, color = c.textPrimary)
        Text(
            if (count == 0) "Earn video cards by claiming daily rewards.\nEach card lets you start a free random call."
            else "You have $count video card${if (count > 1) "s" else ""}.\nEach card lets you start a free random call.",
            style = ZipperTheme.type.bodyS, color = c.textSecondary, textAlign = TextAlign.Center, modifier = Modifier.padding(horizontal = Space.xxl),
        )
        if (count == 0) Text("Claim your daily reward to earn cards", style = ZipperTheme.type.labelS, color = c.textBrand)
    }
}

// ── Gradient helpers (original colour schemes per item) ───────────────────────

private fun bubbleGradient(id: String): List<Color> = when (id) {
    "cb_default" -> listOf(Color(0xFF2C1654), Color(0xFF4A1080))
    "cb_rose"    -> listOf(Color(0xFFAD1457), Color(0xFFE91E63))
    "cb_ocean"   -> listOf(Color(0xFF006064), Color(0xFF00ACC1))
    "cb_galaxy"  -> listOf(Color(0xFF0D0D3D), Color(0xFF4A0080))
    "cb_event"   -> listOf(Color(0xFF880E4F), Color(0xFFCC3300))
    else         -> listOf(Color(0xFF2C1654), Color(0xFF4A1080))
}

private fun cardGradient(id: String): List<Color> = when (id) {
    "pc_basic" -> listOf(Color(0xFF37474F), Color(0xFF607D8B))
    "pc_gold"  -> listOf(Color(0xFF8B6914), Color(0xFFB8860B))
    "pc_royal" -> listOf(Color(0xFF4B0082), Color(0xFF7B00C0))
    "pc_event" -> listOf(Color(0xFF880E4F), Color(0xFFC2185B))
    else       -> listOf(Color(0xFF37474F), Color(0xFF607D8B))
}

private fun bannerGradient(id: String): List<Color> = when (id) {
    "id_basic" -> listOf(Color(0xFF1565C0), Color(0xFF1976D2))
    "id_gold"  -> listOf(Color(0xFF8B6914), Color(0xFFB8860B))
    "id_royal" -> listOf(Color(0xFF4B0082), Color(0xFF9C27B0))
    "id_event" -> listOf(Color(0xFFAD1457), Color(0xFFE91E63))
    else       -> listOf(Color(0xFF1565C0), Color(0xFF1976D2))
}

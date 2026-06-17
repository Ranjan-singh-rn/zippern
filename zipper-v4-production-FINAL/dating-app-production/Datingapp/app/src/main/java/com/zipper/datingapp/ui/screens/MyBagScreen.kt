package com.zipper.datingapp.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zipper.datingapp.ui.theme.AppBackground
import com.zipper.datingapp.ui.theme.AppContainer
import com.zipper.datingapp.ui.theme.AppSurface
import com.zipper.datingapp.ui.theme.BrandPink
import com.zipper.datingapp.ui.theme.BrandPurple
import androidx.activity.compose.BackHandler
import com.zipper.datingapp.ui.theme.GoldAccent
import com.zipper.datingapp.ui.theme.OutlineDefault
import com.zipper.datingapp.ui.theme.TextMuted
import com.zipper.datingapp.ui.theme.TextPrimary
import com.zipper.datingapp.ui.theme.TextSecondary

// ─────────────────────────────────────────────────────────────────────────────
// DATA MODEL
// ─────────────────────────────────────────────────────────────────────────────

data class CosmeticItem(
    val id: String,
    val name: String,
    val emoji: String,
    val rarity: String,               // "Eternal", "30 Days", "7 Days"
    val category: String,             // "frame", "chat", "card", "bubble", "entrance"
    val gradientStart: Long,
    val gradientEnd: Long,
    val isOwned: Boolean = false,
    val isWearing: Boolean = false,
    val effectiveDaysLeft: Int? = null, // null = Eternal
)

// ─────────────────────────────────────────────────────────────────────────────
// SAMPLE DATA
// ─────────────────────────────────────────────────────────────────────────────

val SAMPLE_FRAMES = listOf(
    CosmeticItem("frame_gold",    "Gold Crown",   "👑", "Eternal", "frame", 0xFFFFD700, 0xFFFF8C00, isOwned = true, isWearing = true),
    CosmeticItem("frame_diamond", "Diamond",      "💎", "30 Days", "frame", 0xFF00CED1, 0xFF1E90FF, isOwned = true),
    CosmeticItem("frame_fire",    "Fire Ring",    "🔥", "7 Days",  "frame", 0xFFFF4500, 0xFFFF8C00, isOwned = true, effectiveDaysLeft = 5),
    CosmeticItem("frame_rose",    "Rose Garden",  "🌹", "Eternal", "frame", 0xFFFF1493, 0xFF8B0000),
    CosmeticItem("frame_ice",     "Ice Frost",    "❄️", "30 Days", "frame", 0xFF00BFFF, 0xFF4169E1),
    CosmeticItem("frame_rainbow", "Rainbow",      "🌈", "Eternal", "frame", 0xFF9400D3, 0xFFFF4500),
    CosmeticItem("frame_angel",   "Angel Wings",  "👼", "Eternal", "frame", 0xFFFFFFFF, 0xFFB0C4DE),
    CosmeticItem("frame_galaxy",  "Galaxy",       "🌌", "30 Days", "frame", 0xFF0D0D2B, 0xFF7B61FF),
    CosmeticItem("frame_neon",    "Neon Glow",    "💡", "7 Days",  "frame", 0xFF00FF7F, 0xFF00CED1),
)

val SAMPLE_CHAT_STYLES = listOf(
    CosmeticItem("chat_bubble_pink",   "Pink Bubble",   "💬", "Eternal", "chat", 0xFFFF4D6D, 0xFFFF007F, isOwned = true, isWearing = true),
    CosmeticItem("chat_bubble_purple", "Purple Haze",   "🟣", "30 Days", "chat", 0xFF7B61FF, 0xFF4B0082, isOwned = true),
    CosmeticItem("chat_bubble_gold",   "Golden Chat",   "✨", "Eternal", "chat", 0xFFFFD700, 0xFFDAA520),
    CosmeticItem("chat_bubble_fire",   "Fire Chat",     "🔥", "7 Days",  "chat", 0xFFFF4500, 0xFFFF6347),
    CosmeticItem("chat_bubble_ocean",  "Ocean Wave",    "🌊", "30 Days", "chat", 0xFF006994, 0xFF00CED1),
    CosmeticItem("chat_bubble_mint",   "Mint Fresh",    "🍃", "Eternal", "chat", 0xFF98FF98, 0xFF00FA9A),
    CosmeticItem("chat_bubble_sakura", "Sakura",        "🌸", "7 Days",  "chat", 0xFFFF9EB5, 0xFFFF4D6D),
    CosmeticItem("chat_bubble_night",  "Midnight",      "🌙", "Eternal", "chat", 0xFF191970, 0xFF483D8B),
    CosmeticItem("chat_bubble_lava",   "Lava Flow",     "🌋", "30 Days", "chat", 0xFFB22222, 0xFFFF4500),
)

val SAMPLE_PROFILE_CARDS = listOf(
    CosmeticItem("card_diamond_elite", "Diamond Elite", "💎", "Eternal", "card", 0xFF00CED1, 0xFF7B61FF, isOwned = true, isWearing = true),
    CosmeticItem("card_rose_gold",     "Rose Gold",     "🌹", "30 Days", "card", 0xFFB76E79, 0xFFFF4D6D),
    CosmeticItem("card_obsidian",      "Obsidian",      "🖤", "Eternal", "card", 0xFF1C1C1C, 0xFF434343),
    CosmeticItem("card_aurora",        "Aurora",        "🌅", "7 Days",  "card", 0xFF00C9FF, 0xFF92FE9D, isOwned = true, effectiveDaysLeft = 2),
    CosmeticItem("card_cyberpunk",     "Cyberpunk",     "⚡", "Eternal", "card", 0xFFFF00FF, 0xFF00FFFF),
    CosmeticItem("card_sakura_bloom",  "Sakura Bloom",  "🌸", "30 Days", "card", 0xFFFFB7C5, 0xFFFF69B4),
    CosmeticItem("card_cosmic",        "Cosmic",        "🪐", "Eternal", "card", 0xFF090909, 0xFF7B61FF),
    CosmeticItem("card_neon_club",     "Neon Club",     "🎆", "7 Days",  "card", 0xFFFF00FF, 0xFF7B61FF),
    CosmeticItem("card_royale",        "Royale",        "👑", "Eternal", "card", 0xFFFFD700, 0xFF8B6914),
)

val SAMPLE_BUBBLES = listOf(
    CosmeticItem("bubble_hearts",  "Hearts Storm",  "❤️", "Eternal", "bubble", 0xFFFF4D6D, 0xFFFF007F, isOwned = true, isWearing = true),
    CosmeticItem("bubble_stars",   "Star Shower",   "⭐", "30 Days", "bubble", 0xFFFFD700, 0xFFFFA500, isOwned = true),
    CosmeticItem("bubble_confetti","Confetti Pop",  "🎊", "7 Days",  "bubble", 0xFF9400D3, 0xFFFF4500),
    CosmeticItem("bubble_snow",    "Snow Fall",     "❄️", "Eternal", "bubble", 0xFF87CEEB, 0xFF4169E1),
    CosmeticItem("bubble_sakura2", "Petal Rain",    "🌸", "30 Days", "bubble", 0xFFFFB7C5, 0xFFFF69B4),
    CosmeticItem("bubble_firework","Fireworks",     "🎆", "Eternal", "bubble", 0xFFFF6347, 0xFF7B61FF),
    CosmeticItem("bubble_rose",    "Rose Petals",   "🌹", "7 Days",  "bubble", 0xFF8B0000, 0xFFFF1493),
    CosmeticItem("bubble_gold",    "Gold Rush",     "🏆", "30 Days", "bubble", 0xFFFFD700, 0xFF8B6914),
    CosmeticItem("bubble_rainbow2","Rainbow Burst", "🌈", "Eternal", "bubble", 0xFF9400D3, 0xFFFF4500),
)

val SAMPLE_BIG_ENTRANCES = listOf(
    CosmeticItem("ent_royal",     "Royal Parade",   "🏰", "Eternal", "entrance", 0xFFFFD700, 0xFF8B6914, isOwned = true, isWearing = true),
    CosmeticItem("ent_dragon",    "Dragon Rise",    "🐉", "30 Days", "entrance", 0xFFFF4500, 0xFFDC143C),
    CosmeticItem("ent_angel2",    "Angel Descent",  "👼", "Eternal", "entrance", 0xFFFFF8DC, 0xFF87CEEB),
    CosmeticItem("ent_galaxy2",   "Galaxy Warp",    "🌌", "7 Days",  "entrance", 0xFF0D0D2B, 0xFF7B61FF, isOwned = true, effectiveDaysLeft = 6),
    CosmeticItem("ent_phoenix",   "Phoenix Flame",  "🦅", "Eternal", "entrance", 0xFFFF6347, 0xFFFFD700),
    CosmeticItem("ent_thunder",   "Thunder Strike", "⚡", "30 Days", "entrance", 0xFF191970, 0xFFFFD700),
    CosmeticItem("ent_sakura3",   "Sakura Arrival", "🌸", "7 Days",  "entrance", 0xFFFFB7C5, 0xFFFF69B4),
    CosmeticItem("ent_diamond2",  "Diamond Drop",   "💎", "Eternal", "entrance", 0xFF00CED1, 0xFF4169E1),
    CosmeticItem("ent_neon2",     "Neon Flash",     "💡", "30 Days", "entrance", 0xFF00FF7F, 0xFF7B61FF),
)

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

private fun rarityColor(rarity: String): Color = when (rarity) {
    "Eternal"  -> GoldAccent
    "30 Days"  -> Color(0xFF1E90FF)
    "7 Days"   -> Color(0xFF9E9E9E)
    else       -> TextMuted
}

private fun rarityLabel(item: CosmeticItem): String =
    if (item.rarity == "Eternal") "Eternal"
    else item.effectiveDaysLeft?.let { "${it}d left" } ?: item.rarity

// ─────────────────────────────────────────────────────────────────────────────
// SCREEN
// ─────────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MyBagScreen(onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    var selectedTab by remember { mutableStateOf(0) }
    val tabs = listOf("Avatar Frame", "Chat Style", "Profile Card", "Entrance", "Big Entrance")

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        "My Bag",
                        color = TextPrimary,
                        fontWeight = FontWeight.Bold,
                        fontSize = 20.sp,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "Back",
                            tint = TextPrimary,
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = AppBackground),
            )
        },
        containerColor = AppBackground,
    ) { padding ->
        Column(Modifier.padding(padding)) {
            ScrollableTabRow(
                selectedTabIndex = selectedTab,
                containerColor = AppBackground,
                contentColor = BrandPink,
                edgePadding = 16.dp,
                divider = {
                    HorizontalDivider(color = OutlineDefault, thickness = 1.dp)
                },
            ) {
                tabs.forEachIndexed { index, title ->
                    Tab(
                        selected = selectedTab == index,
                        onClick = { selectedTab = index },
                        selectedContentColor = BrandPink,
                        unselectedContentColor = TextSecondary,
                        text = {
                            Text(
                                title,
                                fontSize = 13.sp,
                                fontWeight = if (selectedTab == index) FontWeight.SemiBold else FontWeight.Normal,
                            )
                        },
                    )
                }
            }

            BagTabContent(
                items = when (selectedTab) {
                    0    -> SAMPLE_FRAMES
                    1    -> SAMPLE_CHAT_STYLES
                    2    -> SAMPLE_PROFILE_CARDS
                    3    -> SAMPLE_BUBBLES
                    else -> SAMPLE_BIG_ENTRANCES
                },
                onWear = { /* TODO: call viewModel.wearItem(it) */ },
                onGet  = { /* TODO: open shop for item */ },
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB CONTENT
// ─────────────────────────────────────────────────────────────────────────────

@Composable
fun BagTabContent(
    items: List<CosmeticItem>,
    onWear: (CosmeticItem) -> Unit,
    onGet: (CosmeticItem) -> Unit,
) {
    val wearing  = items.firstOrNull { it.isWearing }
    val owned    = items.filter { it.isOwned && !it.isWearing }
    val unowned  = items.filter { !it.isOwned }

    LazyColumn(
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        // ── Currently Wearing ────────────────────────────────────────────────
        if (wearing != null) {
            item(key = "section_wearing") {
                SectionLabel("Currently Wearing")
                Spacer(Modifier.height(10.dp))
                WearingItemCard(wearing)
            }
        }

        // ── My Items ─────────────────────────────────────────────────────────
        if (owned.isNotEmpty() || wearing != null) {
            val ownedAll = listOfNotNull(wearing) + owned
            item(key = "section_owned") {
                Spacer(Modifier.height(4.dp))
                SectionLabel("My Items (${ownedAll.size})")
                Spacer(Modifier.height(10.dp))
            }
            items(ownedAll.chunked(3), key = { it.first().id + "_row" }) { rowItems ->
                ItemRow(rowItems, onWear = onWear, onGet = onGet)
            }
        }

        // ── Not Owned ────────────────────────────────────────────────────────
        if (unowned.isNotEmpty()) {
            item(key = "section_unowned") {
                Spacer(Modifier.height(4.dp))
                SectionLabel("More Items")
                Spacer(Modifier.height(10.dp))
            }
            items(unowned.chunked(3), key = { it.first().id + "_unowned_row" }) { rowItems ->
                ItemRow(rowItems, onWear = onWear, onGet = onGet)
            }
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text,
        color = TextSecondary,
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 0.5.sp,
    )
}

@Composable
private fun ItemRow(
    rowItems: List<CosmeticItem>,
    onWear: (CosmeticItem) -> Unit,
    onGet: (CosmeticItem) -> Unit,
) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        rowItems.forEach { item ->
            CosmeticItemCard(
                item = item,
                modifier = Modifier.weight(1f),
                onWear = onWear,
                onGet = onGet,
            )
        }
        repeat(3 - rowItems.size) {
            Spacer(Modifier.weight(1f))
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// WEARING CARD (large hero card shown at top)
// ─────────────────────────────────────────────────────────────────────────────

@Composable
fun WearingItemCard(item: CosmeticItem) {
    val gradStart = Color(item.gradientStart)
    val gradEnd   = Color(item.gradientEnd)

    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(20.dp),
        color = Color.Transparent,
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(
                    Brush.linearGradient(
                        listOf(gradStart.copy(alpha = 0.25f), gradEnd.copy(alpha = 0.15f))
                    ),
                    shape = RoundedCornerShape(20.dp),
                )
                .border(
                    width = 1.5.dp,
                    brush = Brush.linearGradient(listOf(gradStart.copy(0.8f), gradEnd.copy(0.8f))),
                    shape = RoundedCornerShape(20.dp),
                )
                .padding(20.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                // Emoji badge
                Box(
                    modifier = Modifier
                        .size(72.dp)
                        .background(
                            Brush.radialGradient(listOf(gradStart.copy(0.5f), Color.Transparent)),
                            shape = RoundedCornerShape(16.dp),
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(item.emoji, fontSize = 36.sp)
                }

                Spacer(Modifier.width(16.dp))

                Column(modifier = Modifier.weight(1f)) {
                    // WEARING badge
                    Surface(
                        shape = RoundedCornerShape(6.dp),
                        color = Color(0xFF1B4332),
                    ) {
                        Text(
                            "WEARING",
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                            color = Color(0xFF52B788),
                            fontSize = 10.sp,
                            fontWeight = FontWeight.Bold,
                            letterSpacing = 1.sp,
                        )
                    }

                    Spacer(Modifier.height(6.dp))

                    Text(
                        item.name,
                        color = TextPrimary,
                        fontWeight = FontWeight.Bold,
                        fontSize = 17.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )

                    Spacer(Modifier.height(4.dp))

                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            rarityLabel(item),
                            color = rarityColor(item.rarity),
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                        if (item.rarity != "Eternal") {
                            Text(
                                " · ${item.rarity}",
                                color = TextMuted,
                                fontSize = 12.sp,
                            )
                        }
                    }
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// GRID ITEM CARD
// ─────────────────────────────────────────────────────────────────────────────

@Composable
fun CosmeticItemCard(
    item: CosmeticItem,
    modifier: Modifier = Modifier,
    onWear: (CosmeticItem) -> Unit,
    onGet: (CosmeticItem) -> Unit,
) {
    val gradStart  = Color(item.gradientStart)
    val gradEnd    = Color(item.gradientEnd)
    val isDisabled = !item.isOwned

    Column(
        modifier = modifier
            .clip(RoundedCornerShape(16.dp))
            .background(AppContainer)
            .border(
                width = 1.dp,
                color = if (item.isWearing) gradStart.copy(0.7f)
                        else if (isDisabled) OutlineDefault.copy(0.4f)
                        else OutlineDefault,
                shape = RoundedCornerShape(16.dp),
            )
            .clickable(enabled = !isDisabled) { onWear(item) }
            .padding(10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        // Thumbnail gradient box
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(1f)
                .background(
                    if (isDisabled)
                        Brush.radialGradient(listOf(Color(0xFF222230), Color(0xFF111118)))
                    else
                        Brush.radialGradient(listOf(gradStart.copy(0.45f), gradEnd.copy(0.25f))),
                    shape = RoundedCornerShape(12.dp),
                ),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                item.emoji,
                fontSize = 28.sp,
                color = if (isDisabled) Color.White.copy(0.35f) else Color.White,
            )

            // WEARING chip overlay
            if (item.isWearing) {
                Box(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(4.dp)
                        .background(Color(0xFF1B4332), RoundedCornerShape(5.dp))
                        .padding(horizontal = 5.dp, vertical = 2.dp),
                ) {
                    Text(
                        "ON",
                        color = Color(0xFF52B788),
                        fontSize = 9.sp,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
        }

        // Name
        Text(
            item.name,
            color = if (isDisabled) TextMuted else TextPrimary,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )

        // Rarity
        Text(
            rarityLabel(item),
            color = if (isDisabled) TextMuted.copy(0.5f) else rarityColor(item.rarity),
            fontSize = 10.sp,
            fontWeight = FontWeight.Medium,
            textAlign = TextAlign.Center,
        )

        // Action button
        if (isDisabled) {
            OutlinedButton(
                onClick = { onGet(item) },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(30.dp),
                shape = RoundedCornerShape(8.dp),
                contentPadding = PaddingValues(0.dp),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = TextSecondary),
                border = androidx.compose.foundation.BorderStroke(1.dp, OutlineDefault),
            ) {
                Text("Get", fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            }
        } else if (!item.isWearing) {
            Button(
                onClick = { onWear(item) },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(30.dp),
                shape = RoundedCornerShape(8.dp),
                contentPadding = PaddingValues(0.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = BrandPink,
                    contentColor = Color.White,
                ),
            ) {
                Text("Wear", fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            }
        } else {
            Surface(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(30.dp),
                shape = RoundedCornerShape(8.dp),
                color = Color(0xFF1B4332),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Text(
                        "Wearing",
                        color = Color(0xFF52B788),
                        fontSize = 11.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
            }
        }
    }
}

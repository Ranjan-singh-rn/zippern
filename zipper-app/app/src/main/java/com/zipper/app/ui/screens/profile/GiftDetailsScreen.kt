package com.zipper.app.ui.screens.profile

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CardGiftcard
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.zipper.app.ui.components.EmptyState
import com.zipper.app.ui.components.TopBar
import com.zipper.app.ui.components.ZipperScreen
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme

/*
 * Gift details — 3-column grid of 78×94 tiles: 34 image/emoji, name caption,
 * "×count" in brand/vip.
 *
 * @param title       "Gifts Sent" or "Gifts Received".
 * @param gifts       All aggregated gifts to display.
 * @param onBack      Navigate back.
 */
@Composable
fun GiftDetailsScreen(
    title: String,
    gifts: List<GiftSummaryItem>,
    onBack: () -> Unit,
) {
    val screenTitle = when {
        title.contains("receiv", ignoreCase = true) -> "Gifts received"
        title.contains("sent", ignoreCase = true) -> "Gifts sent"
        else -> title
    }
    ZipperScreen(topBar = { TopBar(screenTitle, onBack = onBack) }) { _ ->
        if (gifts.isEmpty()) {
            EmptyState(Icons.Outlined.CardGiftcard, "No gifts yet", "Go live or join a room to start sending and receiving gifts.")
            return@ZipperScreen
        }
        LazyVerticalGrid(
            columns = GridCells.Fixed(3),
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = Space.lg, top = Space.md, end = Space.lg, bottom = Space.x3l),
            horizontalArrangement = Arrangement.spacedBy(Space.md),
            verticalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            items(gifts) { gift -> GiftTile(gift) }
        }
    }
}

@Composable
private fun GiftTile(gift: GiftSummaryItem) {
    val c = ZipperTheme.colors
    Column(
        Modifier.fillMaxWidth().heightIn(min = 94.dp)
            .background(Brush.verticalGradient(listOf(Color(0x12FFFFFF), Color(0x05FFFFFF))), RoundedCornerShape(Radius.lg))
            .border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.lg))
            .padding(horizontal = Space.sm, vertical = Space.md),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.xs),
    ) {
        Box(Modifier.size(34.dp), contentAlignment = Alignment.Center) {
            if (gift.imageUrl.isNotBlank()) AsyncImage(gift.imageUrl, gift.name, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
            else Text(gift.emoji, fontSize = 26.sp, textAlign = TextAlign.Center)
        }
        Text(gift.name, style = ZipperTheme.type.caption, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
        Text("×${gift.count}", style = ZipperTheme.type.labelS, color = c.brandVip)
    }
}

package com.zipper.app.ui.screens.profile

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.zipper.app.ui.theme.ZipperGold
import com.zipper.app.ui.theme.ZipperPink
import com.zipper.app.ui.theme.ZipperPurple
import com.zipper.app.util.formatCount

/**
 * A single gift available to send — UI representation.
 *
 * Display priority: [imageUrl] → [emoji]          (gift selection grid)
 *                   [lottieAsset]                  (fullscreen overlay on send)
 *
 * [imageUrl]    is a remote PNG/SVG/WebP URL from Firebase Storage.
 * [lottieAsset] is either:
 *               - a bundled asset path inside assets/ (e.g. "gifts/g1_rose.json")
 *               - a remote Lottie URL starting with "https://"
 * [emoji]       is the plain-text fallback when neither image nor Lottie is available.
 *
 * Every instance comes from Firestore via `GiftRepository.fetchGiftCatalogue`.
 * There is no bundled catalogue to fall back on, and that is deliberate — see
 * the note below.
 */
data class GiftItem(
    val giftId: String,
    val name: String,
    val costDiamonds: Int,
    val emoji: String = "🎁",
    val imageUrl: String = "",
    val lottieAsset: String = "",
)

/*
 * There was a MOCK_GIFTS here: ten invented gifts, ids `g1`..`g10`, described as
 * an "offline fallback used while gifts are loading". It was not a preview
 * fixture. It was the default value of OtherUserUiState.availableGifts, of this
 * file's GiftBottomSheet `gifts` parameter, and of ProfileScreen's
 * `availableGifts` — and the nav graph never passed that one, so production took
 * the mock.
 *
 * A gift id is not decoration: `settleGift` looks it up in the `gifts`
 * collection and prices it from the document it finds. There is no `gifts/g1`,
 * so every one of those ten ended in `not-found: That gift no longer exists.`
 * The user chose a gift, tapped send, and was told the gift was not real. A
 * fallback catalogue can only ever produce that, because the ids are the whole
 * point of the catalogue.
 *
 * It is gone rather than hidden behind a private preview constant: this module
 * has no @Preview composables at all, so there was nothing left for it to serve,
 * and a public list of sendable-looking gifts is a default waiting for the next
 * caller who forgets to pass a real one. A preview, when somebody writes one,
 * can spell its own gifts out inline where the fakeness is visible at the call
 * site and cannot become anybody's default.
 */

/** Map a [com.zipper.app.data.repository.GiftItem] (Firestore model) to a [GiftItem] (UI model). */
fun com.zipper.app.data.repository.GiftItem.toUiGiftItem(): GiftItem = GiftItem(
    giftId       = id,
    name         = name,
    costDiamonds = costDiamonds.toInt(),
    emoji        = emoji,
    imageUrl     = imageUrl,
    lottieAsset  = lottieAsset,
)

/**
 * Gift bottom sheet — a 4-column grid of gifts; tapping one selects it.
 *
 * The live gifting path is [com.zipper.app.ui.components.GiftDrawer], which
 * every room, call and profile uses and which knows the difference between a
 * catalogue that is loading, one that is empty and one that failed. This sheet
 * predates it and currently has no callers.
 *
 * [gifts] has no default on purpose. It used to default to a hardcoded
 * catalogue, so a caller who forgot to wire the CRM through still got a full,
 * tappable, unsendable grid. Requiring it means a caller has to decide where the
 * gifts come from, and an empty list renders as an honest empty state instead of
 * ten gifts that do not exist.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GiftBottomSheet(
    recipientName: String,
    userDiamonds: Long,
    gifts: List<GiftItem>,
    onDismiss: () -> Unit,
    onSendGift: (GiftItem) -> Unit = {},
) {
    var selectedGift by remember { mutableStateOf<GiftItem?>(null) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = MaterialTheme.colorScheme.surface,
        dragHandle = {
            Box(
                modifier = Modifier
                    .padding(top = 12.dp, bottom = 4.dp)
                    .size(width = 40.dp, height = 4.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.onSurface.copy(0.2f)),
            )
        },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.7f)
                .padding(bottom = 20.dp),
        ) {
            // ── Header ────────────────────────────────────────────────────
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Text(
                        "Send a Gift",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                    )
                    Text(
                        "To $recipientName",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurface.copy(0.5f),
                    )
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("💎", fontSize = 14.sp)
                    Spacer(Modifier.width(4.dp))
                    Text(
                        text = formatCount(userDiamonds),
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
            }

            HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(0.1f))

            // ── Gift grid ─────────────────────────────────────────────────
            // Same wording as GiftDrawer's empty state, and for the same reason:
            // an empty grid with no explanation reads as a broken screen, which
            // is what made substituting fake gifts look like an improvement.
            if (gifts.isEmpty()) {
                Box(
                    modifier = Modifier.fillMaxWidth().weight(1f),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        "No gifts available right now",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurface.copy(0.6f),
                    )
                }
            } else {
                LazyVerticalGrid(
                    columns = GridCells.Fixed(4),
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f),
                    contentPadding = PaddingValues(12.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(gifts) { gift ->
                        GiftGridItem(
                            gift = gift,
                            isSelected = selectedGift?.giftId == gift.giftId,
                            onClick = { selectedGift = if (selectedGift?.giftId == gift.giftId) null else gift },
                        )
                    }
                }
            }

            // ── Send button ───────────────────────────────────────────────
            val canSend = selectedGift != null && userDiamonds >= (selectedGift?.costDiamonds ?: 0)
            Button(
                onClick = {
                    selectedGift?.let { onSendGift(it) }
                    onDismiss()
                },
                enabled = canSend,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp)
                    .height(52.dp),
                shape = RoundedCornerShape(14.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = ZipperPink,
                    disabledContainerColor = MaterialTheme.colorScheme.onSurface.copy(0.1f),
                ),
            ) {
                val label = selectedGift?.let {
                    "Send ${it.name} — ${it.costDiamonds} 💎"
                } ?: "Select a gift"
                Text(
                    label,
                    fontWeight = FontWeight.Bold,
                    color = if (canSend) Color.White else MaterialTheme.colorScheme.onSurface.copy(0.35f),
                )
            }
        }
    }
}

@Composable
private fun GiftGridItem(
    gift: GiftItem,
    isSelected: Boolean,
    onClick: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(
                if (isSelected) ZipperPink.copy(0.12f)
                else MaterialTheme.colorScheme.surfaceVariant.copy(0.4f)
            )
            .border(
                width = if (isSelected) 1.5.dp else 0.dp,
                color = if (isSelected) ZipperPink else Color.Transparent,
                shape = RoundedCornerShape(12.dp),
            )
            .clickable { onClick() }
            .padding(vertical = 10.dp, horizontal = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // Gift icon: remote image (SVG/PNG from Firebase Storage) → emoji fallback
        // Lottie animation plays on the fullscreen overlay AFTER the gift is sent — not here
        if (gift.imageUrl.isNotBlank()) {
            AsyncImage(
                model = gift.imageUrl,
                contentDescription = gift.name,
                modifier = Modifier.size(44.dp),
                // show emoji while loading / on error
                error = androidx.compose.ui.res.painterResource(android.R.drawable.ic_menu_gallery),
            )
        } else {
            Text(gift.emoji, fontSize = 30.sp, textAlign = TextAlign.Center)
        }
        Spacer(Modifier.height(4.dp))
        Text(
            gift.name,
            fontSize = 10.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            color = MaterialTheme.colorScheme.onSurface.copy(0.7f),
            textAlign = TextAlign.Center,
        )
        Text(
            "${gift.costDiamonds} 💎",
            fontSize = 10.sp,
            color = ZipperGold,
            fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
        )
    }
}

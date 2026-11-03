package com.zipper.app.ui.screens.party

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateMap
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.zipper.app.data.repository.PartyGiftEvent
import kotlin.math.roundToInt

/**
 * B7 (3 Nov 2026): a gift flies from the sender's seat to the receiver's.
 *
 * Seats record where they are (in root coordinates) into [PartySeatCentres] as they are laid out; the overlay reads
 * the two ends from there. Tied to the gift that was paid for: it plays only for a gift event the server wrote
 * (`partyRooms/{id}/gifts`, which now names the receiver and the settlement's transaction), never for a tap.
 * A sender who is not seated sends from the bottom of the screen; a receiver who has left their seat ends in the
 * middle — the centre-screen gift animation plays as before either way.
 */
object PartySeatCentres {
    /** Seat index → centre in root coordinates. One party room is on screen at a time; cleared when it closes. */
    val centres: SnapshotStateMap<Int, Offset> = mutableStateMapOf()
}

/** Record this seat's centre (root coordinates) for gift travel. */
fun Modifier.recordSeatCentre(map: SnapshotStateMap<Int, Offset>?, index: Int): Modifier =
    if (map == null) this else onGloballyPositioned { map[index] = it.boundsInRoot().center }

/** Where a flight starts and ends, in root coordinates; null when the screen is not laid out yet. */
fun travelEnds(
    gift: PartyGiftEvent,
    seatOfUid: (String) -> Int?,
    centres: Map<Int, Offset>,
    screenBottomCentre: Offset,
    screenCentre: Offset,
): Pair<Offset, Offset> {
    val from = seatOfUid(gift.senderUid)?.let { centres[it] } ?: screenBottomCentre
    val to = seatOfUid(gift.receiverUid)?.let { centres[it] } ?: screenCentre
    return from to to
}

@Composable
fun GiftTravelOverlay(
    gift: PartyGiftEvent,
    seatOfUid: (String) -> Int?,
    centres: Map<Int, Offset>,
    onFinished: () -> Unit,
) {
    var origin by remember { mutableStateOf<Offset?>(null) }
    var size by remember { mutableStateOf(Offset.Zero) }
    val progress = remember(gift.id) { Animatable(0f) }
    LaunchedEffect(gift.id) {
        progress.snapTo(0f)
        progress.animateTo(1f, tween(1100, easing = FastOutSlowInEasing))
        onFinished()
    }
    val density = LocalDensity.current
    Box(
        Modifier.fillMaxSize().onGloballyPositioned {
            val b = it.boundsInRoot()
            origin = b.topLeft
            size = Offset(b.width, b.height)
        },
    ) {
        val o = origin ?: return@Box
        val (fromRoot, toRoot) = travelEnds(gift, seatOfUid, centres, Offset(o.x + size.x / 2, o.y + size.y - 120f), Offset(o.x + size.x / 2, o.y + size.y / 2))
        val p = progress.value
        // A gentle arc: up and over, then down onto the receiver.
        val x = fromRoot.x + (toRoot.x - fromRoot.x) * p
        val y = fromRoot.y + (toRoot.y - fromRoot.y) * p - 160f * 4 * p * (1 - p)
        val iconPx = with(density) { 44.dp.toPx() }
        Box(
            Modifier
                .offset { IntOffset((x - o.x - iconPx / 2).roundToInt(), (y - o.y - iconPx / 2).roundToInt()) }
                .size(44.dp)
                .graphicsLayer {
                    val s = 0.7f + 0.6f * (1 - kotlin.math.abs(0.5f - p) * 2)
                    scaleX = s; scaleY = s
                    alpha = if (p > 0.9f) (1 - p) * 10 else 1f
                },
        ) {
            if (gift.imageUrl.isNotBlank()) AsyncImage(model = gift.imageUrl, contentDescription = gift.giftName, modifier = Modifier.fillMaxSize())
            else Text(gift.emoji.ifBlank { "🎁" }, fontSize = 32.sp)
        }
    }
}

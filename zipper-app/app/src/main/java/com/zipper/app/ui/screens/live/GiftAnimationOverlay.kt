package com.zipper.app.ui.screens.live

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.zipper.app.data.model.LiveGiftEvent
import com.zipper.app.ui.components.Avatar
import com.zipper.app.ui.components.AvatarRing
import com.zipper.app.ui.components.AvatarSize
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * The centre-stage gift moment.
 *
 * Was a small pink pill in the bottom-left corner that rendered `emoji` as
 * text and never touched `imageUrl` — so every gift in the catalogue, all of
 * which ship artwork, looked identical and cost nothing to send visually.
 *
 * Now: the artwork large in the centre, sender and gift name underneath, with
 * a scale-overshoot entrance, a hold, and a fade out. One gift at a time; the
 * caller pops the queue in [onDismiss].
 *
 * B12 (4 Nov 2026): after the hold the gift TRAVELS to the host it was paid to —
 * the host's pill, top-left on both the broadcaster's and the viewer's screen —
 * shrinking as it goes, while the caption fades. It plays only for a gift the
 * server settled (`liveRooms/{id}/gifts`, written by `settleGift`), never for a tap.
 */
@Composable
fun GiftAnimationOverlay(
    giftEvent: LiveGiftEvent,
    onDismiss: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    // B13: a gift with an SVGA animation plays it full screen, once — with the caption underneath — and the
    // static artwork below stays the fallback for every gift without one.
    if (giftEvent.svgaUrl.isNotBlank()) {
        SvgaGiftOverlay(giftEvent, onDismiss, modifier)
        return
    }
    // O2 (5 Nov 2026): the CRM's Lottie for the gift, full screen, when it has no SVGA.
    if (giftEvent.lottieAsset.isNotBlank()) {
        LottieGiftOverlay(giftEvent, onDismiss, modifier)
        return
    }
    val c = ZipperTheme.colors

    val scale = remember(giftEvent.id) { Animatable(0.6f) }
    val fade = remember(giftEvent.id) { Animatable(0f) }
    /** 0 = centre stage, 1 = arrived at the host's pill. */
    val travel = remember(giftEvent.id) { Animatable(0f) }

    LaunchedEffect(giftEvent.id) {
        launch { fade.animateTo(1f, tween(180)) }
        scale.animateTo(1.1f, tween(260, easing = FastOutSlowInEasing))
        scale.animateTo(1f, tween(140, easing = FastOutSlowInEasing))
        delay(1300)
        launch { scale.animateTo(0.25f, tween(480, easing = FastOutSlowInEasing)) }
        travel.animateTo(1f, tween(480, easing = FastOutSlowInEasing))
        fade.animateTo(0f, tween(160))
        onDismiss()
    }

    BoxWithConstraints(
        modifier
            .fillMaxSize()
            .padding(horizontal = Space.xl),
        contentAlignment = Alignment.Center,
    ) {
        // The host's pill sits near the top-left corner: about 38 % of the width left of centre, 42 % of the
        // height above it.
        val dxDp = -maxWidth.value * 0.38f
        val dyDp = -maxHeight.value * 0.42f
        Column(
            Modifier
                .fillMaxWidth()
                // O10 (5 Nov 2026), speed: every animated value is read in the draw phase, so the gift moves without
                // recomposing the overlay on each frame (`.scale(scale.value)` / `.alpha(fade.value)` read them in
                // composition).
                .graphicsLayer {
                    translationX = travel.value * dxDp.dp.toPx()
                    translationY = travel.value * dyDp.dp.toPx()
                    scaleX = scale.value
                    scaleY = scale.value
                    alpha = fade.value
                },
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            // TODO(svga): swap this static artwork for the SVGA player once the
            // animated gift files land — keep the same 140dp box and the same
            // enter/hold/exit timing so the caption below does not move.
            Box(Modifier.size(140.dp), contentAlignment = Alignment.Center) {
                if (giftEvent.imageUrl.isNotBlank()) {
                    AsyncImage(
                        model = giftEvent.imageUrl,
                        contentDescription = giftEvent.giftName,
                        contentScale = ContentScale.Fit,
                        modifier = Modifier.fillMaxSize(),
                    )
                } else {
                    Text(
                        giftEvent.emoji.ifBlank { "🎁" },
                        fontSize = 96.sp,
                        textAlign = TextAlign.Center,
                    )
                }
            }

            Row(
                Modifier
                    .alpha(1f - travel.value)
                    .background(c.scrimStrong, CircleShape)
                    .border(1.dp, c.glassMid, CircleShape)
                    .padding(start = 2.dp, end = Space.md, top = 2.dp, bottom = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Space.sm),
            ) {
                Avatar(
                    giftEvent.senderPhotoUrl.ifBlank { null },
                    size = AvatarSize.SM,
                    ring = AvatarRing.Vip,
                    initial = giftEvent.senderName,
                )
                Text(
                    "${giftEvent.senderName.ifBlank { "Someone" }} sent ${giftEvent.giftName}",
                    style = ZipperTheme.type.labelM,
                    color = c.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.widthIn(max = 220.dp),
                )
                Box(
                    Modifier
                        .background(
                            Brush.horizontalGradient(listOf(Color(0xFFFFE08A), Color(0xFFFFB627), Color(0xFFE89806))),
                            CircleShape,
                        )
                        .padding(horizontal = Space.sm, vertical = 2.dp),
                ) {
                    Text("×${giftEvent.quantity}", style = ZipperTheme.type.overline, color = Color(0xFF0E0F21))
                }
            }
            Spacer(Modifier.height(Space.xs))
        }
    }
}


/** B13: the SVGA path — the animation once, the sender caption, and a watchdog so a bad file never blocks the queue. */
@Composable
private fun SvgaGiftOverlay(giftEvent: LiveGiftEvent, onDismiss: () -> Unit, modifier: Modifier) {
    val c = ZipperTheme.colors
    var done by remember(giftEvent.id) { mutableStateOf(false) }
    val finish = {
        if (!done) {
            done = true
            onDismiss()
        }
    }
    LaunchedEffect(giftEvent.id) {
        delay(SVGA_GIFT_WATCHDOG_MS)
        finish()
    }
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        com.zipper.app.ui.components.Svga(
            source = giftEvent.svgaUrl,
            modifier = Modifier.fillMaxSize(),
            loops = 1,
            onFinished = finish,
        )
        Row(
            Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 180.dp)
                .background(c.scrimStrong, CircleShape)
                .border(1.dp, c.glassMid, CircleShape)
                .padding(start = 2.dp, end = Space.md, top = 2.dp, bottom = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            Avatar(giftEvent.senderPhotoUrl.ifBlank { null }, size = AvatarSize.SM, ring = AvatarRing.Vip, initial = giftEvent.senderName)
            Text(
                "${giftEvent.senderName.ifBlank { "Someone" }} sent ${giftEvent.giftName} ×${giftEvent.quantity}",
                style = ZipperTheme.type.labelM,
                color = c.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = 260.dp),
            )
        }
    }
}

/** The longest an SVGA gift may hold the queue, whatever its own length says. */
private const val SVGA_GIFT_WATCHDOG_MS = 8_000L

/**
 * O2: the Lottie path — a gift the CRM gave a Lottie (one of the bundled `gifts/….json`, or an uploaded URL) plays it
 * once, full screen, with the sender caption; a file that will not load, or never ends, is cut off by the same
 * watchdog as an SVGA so the queue always moves on.
 */
@Composable
private fun LottieGiftOverlay(giftEvent: LiveGiftEvent, onDismiss: () -> Unit, modifier: Modifier) {
    val c = ZipperTheme.colors
    var done by remember(giftEvent.id) { mutableStateOf(false) }
    val finish = {
        if (!done) {
            done = true
            onDismiss()
        }
    }
    val spec = remember(giftEvent.lottieAsset) { lottieSpecOf(giftEvent.lottieAsset) }
    val composition by com.airbnb.lottie.compose.rememberLottieComposition(spec)
    val progress = com.airbnb.lottie.compose.animateLottieCompositionAsState(composition, iterations = 1)
    LaunchedEffect(giftEvent.id) {
        delay(SVGA_GIFT_WATCHDOG_MS)
        finish()
    }
    // O10: watched as a flow, not as an effect key — keyed on the progress, this effect was cancelled and restarted
    // on every animation frame, and the whole overlay recomposed with it.
    LaunchedEffect(composition) {
        if (composition == null) return@LaunchedEffect
        androidx.compose.runtime.snapshotFlow { progress.value }.first { it >= 1f }
        finish()
    }
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        com.airbnb.lottie.compose.LottieAnimation(composition, { progress.value }, modifier = Modifier.fillMaxSize())
        Row(
            Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 180.dp)
                .background(c.scrimStrong, CircleShape)
                .border(1.dp, c.glassMid, CircleShape)
                .padding(start = 2.dp, end = Space.md, top = 2.dp, bottom = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            Avatar(giftEvent.senderPhotoUrl.ifBlank { null }, size = AvatarSize.SM, ring = AvatarRing.Vip, initial = giftEvent.senderName)
            Text(
                "${giftEvent.senderName.ifBlank { "Someone" }} sent ${giftEvent.giftName} ×${giftEvent.quantity}",
                style = ZipperTheme.type.labelM,
                color = c.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = 260.dp),
            )
        }
    }
}

/** O2: a CRM `lottieAsset` is either a URL (uploaded) or a path inside the app's assets (`gifts/g1_rose.json`). */
internal fun lottieSpecOf(asset: String): com.airbnb.lottie.compose.LottieCompositionSpec {
    val a = asset.trim()
    return if (a.startsWith("http://") || a.startsWith("https://")) com.airbnb.lottie.compose.LottieCompositionSpec.Url(a)
    else com.airbnb.lottie.compose.LottieCompositionSpec.Asset(a.removePrefix("/"))
}

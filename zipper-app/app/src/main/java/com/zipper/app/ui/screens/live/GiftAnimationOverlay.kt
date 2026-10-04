package com.zipper.app.ui.screens.live

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
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
 */
@Composable
fun GiftAnimationOverlay(
    giftEvent: LiveGiftEvent,
    onDismiss: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val c = ZipperTheme.colors

    val scale = remember(giftEvent.id) { Animatable(0.6f) }
    val fade = remember(giftEvent.id) { Animatable(0f) }

    LaunchedEffect(giftEvent.id) {
        launch { fade.animateTo(1f, tween(180)) }
        scale.animateTo(1.1f, tween(260, easing = FastOutSlowInEasing))
        scale.animateTo(1f, tween(140, easing = FastOutSlowInEasing))
        delay(1600)
        fade.animateTo(0f, tween(280))
        onDismiss()
    }

    Box(
        modifier
            .fillMaxSize()
            .padding(horizontal = Space.xl),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .scale(scale.value)
                .alpha(fade.value),
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

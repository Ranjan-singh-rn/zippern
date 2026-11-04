package com.zipper.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.zipper.app.ui.theme.Size
import com.zipper.app.ui.theme.ZipperTheme

/*
 * Avatar — from the Figma component set (16:18).
 *
 *   Size: SM 36 · MD 44 · LG 56 · XL 72   (plus XS 28, 2XL 96, 3XL 120 from tokens)
 *   Ring: None · Online (mint) · Live (coral) · VIP (gold)
 *   Ring stroke: 2 at SM/MD, 3 at LG and above.
 *   Placeholder: the 594D8C→2E2652 gradient, with an initial.
 */

enum class AvatarRing { None, Online, Live, Vip }

enum class AvatarSize(val dp: Dp, val ring: Dp) {
    XS(Size.Avatar.xs, 2.dp),
    SM(Size.Avatar.sm, 2.dp),
    MD(Size.Avatar.md, 2.dp),
    LG(Size.Avatar.lg, 3.dp),
    XL(Size.Avatar.xl, 3.dp),
    XXL(Size.Avatar.xxl, 3.dp),
    X3L(Size.Avatar.x3l, 4.dp),
}

private val PlaceholderGradient = Brush.linearGradient(listOf(Color(0xFF594D8C), Color(0xFF2E2652)))

@Composable
fun Avatar(
    photoUrl: String?,
    modifier: Modifier = Modifier,
    size: AvatarSize = AvatarSize.MD,
    ring: AvatarRing = AvatarRing.None,
    /** Shown on the placeholder when there is no photo. First letter of the name. */
    initial: String = "",
    /**
     * An equipped frame's image URL, drawn over the avatar and slightly larger
     * than it. Frames are the most visible cosmetic in the product — a host
     * pays real diamonds for one, so it must render everywhere the avatar does.
     */
    frameUrl: String? = null,
    /**
     * B13: the equipped frame's catalogue ID (`users/{uid}.equippedFrame`). Resolved to its artwork here — the
     * pointer holds the id, and handing that to [frameUrl] drew nothing. An SVGA frame plays (looping) only when
     * [animatedFrame] is true: one avatar on a profile, never a list of them.
     */
    frameItemId: String? = null,
    animatedFrame: Boolean = false,
    /**
     * O9 (5 Nov 2026): whose avatar this is. With no [frameItemId] given, the frame they wear NOW is read from their
     * public profile (cached) — so a seat, a viewer, a chat header shows the frame without every caller fetching it.
     */
    decorUid: String? = null,
) {
    val c = ZipperTheme.colors
    val decor = if (frameItemId == null && frameUrl == null) rememberUserDecor(decorUid) else null
    val frameId = frameItemId ?: decor?.frameId?.takeIf { it.isNotBlank() }
    val ringColor = when (ring) {
        AvatarRing.None -> null
        AvatarRing.Online -> c.statusOnline
        AvatarRing.Live -> c.statusLive
        AvatarRing.Vip -> c.brandVip
    }

    Box(modifier = modifier.size(size.dp), contentAlignment = Alignment.Center) {
        Box(
            modifier = Modifier
                .size(size.dp)
                .then(if (ringColor != null) Modifier.border(size.ring, ringColor, CircleShape) else Modifier)
                // A ring sits outside the photo, not over it: inset by the stroke
                // plus a hairline of breathing room so the photo does not touch it.
                .padding(if (ringColor != null) size.ring + 1.dp else 0.dp)
                .clip(CircleShape)
                .background(PlaceholderGradient),
            contentAlignment = Alignment.Center,
        ) {
            if (!photoUrl.isNullOrBlank()) {
                AsyncImage(
                    model = photoUrl,
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.size(size.dp),
                )
            } else if (initial.isNotBlank()) {
                Text(
                    initial.take(1).uppercase(),
                    style = when {
                        size.dp >= Size.Avatar.xl -> ZipperTheme.type.headingL
                        size.dp >= Size.Avatar.md -> ZipperTheme.type.labelL
                        else -> ZipperTheme.type.labelS
                    },
                    color = c.textPrimary,
                )
            }
        }
        if (!frameUrl.isNullOrBlank()) {
            // A frame image handed in directly (a listener row's resolved URL). Authored at ~1.3× the avatar so the
            // artwork clears the photo edge; not clipped — frames have wings and crowns.
            AsyncImage(
                model = frameUrl,
                contentDescription = null,
                contentScale = ContentScale.Fit,
                modifier = Modifier.requiredSize(size.dp * 1.3f),
            )
        } else {
            // O9: SVGA (animated where asked) → Lottie ring → colour ring → image, by what the catalogue row carries.
            DecorFrame(frameId, size.dp, animated = animatedFrame)
        }
    }
}

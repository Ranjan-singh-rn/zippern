package com.zipper.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.zipper.app.data.model.PublicProfile
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.ZipperTheme

/*
 * Discover user card — Figma "01 Home" (41:2), "User card".
 *
 *   162×220 (aspect 0.736), r16, pad 8. Photo full-bleed under a video scrim
 *   (transparent → 35% → 90% ink/950). Top row: Live/Party badge left,
 *   16dp presence disc right (8dp dot: mint online, amber busy). Bottom:
 *   name Semi Bold 14 + 14dp verified check, then "City · Age" Medium 11 in
 *   ink/300 and a gold "LV n" chip (Bold 10, ink/900 text).
 *
 * Placeholder when there is no photo: a gradient picked from the uid so the
 * same person always gets the same colours, with their initial at 40 Extra
 * Bold in 16% white.
 */

private val PlaceholderGradients = listOf(
    listOf(Color(0xFFFF3D8B), Color(0xFF7038E8)),
    listOf(Color(0xFFA47CFF), Color(0xFF22C8D6)),
    listOf(Color(0xFFFFD05C), Color(0xFFFF4D5E)),
    listOf(Color(0xFF5CE1E6), Color(0xFF7038E8)),
    listOf(Color(0xFFFF7A88), Color(0xFFC00E56)),
    listOf(Color(0xFF5CE6A8), Color(0xFF0FA3B1)),
)

fun placeholderBrush(seed: String): Brush {
    val i = (seed.hashCode() and 0x7fffffff) % PlaceholderGradients.size
    return Brush.linearGradient(PlaceholderGradients[i])
}

@Composable
fun UserCard(
    user: PublicProfile,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val c = ZipperTheme.colors
    val shape = RoundedCornerShape(Radius.lg)

    Box(
        modifier
            .aspectRatio(162f / 220f)
            .clip(shape)
            .background(placeholderBrush(user.uid))
            .clickableNoRipple(onClick),
    ) {
        if (user.photoUrl.isNotBlank()) {
            AsyncImage(
                model = user.photoUrl, contentDescription = user.name,
                contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize(),
            )
        } else {
            Text(
                user.name.take(1).uppercase(),
                style = ZipperTheme.type.displayXl, color = Color.White.copy(alpha = 0.16f),
                modifier = Modifier.align(Alignment.Center),
            )
        }

        // Video scrim
        Box(
            Modifier.fillMaxSize().background(
                Brush.verticalGradient(
                    0f to Color.Transparent, 0.5f to Color(0x59070812), 1f to Color(0xE5070812),
                )
            )
        )

        // Top row
        Row(
            Modifier.fillMaxWidth().padding(8.dp).align(Alignment.TopStart),
            verticalAlignment = Alignment.Top,
        ) {
            when {
                user.isLive -> LiveBadge(LiveBadgeKind.Live)
                user.isInParty -> LiveBadge(LiveBadgeKind.Party)
            }
            Spacer(Modifier.weight(1f))
            val presence = when {
                user.isInCall -> c.statusWarning
                user.isOnline || user.isLive || user.isInParty -> c.statusOnline
                else -> null
            }
            if (presence != null) {
                Box(Modifier.size(16.dp).background(c.scrimMedium, CircleShape), contentAlignment = Alignment.Center) {
                    Box(Modifier.size(8.dp).background(presence, CircleShape))
                }
            }
        }

        // Info
        Column(
            Modifier.fillMaxWidth().padding(8.dp).align(Alignment.BottomStart),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    user.name, style = ZipperTheme.type.labelM, color = Color.White,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                )
                if (user.isVerifiedHost || user.isOfficial) {
                    Icon(Icons.Default.CheckCircle, "Verified", tint = c.currencyDiamond, modifier = Modifier.size(14.dp))
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                val meta = listOfNotNull(
                    user.city.ifBlank { user.country }.ifBlank { null },
                    user.age.takeIf { it > 0 }?.toString(),
                ).joinToString(" · ")
                Text(
                    meta, style = ZipperTheme.type.caption, color = c.textSecondary,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                )
                if (user.level > 0) LevelChip(user.level)
            }
        }
    }
}

/** Gold "LV 12" chip, 16dp tall. */
@Composable
fun LevelChip(level: Int, modifier: Modifier = Modifier) {
    Box(
        modifier
            .height(16.dp)
            .background(Brush.horizontalGradient(listOf(Color(0xFFFFE08A), Color(0xFFFFB627), Color(0xFFE89806))), CircleShape)
            .padding(horizontal = 4.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text("LV $level", style = ZipperTheme.type.overline, color = Color(0xFF0E0F21), maxLines = 1)
    }
}

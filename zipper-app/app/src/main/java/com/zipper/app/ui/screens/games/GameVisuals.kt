package com.zipper.app.ui.screens.games

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zipper.app.ui.components.clickableNoRipple
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme

/**
 * Games — shared look (B6, 3 Nov 2026). Original Zipper presentation: every game has its own name, colours and a
 * glyph drawn from Unicode — no provider's art, names or branding.
 */
data class GameLook(
    val gameId: String,
    val name: String,
    val tagline: String,
    val glyph: String,
    val from: Color,
    val to: Color,
    val multiplayer: Boolean,
)

val GAME_LOOKS: Map<String, GameLook> = listOf(
    GameLook("ludo", "Ludo", "Race four tokens home — 2, 4 or 6 players", "🎲", Color(0xFF2E7DFF), Color(0xFF7A4DFF), true),
    GameLook("carrom", "Carrom", "Flick, pocket, win — 2 or 4 players", "⚪", Color(0xFFB8732E), Color(0xFF6B3F14), true),
    GameLook("teen_patti", "Teen Patti", "Three cards, nerves of steel", "🃏", Color(0xFFD7263D), Color(0xFF6A0F2A), true),
    GameLook("crash", "Zip Flight", "Cash out before it flies away", "🚀", Color(0xFFFF6B35), Color(0xFFB0124B), false),
    GameLook("slots", "Mela Reels", "Five festive reels, ten lines", "🎰", Color(0xFFF5A623), Color(0xFFE0457B), false),
    GameLook("chicken_road", "Lane Hopper", "One lane at a time — stop when you like", "🐔", Color(0xFF2BB673), Color(0xFF0F6B5B), false),
    GameLook("plinko", "Peg Drop", "Drop the ball, watch it bounce", "🔵", Color(0xFF00B4D8), Color(0xFF3A0CA3), false),
    GameLook("fishing", "Lucky Catch", "Cast your line — what will bite?", "🎣", Color(0xFF1B98E0), Color(0xFF0B3C5D), false),
    // Friendly matches, second set.
    GameLook("snakes", "Snakes & Ladders", "Climb up, slide down — 2 to 4 players", "🐍", Color(0xFF43A047), Color(0xFF1B5E20), true),
    GameLook("four_row", "Four in a Row", "Line up four before your friend does", "🔴", Color(0xFF1565C0), Color(0xFF0D2C6B), true),
    // Quick games, second set.
    GameLook("dice", "Lucky Dice", "Pick your chance, roll under or over", "🎲", Color(0xFF8E24AA), Color(0xFF3D0B5A), false),
    GameLook("coin_toss", "Toss Up", "Heads or tails?", "🪙", Color(0xFFFFB300), Color(0xFFB26A00), false),
    GameLook("wheel", "Fortune Wheel", "Spin twenty segments", "🎡", Color(0xFFEC407A), Color(0xFF880E4F), false),
    GameLook("keno", "Number Draw", "Pick up to ten of forty", "🔢", Color(0xFF26A69A), Color(0xFF00695C), false),
    GameLook("limbo", "Sky High", "Set a target — will it fly that high?", "🎈", Color(0xFF29B6F6), Color(0xFF01579B), false),
    GameLook("roulette", "Roulette", "One zero, thirty-seven pockets", "🎯", Color(0xFF2E7D32), Color(0xFF1B3D1E), false),
    GameLook("dragon_tiger", "Dragon Tiger", "One card each — which is higher?", "🐉", Color(0xFFE53935), Color(0xFF4A148C), false),
    GameLook("andar_bahar", "Andar Bahar", "Inside or outside — where will it match?", "🃏", Color(0xFFFF7043), Color(0xFF6D1B0A), false),
    GameLook("hilo", "Higher or Lower", "Guess the next card, stop when you like", "🔼", Color(0xFF5C6BC0), Color(0xFF1A237E), false),
    GameLook("mines", "Gem Field", "Find the gems, dodge the mines", "💎", Color(0xFF00ACC1), Color(0xFF004D60), false),
).associateBy { it.gameId }

fun lookOf(gameId: String): GameLook =
    GAME_LOOKS[gameId] ?: GameLook(gameId, gameId, "", "🎮", Color(0xFF594D8C), Color(0xFF2E2652), false)

/** A game's tile: its gradient, glyph, name and line. */
@Composable
fun GameTile(look: GameLook, modifier: Modifier = Modifier, badge: String? = null, onClick: () -> Unit) {
    val c = ZipperTheme.colors
    Box(
        modifier
            .background(Brush.linearGradient(listOf(look.from, look.to)), RoundedCornerShape(Radius.lg))
            .clickableNoRipple(onClick)
            .padding(Space.md),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(Space.xs)) {
            Text(look.glyph, fontSize = 34.sp)
            Text(look.name, style = ZipperTheme.type.headingS, color = Color.White)
            Text(look.tagline, style = ZipperTheme.type.caption, color = Color.White.copy(alpha = 0.85f), maxLines = 2)
        }
        if (badge != null) {
            Text(
                badge,
                style = ZipperTheme.type.labelS,
                color = c.textPrimary,
                modifier = Modifier.align(Alignment.TopEnd)
                    .background(c.bgBase.copy(alpha = 0.75f), CircleShape)
                    .padding(horizontal = Space.sm, vertical = 2.dp),
            )
        }
    }
}

/** A row of choices (entry amounts, player counts, risk levels): one selected. */
@Composable
fun <T> ChoiceRow(options: List<T>, selected: T?, label: (T) -> String, enabled: Boolean = true, onSelect: (T) -> Unit) {
    val c = ZipperTheme.colors
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(Space.sm),
    ) {
        options.forEach { o ->
            val on = o == selected
            Text(
                label(o),
                style = ZipperTheme.type.labelM,
                color = if (on) c.textOnBrand else c.textPrimary,
                modifier = Modifier
                    .background(if (on) c.brandPrimary else c.bgElevated, CircleShape)
                    .border(1.dp, if (on) c.brandPrimary else c.borderSubtle, CircleShape)
                    .then(if (enabled) Modifier.clickableNoRipple { onSelect(o) } else Modifier)
                    .padding(horizontal = Space.lg, vertical = Space.sm),
            )
        }
    }
}

/** "◆ 1,250" — a diamond amount, Indian grouping. */
fun diamondsText(n: Long): String = "◆ " + indianGroup(n)

fun indianGroup(n: Long): String {
    val neg = n < 0
    val s = kotlin.math.abs(n).toString()
    if (s.length <= 3) return (if (neg) "-" else "") + s
    val last3 = s.takeLast(3)
    val rest = s.dropLast(3).reversed().chunked(2).joinToString(",").reversed()
    return (if (neg) "-" else "") + "$rest,$last3"
}

/** "25%" or "12.5%" — a fee percentage as people say it. */
fun feeText(pct: Double): String =
    if (pct == Math.floor(pct)) "${pct.toLong()}%" else String.format(java.util.Locale.US, "%.1f%%", pct)

/** "×2.35" */
fun multText(m: Double): String = "×" + String.format(java.util.Locale.US, "%.2f", m)

/** The big result line after a round: a win in gold, a loss quiet. */
@Composable
fun ResultBanner(payout: Long, entry: Long, multiplier: Double, modifier: Modifier = Modifier) {
    val c = ZipperTheme.colors
    val won = payout > 0
    Column(
        modifier.fillMaxWidth()
            .background(if (won) c.tintGoldSubtle else c.bgElevated, RoundedCornerShape(Radius.lg))
            .padding(Space.md),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            if (won) "You won ${diamondsText(payout)}" else "No win this time",
            style = ZipperTheme.type.headingM,
            color = if (won) c.currencyCoin else c.textSecondary,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
        )
        Text(
            if (won) "${multText(multiplier)} on ${diamondsText(entry)}" else "Entry ${diamondsText(entry)}",
            style = ZipperTheme.type.bodyS, color = c.textMuted,
        )
    }
}

/** A short plain-language line about how the game decides, for the rules sheets. */
const val FAIRNESS_LINE =
    "Every result is decided on Zipper's server, never on your phone. The server commits to a secret seed before you " +
        "play and reveals it afterwards, so every result can be checked."

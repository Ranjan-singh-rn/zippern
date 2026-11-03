package com.zipper.app.ui.screens.games

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zipper.app.data.model.Cards
import com.zipper.app.data.model.GameMatch
import com.zipper.app.data.model.TeenPattiTable
import com.zipper.app.data.repository.GameFunctions
import com.zipper.app.ui.components.*
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import kotlinx.coroutines.delay

/**
 * Teen Patti (B4, 3 Nov 2026) — the table as the server keeps it. My three cards stay face down until I choose to
 * see them (then the server sends them to me alone); everybody else's are shown only when the game is over. The
 * buttons say exactly what each choice costs — the server's own rule (functions/src/games/teenPattiEngine.ts).
 */
@Composable
fun TeenPattiTableView(
    m: GameMatch,
    me: Int,
    myCards: GameFunctions.MyCards?,
    acting: Boolean,
    onSee: () -> Unit,
    onAct: (String) -> Unit,
) {
    val t = m.teenPatti ?: return
    val c = ZipperTheme.colors
    val over = t.winners != null || m.isOver
    Column(verticalArrangement = Arrangement.spacedBy(Space.md)) {
        PotBar(t)
        SeatsGrid(m, t, me, over)
        LastMoveLine(m, t, me)
        if (me >= 0 && !over) {
            MyHand(myCards, t.seen.getOrElse(me) { false }, t.packed.getOrElse(me) { false }, acting, onSee)
            ActionBar(m, t, me, acting, onAct)
        }
        if (over && m.reveal.isNotEmpty()) {
            Text(endedLine(t), style = ZipperTheme.type.bodyS, color = c.textSecondary)
        }
        Text(
            "Hands, best first: Trail · Pure sequence · Sequence · Colour · Pair · High card. A-K-Q is the top " +
                "sequence, then A-2-3. A turn not taken in time is a pack.",
            style = ZipperTheme.type.caption, color = c.textMuted,
        )
    }
}

private fun endedLine(t: TeenPattiTable): String = when (t.endedBy) {
    "show" -> "Ended in a show."
    "pot_limit" -> "The pot reached its limit — everyone still in showed."
    "packed" -> "Everyone else packed."
    else -> ""
}

@Composable
private fun PotBar(t: TeenPattiTable) {
    val c = ZipperTheme.colors
    // The pot number counts up when it grows, so a chaal is felt, not just read.
    val shown = remember { Animatable(t.pot.toFloat()) }
    LaunchedEffect(t.pot) { shown.animateTo(t.pot.toFloat(), tween(500)) }
    Row(
        Modifier.fillMaxWidth()
            .background(Brush.linearGradient(listOf(Color(0xFF0E5B3A), Color(0xFF083B26))), RoundedCornerShape(Radius.lg))
            .padding(Space.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text("POT", style = ZipperTheme.type.labelS, color = Color.White.copy(alpha = 0.7f))
            Text(diamondsText(shown.value.toLong()), style = ZipperTheme.type.headingL, color = c.currencyCoin, fontWeight = FontWeight.Bold)
        }
        Column(horizontalAlignment = Alignment.End) {
            Text("Stake ${diamondsText(t.stake)}", style = ZipperTheme.type.labelM, color = Color.White)
            Text("Limit ${diamondsText(t.potLimit)}", style = ZipperTheme.type.caption, color = Color.White.copy(alpha = 0.7f))
        }
    }
}

@Composable
private fun SeatsGrid(m: GameMatch, t: TeenPattiTable, me: Int, over: Boolean) {
    val c = ZipperTheme.colors
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(m.deadlineMs) { while (true) { now = System.currentTimeMillis(); delay(250) } }
    val left = ((m.deadlineMs ?: now) - now).coerceAtLeast(0L) / 1000
    val rows = m.seats.indices.chunked(3)
    Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        rows.forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                row.forEach { i ->
                    val seat = m.seats[i]
                    val packed = t.packed.getOrElse(i) { false }
                    val active = !over && t.turn == i
                    val won = t.winners?.contains(i) == true
                    val reveal = m.reveal.firstOrNull { it.seat == i }
                    Column(
                        Modifier.weight(1f)
                            .background(if (won) c.tintGoldSubtle else c.bgRaised, RoundedCornerShape(Radius.md))
                            .border(if (active) 2.dp else 1.dp, if (active) c.brandPrimary else c.borderSubtle, RoundedCornerShape(Radius.md))
                            .padding(Space.sm)
                            .alpha(if (packed && !over) 0.55f else 1f),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        Avatar(seat.photoUrl, size = AvatarSize.SM, initial = seat.name)
                        Text(if (i == me) "You" else seat.name, style = ZipperTheme.type.labelS, color = c.textPrimary, maxLines = 1)
                        Text(
                            when {
                                won -> "Winner"
                                packed -> "Packed"
                                t.seen.getOrElse(i) { false } -> "Seen"
                                else -> "Blind"
                            },
                            style = ZipperTheme.type.caption,
                            color = when { won -> c.currencyCoin; packed -> c.textMuted; else -> c.textSecondary },
                        )
                        Text("In ${diamondsText(t.paid.getOrElse(i) { 0L })}", style = ZipperTheme.type.caption, color = c.textMuted)
                        if (active) Text("${left}s", style = ZipperTheme.type.labelS, color = if (left <= 5) c.statusDanger else c.brandPrimary)
                        if (reveal != null && reveal.cards.size == 3) {
                            Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                                reveal.cards.forEach { PlayingCard(it, faceUp = true, width = 26.dp) }
                            }
                            Text(reveal.hand, style = ZipperTheme.type.caption, color = if (won) c.currencyCoin else c.textSecondary)
                        }
                    }
                }
                repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

@Composable
private fun LastMoveLine(m: GameMatch, t: TeenPattiTable, me: Int) {
    val c = ZipperTheme.colors
    val e = m.lastEventRaw
    val p = (e["player"] as? Number)?.toInt() ?: return
    val who = if (p == me) "You" else m.seats.getOrNull(p)?.name ?: "Player"
    val cost = (e["cost"] as? Number)?.toLong() ?: 0L
    val line = when (e["action"] as? String) {
        "chaal" -> "$who played chaal · ${diamondsText(cost)}"
        "raise" -> "$who raised · ${diamondsText(cost)}"
        "pack" -> if (e["timedOut"] == true) "$who ran out of time and packed" else if (e["left"] == true) "$who left and packed" else "$who packed"
        "show" -> "$who asked for a show · ${diamondsText(cost)}"
        else -> return
    }
    Text(line, style = ZipperTheme.type.bodyS, color = c.textSecondary, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center)
}

@Composable
private fun MyHand(myCards: GameFunctions.MyCards?, seen: Boolean, packed: Boolean, acting: Boolean, onSee: () -> Unit) {
    val c = ZipperTheme.colors
    val cards = myCards?.cards.orEmpty()
    Column(
        Modifier.fillMaxWidth().background(c.bgRaised, RoundedCornerShape(Radius.lg)).padding(Space.md),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.sm),
    ) {
        Text(if (packed) "You packed" else "Your cards", style = ZipperTheme.type.labelM, color = c.textSecondary)
        Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
            for (k in 0 until 3) {
                val card = cards.getOrNull(k)
                // A short flip when the cards arrive.
                val flip = remember { Animatable(0f) }
                LaunchedEffect(card) { if (card != null) { flip.snapTo(90f); flip.animateTo(0f, tween(300 + k * 120)) } }
                PlayingCard(card ?: -1, faceUp = card != null, width = 64.dp, modifier = Modifier.graphicsLayer { rotationY = flip.value })
            }
        }
        if (cards.size == 3 && myCards != null) {
            Text(myCards.hand, style = ZipperTheme.type.headingS, color = c.textPrimary)
        } else if (!packed) {
            ZipperButton(
                if (seen) "Show my cards" else "See cards", onSee, size = ButtonSize.Medium, loading = acting, enabled = !acting,
            )
            if (!seen) Text("Playing blind costs half as much as playing seen.", style = ZipperTheme.type.caption, color = c.textMuted)
        }
    }
}

@Composable
private fun ActionBar(m: GameMatch, t: TeenPattiTable, me: Int, acting: Boolean, onAct: (String) -> Unit) {
    val c = ZipperTheme.colors
    if (t.packed.getOrElse(me) { true }) return
    if (t.turn != me) {
        Text(
            "Waiting for ${m.seats.getOrNull(t.turn)?.name ?: "the next player"}…",
            style = ZipperTheme.type.bodyS, color = c.textMuted, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center,
        )
        return
    }
    val chaal = t.chaalCost(me, raise = false)
    val raise = t.chaalCost(me, raise = true)
    var confirmPack by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        Text("Your turn", style = ZipperTheme.type.labelL, color = c.brandPrimary, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
            ZipperButton("Pack", { confirmPack = true }, Modifier.weight(1f), style = ButtonStyle.Secondary, size = ButtonSize.Medium, enabled = !acting)
            ZipperButton("Chaal ${diamondsText(chaal)}", { onAct("chaal") }, Modifier.weight(1.4f), size = ButtonSize.Medium,
                gradient = true, loading = acting, enabled = !acting)
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
            ZipperButton("Raise ${diamondsText(raise)}", { onAct("raise") }, Modifier.weight(1f), style = ButtonStyle.Secondary,
                size = ButtonSize.Medium, enabled = !acting)
            if (t.canShow) {
                ZipperButton("Show ${diamondsText(chaal)}", { onAct("show") }, Modifier.weight(1f), style = ButtonStyle.Secondary,
                    size = ButtonSize.Medium, enabled = !acting)
            }
        }
    }
    if (confirmPack) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirmPack = false },
            title = { Text("Pack?") },
            text = { Text("You fold. The ${diamondsText(t.paid.getOrElse(me) { 0L })} you have put in stays in the pot.") },
            confirmButton = { androidx.compose.material3.TextButton({ confirmPack = false; onAct("pack") }) { Text("Pack") } },
            dismissButton = { androidx.compose.material3.TextButton({ confirmPack = false }) { Text("Keep playing") } },
        )
    }
}

/** A card: face up (rank and suit, red or black) or the Zipper back. [card] < 0 is always the back. */
@Composable
fun PlayingCard(card: Int, faceUp: Boolean, width: Dp, modifier: Modifier = Modifier) {
    val height = width * 1.4f
    val shape = RoundedCornerShape(width * 0.12f)
    if (!faceUp || card < 0) {
        Box(
            modifier.size(width, height)
                .background(Brush.linearGradient(listOf(Color(0xFFD7263D), Color(0xFF6A0F2A))), shape)
                .border(1.dp, Color.White.copy(alpha = 0.6f), shape),
            contentAlignment = Alignment.Center,
        ) { Text("Z", color = Color.White.copy(alpha = 0.85f), fontWeight = FontWeight.Bold, fontSize = (width.value * 0.4f).sp) }
        return
    }
    val ink = if (Cards.isRed(card)) Color(0xFFD32F2F) else Color(0xFF1B1B1B)
    Box(
        modifier.size(width, height).background(Color.White, shape).border(1.dp, Color(0xFFBDBDBD), shape),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(Cards.rank(card), color = ink, fontWeight = FontWeight.Bold, fontSize = (width.value * 0.34f).sp)
            Text(Cards.suit(card), color = ink, fontSize = (width.value * 0.36f).sp)
        }
    }
}

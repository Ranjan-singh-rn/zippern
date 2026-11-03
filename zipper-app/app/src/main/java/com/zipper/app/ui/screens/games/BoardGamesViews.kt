package com.zipper.app.ui.screens.games

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zipper.app.data.model.FourRowTable
import com.zipper.app.data.model.GameMatch
import com.zipper.app.data.model.SnakesTable
import com.zipper.app.ui.components.*
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import kotlinx.coroutines.delay

/**
 * Snakes & Ladders and Four in a Row (B4, 3 Nov 2026) — drawn from the server's state. The die and every move are
 * the server's (functions/src/games/boardGames.ts); the phone sends "roll" or a column, nothing else.
 */

private val TOKEN_COLOURS = listOf(Color(0xFFE53935), Color(0xFF1E88E5), Color(0xFFFDD835), Color(0xFF43A047))

@Composable
private fun turnSecondsLeft(deadlineMs: Long?): Long {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(deadlineMs) { while (true) { now = System.currentTimeMillis(); delay(250) } }
    return ((deadlineMs ?: now) - now).coerceAtLeast(0L) / 1000
}

@Composable
private fun SeatChips(m: GameMatch, me: Int, turn: Int, over: Boolean, colourOf: (Int) -> Color, extra: (Int) -> String) {
    val c = ZipperTheme.colors
    val left = turnSecondsLeft(m.deadlineMs)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
        m.seats.forEachIndexed { i, seat ->
            val active = !over && turn == i
            Column(
                Modifier.weight(1f)
                    .background(if (m.winners.contains(seat.uid)) c.tintGoldSubtle else c.bgRaised, RoundedCornerShape(Radius.md))
                    .border(if (active) 2.dp else 1.dp, if (active) colourOf(i) else c.borderSubtle, RoundedCornerShape(Radius.md))
                    .padding(Space.sm),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Box(Modifier.size(12.dp).background(colourOf(i), CircleShape))
                Avatar(seat.photoUrl, size = AvatarSize.XS, initial = seat.name)
                Text(if (i == me) "You" else seat.name, style = ZipperTheme.type.caption, color = c.textSecondary, maxLines = 1)
                Text(if (active) "${left}s" else extra(i), style = ZipperTheme.type.caption, color = if (active && left <= 5) c.statusDanger else c.textMuted)
            }
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Snakes & Ladders
// ══════════════════════════════════════════════════════════════════════════════

@Composable
fun SnakesTableView(m: GameMatch, me: Int, acting: Boolean, onRoll: () -> Unit) {
    val t = m.snakes ?: return
    val c = ZipperTheme.colors
    val over = t.winner != null || m.isOver
    val myTurn = me >= 0 && t.turn == me && !over
    val e = m.lastEventRaw
    val die = (e["die"] as? Number)?.toInt() ?: 0
    Column(verticalArrangement = Arrangement.spacedBy(Space.md)) {
        SeatChips(m, me, t.turn, over, { TOKEN_COLOURS[it % TOKEN_COLOURS.size] }) { i ->
            if (t.out.getOrElse(i) { false }) "Out" else "Square ${t.positions.getOrElse(i) { 0 }}"
        }
        SnakesBoardCanvas(t)
        Row(
            Modifier.fillMaxWidth().background(c.bgRaised, RoundedCornerShape(Radius.md)).padding(Space.md),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            Text(dieFace(die), fontSize = 40.sp)
            Column(Modifier.weight(1f)) {
                val p = (e["player"] as? Number)?.toInt()
                if (p != null) {
                    val who = if (p == me) "You" else m.seats.getOrNull(p)?.name ?: "Player"
                    Text(
                        when {
                            e["stayed"] == true -> "$who rolled $die — too far, stays"
                            e["via"] == "ladder" -> "$who rolled $die — up a ladder to ${e["to"]}!"
                            e["via"] == "snake" -> "$who rolled $die — down a snake to ${e["to"]}"
                            e["left"] == true -> "$who left the game"
                            else -> "$who rolled $die — to ${e["to"]}"
                        } + if (e["timedOut"] == true) " (rolled by the server)" else "",
                        style = ZipperTheme.type.bodyS, color = c.textSecondary,
                    )
                }
                Text(if (myTurn) "Your turn" else if (!over) "${m.seats.getOrNull(t.turn)?.name ?: "Player"}'s turn" else "", style = ZipperTheme.type.labelL, color = c.textPrimary)
            }
            if (myTurn) ZipperButton("Roll", onRoll, size = ButtonSize.Medium, gradient = true, loading = acting, enabled = !acting)
        }
        Text("Land exactly on 100 to win. A ladder's foot takes you up; a snake's head takes you down.", style = ZipperTheme.type.caption, color = c.textMuted)
    }
}

@Composable
private fun SnakesBoardCanvas(t: SnakesTable) {
    // Tokens glide to their new squares.
    val anims = remember(t.players) { List(t.players) { Animatable(0f) } }
    t.positions.forEachIndexed { i, pos ->
        LaunchedEffect(i, pos) { anims.getOrNull(i)?.animateTo(pos.toFloat(), tween(500)) }
    }
    Canvas(Modifier.fillMaxWidth().aspectRatio(1f)) {
        val cell = size.width / 10
        fun centre(square: Int): Offset {
            val (row, col) = SnakesTable.cellOf(square)
            return Offset(col * cell + cell / 2, size.height - (row * cell + cell / 2))
        }
        for (sq in 1..100) {
            val (row, col) = SnakesTable.cellOf(sq)
            val light = (row + col) % 2 == 0
            drawRect(if (light) Color(0xFFFFF3E0) else Color(0xFFFFE0B2), Offset(col * cell, size.height - (row + 1) * cell), Size(cell, cell))
        }
        SnakesTable.LADDERS.forEach { (from, to) ->
            val a = centre(from); val b = centre(to)
            val dx = (b.y - a.y) * 0.08f; val dy = (a.x - b.x) * 0.08f
            drawLine(Color(0xFF8D6E63), a + Offset(dx, dy), b + Offset(dx, dy), strokeWidth = cell * 0.08f)
            drawLine(Color(0xFF8D6E63), a - Offset(dx, dy), b - Offset(dx, dy), strokeWidth = cell * 0.08f)
            for (k in 1..5) {
                val p = a + (b - a) * (k / 6f)
                drawLine(Color(0xFF8D6E63), p + Offset(dx, dy), p - Offset(dx, dy), strokeWidth = cell * 0.06f)
            }
        }
        SnakesTable.SNAKES.forEach { (head, tail) ->
            val a = centre(head); val b = centre(tail)
            val mid = (a + b) * 0.5f + Offset((b.y - a.y) * 0.25f, (a.x - b.x) * 0.25f)
            val path = Path().apply { moveTo(a.x, a.y); quadraticBezierTo(mid.x, mid.y, b.x, b.y) }
            drawPath(path, Color(0xFF2E7D32), style = Stroke(width = cell * 0.18f))
            drawCircle(Color(0xFF1B5E20), cell * 0.16f, a)
        }
        for (sq in listOf(1, 100)) drawCircle(Color(0xFF6A1B9A).copy(alpha = 0.25f), cell * 0.35f, centre(sq))
        anims.forEachIndexed { i, a ->
            val pos = a.value
            if (pos < 0.5f) return@forEachIndexed
            val lo = centre(pos.toInt().coerceIn(1, 100))
            val hi = centre((pos.toInt() + 1).coerceIn(1, 100))
            val f = pos - pos.toInt()
            val at = lo + (hi - lo) * f + Offset((i % 2) * cell * 0.22f - cell * 0.11f, (i / 2) * cell * 0.22f - cell * 0.11f)
            drawCircle(Color.Black.copy(alpha = 0.3f), cell * 0.22f, at + Offset(2f, 3f))
            drawCircle(TOKEN_COLOURS[i % TOKEN_COLOURS.size], cell * 0.22f, at)
            drawCircle(Color.White, cell * 0.22f, at, style = Stroke(cell * 0.05f))
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Four in a Row
// ══════════════════════════════════════════════════════════════════════════════

private val DISC = listOf(Color(0xFFE53935), Color(0xFFFDD835))

@Composable
fun FourRowTableView(m: GameMatch, me: Int, acting: Boolean, onDrop: (Int) -> Unit) {
    val t = m.fourRow ?: return
    val c = ZipperTheme.colors
    val over = t.winners != null || m.isOver
    val myTurn = me >= 0 && t.turn == me && !over
    Column(verticalArrangement = Arrangement.spacedBy(Space.md)) {
        SeatChips(m, me, t.turn, over, { DISC[it % 2] }) { i -> if (t.misses.getOrElse(i) { 0 } > 0) "Missed ${t.misses[i]}" else " " }
        Canvas(
            Modifier.fillMaxWidth().aspectRatio(FourRowTable.COLS / FourRowTable.ROWS.toFloat())
                .pointerInput(myTurn, acting, t.step) {
                    if (!myTurn || acting) return@pointerInput
                    detectTapGestures { pos ->
                        val col = (pos.x / (size.width / FourRowTable.COLS.toFloat())).toInt().coerceIn(0, FourRowTable.COLS - 1)
                        if (!t.columnFull(col)) onDrop(col)
                    }
                },
        ) {
            val cell = size.width / FourRowTable.COLS
            drawRoundRect(Color(0xFF1565C0), size = size, cornerRadius = androidx.compose.ui.geometry.CornerRadius(cell * 0.2f))
            for (row in 0 until FourRowTable.ROWS) for (col in 0 until FourRowTable.COLS) {
                val centre = Offset(col * cell + cell / 2, size.height - (row * cell + cell / 2))
                val v = t.at(row, col)
                drawCircle(if (v < 0) Color(0xFF0D2C6B) else DISC[v % 2], cell * 0.38f, centre)
                if (row * FourRowTable.COLS + col in t.line) drawCircle(Color.White, cell * 0.4f, centre, style = Stroke(cell * 0.08f))
            }
        }
        Text(
            when {
                t.endedBy == "draw" -> "A draw — the pool is shared"
                t.endedBy == "forfeit" -> "Forfeit"
                over -> ""
                myTurn -> "Your turn — tap a column"
                else -> "${m.seats.getOrNull(t.turn)?.name ?: "Player"}'s turn"
            },
            style = ZipperTheme.type.labelL, color = c.textPrimary, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center,
        )
        Text("Four of yours in a line — across, up or diagonally — wins. Two missed turns in a row forfeit.", style = ZipperTheme.type.caption, color = c.textMuted)
    }
}

package com.zipper.app.ui.screens.games

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.zipper.app.data.model.CarromPiece
import com.zipper.app.data.model.CarromTable
import com.zipper.app.data.model.CarromTable.Companion.BASE_U_MAX
import com.zipper.app.data.model.CarromTable.Companion.BASE_U_MIN
import com.zipper.app.data.model.CarromTable.Companion.BASE_V
import com.zipper.app.data.model.CarromTable.Companion.BOARD
import com.zipper.app.data.model.CarromTable.Companion.PIECE_R
import com.zipper.app.data.model.CarromTable.Companion.POCKETS
import com.zipper.app.data.model.CarromTable.Companion.POCKET_R
import com.zipper.app.data.model.CarromTable.Companion.STRIKER_R
import com.zipper.app.data.model.GameMatch
import com.zipper.app.ui.components.Avatar
import com.zipper.app.ui.components.AvatarSize
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import kotlinx.coroutines.delay
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.min
import kotlin.math.sin

/**
 * Carrom's board geometry on the phone — the same numbers as functions/src/games/carromEngine.ts. The phone never
 * simulates a shot: it turns the board so the player's own side is at the bottom, lets them place and aim the
 * striker, sends the shot, and replays the frames the server sends back.
 */
object CarromView {
    private const val C = BOARD / 2f

    /** A quarter turn clockwise (y down), [k] times — the server's `rotate`. */
    fun rotateCW(x: Float, y: Float, k: Int): Pair<Float, Float> {
        var px = x
        var py = y
        repeat(((k % 4) + 4) % 4) {
            val nx = C - (py - C)
            val ny = C + (px - C)
            px = nx
            py = ny
        }
        return px to py
    }

    /** Board → the view of a player sitting on [side] (their side at the bottom). */
    fun toView(x: Float, y: Float, side: Int): Pair<Float, Float> = rotateCW(x, y, 4 - (side % 4))

    /** My striker in my own view for a spot [x01] on my baseline. */
    fun strikerInView(x01: Float): Pair<Float, Float> =
        (BASE_U_MIN + x01.coerceIn(0f, 1f) * (BASE_U_MAX - BASE_U_MIN)) to (BOARD - BASE_V)

    /** Whether the striker at [x01] would sit on a piece — the server refuses such a shot, so the phone says so first. */
    fun strikerBlocked(table: CarromTable, side: Int, x01: Float): Boolean {
        val (vx, vy) = strikerInView(x01)
        val (bx, by) = rotateCW(vx, vy, side)
        return table.pieces.any { it.on && hypot(it.x - bx, it.y - by) < STRIKER_R + PIECE_R }
    }

    /** A slingshot: pull back from anywhere; the shot goes the other way, harder the further the pull. */
    fun shotFromDrag(dx: Float, dy: Float, boardPx: Float): Pair<Float, Float>? {
        val len = hypot(dx, dy)
        val power = min(1f, len / (boardPx * 0.4f))
        if (power < 0.05f) return null
        return atan2(-dy, -dx) to power
    }
}

private val WOOD = Color(0xFFE9CDA3)
private val FRAME = Color(0xFF5D3A1A)
private val INK = Color(0xFF7A4B22)
private val WHITE_PIECE = Color(0xFFF6EEDC)
private val BLACK_PIECE = Color(0xFF2A2A2A)
private val QUEEN = Color(0xFFD32F2F)
private val STRIKER = Color(0xFF2F6FD6)

@Composable
fun CarromTableView(m: GameMatch, me: Int, acting: Boolean, onShoot: (Float, Float, Float) -> Unit) {
    val t = m.carrom ?: return
    val c = ZipperTheme.colors
    val side = if (me >= 0) t.sides.getOrElse(me) { 0 } else 0
    val myTurn = me >= 0 && t.turn == me && t.winners == null && m.isPlaying

    // Replay: when a new shot arrives, play its frames; the state underneath is where everything ends up.
    var replay by remember { mutableStateOf<FloatArray?>(null) }
    var seenShot by remember { mutableIntStateOf(m.lastShot?.n ?: 0) }
    LaunchedEffect(m.lastShot?.n) {
        val shot = m.lastShot ?: return@LaunchedEffect
        if (shot.n <= seenShot || shot.frames.size < 2) { seenShot = maxOf(seenShot, shot.n); return@LaunchedEffect }
        seenShot = shot.n
        val total = (shot.frames.size - 1) * shot.frameMs
        val start = withFrameMillis { it }
        while (true) {
            val el = (withFrameMillis { it } - start).toFloat()
            if (el >= total) break
            val fi = el / shot.frameMs
            val i = fi.toInt().coerceAtMost(shot.frames.size - 2)
            replay = lerpFrame(shot.frames[i], shot.frames[i + 1], fi - i)
        }
        replay = null
    }

    var x01 by remember { mutableFloatStateOf(0.5f) }
    val blocked = myTurn && CarromView.strikerBlocked(t, side, x01)

    Column(verticalArrangement = Arrangement.spacedBy(Space.md)) {
        ScoresRow(m, t, me)
        CarromCanvas(
            table = t, side = side, replay = replay, myTurn = myTurn && !acting && replay == null && !blocked, x01 = x01,
            otherTurnSide = if (!myTurn && t.winners == null) t.sides.getOrElse(t.turn) { 0 } else null,
            onShoot = { angle, power -> onShoot(x01, angle, power) },
        )
        if (myTurn) {
            Column(Modifier.fillMaxWidth().background(c.bgRaised, RoundedCornerShape(Radius.md)).padding(Space.md)) {
                Text(
                    when {
                        acting -> "Shooting…"
                        blocked -> "The striker is on a piece — slide it along your line."
                        else -> "Slide to place the striker, then pull back on the board and let go."
                    },
                    style = ZipperTheme.type.labelM, color = if (blocked) c.statusWarning else c.textPrimary,
                )
                Slider(value = x01, onValueChange = { x01 = it }, enabled = !acting && replay == null)
            }
        } else if (t.winners == null && m.isPlaying) {
            Text(
                "${m.seats.getOrNull(t.turn)?.name ?: "Player"} is shooting…",
                style = ZipperTheme.type.bodyS, color = c.textMuted, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center,
            )
        }
        LastShotLine(m, me)
        Text(
            "White 20 · black 10 · queen 50 (cover her with your next pocket). Pocket and shoot again. The striker in a " +
                "pocket is a foul: −10. First to ${t.target} wins; three missed turns and you are out.",
            style = ZipperTheme.type.caption, color = c.textMuted,
        )
    }
}

private fun lerpFrame(a: FloatArray, b: FloatArray, f: Float): FloatArray = FloatArray(a.size) { i ->
    val pair = i - i % 2
    when {
        a[pair] < 0f -> -1f
        b[pair] < 0f -> if (f < 0.5f) a[i] else -1f
        else -> a[i] + (b[i] - a[i]) * f
    }
}

@Composable
private fun ScoresRow(m: GameMatch, t: CarromTable, me: Int) {
    val c = ZipperTheme.colors
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(m.deadlineMs) { while (true) { now = System.currentTimeMillis(); delay(250) } }
    val left = ((m.deadlineMs ?: now) - now).coerceAtLeast(0L) / 1000
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
        m.seats.forEachIndexed { i, seat ->
            val active = t.winners == null && t.turn == i && m.isPlaying
            val won = t.winners?.contains(i) == true
            val out = t.out.getOrElse(i) { false }
            Column(
                Modifier.weight(1f)
                    .background(if (won) c.tintGoldSubtle else c.bgRaised, RoundedCornerShape(Radius.md))
                    .border(if (active) 2.dp else 1.dp, if (active) c.brandPrimary else c.borderSubtle, RoundedCornerShape(Radius.md))
                    .padding(Space.sm),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Avatar(seat.photoUrl, size = AvatarSize.XS, initial = seat.name)
                Text(if (i == me) "You" else seat.name, style = ZipperTheme.type.caption, color = c.textSecondary, maxLines = 1)
                Text("${t.scores.getOrElse(i) { 0 }}", style = ZipperTheme.type.headingS, color = if (won) c.currencyCoin else c.textPrimary)
                Text(
                    when {
                        won -> "Winner"
                        out -> "Out"
                        active -> "${left}s"
                        t.misses.getOrElse(i) { 0 } > 0 -> "Missed ${t.misses[i]}"
                        else -> " "
                    },
                    style = ZipperTheme.type.caption,
                    color = when { out -> c.textMuted; active && left <= 5 -> c.statusDanger; else -> c.textMuted },
                )
            }
        }
    }
    Text("Shots ${t.shots} of ${t.maxShots}", style = ZipperTheme.type.caption, color = c.textMuted)
}

@Composable
private fun LastShotLine(m: GameMatch, me: Int) {
    val c = ZipperTheme.colors
    val e = m.lastEventRaw
    val p = (e["player"] as? Number)?.toInt() ?: return
    val who = if (p == me) "You" else m.seats.getOrNull(p)?.name ?: "Player"
    val line = when {
        e["timedOut"] == true -> "$who ran out of time"
        e["left"] == true -> "$who left the game"
        e["foul"] == true -> "Foul — $who pocketed the striker (−10)"
        else -> {
            val pocketed = (e["pocketed"] as? List<*>).orEmpty().map { it.toString() }
            val pts = (e["points"] as? Number)?.toInt() ?: 0
            val queen = when (e["queen"]) { "pending" -> " · cover the queen!"; "covered" -> " · queen covered"; "returned" -> " · queen back to the centre"; else -> "" }
            if (pocketed.isEmpty()) "$who missed$queen" else "$who pocketed ${pocketed.joinToString(", ")} (+$pts)$queen"
        }
    }
    Text(line, style = ZipperTheme.type.bodyS, color = c.textSecondary, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center)
}

@Composable
private fun CarromCanvas(
    table: CarromTable,
    side: Int,
    replay: FloatArray?,
    myTurn: Boolean,
    x01: Float,
    otherTurnSide: Int?,
    onShoot: (angle: Float, power: Float) -> Unit,
) {
    var dragStart by remember { mutableStateOf<Offset?>(null) }
    var dragNow by remember { mutableStateOf<Offset?>(null) }
    val currentShoot by rememberUpdatedState(onShoot)
    Canvas(
        Modifier.fillMaxWidth().aspectRatio(1f)
            .pointerInput(myTurn) {
                if (!myTurn) return@pointerInput
                detectDragGestures(
                    onDragStart = { dragStart = it; dragNow = it },
                    onDrag = { change, _ -> dragNow = change.position },
                    onDragEnd = {
                        val s = dragStart
                        val n = dragNow
                        dragStart = null
                        dragNow = null
                        if (s != null && n != null) {
                            CarromView.shotFromDrag(n.x - s.x, n.y - s.y, size.width.toFloat())?.let { (a, p) -> currentShoot(a, p) }
                        }
                    },
                    onDragCancel = { dragStart = null; dragNow = null },
                )
            },
    ) {
        val k = size.width / BOARD
        fun v(x: Float, y: Float): Offset { val (vx, vy) = CarromView.toView(x, y, side); return Offset(vx * k, vy * k) }

        drawBoard(k)
        // Pockets (symmetric, drawn in view space).
        POCKETS.forEach { (px, py) -> drawCircle(Color(0xFF151515), POCKET_R * k, Offset(px * k, py * k)) }

        if (replay != null) {
            for (b in 0 until replay.size / 2) {
                val x = replay[2 * b]
                val y = replay[2 * b + 1]
                if (x < 0f) continue
                if (b == 0) drawStriker(v(x, y), k, 1f) else drawPiece(table.pieces.getOrNull(b - 1)?.kind ?: "white", v(x, y), k)
            }
        } else {
            table.pieces.forEach { p: CarromPiece -> if (p.on) drawPiece(p.kind, v(p.x, p.y), k) }
            if (myTurn) {
                val (sx, sy) = CarromView.strikerInView(x01)
                val at = Offset(sx * k, sy * k)
                drawStriker(at, k, 1f)
                val s = dragStart
                val n = dragNow
                if (s != null && n != null) {
                    CarromView.shotFromDrag(n.x - s.x, n.y - s.y, size.width)?.let { (a, p) ->
                        val len = (80f + 320f * p) * k
                        drawLine(
                            Color.White.copy(alpha = 0.9f), at, Offset(at.x + cos(a) * len, at.y + sin(a) * len),
                            strokeWidth = 3.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(14f, 10f)),
                        )
                        drawCircle(Color.White.copy(alpha = 0.35f + 0.5f * p), (STRIKER_R + 6f + 18f * p) * k, at, style = Stroke(3.dp.toPx()))
                    }
                }
            } else if (otherTurnSide != null) {
                // The shooter's striker, waiting on their own line.
                val (bx, by) = CarromView.rotateCW(BOARD / 2f, BOARD - BASE_V, otherTurnSide)
                drawStriker(v(bx, by), k, 0.45f)
            }
        }
    }
}

private fun DrawScope.drawBoard(k: Float) {
    drawRect(WOOD, size = Size(size.width, size.height))
    drawRect(FRAME, size = Size(size.width, size.height), style = Stroke(10f * k))
    val c = Offset(BOARD / 2f * k, BOARD / 2f * k)
    drawCircle(INK, 85f * k, c, style = Stroke(2f * k))
    drawCircle(INK, 16f * k, c, style = Stroke(2f * k))
    // The four baselines: two lines and an end circle each side — the same on every side.
    for (q in 0 until 4) {
        fun p(u: Float, vv: Float): Offset { val (x, y) = CarromView.rotateCW(u, BOARD - vv, q); return Offset(x * k, y * k) }
        drawLine(INK, p(BASE_U_MIN, BASE_V - 16f), p(BASE_U_MAX, BASE_V - 16f), strokeWidth = 2f * k)
        drawLine(INK, p(BASE_U_MIN, BASE_V + 16f), p(BASE_U_MAX, BASE_V + 16f), strokeWidth = 2f * k)
        drawCircle(QUEEN.copy(alpha = 0.8f), 16f * k, p(BASE_U_MIN, BASE_V), style = Stroke(2f * k))
        drawCircle(QUEEN.copy(alpha = 0.8f), 16f * k, p(BASE_U_MAX, BASE_V), style = Stroke(2f * k))
    }
}

private fun DrawScope.drawPiece(kind: String, at: Offset, k: Float) {
    val fill = when (kind) { "queen" -> QUEEN; "black" -> BLACK_PIECE; else -> WHITE_PIECE }
    drawCircle(Color.Black.copy(alpha = 0.25f), PIECE_R * k, at + Offset(1.5f * k, 2f * k))
    drawCircle(fill, PIECE_R * k, at)
    drawCircle(if (kind == "black") Color(0xFF555555) else Color(0xFFB08A5A), PIECE_R * 0.65f * k, at, style = Stroke(1.5f * k))
}

private fun DrawScope.drawStriker(at: Offset, k: Float, alpha: Float) {
    drawCircle(Color.Black.copy(alpha = 0.25f * alpha), STRIKER_R * k, at + Offset(2f * k, 2.5f * k))
    drawCircle(STRIKER.copy(alpha = alpha), STRIKER_R * k, at)
    drawCircle(Color.White.copy(alpha = 0.8f * alpha), STRIKER_R * 0.6f * k, at, style = Stroke(2f * k))
}

package com.zipper.app.ui.screens.games

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import com.zipper.app.data.model.LudoBoard
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlin.math.hypot

/** Player colours by ARM (arm 0 red, then clockwise). */
val LUDO_COLOURS = listOf(
    Color(0xFFE53935), Color(0xFF43A047), Color(0xFFFDD835),
    Color(0xFF1E88E5), Color(0xFF8E24AA), Color(0xFFFB8C00),
)

/**
 * The board, drawn from the server's state. Tokens slide to where the server put them; when it is my turn and a
 * roll is waiting, the tokens I may move pulse and a tap on one is reported through [onToken].
 */
@Composable
fun LudoBoardView(
    board: LudoBoard,
    me: Int,
    modifier: Modifier = Modifier,
    onToken: (Int) -> Unit,
) {
    val movable = if (board.turn == me && board.roll != null && board.winner == null) board.movable(me, board.roll) else emptyList()
    val pulse by rememberInfiniteTransition(label = "pulse").animateFloat(
        0.6f, 1f, infiniteRepeatable(tween(600), RepeatMode.Reverse), label = "pulse",
    )
    // One animated position per token, keyed by player × token, so a move slides rather than jumps.
    val anims = remember(board.armOf.size) {
        List(board.armOf.size) { List(4) { Animatable(0f) to Animatable(0f) } }
    }
    board.tokens.forEachIndexed { p, toks ->
        toks.forEachIndexed { t, rel ->
            val pt = LudoGeometry.tokenPoint(board.arms, board.armOf[p], rel, t)
            LaunchedEffect(p, t, pt) {
                val (ax, ay) = anims[p][t]
                if (ax.value == 0f && ay.value == 0f) { ax.snapTo(pt.x); ay.snapTo(pt.y) }
                else coroutineScope {
                    launch { ax.animateTo(pt.x, tween(350)) }
                    launch { ay.animateTo(pt.y, tween(350)) }
                }
            }
        }
    }

    Canvas(
        modifier.fillMaxWidth().aspectRatio(1f).pointerInput(movable, me) {
            detectTapGestures { tap ->
                if (movable.isEmpty()) return@detectTapGestures
                val unit = size.width / LudoGeometry.SIZE
                val hit = movable.minByOrNull { t ->
                    val (ax, ay) = anims[me][t]
                    hypot(ax.value * unit - tap.x, ay.value * unit - tap.y)
                } ?: return@detectTapGestures
                val (ax, ay) = anims[me][hit]
                if (hypot(ax.value * unit - tap.x, ay.value * unit - tap.y) < unit * 1.2f) onToken(hit)
            }
        },
    ) {
        val unit = size.width / LudoGeometry.SIZE
        drawBoard(board, unit)
        // Tokens: same-square stacks are nudged apart so every one can be seen.
        val seen = mutableMapOf<Pair<Int, Int>, Int>()
        board.tokens.forEachIndexed { p, toks ->
            if (board.out.contains(p)) return@forEachIndexed
            toks.forEachIndexed { t, _ ->
                val (ax, ay) = anims[p][t]
                val key = (ax.value * 10).toInt() to (ay.value * 10).toInt()
                val k = seen.merge(key, 1, Int::plus) ?: 1
                val nudge = (k - 1) * unit * 0.18f
                val c = Offset(ax.value * unit + nudge, ay.value * unit - nudge)
                val colour = LUDO_COLOURS[board.armOf[p] % LUDO_COLOURS.size]
                val r = unit * 0.36f
                if (p == me && t in movable) drawCircle(Color.White.copy(alpha = pulse), r * 1.45f, c)
                drawCircle(Color.Black.copy(alpha = 0.25f), r, c + Offset(unit * 0.05f, unit * 0.06f))
                drawCircle(colour, r, c)
                drawCircle(Color.White, r * 0.45f, c)
                drawCircle(Color.Black.copy(alpha = 0.35f), r, c, style = Stroke(unit * 0.04f))
            }
        }
    }
}

private fun DrawScope.drawBoard(board: LudoBoard, unit: Float) {
    drawRect(Color(0xFFFAF7F0))
    if (board.arms == 6) {
        // The ring: 78 squares, starts coloured, stars marked; spokes for the home columns.
        for (i in 0 until 78) {
            val p = LudoGeometry.trackPoint(6, i)
            val arm = i / 13
            val fill = when {
                LudoGeometry.isStart(i) -> LUDO_COLOURS[arm]
                LudoGeometry.isStar(i) -> Color(0xFFE0E0E0)
                else -> Color.White
            }
            drawCircle(fill, unit * 0.42f, Offset(p.x * unit, p.y * unit))
            drawCircle(Color(0xFF9E9E9E), unit * 0.42f, Offset(p.x * unit, p.y * unit), style = Stroke(unit * 0.03f))
        }
        for (arm in 0 until 6) {
            for (step in 1..5) {
                val p = LudoGeometry.tokenPoint(6, arm, 76 + step, 0)
                drawCircle(LUDO_COLOURS[arm].copy(alpha = 0.7f), unit * 0.36f, Offset(p.x * unit, p.y * unit))
            }
        }
        drawCircle(Color(0xFFFFF3C4), unit * 1.1f, Offset(7.5f * unit, 7.5f * unit))
        return
    }
    // The cross: yards, track, home columns, centre.
    val yards = listOf(0 to 0, 0 to 9, 9 to 9, 9 to 0)
    yards.forEachIndexed { arm, (r, c) ->
        drawRect(LUDO_COLOURS[arm], Offset(c * unit, r * unit), Size(6 * unit, 6 * unit))
        drawRect(Color.White, Offset((c + 1) * unit, (r + 1) * unit), Size(4 * unit, 4 * unit))
    }
    LudoGeometry.CROSS_TRACK.forEachIndexed { i, (r, c) ->
        val fill = when {
            LudoGeometry.isStart(i) -> LUDO_COLOURS[(i / 13) % 4]
            LudoGeometry.isStar(i) -> Color(0xFFE6E6E6)
            else -> Color.White
        }
        drawRect(fill, Offset(c * unit, r * unit), Size(unit, unit))
        drawRect(Color(0xFFBDBDBD), Offset(c * unit, r * unit), Size(unit, unit), style = Stroke(unit * 0.03f))
        if (LudoGeometry.isStar(i)) drawCircle(Color(0xFFFFC107), unit * 0.18f, Offset((c + 0.5f) * unit, (r + 0.5f) * unit))
    }
    LudoGeometry.CROSS_HOME.forEachIndexed { arm, squares ->
        squares.forEach { (r, c) ->
            drawRect(LUDO_COLOURS[arm].copy(alpha = 0.75f), Offset(c * unit, r * unit), Size(unit, unit))
            drawRect(Color(0xFFBDBDBD), Offset(c * unit, r * unit), Size(unit, unit), style = Stroke(unit * 0.03f))
        }
    }
    drawRect(Color(0xFFFFF3C4), Offset(6 * unit, 6 * unit), Size(3 * unit, 3 * unit))
}

/** Faces ⚀ … ⚅ for 1 … 6. */
fun dieFace(n: Int): String = if (n in 1..6) "⚀⚁⚂⚃⚄⚅"[n - 1].toString() else "🎲"

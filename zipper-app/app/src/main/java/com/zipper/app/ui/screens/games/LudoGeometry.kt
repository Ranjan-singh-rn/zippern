package com.zipper.app.ui.screens.games

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * Where things are drawn on a Ludo board (B4, 3 Nov 2026). Pure — no Compose — and unit-tested
 * (`LudoGeometryTest`). Positions are in BOARD UNITS: the board is [SIZE] × [SIZE] units, a square is 1 × 1 and
 * a point is the CENTRE of a square, so (0.5, 0.5) is the middle of the top-left square.
 *
 * Two layouts, matching the server's two boards (functions/src/games/ludoEngine.ts):
 *
 *  * 4 arms — the classic 15 × 15 cross. The shared track is 52 squares, clockwise, starting at arm 0's start
 *    square (row 6, column 1). Arm a starts at track index 13a; its star is 13a + 8. Each arm has a 5-square home
 *    column into the centre. Yards are the four 6 × 6 corners.
 *  * 6 arms — a ring of 78 squares (Zipper's own six-player board), home columns as spokes into the centre, yards
 *    outside the ring by each start.
 */
object LudoGeometry {
    const val SIZE = 15f

    data class Pt(val x: Float, val y: Float)

    /** The 52-square track of the cross, as (row, column), index 0 = arm 0's start. */
    val CROSS_TRACK: List<Pair<Int, Int>> = buildList {
        for (c in 1..5) add(6 to c)                 // 0–4    left arm, top row, rightwards
        for (r in 5 downTo 0) add(r to 6)           // 5–10   up the top arm's left column
        add(0 to 7); add(0 to 8)                    // 11–12  across the top
        for (r in 1..5) add(r to 8)                 // 13–17  arm 1 starts at (1, 8)
        for (c in 9..14) add(6 to c)                // 18–23
        add(7 to 14); add(8 to 14)                  // 24–25
        for (c in 13 downTo 9) add(8 to c)          // 26–30  arm 2 starts at (8, 13)
        for (r in 9..14) add(r to 8)                // 31–36
        add(14 to 7); add(14 to 6)                  // 37–38
        for (r in 13 downTo 9) add(r to 6)          // 39–43  arm 3 starts at (13, 6)
        for (c in 5 downTo 0) add(8 to c)           // 44–49
        add(7 to 0); add(6 to 0)                    // 50–51
    }

    /** Home column squares (row, col) for each arm of the cross, outermost first. */
    val CROSS_HOME: List<List<Pair<Int, Int>>> = listOf(
        (1..5).map { 7 to it },
        (1..5).map { it to 7 },
        (13 downTo 9).map { 7 to it },
        (13 downTo 9).map { it to 7 },
    )

    /** The 6 × 6 yard corners (top-left row, col) per arm. */
    private val CROSS_YARD = listOf(0 to 0, 0 to 9, 9 to 9, 9 to 0)

    private fun cell(rc: Pair<Int, Int>) = Pt(rc.second + 0.5f, rc.first + 0.5f)

    /** Where a token is drawn: the player's arm, its relative position (see the engine) and its index (for yards). */
    fun tokenPoint(arms: Int, arm: Int, rel: Int, tokenIndex: Int): Pt =
        if (arms == 6) ringToken(arm, rel, tokenIndex) else crossToken(arm, rel, tokenIndex)

    /** The centre of a track square by its ring index — for drawing the board. */
    fun trackPoint(arms: Int, index: Int): Pt =
        if (arms == 6) ringPoint(index) else cell(CROSS_TRACK[((index % 52) + 52) % 52])

    fun isStar(index: Int) = index % 13 == 8
    fun isStart(index: Int) = index % 13 == 0

    // ── The cross ─────────────────────────────────────────────────────────────

    private fun crossToken(arm: Int, rel: Int, tokenIndex: Int): Pt {
        val track = 51
        val home = 56
        return when {
            rel < 0 -> {
                val (r0, c0) = CROSS_YARD[arm]
                val dr = if (tokenIndex / 2 == 0) 1.5f else 3.5f
                val dc = if (tokenIndex % 2 == 0) 1.5f else 3.5f
                Pt(c0 + dc + 0.5f, r0 + dr + 0.5f)
            }
            rel < track -> cell(CROSS_TRACK[(arm * 13 + rel) % 52])
            rel < home -> cell(CROSS_HOME[arm][rel - track])
            else -> {
                // Home: four spots around the centre, nudged toward the player's arm.
                val off = listOf(Pt(-0.6f, 0f), Pt(0f, -0.6f), Pt(0.6f, 0f), Pt(0f, 0.6f))[arm % 4]
                Pt(7.5f + off.x + (tokenIndex - 1.5f) * 0.12f, 7.5f + off.y)
            }
        }
    }

    // ── The ring (six arms) ───────────────────────────────────────────────────

    private const val RING_SQUARES = 78
    private const val RING_R = 5.2f
    private const val CENTRE = 7.5f

    private fun ringPoint(index: Int): Pt {
        val a = 2 * PI * (((index % RING_SQUARES) + RING_SQUARES) % RING_SQUARES) / RING_SQUARES - PI / 2
        return Pt(CENTRE + RING_R * cos(a).toFloat(), CENTRE + RING_R * sin(a).toFloat())
    }

    private fun ringToken(arm: Int, rel: Int, tokenIndex: Int): Pt {
        val track = 77
        val home = 82
        val startIndex = arm * 13
        val a = 2 * PI * startIndex / RING_SQUARES - PI / 2
        return when {
            rel < 0 -> {
                // Outside the ring, by the start square.
                val r = RING_R + 1.2f + (tokenIndex / 2) * 0.5f
                val spread = (tokenIndex % 2 - 0.5f) * 0.12f
                Pt(CENTRE + r * cos(a + spread).toFloat(), CENTRE + r * sin(a + spread).toFloat())
            }
            rel < track -> ringPoint(startIndex + rel)
            rel < home -> {
                // The spoke from the square before the start, inwards.
                val entry = 2 * PI * (startIndex - 1) / RING_SQUARES - PI / 2
                val step = rel - track + 1
                val r = RING_R - step * 0.8f
                Pt(CENTRE + r * cos(entry).toFloat(), CENTRE + r * sin(entry).toFloat())
            }
            else -> {
                val r = 0.6f
                Pt(CENTRE + r * cos(a).toFloat() + (tokenIndex - 1.5f) * 0.1f, CENTRE + r * sin(a).toFloat())
            }
        }
    }
}

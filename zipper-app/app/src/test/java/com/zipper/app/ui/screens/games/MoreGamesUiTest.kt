package com.zipper.app.ui.screens.games

import com.zipper.app.data.model.FourRowTable
import com.zipper.app.data.model.SnakesTable
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * B4/B5 (3 Nov 2026) — the second set of games on the phone. The odds the phone shows before a player pays are the
 * server's own (the numbers below are what functions/src/games/moreMath.ts computes — test/moreGames.test.js pins
 * the same ones), the boards read the server's state the way the server writes it, and no screen decides a result.
 */
class MoreGamesUiTest {

    private val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
    private fun src(path: String) = File(main, "com/zipper/app/$path").readText()

    @Test fun `the odds shown are the server's`() {
        assertEquals(1.94, QuickOdds.dice(50, 3.0), 0.0)
        assertEquals(48.5, QuickOdds.dice(2, 3.0), 0.0)
        assertEquals(1.94, QuickOdds.coin(3.0), 0.0)
        assertEquals(19.4, QuickOdds.wheel("high", 3.0).last(), 0.0)
        assertEquals(listOf(1.46, 1.17), QuickOdds.wheel("low", 3.0).take(2))
        assertEquals(listOf(0.0, 0.0, 0.0, 9.41, 18.82, 112.92), QuickOdds.keno(5, 3.0))
        assertEquals(listOf(0.0, 3.88), QuickOdds.keno(1, 3.0))
        assertEquals(36.0, QuickOdds.roulette("straight", 2.7), 0.0)
        assertEquals(3.0, QuickOdds.roulette("dozen", 2.7), 0.0)
        assertEquals(2.0, QuickOdds.roulette("red", 2.7), 0.0)
        assertEquals(2.0 to 16.5, QuickOdds.dragonTiger(2.94))
        assertEquals(1.88 to 2.0, QuickOdds.andarBahar(3.0))
        assertEquals(1.1, QuickOdds.mines(3, 1, 3.0), 0.0)
        assertEquals(24.25, QuickOdds.mines(24, 1, 3.0), 0.0)
        assertEquals(1.0, QuickOdds.mines(5, 0, 3.0), 0.0)
    }

    @Test fun `higher includes the same rank - an ace can only be matched, never beaten`() {
        assertEquals(1.0 / 13, QuickOdds.hiloChance(12, higher = true), 1e-12)
        assertEquals(1.0, QuickOdds.hiloChance(12, higher = false), 1e-12)
        assertEquals(1.0, QuickOdds.hiloChance(0, higher = true), 1e-12)
        // A seven (rank 5): higher-or-same 8 of 13 → 1 × 0.97 × 13 / 8 = 1.57.
        assertEquals(1.57, QuickOdds.hiloNext(1.0, 5, higher = true, edge = 3.0), 0.0)
    }

    @Test fun `snakes - squares snake across the rows, and the board is the server's`() {
        assertEquals(0 to 0, SnakesTable.cellOf(1))
        assertEquals(0 to 9, SnakesTable.cellOf(10))
        assertEquals(1 to 9, SnakesTable.cellOf(11))      // the second row runs right to left
        assertEquals(1 to 0, SnakesTable.cellOf(20))
        assertEquals(9 to 0, SnakesTable.cellOf(100))
        assertEquals(20, SnakesTable.LADDERS[3]); assertEquals(81, SnakesTable.SNAKES[99])
        assertTrue(SnakesTable.LADDERS.all { (a, b) -> b > a })
        assertTrue(SnakesTable.SNAKES.all { (a, b) -> b < a })
        val t = SnakesTable.from(mapOf("players" to 2, "positions" to listOf(5, 0), "turn" to 1, "step" to 3,
            "misses" to listOf(0, 1), "out" to listOf(false, false)))!!
        assertEquals(listOf(5, 0), t.positions)
        assertEquals(null, t.winner)
    }

    @Test fun `four in a row - cells are row by row from the bottom`() {
        val cells = MutableList(42) { -1 }
        cells[0] = 0; cells[7] = 1; cells[35 + 3] = 0
        val t = FourRowTable.from(mapOf("cells" to cells, "turn" to 1, "step" to 3, "misses" to listOf(0, 0), "line" to emptyList<Int>()))!!
        assertEquals(0, t.at(0, 0))
        assertEquals(1, t.at(1, 0))
        assertTrue(t.columnFull(3))
        assertFalse(t.columnFull(0))
    }

    @Test fun `no screen decides a result - the second set only asks the server`() {
        val more = src("ui/screens/games/MoreInstantGames.kt")
        val board = src("ui/screens/games/BoardGamesViews.kt")
        // The only randomness on the phone is Quick pick (choosing numbers for the player), never an outcome.
        assertEquals(1, Regex("shuffled\\(").findAll(more).count())
        assertFalse(board.contains("Random") || board.contains("shuffled("))
        val fns = src("data/repository/GameFunctions.kt")
        listOf("playDice", "tossCoin", "spinWheel", "playKeno", "playLimbo", "spinRoulette", "playDragonTiger", "playAndarBahar",
            "hiloStart", "hiloGuess", "hiloCashout", "minesStart", "minesReveal", "minesCashout", "snakesRoll", "fourRowDrop",
        ).forEach { assertTrue(it, fns.contains("\"$it\"")) }
        val looks = src("ui/screens/games/GameVisuals.kt")
        listOf("snakes", "four_row", "dice", "coin_toss", "wheel", "keno", "limbo", "roulette", "dragon_tiger", "andar_bahar", "hilo", "mines")
            .forEach { assertTrue(it, looks.contains("GameLook(\"$it\"")) }
    }
}

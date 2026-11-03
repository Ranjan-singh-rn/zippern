package com.zipper.app.ui.screens.games

import com.zipper.app.data.model.CarromPiece
import com.zipper.app.data.model.CarromReplay
import com.zipper.app.data.model.CarromTable
import com.zipper.app.data.model.Cards
import com.zipper.app.data.model.TeenPattiTable
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.math.PI

/**
 * B4 (3 Nov 2026) — Teen Patti and Carrom on the phone: the buttons quote the server's prices, the board is turned
 * the way the server turns it, the replay frames decode exactly as the server packs them, and neither screen decides
 * an outcome itself.
 */
class TeenPattiCarromUiTest {

    private val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
    private fun src(path: String) = File(main, "com/zipper/app/$path").readText()

    private fun table(seen: List<Boolean>, packed: List<Boolean> = seen.map { false }, stake: Long = 100) = TeenPattiTable(
        players = seen.size, boot = 100, stake = stake, pot = 100L * seen.size, potLimit = 12_800,
        paid = seen.map { 100L }, seen = seen, packed = packed, turn = 0, step = 0, winners = null, endedBy = null,
    )

    @Test fun `teen patti prices are the server's - blind pays the stake, seen twice, a raise doubles first`() {
        val t = table(listOf(false, true), stake = 100)
        assertEquals(100L, t.chaalCost(0, raise = false))
        assertEquals(200L, t.chaalCost(0, raise = true))
        assertEquals(200L, t.chaalCost(1, raise = false))
        assertEquals(400L, t.chaalCost(1, raise = true))
    }

    @Test fun `a show is offered only with exactly two players left`() {
        assertTrue(table(listOf(false, false)).canShow)
        assertFalse(table(listOf(false, false, false)).canShow)
        assertTrue(table(listOf(false, false, false), packed = listOf(false, true, false)).canShow)
    }

    @Test fun `cards read as the server deals them - rank is card mod 13, suit card div 13`() {
        assertEquals("2", Cards.rank(0)); assertEquals("♠", Cards.suit(0))
        assertEquals("A", Cards.rank(12)); assertEquals("10", Cards.rank(8))
        assertEquals("♥", Cards.suit(13)); assertTrue(Cards.isRed(13)); assertTrue(Cards.isRed(26)); assertFalse(Cards.isRed(39))
        assertEquals("♣", Cards.suit(51)); assertEquals("A", Cards.rank(51))
    }

    @Test fun `carrom - a quarter turn four times is no turn, and the view undoes the side's turn`() {
        val (x, y) = CarromView.rotateCW(123f, 456f, 4)
        assertEquals(123f, x, 1e-3f); assertEquals(456f, y, 1e-3f)
        for (side in 0..3) {
            val (bx, by) = CarromView.rotateCW(200f, 635f, side)
            val (vx, vy) = CarromView.toView(bx, by, side)
            assertEquals(200f, vx, 1e-3f); assertEquals(635f, vy, 1e-3f)
        }
        // The server: seat 0 at x01 = 0 is (175, 635); the top player's left end is the board's right (565, 105).
        assertEquals(175f to 635f, CarromView.rotateCW(175f, 635f, 0))
        val (tx, ty) = CarromView.rotateCW(175f, 635f, 2)
        assertEquals(565f, tx, 1e-3f); assertEquals(105f, ty, 1e-3f)
    }

    @Test fun `carrom - the striker on a piece is caught before the server refuses it`() {
        val t = CarromTable(
            players = 2, sides = listOf(0, 2), pieces = listOf(CarromPiece("white", 180f, 635f, true)),
            scores = listOf(0, 0), misses = listOf(0, 0), out = listOf(false, false), turn = 0, step = 0, shots = 0,
            maxShots = 50, target = 160, queenPendingBy = null, winners = null, endedBy = null,
        )
        assertTrue(CarromView.strikerBlocked(t, 0, 0f))
        assertFalse(CarromView.strikerBlocked(t, 0, 1f))
        // From the top side the same spot is the other end of their line.
        assertFalse(CarromView.strikerBlocked(t, 2, 0f))
    }

    @Test fun `carrom - pulling back shoots the other way, and a tiny pull is not a shot`() {
        val (angle, power) = CarromView.shotFromDrag(0f, 200f, 1000f)!!    // pull straight down → shoot straight up
        assertEquals(-PI.toFloat() / 2f, angle, 1e-4f)
        assertEquals(0.5f, power, 1e-4f)
        assertEquals(1f, CarromView.shotFromDrag(0f, 5000f, 1000f)!!.second, 0f)
        assertNull(CarromView.shotFromDrag(3f, 3f, 1000f))
    }

    @Test fun `carrom - replay frames decode exactly as the server packs them`() {
        // functions/src/games/carromEngine.ts packFrames([[1,2,3,4],[-1,-1,740,0]])
        val frames = CarromReplay.unpack("AQACAAMABAD/////5AIAAA==", bodies = 2)
        assertEquals(2, frames.size)
        assertArrayEquals(floatArrayOf(1f, 2f, 3f, 4f), frames[0], 0f)
        assertArrayEquals(floatArrayOf(-1f, -1f, 740f, 0f), frames[1], 0f)
        assertTrue(CarromReplay.unpack("not base64 !!", 2).isEmpty())
    }

    @Test fun `neither screen decides an outcome - they send choices and draw the server's state`() {
        val tp = src("ui/screens/games/TeenPattiTable.kt")
        val cr = src("ui/screens/games/CarromBoard.kt")
        listOf(tp, cr).forEach { s ->
            assertFalse(s.contains("Random"))
            assertFalse(s.contains("diamonds -="))
        }
        // The phone never simulates carrom: no friction or collision code on this side.
        assertFalse(cr.contains("restitution", ignoreCase = true))
        val fns = src("data/repository/GameFunctions.kt")
        assertTrue(fns.contains("\"teenPattiAction\"") && fns.contains("\"carromShot\"") && fns.contains("\"teenPattiMyCards\""))
        // The step goes with every action, so a stale tap does nothing on the server.
        assertTrue(fns.contains("\"step\" to step"))
    }

    @Test fun `the match screen has a table for each multiplayer game`() {
        val screen = src("ui/screens/games/GameMatchScreen.kt")
        assertTrue(screen.contains("TeenPattiTableView("))
        assertTrue(screen.contains("CarromTableView("))
        assertTrue(screen.contains("m.stateStep"))
    }
}

/** Firestore stores no array inside an array: the server sends Ludo's tokens and the slot grid flat. */
class FlatStorageUiTest {
    @Test fun `ludo tokens arrive flat - four per player - and read back per player`() {
        val t = com.zipper.app.data.model.LudoBoard.tokensOf(listOf(-1, 3, 56, -1, 10, 11, 12, 13), 2)
        assertEquals(listOf(listOf(-1, 3, 56, -1), listOf(10, 11, 12, 13)), t)
        // An older nested list still reads.
        assertEquals(listOf(listOf(1, 2, 3, 4)), com.zipper.app.data.model.LudoBoard.tokensOf(listOf(listOf(1, 2, 3, 4)), 1))
    }

    @Test fun `the slot grid arrives flat - reel by reel`() {
        val g = slotGrid(mapOf("grid" to (0 until 15).toList(), "reels" to 5, "rows" to 3))
        assertEquals(5, g.size)
        assertEquals(listOf(3, 4, 5), g[1])
        assertTrue(slotGrid(mapOf("grid" to listOf(1, 2), "reels" to 5, "rows" to 3)).isEmpty())
    }
}

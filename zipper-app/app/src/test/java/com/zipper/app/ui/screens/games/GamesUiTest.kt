package com.zipper.app.ui.screens.games

import com.zipper.app.data.model.LudoBoard
import com.zipper.app.ui.screens.main.navItemsFor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.math.abs

/**
 * B4–B6 (3 Nov 2026) — the app side of the games: the board is drawn where the server's rules say, the lobby shows
 * the server's split before anybody pays, the Games tab exists only when games are switched on, and no screen
 * decides an outcome itself.
 */
class GamesUiTest {

    private val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
    private fun src(path: String) = File(main, "com/zipper/app/$path").readText()

    @Test fun `the cross has 52 distinct track squares, starts every 13 and stars 8 after`() {
        val t = LudoGeometry.CROSS_TRACK
        assertEquals(52, t.size)
        assertEquals(52, t.toSet().size)
        assertEquals(6 to 1, t[0]); assertEquals(1 to 8, t[13]); assertEquals(8 to 13, t[26]); assertEquals(13 to 6, t[39])
        assertEquals(2 to 6, t[8]); assertEquals(6 to 12, t[21]); assertEquals(12 to 8, t[34]); assertEquals(8 to 2, t[47])
        // Every step is to a neighbouring square (the four inner corners are diagonal steps).
        for (i in 0 until 52) {
            val (r1, c1) = t[i]; val (r2, c2) = t[(i + 1) % 52]
            assertTrue("step $i", abs(r1 - r2) <= 1 && abs(c1 - c2) <= 1)
        }
        // No track square is a home-column square or in the centre.
        val homes = LudoGeometry.CROSS_HOME.flatten().toSet()
        assertTrue(t.none { it in homes })
    }

    @Test fun `each arm's last track square leads into its own home column`() {
        listOf(0, 1, 2, 3).forEach { arm ->
            val last = LudoGeometry.CROSS_TRACK[(arm * 13 + 50) % 52]
            val firstHome = LudoGeometry.CROSS_HOME[arm][0]
            assertTrue("arm $arm", abs(last.first - firstHome.first) + abs(last.second - firstHome.second) == 1)
        }
    }

    @Test fun `tokens are drawn inside the board in every state, on both boards`() {
        for (arms in listOf(4, 6)) {
            for (arm in 0 until arms) for (rel in listOf(-1, 0, 13, 50, 51, 55, 56, 76, 77, 81, 82)) for (t in 0 until 4) {
                if (arms == 4 && rel > 56) continue
                val p = LudoGeometry.tokenPoint(arms, arm, rel, t)
                assertTrue("arms $arms arm $arm rel $rel", p.x in 0f..LudoGeometry.SIZE && p.y in 0f..LudoGeometry.SIZE)
            }
        }
    }

    @Test fun `the board's movable tokens follow the server's rule`() {
        val b = LudoBoard(4, listOf(0, 2), listOf(listOf(-1, 10, 53, 56), listOf(-1, -1, -1, -1)), 0, 6, 3, 2, 4, emptyList(), listOf(0, 0), null)
        assertEquals(listOf(0, 1), b.movable(0, 6))          // out of the yard; 10 → 16; 53 + 6 overshoots; home is home
        assertEquals(listOf(1, 2), b.movable(0, 3))          // 53 + 3 = 56 exactly home
        assertEquals(26, b.absSquare(1, 0))
    }

    @Test fun `numbers are shown the Indian way`() {
        assertEquals("150", indianGroup(150))
        assertEquals("1,250", indianGroup(1250))
        assertEquals("1,00,000", indianGroup(100_000))
        assertEquals("◆ 12,34,567", diamondsText(1_234_567))
        assertEquals("×2.35", multText(2.35))
    }

    @Test fun `the Games tab exists only when games are switched on, between Live and Messages`() {
        assertEquals(listOf("tab_home", "tab_live", "tab_messages", "tab_me"), navItemsFor(false).map { it.route })
        assertEquals(listOf("tab_home", "tab_live", "tab_games", "tab_messages", "tab_me"), navItemsFor(true).map { it.route })
        val repo = src("data/repository/GameRepository.kt")
        assertTrue(repo.contains("snap?.getBoolean(\"enabled\") == true"))
    }

    @Test fun `no screen decides an outcome - no client randomness in the games package`() {
        val dir = File(main, "com/zipper/app/ui/screens/games")
        val text = dir.listFiles().orEmpty().filter { it.extension == "kt" }.joinToString("\n") { it.readText() }
        assertFalse(Regex("\\bRandom\\b|Math\\.random|nextInt\\(|SecureRandom").containsMatchIn(text))
        // Every paid action carries an idempotency key from GameFunctions.newKey().
        val vm = File(dir, "InstantGameViewModel.kt").readText() + File(dir, "GameLobbyScreen.kt").readText()
        assertTrue(vm.contains("fn.newKey()"))
    }
}

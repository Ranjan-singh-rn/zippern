package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * APK 20 / spec §11 — lucky gifts are sent as a combo the server configured,
 * and the client never rolls the result.
 */
class LuckyCombosTest {

    @Test fun `defaults match the server's LUCKY_DEFAULTS`() {
        assertEquals(listOf(10, 17, 25, 77), LuckyCombos.DEFAULT)
        assertEquals(10, LuckyCombos.COMBO_MIN)
        assertEquals(5, LuckyCombos.MULTIPLIER_MIN)
        assertEquals(100, LuckyCombos.MULTIPLIER_MAX)
    }

    @Test fun `parse keeps whole numbers at or above ten, sorted and de-duplicated`() {
        assertEquals(listOf(10, 25, 77), LuckyCombos.parse(listOf(77L, 25, 10, 25)))
        // Doubles from a JSON writer, strings from a hand-edited document.
        assertEquals(listOf(17, 25), LuckyCombos.parse(listOf(17.0, "25")))
        // Fractions, zero, negatives, below the minimum and over the cap are dropped.
        assertEquals(listOf(12), LuckyCombos.parse(listOf(12, 9, 0, -5, 2.5, 10_000)))
    }

    @Test fun `parse falls back to the defaults when nothing usable survives`() {
        assertEquals(LuckyCombos.DEFAULT, LuckyCombos.parse(null))
        assertEquals(LuckyCombos.DEFAULT, LuckyCombos.parse("10,17"))
        assertEquals(LuckyCombos.DEFAULT, LuckyCombos.parse(emptyList<Int>()))
        assertEquals(LuckyCombos.DEFAULT, LuckyCombos.parse(listOf(1, 2, 3)))
    }

    @Test fun `only a configured combo is valid`() {
        assertTrue(LuckyCombos.isValid(17))
        assertFalse(LuckyCombos.isValid(18))
        assertFalse(LuckyCombos.isValid(1))
        assertTrue(LuckyCombos.isValid(12, listOf(12, 40)))
        assertFalse(LuckyCombos.isValid(17, listOf(12, 40)))
    }

    @Test fun `the default choice is the smallest combo`() {
        assertEquals(10, LuckyCombos.defaultChoice())
        assertEquals(12, LuckyCombos.defaultChoice(listOf(40, 12)))
        assertEquals(10, LuckyCombos.defaultChoice(emptyList()))
    }

    @Test fun `the sender pays unit times combo and the reward band is five to a hundred units`() {
        assertEquals(1_700L, LuckyCombos.charge(100, 17))
        assertEquals(0L, LuckyCombos.charge(-100, 17))
        assertEquals(500L..10_000L, LuckyCombos.rewardRange(100))
    }

    @Test fun `a lucky gift sends combo and no quantity, a normal gift the reverse`() {
        assertEquals(LuckyCombos.SendShape(quantity = null, combo = 17), LuckyCombos.sendShape(isLucky = true, picked = 17))
        assertEquals(LuckyCombos.SendShape(quantity = 17, combo = null), LuckyCombos.sendShape(isLucky = false, picked = 17))
        assertEquals(LuckyCombos.SendShape(quantity = 1, combo = null), LuckyCombos.sendShape(isLucky = false, picked = 0))
    }

    @Test fun `a lucky send without a configured combo is refused before the network`() {
        assertNull(LuckyCombos.sendError(isLucky = false, combo = null, combos = LuckyCombos.DEFAULT))
        assertNull(LuckyCombos.sendError(isLucky = true, combo = 25, combos = LuckyCombos.DEFAULT))
        assertEquals("Choose a combo for this lucky gift.", LuckyCombos.sendError(true, null, LuckyCombos.DEFAULT))
        assertEquals(
            "Lucky gifts are sent as a combo of 10, 17, 25, 77.",
            LuckyCombos.sendError(true, 1, LuckyCombos.DEFAULT),
        )
    }

    @Test fun `the explainer states the charge, the band and the receiver's beans`() {
        val text = LuckyCombos.explainer(unitDiamonds = 100, combo = 17, receiverPct = 5)
        assertTrue(text.contains("You pay 1700"))
        assertTrue(text.contains("between 500 and 10000"))
        assertTrue(text.contains("receiver gets 85 beans"))
    }

    @Test fun `no client-side lucky roll survives anywhere in the app`() {
        val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
        val economy = File(main, "com/zipper/app/util/EconomyEngine.kt").readText()
        assertFalse("EconomyEngine must not roll lucky gifts", economy.contains("fun luckyGiftOutcome"))
        assertFalse(economy.contains("COMBO_WEIGHTS"))
        assertFalse(economy.contains("import kotlin.random.Random"))
        assertFalse(economy.contains("GAMING_BET_DENOMINATIONS"))
        // The only random numbers in the gift path are the server's.
        val giftRepo = File(main, "com/zipper/app/data/repository/GiftRepository.kt").readText()
        assertFalse(giftRepo.contains("Random"))
        assertTrue("a lucky gift travels as `combo`", giftRepo.contains("combo = shape.combo"))
        val money = File(main, "com/zipper/app/data/repository/MoneyFunctions.kt").readText()
        assertTrue(money.contains("if (combo != null) put(\"combo\", combo) else put(\"quantity\", quantity)"))
        assertTrue("the server's roll is read, never computed", money.contains("m[\"lucky\"]"))
    }

    @Test fun `the gift sheet offers the combo picker for a lucky gift`() {
        val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
        val drawer = File(main, "com/zipper/app/ui/components/GiftDrawer.kt").readText()
        assertTrue(drawer.contains("(if (luckySelected) combos else QUANTITIES).forEach"))
        assertTrue(drawer.contains("fun LuckyWinBanner("))
        assertTrue(drawer.contains("LuckyGiftConfigViewModel"))
    }
}

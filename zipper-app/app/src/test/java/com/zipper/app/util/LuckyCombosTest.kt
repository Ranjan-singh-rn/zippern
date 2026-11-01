package com.zipper.app.util

import com.zipper.app.data.repository.GiftRepository
import com.zipper.app.data.repository.GiftResult
import com.zipper.app.data.repository.MoneyFunctions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * APK 20 / spec §11 — lucky gifts are sent as a combo the server configured,
 * and the client never rolls the result. And they are OFF until the Owner
 * turns them on (`appConfig/luckyGifts.enabled`, after legal clearance): the
 * sheet shows them as unavailable, and the server's LUCKY_GIFTS_DISABLED
 * refusal reads "Lucky gifts are not available right now."
 */
class LuckyCombosTest {

    private val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
    private fun src(rel: String) = File(main, "com/zipper/app/$rel").readText()

    @Test fun `the Owner's switch is on only for a real true, and off by default`() {
        assertTrue(LuckyCombos.parseEnabled(true))
        assertFalse(LuckyCombos.parseEnabled(null))
        assertFalse(LuckyCombos.parseEnabled(false))
        assertFalse(LuckyCombos.parseEnabled("true"))
        assertFalse(LuckyCombos.parseEnabled(1L))
        // Read beside the combos; an absent or unreadable document is off.
        val repo = src("data/repository/LuckyGiftConfigRepository.kt")
        assertTrue(repo.contains("enabled = LuckyCombos.parseEnabled(snap.get(\"enabled\"))"))
        assertTrue("the default Config is OFF", repo.contains("val enabled: Boolean = false"))
        assertTrue("an absent document is the default Config", repo.contains("if (!snap.exists()) Config()"))
    }

    @Test fun `while the switch is off a lucky gift cannot be sent and a normal gift still can`() {
        assertFalse(LuckyCombos.sendable(isLucky = true, enabled = false))
        assertTrue(LuckyCombos.sendable(isLucky = true, enabled = true))
        assertTrue(LuckyCombos.sendable(isLucky = false, enabled = false))
        assertTrue(LuckyCombos.sendable(isLucky = false, enabled = true))
    }

    @Test fun `the server's LUCKY_GIFTS_DISABLED refusal reads as lucky gifts not available`() {
        assertEquals("LUCKY_GIFTS_DISABLED", LuckyCombos.DISABLED_CODE)
        assertEquals("Lucky gifts are not available right now.", LuckyCombos.UNAVAILABLE_MESSAGE)
        assertEquals(LuckyCombos.UNAVAILABLE_MESSAGE, LuckyCombos.refusalMessage("LUCKY_GIFTS_DISABLED"))
        assertEquals(LuckyCombos.UNAVAILABLE_MESSAGE, LuckyCombos.refusalMessage(" LUCKY_GIFTS_DISABLED "))
        for (other in listOf(null, "", "LUCKY_PAYOUT_GUARD", "SESSION_DISPLACED", "lucky_gifts_disabled")) {
            assertNull("'$other' is not the switch", LuckyCombos.refusalMessage(other))
        }
    }

    @Test fun `every send path maps the switch refusal by its code, never into the diamond branch`() {
        val off = { message: String -> MoneyFunctions.Result.Failed("FAILED_PRECONDITION", message, "LUCKY_GIFTS_DISABLED") }
        assertEquals(GiftResult.Error("Lucky gifts are not available right now."),
            GiftRepository.failureOf(off("Lucky gifts are not available right now.")))
        // A reworded server sentence that mentions diamonds still reads as the switch, not as a short balance.
        assertEquals(GiftResult.Error("Lucky gifts are not available right now."),
            GiftRepository.failureOf(off("Lucky gifts cannot take your diamonds right now.")))
        // Everything else is unchanged.
        assertEquals(GiftResult.InsufficientDiamonds, GiftRepository.failureOf(
            MoneyFunctions.Result.Failed("FAILED_PRECONDITION", "Not enough diamonds. This costs 1700, you have 1699.")))
        assertEquals(GiftResult.Error("Lucky gifts are unavailable right now."), GiftRepository.failureOf(
            MoneyFunctions.Result.Failed("FAILED_PRECONDITION", "Lucky gifts are unavailable right now.", "LUCKY_PAYOUT_GUARD")))
        // The live and party paths use the same mapping.
        assertTrue(src("data/repository/LiveRepository.kt").contains("GiftRepository.failureOf(res)"))
        assertTrue(src("data/repository/PartyRepository.kt").contains("GiftRepository.failureOf(res)"))
    }

    @Test fun `the gift sheet shows a lucky gift as unavailable while the switch is off`() {
        val drawer = src("ui/components/GiftDrawer.kt")
        assertTrue(drawer.contains("val luckyEnabled = luckyConfig.enabled"))
        assertTrue(drawer.contains("unavailable = !com.zipper.app.util.LuckyCombos.sendable(gift.isLucky, luckyEnabled)"))
        assertTrue("the sheet says why", drawer.contains("com.zipper.app.util.LuckyCombos.UNAVAILABLE_MESSAGE"))
        assertTrue("Send is disabled", drawer.contains("enabled = selected != null && !nothingPicked && !luckyUnavailable"))
        assertTrue("and refuses anyway", drawer.contains("if (!com.zipper.app.util.LuckyCombos.sendable(g.isLucky, luckyEnabled)) return@ZipperButton"))
        assertTrue("the switch is re-read when the sheet opens", drawer.contains("LaunchedEffect(luckyConfigVm) { luckyConfigVm.refresh() }"))
        // Normal gifts keep their quantity chips and Send.
        assertTrue(drawer.contains("(if (luckySelected) combos else QUANTITIES).forEach"))
    }

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

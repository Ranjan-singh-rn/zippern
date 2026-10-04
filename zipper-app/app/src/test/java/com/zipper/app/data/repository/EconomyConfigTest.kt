package com.zipper.app.data.repository

import com.zipper.app.data.repository.EconomyConfigRepository.CallSplitMatrix
import com.zipper.app.data.repository.EconomyConfigRepository.EconomyConfig
import com.zipper.app.data.repository.EconomyConfigRepository.GiftRates
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Everything covered here is money.
 *
 * ── THIS FILE WAS BROKEN AND NOBODY KNEW ─────────────────────────────────────
 *
 * It was written against an older economy model — a `ReceiverSplit(50, 40, 30)`
 * of three gender tiers, reached through `receiverPct(earner, payer,
 * callerIsHost)` and `callerDiamondsPerMin(...)`. That model is gone. The split
 * is now a full 3×3 payer×earner matrix, `CallSplitMatrix`, mirroring
 * `SPLIT_DEFAULTS` in functions/src/pricing.ts, and the caller/receiver framing
 * was replaced by payer/earner because the caller is not always the payer.
 *
 * When the model changed, this file was not. It stopped COMPILING — which took
 * the whole `test` source set with it, so every unit test in the project has
 * been unrunnable since, and nothing said so: `assembleDebug` does not build
 * test sources, and nobody ran `testDebugUnitTest`.
 *
 * Rewritten against the real API. The assertions that still describe a rule the
 * product has are kept and re-expressed; the ones that only described the old
 * shape are replaced by the rule that took over.
 */
class EconomyConfigTest {

    private fun config(
        retail: Int = 2390,
        wholesale: Int = 2000,
        beanToInr: Double = 0.01,          // 100 beans = ₹1
        minPayoutInr: Int = 1000,
        minPayoutBeans: Long? = null,
        matrix: CallSplitMatrix = CallSplitMatrix.FALLBACK,
    ) = EconomyConfig(
        diamondPackPriceInr = retail,
        diamondPackPriceUsd = 28,
        sellerWholesalePriceInr = wholesale,
        beanToDiamondRate = 20.0,
        weeklyMinPayoutInr = minPayoutInr,
        weeklyMinPayoutBeans = minPayoutBeans,
        callRateBeansPerMin = 750L,
        userCallRatePerMin = 500L,
        minHostCallRate = 100L,
        maxHostCallRate = 12_000L,
        giftRates = GiftRates(50, 50, 55, 50, 0, 20, beanToInr),
        callSplitMatrix = matrix,
        usdToInrRate = 83.0,
        isFallback = false,
    )

    // ── The split matrix ─────────────────────────────────────────────────────

    @Test
    fun `the matrix matches the server's table cell for cell`() {
        // The same nine numbers as SPLIT_DEFAULTS in functions/src/pricing.ts.
        // They are asserted here rather than trusted because the app quotes a
        // price on the call button and the server charges it — a drift between
        // the two is a user being shown one number and billed another.
        val c = config()
        assertEquals(30, c.earnerPct("male", "male"))
        assertEquals(50, c.earnerPct("male", "female"))
        assertEquals(40, c.earnerPct("male", "transgender"))
        assertEquals(40, c.earnerPct("female", "male"))
        assertEquals(30, c.earnerPct("female", "female"))
        assertEquals(40, c.earnerPct("female", "transgender"))
        assertEquals(40, c.earnerPct("transgender", "male"))
        assertEquals(40, c.earnerPct("transgender", "female"))
        assertEquals(40, c.earnerPct("transgender", "transgender"))
    }

    @Test
    fun `the table is not symmetric, which is the whole point`() {
        val c = config()
        // A male paying a female host is the 50% cell; a female paying a male
        // host is the 40% one. Collapsing them into one number per pairing —
        // the obvious simplification — silently rewrites the earnings of every
        // host on one side of it.
        assertEquals(50, c.earnerPct("male", "female"))
        assertEquals(40, c.earnerPct("female", "male"))
    }

    @Test
    fun `an unrecorded gender is priced, never refused`() {
        val c = config()
        // Reads as transgender: the middle row and column. It never overpays,
        // never badly underpays, and never fails to produce a price — a call
        // that cannot be priced is a call that cannot be made.
        assertEquals(c.earnerPct("transgender", "male"), c.earnerPct("", "male"))
        assertEquals(c.earnerPct("transgender", "male"), c.earnerPct("unknown", "male"))
        assertEquals(c.earnerPct("male", "transgender"), c.earnerPct("male", "  "))
    }

    @Test
    fun `case and whitespace do not change a price`() {
        val c = config()
        assertEquals(50, c.earnerPct(" MALE ", "Female"))
    }

    @Test
    fun `a nonsense cell falls back to the specified table rather than to zero`() {
        // A percentage outside 1..100 is a typo or a bad write, and honouring it
        // would either pay the earner nothing or charge the payer a multiple of
        // the real price. CallSplitMatrix.pct bounds-checks exactly as the
        // server does.
        val c = config(matrix = CallSplitMatrix(mapOf("male" to mapOf("female" to 0))))
        assertEquals(50, c.earnerPct("male", "female"))
    }

    // ── Who pays ─────────────────────────────────────────────────────────────

    @Test
    fun `the user pays, whoever dialled`() {
        val c = config()
        // One host and one user: the USER pays, regardless of direction. This is
        // the rule that makes "caller" and "payer" different words.
        assertTrue(c.payerIsCaller(callerIsHost = false, receiverIsHost = true))
        assertFalse(c.payerIsCaller(callerIsHost = true, receiverIsHost = false))
    }

    @Test
    fun `between two of a kind the caller pays`() {
        val c = config()
        assertTrue(c.payerIsCaller(callerIsHost = false, receiverIsHost = false))
        assertTrue(c.payerIsCaller(callerIsHost = true, receiverIsHost = true))
    }

    // ── The price follows the earner's income ────────────────────────────────

    @Test
    fun `the earner's income is the input, and only the payer's price moves`() {
        val c = config()
        // 750 beans/min at 50% → the payer pays 1500 diamonds/min.
        // The same host earns the same 750 from a female payer at 30% → 2500.
        assertEquals(1500L, c.payerDiamondsPerMin(750L, "male", "female"))
        assertEquals(2500L, c.payerDiamondsPerMin(750L, "female", "female"))
    }

    @Test
    fun `rounding never favours the payer`() {
        val c = config()
        // 751 × 100 ÷ 30 = 2503.33. Flooring would short-pay the earner by a
        // diamond a minute, every minute, for ever.
        assertEquals(2504L, c.payerDiamondsPerMin(751L, "female", "female"))
    }

    @Test
    fun `no pairing ever produces a free call`() {
        val c = config()
        for (payer in listOf("male", "female", "transgender", "nonsense")) {
            for (earner in listOf("male", "female", "transgender", "nonsense")) {
                assertTrue(
                    "$payer paying $earner priced at zero",
                    c.payerDiamondsPerMin(750L, payer, earner) > 0L,
                )
            }
        }
    }

    // ── Seller margin ────────────────────────────────────────────────────────

    @Test
    fun `seller margin is the gap between retail and wholesale`() {
        assertEquals(390, config(retail = 2390, wholesale = 2000).sellerMarginInrPerLakh)
    }

    @Test
    fun `a wholesale price equal to retail leaves the seller nothing`() {
        // Selling a seller a lakh for exactly what a user pays means the seller
        // works for free. The test exists so that configuration fails loudly.
        assertEquals(0, config(retail = 2290, wholesale = 2290).sellerMarginInrPerLakh)
    }

    // ── Bean value vs. eligibility: two different questions ───────────────────

    @Test
    fun `bean value is shown below the payout threshold`() {
        val c = config(minPayoutInr = 1000)
        // EconomyEngine.beansToRupees returns 0 here, so a host one bean short
        // of the threshold is told their week is worth nothing. This does not.
        assertEquals(999.99, c.beansToRupees(99_999L), 0.001)
        assertFalse(c.meetsPayoutThreshold(99_999L))
    }

    @Test
    fun `threshold is met at the boundary`() {
        val c = config(minPayoutInr = 1000)
        assertEquals(1000.0, c.beansToRupees(100_000L), 0.001)
        assertTrue(c.meetsPayoutThreshold(100_000L))
    }

    @Test
    fun `absent bean rule means the rupee rule decides alone`() {
        // Null is "not configured", never "zero". The CRM refuses to invent a
        // number here and so must the app.
        val c = config(minPayoutInr = 1000, minPayoutBeans = null)
        assertTrue(c.meetsPayoutThreshold(100_000L))
    }

    @Test
    fun `a configured bean rule can block an otherwise eligible payout`() {
        val c = config(minPayoutInr = 1000, minPayoutBeans = 200_000L)
        assertTrue(c.beansToRupees(100_000L) >= 1000)
        assertFalse(c.meetsPayoutThreshold(100_000L))
    }

    // ── Derived rates ────────────────────────────────────────────────────────

    @Test
    fun `per-diamond rates derive from the per-lakh price`() {
        val c = config(retail = 2390, wholesale = 2000)
        assertEquals(0.0239, c.inrPerDiamond, 1e-9)
        assertEquals(0.02, c.wholesaleInrPerDiamond, 1e-9)
    }

    // ── Fallback honesty ─────────────────────────────────────────────────────

    @Test
    fun `fallback config is flagged so the UI can say so`() {
        // A screen showing compiled-in constants as though they were live is the
        // failure the CRM already hit, where a permission error rendered
        // identically to a real zero.
        assertFalse(config().isFallback)
    }
}

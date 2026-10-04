package com.zipper.app.util

import kotlin.random.Random

/**
 * Single source of truth for all Zipper economic calculations.
 *
 * Currency: 1 Diamond == 1 Bean (1:1 parity)
 * - Diamonds : spent by users  (calls, gifts, topped up offline via coin sellers)
 * - Beans    : earned by hosts/users (withdrawable)
 *
 * ── Gift reward rules ────────────────────────────────────────────────────────
 *
 * NORMAL gift  → receiver always gets exactly 50% of total diamond cost as beans
 * SPECIAL gift → receiver gets 50–55% (luck roll per transaction)
 * LUCKY gift   → receiver always gets 5% as beans; sender additionally rolls:
 *
 *   Single (qty = 1):
 *     0× no return   65%
 *     1× cost back   20%
 *     2× cost × 2     9%
 *     3× cost × 3     4%
 *     4× cost × 4     2%
 *   Expected sender return = 0.58× spend → platform nets ~37% after receiver cut.
 *
 *   Combo (qty = 17 / 37 / 77):
 *     Multiplier is applied to per-gift cost (NOT total combo spend).
 *     5×   80%
 *     10×  10%
 *     20×   5%
 *     50×   3%
 *     100×  1.5%
 *     200×  0.5%
 *   Expected sender return = 10× per-gift-cost → platform nets 36–82% depending on combo size.
 *   Larger combo = worse deal for sender, much better for platform.
 *
 *   ⚠️  Individual 200× wins cause a per-transaction platform loss. This is intentional —
 *       profit comes from statistical aggregate across all lucky gift sends.
 *       Diamond returns to sender are synthetic (credited from platform's cut); no pool needed
 *       since real money was already collected offline by coin sellers.
 *
 * ── Call cost rules ──────────────────────────────────────────────────────────
 *
 * USER ↔ USER  (neither is host)
 *   Fixed 1600 diamonds/min. Receiver always earns.
 *   • Male   caller → Female receiver : female earns 50% → 800 beans
 *   • Female caller → Male   receiver : male   earns 40% → 640 beans
 *   • Same gender (both genders needed to detect)  : receiver earns 30% → 480 beans
 *
 * HOST involved (one or both are hosts)
 *   HOST always earns. If both hosts → receiver host earns, their callRateBeans drives cost.
 *   Diamond cost to caller = hostBeanRate ÷ rewardPercent (ceiling).
 *   rewardPercent:
 *     • Female host + non-same-gender-host caller → 50%
 *     • Male   host + non-same-gender-host caller → 40%
 *     • Same-gender HOST ↔ HOST                   → 30%
 */
object EconomyEngine {

    /** Fixed per-minute diamond cost for user-to-user calls */
    const val USER_CALL_RATE_PER_MIN = 1600L

    /**
     * Fallback host income in beans/min when a user doc has no callRateBeans.
     *
     * Mirrors User.callRateBeans and the CRM's callRateBeansPerMin.
     *
     * This exists because four places in CallEconomyRepository were using
     * USER_CALL_RATE_PER_MIN for this — a DIAMOND PRICE standing in for a BEAN
     * RATE. A host missing the field was treated as earning 1600 beans/min, so
     * their callers were quoted roughly 4.3x the correct price and the
     * affordability check then blocked the call entirely.
     */
    const val DEFAULT_HOST_BEAN_RATE = 375L

    // ── Diamond / Bean exchange rates ─────────────────────────────────────────

    /** Beans per Indian Rupee for withdrawal purposes (1 lakh beans = ₹1,000) */
    const val BEANS_PER_RUPEE = 100L

    /** Minimum beans required before a host can request withdrawal */
    const val MIN_WITHDRAWAL_BEANS = 100_000L   // 1 lakh beans = ₹1,000

    /** Wholesale price Zipper charges coin sellers per lakh diamonds (INR) */
    const val WHOLESALE_PRICE_PER_LAKH_INR = 2_290

    // ── Gaming bet denominations ───────────────────────────────────────────────

    /** Valid bet amounts in diamonds for all casino / lucky games */
    val GAMING_BET_DENOMINATIONS = longArrayOf(10L, 100L, 500L, 1_000L, 5_000L, 10_000L)

    /**
     * Platform house edge on gaming bets (5%).
     * The actual odds/payouts are handled by the WebView game engine.
     * The Android app deducts bets and credits winnings; the 5% edge is
     * embedded in the game's payout math on the server/WebView side.
     */
    const val GAMING_HOUSE_EDGE_PCT = 5

    // ── Withdrawal helpers ────────────────────────────────────────────────────

    /**
     * Converts [beans] to the equivalent INR payout.
     * Returns 0 if [beans] is below [MIN_WITHDRAWAL_BEANS].
     */
    fun beansToRupees(beans: Long): Long {
        if (beans < MIN_WITHDRAWAL_BEANS) return 0L
        return beans / BEANS_PER_RUPEE
    }

    /**
     * Checks whether a host has enough beans to withdraw.
     */
    fun canWithdraw(beans: Long): Boolean = beans >= MIN_WITHDRAWAL_BEANS

    // ─────────────────────────────────────────────────────────────────────────
    // Gift types
    // ─────────────────────────────────────────────────────────────────────────

    enum class GiftType { NORMAL, LUCKY, SPECIAL }

    // ─────────────────────────────────────────────────────────────────────────
    // Gift bean rewards
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Beans earned by the gift receiver for [totalCostDiamonds] worth of gifts.
     *
     * NORMAL  → 50% exactly
     * SPECIAL → random 50–55% (rolled here, same value written to Firestore)
     * LUCKY   → 5% exactly (sender return handled separately via [luckyGiftOutcome])
     */
    fun giftBeanReward(totalCostDiamonds: Long, type: GiftType): Long {
        val pct = when (type) {
            GiftType.NORMAL  -> 50L
            GiftType.LUCKY   -> 5L
            GiftType.SPECIAL -> 50L + Random.nextLong(6L)   // 50, 51, 52, 53, 54, or 55
        }
        return (totalCostDiamonds * pct) / 100L
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Lucky gift outcome
    // ─────────────────────────────────────────────────────────────────────────

    data class LuckyGiftResult(
        /** Multiplier applied to per-gift cost (0/1/2/3/4 for single; 5–200 for combo) */
        val multiplier: Int,
        /** Diamonds credited back to sender = multiplier × perGiftCostDiamonds */
        val diamondsBack: Long,
        /** Whether the sender actually wins anything */
        val isWin: Boolean,
    )

    /**
     * Determines the lucky gift outcome for the sender.
     *
     * @param perGiftCostDiamonds  Cost of ONE gift (not total combo cost)
     * @param isCombo              true if quantity > 1 (17 / 37 / 77)
     *
     * ⚠️  Currently client-side. MUST migrate to Cloud Functions before production
     *     to prevent APK tampering for guaranteed 4× / 200× outcomes.
     */
    fun luckyGiftOutcome(perGiftCostDiamonds: Long, isCombo: Boolean): LuckyGiftResult {
        val multiplier = if (isCombo) rollCombo() else rollSingle()
        val diamondsBack = perGiftCostDiamonds * multiplier
        return LuckyGiftResult(
            multiplier   = multiplier,
            diamondsBack = diamondsBack,
            isWin        = multiplier > 0,
        )
    }

    // Single: weights out of 10 000
    // 0× = 65%, 1× = 20%, 2× = 9%, 3× = 4%, 4× = 2%
    private val SINGLE_MULTIPLIERS = intArrayOf(0, 1, 2, 3, 4)
    private val SINGLE_WEIGHTS     = intArrayOf(6500, 2000, 900, 400, 200)

    // Combo: weights out of 10 000
    // 5× = 80%, 10× = 10%, 20× = 5%, 50× = 3%, 100× = 1.5%, 200× = 0.5%
    private val COMBO_MULTIPLIERS = intArrayOf(5, 10, 20, 50, 100, 200)
    private val COMBO_WEIGHTS     = intArrayOf(8000, 1000, 500, 300, 150, 50)

    private fun rollSingle(): Int = weightedRandom(SINGLE_WEIGHTS, SINGLE_MULTIPLIERS)
    private fun rollCombo(): Int  = weightedRandom(COMBO_WEIGHTS,  COMBO_MULTIPLIERS)

    private fun weightedRandom(weights: IntArray, values: IntArray): Int {
        var roll = Random.nextInt(weights.sum())
        for (i in weights.indices) {
            roll -= weights[i]
            if (roll < 0) return values[i]
        }
        return values.last()
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Call rewards
    // ─────────────────────────────────────────────────────────────────────────

    data class CallReward(
        /** UID of the person who earns beans */
        val beneficiaryUid: String,
        /** Beans earned this call */
        val beansEarned: Long,
        /** Reward percentage applied (for logging / Firestore records) */
        val rewardPercent: Int,
    )

    /**
     * Calculates beneficiary and beans earned at the end of a paid call.
     */
    fun callReward(
        callerUid: String,
        callerGender: String,
        callerIsHost: Boolean,
        receiverUid: String,
        receiverGender: String,
        receiverIsHost: Boolean,
        callCostDiamonds: Long,
    ): CallReward? {
        if (callCostDiamonds <= 0L) return null

        return when {
            callerIsHost && receiverIsHost -> {
                val pct = hostRewardPercent(receiverGender, callerGender, callerIsHost = true)
                CallReward(receiverUid, beansFromCost(callCostDiamonds, pct), pct)
            }
            receiverIsHost -> {
                val pct = hostRewardPercent(receiverGender, callerGender, callerIsHost = false)
                CallReward(receiverUid, beansFromCost(callCostDiamonds, pct), pct)
            }
            callerIsHost -> {
                val pct = hostRewardPercent(callerGender, receiverGender, callerIsHost = false)
                CallReward(callerUid, beansFromCost(callCostDiamonds, pct), pct)
            }
            else -> {
                val pct = userRewardPercent(callerGender, receiverGender)
                CallReward(receiverUid, beansFromCost(callCostDiamonds, pct), pct)
            }
        }
    }

    /**
     * Diamond cost per minute to the caller, derived from a host's desired bean rate.
     */
    fun callCostFromHostBeanRate(
        hostBeanRate: Long,
        hostGender: String,
        callerGender: String,
        callerIsHost: Boolean,
    ): Long {
        val pct = hostRewardPercent(hostGender, callerGender, callerIsHost)
        return (hostBeanRate * 100L + pct - 1L) / pct
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────

    private fun hostRewardPercent(hostGender: String, callerGender: String, callerIsHost: Boolean): Int {
        val hg = hostGender.lowercase()
        val cg = callerGender.lowercase()
        if (callerIsHost && hg == cg) return 30
        return when (hg) {
            "female" -> 50
            "male"   -> 40
            else     -> 30
        }
    }

    private fun userRewardPercent(callerGender: String, receiverGender: String): Int {
        val cg = callerGender.lowercase()
        val rg = receiverGender.lowercase()
        return when {
            cg == rg                         -> 30
            cg == "male"  && rg == "female"  -> 50
            cg == "female" && rg == "male"   -> 40
            else                             -> 30
        }
    }

    private fun beansFromCost(costDiamonds: Long, pct: Int): Long =
        (costDiamonds * pct) / 100L
}

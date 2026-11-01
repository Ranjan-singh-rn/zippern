package com.zipper.app.util

/**
 * Zipper economic constants that the CLIENT still needs — and nothing that
 * moves money.
 *
 * Currency: 1 Diamond == 1 Bean (1:1 parity)
 * - Diamonds : spent by users  (calls, gifts, topped up offline via coin sellers)
 * - Beans    : earned by hosts/users (withdrawable)
 *
 * ── What is deliberately NOT here any more (APK 20, spec §11) ────────────────
 *
 * The lucky-gift odds tables and the client-side roll (`luckyGiftOutcome`,
 * `rollSingle`, `rollCombo`, `weightedRandom`), the per-category bean reward
 * (`giftBeanReward`) and the casino bet denominations are gone. Every one of
 * them was a number the server now decides: `settleGift` prices the gift from
 * the catalogue, takes the receiver's share from the CRM, and for a lucky
 * gift draws the multiplier from `appConfig/luckyGifts` inside the same
 * transaction as the charge. A client that keeps a copy of the odds is a
 * client that can be edited to show — or to expect — a different result than
 * the one it is charged for, and nothing on this side should be able to
 * disagree with the ledger.
 *
 * ── Call cost rules (reference; the server's `rateFor` in pricing.ts decides) ─
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

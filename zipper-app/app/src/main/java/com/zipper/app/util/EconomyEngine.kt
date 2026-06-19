package com.zipper.app.util

/**
 * Single source of truth for all Zipper economic calculations.
 *
 * Currency: 1 Diamond == 1 Bean (1:1)
 * - Diamonds: spent by users (calls, gifts, in-app purchases)
 * - Beans: earned by hosts/users (withdrawable)
 */
object EconomyEngine {

    // ── Gift rewards ─────────────────────────────────────────────────────────

    /**
     * Returns how many beans the gift receiver earns.
     * Regular gift → 50% of diamond cost
     * Lucky gift   → 5% of diamond cost
     */
    fun giftBeanReward(giftCostDiamonds: Long, isLuckyGift: Boolean): Long {
        val pct = if (isLuckyGift) 5L else 50L
        return (giftCostDiamonds * pct) / 100L
    }

    // ── Call rewards ─────────────────────────────────────────────────────────

    data class CallReward(
        /** UID of the person who earns beans */
        val beneficiaryUid: String,
        /** Beans earned */
        val beansEarned: Long,
        /** Percentage applied (for logging/debug) */
        val rewardPercent: Int,
    )

    /**
     * Calculates who earns beans and how many after a paid video/audio call.
     *
     * @param callerUid      Firebase UID of the person who initiated the call
     * @param callerGender   "male" | "female" | "transgender" (transgender treated as neutral = same-gender rules)
     * @param callerIsHost   Whether the caller is a verified host
     * @param receiverUid    Firebase UID of the person who received the call
     * @param receiverGender "male" | "female" | "transgender"
     * @param receiverIsHost Whether the receiver is a verified host
     * @param callCostDiamonds Total diamonds deducted from caller for the call
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

        // Step 1: determine who benefits
        val beneficiaryIsCaller = callerIsHost && !receiverIsHost
        // (host calling user → caller=host earns; all other combos → receiver earns)

        val beneficiaryUid    = if (beneficiaryIsCaller) callerUid    else receiverUid
        val beneficiaryGender = if (beneficiaryIsCaller) callerGender else receiverGender
        val counterGender     = if (beneficiaryIsCaller) receiverGender else callerGender

        // Step 2: determine reward %
        val pct = rewardPercent(beneficiaryGender, counterGender)
        val beans = (callCostDiamonds * pct) / 100L

        return CallReward(
            beneficiaryUid  = beneficiaryUid,
            beansEarned     = beans,
            rewardPercent   = pct,
        )
    }

    /**
     * Reward percentage based on beneficiary gender vs counterparty gender.
     * - Female earns from male → 50%
     * - Male earns from female → 40%
     * - Same gender (or transgender) → 30%
     */
    private fun rewardPercent(beneficiaryGender: String, counterGender: String): Int {
        val bg = beneficiaryGender.lowercase()
        val cg = counterGender.lowercase()
        return when {
            bg == "female" && cg == "male"   -> 50
            bg == "male"   && cg == "female" -> 40
            else                             -> 30   // same gender or transgender
        }
    }
}

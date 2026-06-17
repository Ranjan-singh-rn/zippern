package com.zipper.datingapp.economy

import com.zipper.datingapp.data.DiamondPackage
import com.zipper.datingapp.data.Gift
import com.zipper.datingapp.data.GiftType
import com.zipper.datingapp.data.HostLevelConfig
import com.zipper.datingapp.data.UserLevelConfig

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ZIPPER VIRTUAL ECONOMY ENGINE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Fixed platform rates (PUBLIC — shown to users and hosts):
 *   1,00,000 diamonds  →  ₹2,290  (platform sells to coin seller)
 *   1,00,000 beans     →  ₹1,000  (platform pays to host)
 *   Coin seller margin: ₹290 per 1L diamonds
 *   Agency cut:         ₹25 per 1L beans earned by their hosts
 *
 * INTERNAL MULTIPLIER IS CONFIDENTIAL. Do not log or expose to users.
 * The ratio makes gift splits appear as percentage of "total value" to hosts,
 * while the actual Rs value is INTERNAL_DIAMOND_TO_GROSS_BEAN_MULTIPLIER × less
 * per bean vs diamond. This is the company's profit lever — NOT exposed to
 * users or hosts. Server-side only.
 *
 * Gift splits:
 *   REGULAR gift → 50% to recipient (beans), 50% to company
 *   LUCKY gift   → 5%  to recipient (beans), 95% to company
 *
 * Call splits (gender-based):
 *   Male caller   → Female callee  →  50% of diamonds charged as beans to callee
 *   Same gender   → Same gender    →  40% of diamonds charged as beans to callee
 *   Female caller → Male callee    →  30% of diamonds charged as beans to callee
 *
 * Call pricing formula:
 *   Diamond cost to caller = calleeBeansPerMin / genderRatio
 *   Example: female host sets 500 beans/min, male caller →
 *   cost = 500 / 0.50 = 1,000 diamonds/min shown to caller
 *
 * Host-involved calls: HOST always gets the beans.
 * User-to-user calls: Fixed platform rate, gender ratio applied.
 * ─────────────────────────────────────────────────────────────────────────────
 */
object VirtualEconomyMath {

    // ─────────────────────────────────────────────────────────────────────────
    // PLATFORM CONSTANTS
    // ─────────────────────────────────────────────────────────────────────────

    /** Price (₹) platform charges coin seller for 1 lakh diamonds. */
    const val PRICE_RS_PER_LAKH_DIAMONDS: Int = 2_290

    /** Platform payout (₹) per 1 lakh beans to host. */
    const val PRICE_RS_PER_LAKH_BEANS: Int = 1_000

    /** Commission (₹) kept by coin seller per 1 lakh diamonds sold. */
    const val COIN_SELLER_COMMISSION_RS_PER_LAKH: Int = 290

    /** Agency payout (₹) per 1 lakh beans earned by their hosts. */
    const val AGENCY_COMMISSION_RS_PER_LAKH_BEANS: Int = 25

    /**
     * CONFIDENTIAL — server-side only. Do not log or expose to users or hosts.
     *
     * Internal conversion: 1 diamond → this many "gross beans" before split.
     * This is the company's profit lever.
     *
     * Example (regular gift):
     *   User spends 1,000 diamonds → 2,500 gross beans generated internally.
     *   Host gets 50% of gross beans = 1,250 beans → worth ₹12.50.
     *   User paid: 1,000 diamonds = ₹22.90. Company profit: ₹22.90 - ₹12.50 = ₹10.40 (45.4% margin).
     *   Host sees "50% split" and considers it fair — internally diamonds ≠ beans in Rs value.
     */
    const val INTERNAL_DIAMOND_TO_GROSS_BEAN_MULTIPLIER: Double = 2.5

    /** True cost of 1 diamond in ₹ (= PRICE_RS_PER_LAKH_DIAMONDS / 1,00,000 = ₹0.02290). */
    const val RS_PER_DIAMOND: Double = PRICE_RS_PER_LAKH_DIAMONDS / 100_000.0

    /** True payout of 1 bean in ₹ (= PRICE_RS_PER_LAKH_BEANS / 1,00,000 = ₹0.01000). */
    const val RS_PER_BEAN: Double = PRICE_RS_PER_LAKH_BEANS / 100_000.0

    /**
     * Company profit margin per diamond spent (after host payout on regular gifts, before other costs).
     * = 1 - (RS_PER_BEAN * REGULAR_GIFT_RECIPIENT_PERCENT / 100) / RS_PER_DIAMOND
     * = 1 - (0.01 * 0.50) / 0.02290 ≈ 78.2% on regular gifts.
     * Actual margin varies by gift type and call gender ratio.
     */

    /** Fixed diamond rate for user-to-user calls (no host involved). */
    const val USER_TO_USER_CALL_DIAMONDS_PER_MIN: Int = 100

    /** Default audio call rate (beans/min) if host has not set a custom rate. */
    const val DEFAULT_AUDIO_BEANS_PER_MIN: Int = 200

    /** Default video call rate (beans/min) if host has not set a custom rate. */
    const val DEFAULT_VIDEO_BEANS_PER_MIN: Int = 500

    /**
     * Default diamonds per minute charged to the caller for a 1:1 video call when
     * the callee has not set a custom rate. Derived from [DEFAULT_VIDEO_BEANS_PER_MIN]
     * at the male-to-female gender ratio (most common pairing).
     */
    const val DEFAULT_CALL_VIDEO_DIAMONDS_PER_MIN: Int = 1_000  // 500 beans / 0.50 ratio

    /**
     * Default diamonds per minute charged to the caller for a 1:1 audio call when
     * the callee has not set a custom rate.
     */
    const val DEFAULT_CALL_AUDIO_DIAMONDS_PER_MIN: Int = 400    // 200 beans / 0.50 ratio

    // ─────────────────────────────────────────────────────────────────────────
    // GENDER RATIOS
    // ─────────────────────────────────────────────────────────────────────────

    /** Male caller → Female callee: callee earns 50% of diamonds spent (as beans). */
    const val RATIO_MALE_TO_FEMALE = 0.50

    /** Same gender call: callee earns 40% of diamonds spent (as beans). */
    const val RATIO_SAME_GENDER = 0.40

    /** Female caller → Male callee: callee earns 30% of diamonds spent (as beans). */
    const val RATIO_FEMALE_TO_MALE = 0.30

    // ─────────────────────────────────────────────────────────────────────────
    // GIFT SPLITS
    // ─────────────────────────────────────────────────────────────────────────

    /** Regular gift: 50% of diamond value goes to recipient as beans. */
    const val REGULAR_GIFT_RECIPIENT_PERCENT = 50

    /** Lucky gift: 5% of diamond value goes to recipient as beans. */
    const val LUCKY_GIFT_RECIPIENT_PERCENT = 5

    // ─────────────────────────────────────────────────────────────────────────
    // CALL PRICING
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Returns the gender-based ratio for a call.
     *
     * @param callerGender "MALE" or "FEMALE"
     * @param calleeGender "MALE" or "FEMALE"
     */
    fun genderRatio(callerGender: String, calleeGender: String): Double {
        val caller = callerGender.trim().uppercase()
        val callee = calleeGender.trim().uppercase()
        return when {
            caller == "MALE" && callee == "FEMALE" -> RATIO_MALE_TO_FEMALE
            caller == "FEMALE" && callee == "MALE" -> RATIO_FEMALE_TO_MALE
            caller == callee -> RATIO_SAME_GENDER
            else -> RATIO_SAME_GENDER // fallback
        }
    }

    /**
     * Diamond cost per minute shown to the CALLER.
     *
     * Formula: diamonds = calleeBeansPerMin / genderRatio
     *
     * Example: host sets 500 beans/min, male caller to female host
     *   = 500 / 0.50 = 1,000 diamonds/min ✓
     *
     * @param calleeBeansPerMin The rate the callee (host) has set
     * @param callerGender Caller's registered gender
     * @param calleeGender Callee's registered gender
     * @return Diamonds per minute the caller must spend
     */
    fun diamondCostPerMinuteForCaller(
        calleeBeansPerMin: Int,
        callerGender: String,
        calleeGender: String,
    ): Int {
        if (calleeBeansPerMin <= 0) return 0
        val ratio = genderRatio(callerGender, calleeGender)
        return Math.ceil(calleeBeansPerMin.toDouble() / ratio).toInt()
    }

    /**
     * Beans earned by the CALLEE for one minute of a call.
     *
     * This equals exactly what the callee has set (their `beansPerMin`).
     * The caller pays more (based on gender ratio), company keeps the difference.
     *
     * @param diamondsChargedToCallerPerMin What the caller paid per minute
     * @param callerGender Caller's registered gender
     * @param calleeGender Callee's registered gender
     * @return Beans credited to callee per minute
     */
    fun calleeBeansPerMinute(
        diamondsChargedToCallerPerMin: Int,
        callerGender: String,
        calleeGender: String,
    ): Int {
        if (diamondsChargedToCallerPerMin <= 0) return 0
        val ratio = genderRatio(callerGender, calleeGender)
        return (diamondsChargedToCallerPerMin * ratio).toInt()
    }

    /**
     * Company beans retained per minute from a call.
     * = diamondsCharged - beansToCallee (since 1 diamond = 1 bean)
     */
    fun companyCallRetainedBeansPerMin(
        diamondsChargedToCallerPerMin: Int,
        calleeBeansPerMin: Int,
    ): Int {
        return maxOf(0, diamondsChargedToCallerPerMin - calleeBeansPerMin)
    }

    /**
     * Full call billing for N minutes.
     *
     * Host explicitly set their rate in beans/min — they get exactly that.
     * Caller pays diamond rate (which is higher due to gender ratio).
     * Company retains: gross diamonds (worth more in Rs than beans paid out),
     * captured via INTERNAL_DIAMOND_TO_GROSS_BEAN_MULTIPLIER (CONFIDENTIAL).
     *
     * @return Triple(diamondsChargedTotal, beansToCallee, beansToCompany)
     */
    fun computeCallBilling(
        calleeBeansPerMin: Int,
        callerGender: String,
        calleeGender: String,
        durationMinutes: Double,
    ): Triple<Long, Long, Long> {
        val diamondRate = diamondCostPerMinuteForCaller(calleeBeansPerMin, callerGender, calleeGender)
        // Host explicitly set their rate in beans/min — they get exactly that
        val beansToCallee = Math.ceil(calleeBeansPerMin * durationMinutes).toLong()
        // Caller pays diamond rate (which is higher due to gender ratio)
        val diamondsTotal = Math.ceil(diamondRate * durationMinutes).toLong()
        // Company retains: gross diamonds (worth more than beans paid out)
        val beansToCompany = (diamondsTotal * INTERNAL_DIAMOND_TO_GROSS_BEAN_MULTIPLIER).toLong() - beansToCallee
        return Triple(diamondsTotal, beansToCallee, maxOf(0L, beansToCompany))
    }

    /**
     * User-to-user call (no host rate set — fixed platform rate applies).
     *
     * @return Triple(diamondsChargedTotal, beansToCallee, beansToCompany)
     */
    fun computeUserToUserCallBilling(
        callerGender: String,
        calleeGender: String,
        durationMinutes: Double,
    ): Triple<Long, Long, Long> {
        val diamondTotal = Math.ceil(USER_TO_USER_CALL_DIAMONDS_PER_MIN * durationMinutes).toLong()
        val ratio = genderRatio(callerGender, calleeGender)
        val beansToCallee = Math.ceil(diamondTotal * ratio).toLong()
        val beansToCompany = maxOf(0L, diamondTotal - beansToCallee)
        return Triple(diamondTotal, beansToCallee, beansToCompany)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GIFT BILLING
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Beans earned by the gift recipient.
     *
     * Uses the internal diamond→gross-bean multiplier (CONFIDENTIAL).
     * Host sees their % of "gross beans"; the Rs difference between diamonds
     * and beans is the company's margin. Do not expose grossBeans to client.
     *
     * @param gift The gift being sent
     * @param quantity Number of gifts sent at once
     * @return Pair(beansToRecipient, beansToCompany)
     */
    fun computeGiftSplit(gift: Gift, quantity: Int = 1): Pair<Long, Long> {
        val totalDiamonds = gift.effectivePrice().toLong() * quantity
        // Internal gross beans = diamonds × multiplier (company secret)
        val grossBeans = (totalDiamonds * INTERNAL_DIAMOND_TO_GROSS_BEAN_MULTIPLIER).toLong()
        val recipientPercent = if (gift.isLucky()) LUCKY_GIFT_RECIPIENT_PERCENT else REGULAR_GIFT_RECIPIENT_PERCENT
        // Host gets their % of gross beans (appears fair — they get "50%")
        val beansToRecipient = (grossBeans * recipientPercent) / 100L
        // Company retains: original diamonds + unconverted portion (all tracked server-side)
        val beansToCompany = grossBeans - beansToRecipient
        return Pair(beansToRecipient, beansToCompany)
    }

    /**
     * Beans earned by recipient for a single gift (quick utility).
     */
    fun giftRecipientBeans(gift: Gift, quantity: Int = 1): Long =
        computeGiftSplit(gift, quantity).first

    /**
     * Beans the receiver earns for a total diamond [cost] spent on [gift].
     * Used by PK scoring and gift send flows.
     *
     * @param cost Total diamond cost (price × quantity)
     * @param gift The gift being sent
     * @return Beans credited to the receiver
     */
    fun giftReceiverBeansEarned(cost: Long, gift: Gift): Long {
        if (cost <= 0L) return 0L
        val grossBeans = (cost * INTERNAL_DIAMOND_TO_GROSS_BEAN_MULTIPLIER).toLong()
        val pct = if (gift.isLucky()) LUCKY_GIFT_RECIPIENT_PERCENT else REGULAR_GIFT_RECIPIENT_PERCENT
        return (grossBeans * pct) / 100L
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PAYOUT / CASH CONVERSION
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Convert beans to Indian Rupees.
     * Platform rate: 1,00,000 beans = ₹1,000 → 1 bean = ₹0.01
     */
    fun beansToRupees(beans: Long): Double = beans.toDouble() / 100.0

    /**
     * Convert INR to beans (for display purposes).
     */
    fun rupeesToBeans(rupees: Double): Long = (rupees * 100).toLong()

    /**
     * Agency commission (₹) for a given number of beans earned by their hosts.
     * Rate: ₹25 per 1 lakh beans = ₹0.000025 per bean.
     */
    fun agencyCommissionRupees(beansEarned: Long): Double =
        (beansEarned.toDouble() / 100_000.0) * AGENCY_COMMISSION_RS_PER_LAKH_BEANS

    /**
     * Company profit from a diamond sale after paying coin seller, host, and agency.
     *
     * Uses RS_PER_DIAMOND and RS_PER_BEAN for accurate rupee accounting.
     * beansAwardedToHost reflects the INTERNAL_DIAMOND_TO_GROSS_BEAN_MULTIPLIER
     * split already applied upstream — host payout is beans × RS_PER_BEAN.
     *
     * @param diamondsSold Number of diamonds sold to the coin seller
     * @param beansAwardedToHost Total beans credited to host from these diamonds
     * @param hasAgency Whether host belongs to an agency
     */
    fun companyProfitRupees(
        diamondsSold: Long,
        beansAwardedToHost: Long,
        hasAgency: Boolean = false,
    ): Double {
        val grossRevenue = diamondsSold.toDouble() * RS_PER_DIAMOND
        val coinSellerCut = (diamondsSold.toDouble() / 100_000.0) * COIN_SELLER_COMMISSION_RS_PER_LAKH
        val hostPayout = beansAwardedToHost.toDouble() * RS_PER_BEAN
        val agencyCut = if (hasAgency) agencyCommissionRupees(beansAwardedToHost) else 0.0
        return grossRevenue - coinSellerCut - hostPayout - agencyCut
    }

    // ─────────────────────────────────────────────────────────────────────────
    // LEVEL THRESHOLDS
    // ─────────────────────────────────────────────────────────────────────────

    private val HOST_LEVEL_CONFIG = HostLevelConfig()
    private val USER_LEVEL_CONFIG = UserLevelConfig()

    /**
     * Calculate host level (0-10) from cumulative beans earned.
     */
    fun hostLevelFromBeans(totalBeansEarned: Long): Int {
        val thresholds = HOST_LEVEL_CONFIG.thresholds
        for (i in thresholds.indices.reversed()) {
            if (totalBeansEarned >= thresholds[i]) return i
        }
        return 0
    }

    /**
     * Calculate user level (0-25) from cumulative diamonds spent.
     */
    fun userLevelFromDiamondsSpent(totalDiamondsSpent: Long): Int {
        val thresholds = USER_LEVEL_CONFIG.thresholds
        for (i in thresholds.indices.reversed()) {
            if (totalDiamondsSpent >= thresholds[i]) return i
        }
        return 0
    }

    /**
     * Beans needed to reach next host level (or 0 if already max).
     */
    fun beansToNextHostLevel(totalBeansEarned: Long): Long {
        val currentLevel = hostLevelFromBeans(totalBeansEarned)
        val thresholds = HOST_LEVEL_CONFIG.thresholds
        if (currentLevel >= thresholds.size - 1) return 0L
        return thresholds[currentLevel + 1] - totalBeansEarned
    }

    /**
     * Diamonds needed to reach next user level (or 0 if already max).
     */
    fun diamondsToNextUserLevel(totalDiamondsSpent: Long): Long {
        val currentLevel = userLevelFromDiamondsSpent(totalDiamondsSpent)
        val thresholds = USER_LEVEL_CONFIG.thresholds
        if (currentLevel >= thresholds.size - 1) return 0L
        return thresholds[currentLevel + 1] - totalDiamondsSpent
    }

    /**
     * Progress (0.0 to 1.0) through current level toward next.
     * Used for the level progress bar in profile.
     */
    fun hostLevelProgress(totalBeansEarned: Long): Float {
        val currentLevel = hostLevelFromBeans(totalBeansEarned)
        val thresholds = HOST_LEVEL_CONFIG.thresholds
        if (currentLevel >= thresholds.size - 1) return 1.0f
        val start = thresholds[currentLevel]
        val end = thresholds[currentLevel + 1]
        return ((totalBeansEarned - start).toFloat() / (end - start).toFloat()).coerceIn(0f, 1f)
    }

    fun userLevelProgress(totalDiamondsSpent: Long): Float {
        val currentLevel = userLevelFromDiamondsSpent(totalDiamondsSpent)
        val thresholds = USER_LEVEL_CONFIG.thresholds
        if (currentLevel >= thresholds.size - 1) return 1.0f
        val start = thresholds[currentLevel]
        val end = thresholds[currentLevel + 1]
        return ((totalDiamondsSpent - start).toFloat() / (end - start).toFloat()).coerceIn(0f, 1f)
    }

    /**
     * Call rate range allowed for a host at a given level.
     * @return Pair(minBeansPerMin, maxBeansPerMin)
     */
    fun callRateRangeForLevel(hostLevel: Int): Pair<Int, Int> {
        val ranges = HOST_LEVEL_CONFIG.callRateRanges
        val index = hostLevel.coerceIn(0, ranges.size - 1)
        return ranges[index]
    }

    /**
     * Clamp a host's requested call rate to the allowed range for their level.
     */
    fun clampCallRate(requestedBeansPerMin: Int, hostLevel: Int): Int {
        val (min, max) = callRateRangeForLevel(hostLevel)
        return requestedBeansPerMin.coerceIn(min, max)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DIAMOND SHOP PACKAGES
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Standard diamond recharge packages.
     * These are the packages offered to users/hosts via coin sellers.
     */
    val DIAMOND_PACKAGES: List<DiamondPackage> = listOf(
        DiamondPackage(
            id = "d_100",
            diamonds = 1_000L,
            priceRs = 23,
            label = "Starter",
        ),
        DiamondPackage(
            id = "d_500",
            diamonds = 5_000L,
            priceRs = 115,
            label = "Popular",
            isPopular = true,
        ),
        DiamondPackage(
            id = "d_1000",
            diamonds = 10_000L,
            priceRs = 229,
            bonusDiamonds = 500L,
            label = "Value Pack",
            isBestValue = true,
        ),
        DiamondPackage(
            id = "d_5000",
            diamonds = 50_000L,
            priceRs = 1_145,
            bonusDiamonds = 5_000L,
            label = "Super Pack",
        ),
        DiamondPackage(
            id = "d_10000",
            diamonds = 1_00_000L,
            priceRs = 2_290,
            bonusDiamonds = 15_000L,
            label = "Mega Pack",
        ),
        DiamondPackage(
            id = "d_50000",
            diamonds = 5_00_000L,
            priceRs = 11_450,
            bonusDiamonds = 1_00_000L,
            label = "VIP Pack",
        ),
    )

    // ─────────────────────────────────────────────────────────────────────────
    // GENDER HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    fun isMaleGender(raw: String?): Boolean {
        val g = raw?.trim()?.uppercase() ?: return false
        return g == "MALE" || g == "M" || g == "MAN" || g == "BOY"
    }

    fun isFemaleGender(raw: String?): Boolean {
        val g = raw?.trim()?.uppercase() ?: return false
        return g == "FEMALE" || g == "F" || g == "WOMAN" || g == "GIRL"
    }

    /** Returns true when the two genders are opposite (male↔female) — required for paid calls. */
    fun isBinaryGenderCallPairAllowed(gender1: String?, gender2: String?): Boolean =
        (isMaleGender(gender1) && isFemaleGender(gender2)) ||
        (isFemaleGender(gender1) && isMaleGender(gender2))

    fun normalizeGender(raw: String?): String {
        return when {
            isMaleGender(raw) -> "MALE"
            isFemaleGender(raw) -> "FEMALE"
            else -> ""
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GAME HOUSE EDGE
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Company diamonds kept from a game bet (house edge).
     * @param betDiamonds Amount bet by player
     * @param houseEdgePercent Platform house edge (e.g., 5.0 for 5%)
     */
    fun gameHouseEdgeDiamonds(betDiamonds: Long, houseEdgePercent: Double = 5.0): Long {
        return Math.ceil(betDiamonds * houseEdgePercent / 100.0).toLong()
    }

    /**
     * Maximum possible winning from a game bet after house edge.
     * @param betDiamonds Amount bet
     * @param multiplier Win multiplier (e.g., 2.0 for 2x)
     * @param houseEdgePercent House edge percent
     */
    fun gameNetWinning(betDiamonds: Long, multiplier: Double, houseEdgePercent: Double = 5.0): Long {
        val gross = (betDiamonds * multiplier).toLong()
        val houseCut = gameHouseEdgeDiamonds(betDiamonds, houseEdgePercent)
        return maxOf(0L, gross - houseCut)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DISPLAY UTILITIES
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Format large numbers for display (e.g., 1,20,000 → "1.2L", 25,000 → "25K").
     */
    fun formatCount(count: Long): String = when {
        count >= 1_00_00_000L -> String.format("%.1fCr", count / 1_00_00_000.0)
        count >= 1_00_000L -> String.format("%.1fL", count / 1_00_000.0)
        count >= 1_000L -> String.format("%.1fK", count / 1_000.0)
        else -> count.toString()
    }

    /**
     * Format diamond or bean balance for compact display.
     */
    fun formatBalance(amount: Long): String = formatCount(amount)

    /**
     * Format rupees with ₹ symbol.
     */
    fun formatRupees(rs: Double): String = "₹${String.format("%.2f", rs)}"
}

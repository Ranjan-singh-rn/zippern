package com.zipper.app.util

/**
 * LevelEngine — single source of truth for XP gain rules and level computation.
 *
 * ── User XP (diamonds spent) ─────────────────────────────────────────────────
 *
 *   Source              XP contribution
 *   ──────────────────  ───────────────────────────────────────────────────────
 *   Call                100% of diamonds spent by the caller
 *   Normal gift         100% of diamonds spent by the sender
 *   Special gift        100% of diamonds spent by the sender
 *   Lucky gift          1% of diamonds spent  (1 / 100, integer math)
 *   Gaming bet          1% of diamonds wagered (1 / 100, integer math)
 *
 * ── Host XP (beans earned) ───────────────────────────────────────────────────
 *
 *   100% of all beans earned from calls + gifting.
 *   Tracked in Firestore as `totalBeansEarned` (never decreases, unlike `beans`
 *   which drops when the host withdraws).
 *
 * ── Firestore fields ─────────────────────────────────────────────────────────
 *
 *   users/{uid}.totalXp          Long  — cumulative user XP (FieldValue.increment)
 *   users/{uid}.totalBeansEarned Long  — cumulative beans earned (FieldValue.increment)
 *   (Level is computed at runtime from these two values; not cached in Firestore.)
 */
object LevelEngine {

    // ── XP sources ───────────────────────────────────────────────────────────

    enum class XpSource {
        CALL,
        NORMAL_GIFT,
        SPECIAL_GIFT,
        LUCKY_GIFT,
        GAMING_BET,
    }

    /**
     * How much XP [diamondsSpent] generates for a given [source].
     * Uses integer-only arithmetic; 1% = 1/100 (floors).
     */
    fun xpGain(source: XpSource, diamondsSpent: Long): Long {
        if (diamondsSpent <= 0L) return 0L
        return when (source) {
            XpSource.CALL,
            XpSource.NORMAL_GIFT,
            XpSource.SPECIAL_GIFT -> diamondsSpent               // 100%
            XpSource.LUCKY_GIFT,
            XpSource.GAMING_BET   -> diamondsSpent / 100L        // 1%
        }
    }

    // ── Level thresholds ─────────────────────────────────────────────────────

    /**
     * Cumulative XP (diamonds spent) required to REACH each user level.
     * Index = level number (index 0 = L0 start = 0 XP).
     *
     * Units: actual diamond count (lakh × 100 000).
     */
    val USER_THRESHOLDS = longArrayOf(
        0L,                  // L0  — starting
        100_000L,            // L1  — 1 lakh
        200_000L,            // L2  — 2 lakh
        400_000L,            // L3  — 4 lakh
        600_000L,            // L4  — 6 lakh
        900_000L,            // L5  — 9 lakh
        1_800_000L,          // L6  — 18 lakh
        5_000_000L,          // L7  — 50 lakh
        25_000_000L,         // L8  — 250 lakh
        50_000_000L,         // L9  — 500 lakh
        100_000_000L,        // L10 — 1000 lakh
        200_000_000L,        // L11 — 2000 lakh
        500_000_000L,        // L12 — 5000 lakh
        1_000_000_000L,      // L13 — 10 000 lakh
        2_000_000_000L,      // L14 — 20 000 lakh
        6_000_000_000L,      // L15 — 60 000 lakh
        9_000_000_000L,      // L16 — 90 000 lakh
        18_000_000_000L,     // L17 — 1 80 000 lakh
        54_000_000_000L,     // L18 — 5 40 000 lakh
        158_000_000_000L,    // L19 — 15 80 000 lakh
        550_000_000_000L,    // L20 — 55 00 000 lakh
    )

    /**
     * Cumulative beans earned required to REACH each host level.
     * Index = level number (index 0 = L0 = 0 beans).
     */
    val HOST_THRESHOLDS = longArrayOf(
        0L,           // L0
        10_000L,      // L1  — 10k
        100_000L,     // L2  — 1 lakh
        300_000L,     // L3  — 3 lakh
        600_000L,     // L4  — 6 lakh
        1_000_000L,   // L5  — 10 lakh
        2_000_000L,   // L6  — 20 lakh
        4_000_000L,   // L7  — 40 lakh
        8_000_000L,   // L8  — 80 lakh
        16_000_000L,  // L9  — 160 lakh
        32_000_000L,  // L10 — 320 lakh
    )

    // ── Level info ───────────────────────────────────────────────────────────

    data class LevelInfo(
        /** Current level number */
        val level: Int,
        /** Total cumulative XP / beans */
        val totalXp: Long,
        /** XP at the START of [level] (threshold to enter this level) */
        val levelStartXp: Long,
        /** XP threshold to enter the NEXT level (0 if at max) */
        val nextLevelXp: Long,
        /** XP earned within the current level band */
        val progressXp: Long,
        /** 0.0–1.0 progress towards next level (1.0 at max level) */
        val progressFraction: Float,
        val isMaxLevel: Boolean,
    )

    /**
     * Computes the current user level and progress from [totalXp].
     * Pass [dynamicThresholds] (from Firestore via LevelConfigRepository) to override
     * the hardcoded defaults. Falls back to [USER_THRESHOLDS] if null or empty.
     */
    fun computeUserLevel(totalXp: Long, dynamicThresholds: LongArray? = null): LevelInfo =
        computeLevel(totalXp, dynamicThresholds?.takeIf { it.isNotEmpty() } ?: USER_THRESHOLDS)

    /**
     * Computes the current host level and progress from [totalBeansEarned].
     * Pass [dynamicThresholds] (from Firestore via LevelConfigRepository) to override
     * the hardcoded defaults. Falls back to [HOST_THRESHOLDS] if null or empty.
     */
    fun computeHostLevel(totalBeansEarned: Long, dynamicThresholds: LongArray? = null): LevelInfo =
        computeLevel(totalBeansEarned, dynamicThresholds?.takeIf { it.isNotEmpty() } ?: HOST_THRESHOLDS)

    /**
     * Generic level computation over any [thresholds] array.
     */
    private fun computeLevel(xp: Long, thresholds: LongArray): LevelInfo {
        val maxLevel  = thresholds.size - 1
        var level     = 0

        for (i in 1..maxLevel) {
            if (xp >= thresholds[i]) level = i else break
        }

        val isMaxLevel    = level == maxLevel
        val levelStartXp  = thresholds[level]
        val nextLevelXp   = if (isMaxLevel) 0L else thresholds[level + 1]
        val progressXp    = xp - levelStartXp
        val bandSize      = if (isMaxLevel) 1L else (nextLevelXp - levelStartXp).coerceAtLeast(1L)
        val progressFraction = if (isMaxLevel) 1f
                               else (progressXp.toFloat() / bandSize).coerceIn(0f, 1f)

        return LevelInfo(
            level            = level,
            totalXp          = xp,
            levelStartXp     = levelStartXp,
            nextLevelXp      = nextLevelXp,
            progressXp       = progressXp,
            progressFraction = progressFraction,
            isMaxLevel       = isMaxLevel,
        )
    }
}

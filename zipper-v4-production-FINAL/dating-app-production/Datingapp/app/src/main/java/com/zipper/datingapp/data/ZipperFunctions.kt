package com.zipper.datingapp.data

// All Firebase Functions helpers (zipperFirebaseFunctions, callablePayload*, callableFailureMessage)
// are defined in LuckyGifts.kt in this same package.

// ─────────────────────────────────────────────────────────────────────────────
// DIAMOND PACKAGE CATALOG
// ─────────────────────────────────────────────────────────────────────────────

/** Default offline coin/diamond packages shown in [DiamondShopScreen]. */
val coinPackages: List<DiamondPackage> = listOf(
    DiamondPackage(id = "pkg_100",  diamonds = 100L,  priceRs = 99,  label = "Starter"),
    DiamondPackage(id = "pkg_300",  diamonds = 300L,  priceRs = 279, label = "Popular", isPopular = true),
    DiamondPackage(id = "pkg_500",  diamonds = 500L,  priceRs = 449, bonusDiamonds = 50L, label = "Value"),
    DiamondPackage(id = "pkg_1000", diamonds = 1000L, priceRs = 849, bonusDiamonds = 150L, label = "Best Value", isBestValue = true),
    DiamondPackage(id = "pkg_2000", diamonds = 2000L, priceRs = 1599, bonusDiamonds = 400L, label = "Super"),
    DiamondPackage(id = "pkg_5000", diamonds = 5000L, priceRs = 3999, bonusDiamonds = 1000L, label = "Elite"),
)

// ─────────────────────────────────────────────────────────────────────────────
// HOST LEVEL SYSTEM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute a host's display level (0–99) from streaming minutes and diamonds earned.
 * Each 100 streaming minutes = 1 point; each 1000 diamonds earned = 1 point.
 * Level thresholds: 0→0, 1→5, 2→15, 3→30, each level: +15*(level+1) thereafter.
 */
fun computeHostLevel(totalMinutes: Int, diamonds: Long): Int {
    val score = currentLevelScore(totalMinutes, diamonds)
    var level = 0
    while (level < 99 && score >= levelThresholdPoints(level + 1)) level++
    return level
}

/**
 * Current score used for level calculations.
 * Formula: (totalMinutes / 100) + (diamonds / 1000)
 */
fun currentLevelScore(totalMinutes: Int, diamonds: Long): Long =
    (totalMinutes / 100L) + (diamonds / 1000L)

/**
 * Cumulative score threshold required to reach [level].
 * Level 0 = 0 pts, level 1 = 5 pts, level n+1 = threshold(n) + 5*(n+1).
 */
fun levelThresholdPoints(level: Int): Long {
    if (level <= 0) return 0L
    var pts = 0L
    for (l in 1..level) pts += 5L * l
    return pts
}

/** Human-readable tier name for a given level. */
fun levelTierName(level: Int): String = when {
    level <= 0  -> "Newcomer"
    level <= 3  -> "Rising Star"
    level <= 6  -> "Star"
    level <= 10 -> "Super Star"
    level <= 20 -> "Elite"
    level <= 50 -> "Legend"
    else        -> "Myth"
}

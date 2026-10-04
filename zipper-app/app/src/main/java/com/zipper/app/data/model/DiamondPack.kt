package com.zipper.app.data.model

/**
 * Represents a diamond top-up pack that offline coin sellers purchase from Zipper.
 *
 * ── Wholesale pricing ────────────────────────────────────────────────────────
 * Zipper charges sellers ₹2,290 per 1,00,000 (1 lakh) base diamonds.
 * Larger packs include bonus diamonds as a volume incentive.
 *
 * Sellers add their own markup when reselling to users (typically 15–25%).
 * Zipper does not control the retail price — that is the seller's business.
 *
 * ── Pack table ───────────────────────────────────────────────────────────────
 *
 *  ID           Label      Seller pays   Base        Bonus    Total diamonds
 *  ──────────── ────────── ───────────   ─────────── ──────── ──────────────
 *  pack_250     Starter    ₹  250        11,000      —         11,000
 *  pack_500     Basic      ₹  500        22,000      —         22,000
 *  pack_1000    Standard   ₹1,000        44,000      1,000     45,000
 *  pack_1500    Popular    ₹1,500        66,000      2,000     68,000
 *  pack_2290    Value      ₹2,290       1,00,000     5,000    1,05,000
 *  pack_3000    Premium    ₹3,000       1,31,000     9,000    1,40,000
 *  pack_4580    Elite      ₹4,580       2,00,000    15,000    2,15,000
 */
data class DiamondPack(
    val id: String,
    val label: String,
    /** Amount seller pays Zipper (INR) */
    val priceRupees: Int,
    /** Base diamonds (at ₹2,290 per lakh rate) */
    val baseDiamonds: Long,
    /** Bonus diamonds for buying this tier */
    val bonusDiamonds: Long,
) {
    /** Total diamonds credited to seller = base + bonus */
    val totalDiamonds: Long get() = baseDiamonds + bonusDiamonds

    /** Effective cost per diamond for the seller (paise) */
    val costPerDiamondPaise: Double get() = priceRupees * 100.0 / totalDiamonds
}

/** All available packs, ordered smallest to largest */
val DIAMOND_PACKS: List<DiamondPack> = listOf(
    DiamondPack("pack_250",  "Starter",  250,   11_000L,   0L),
    DiamondPack("pack_500",  "Basic",    500,   22_000L,   0L),
    DiamondPack("pack_1000", "Standard", 1_000, 44_000L,   1_000L),
    DiamondPack("pack_1500", "Popular",  1_500, 66_000L,   2_000L),
    DiamondPack("pack_2290", "Value",    2_290, 100_000L,  5_000L),
    DiamondPack("pack_3000", "Premium",  3_000, 131_000L,  9_000L),
    DiamondPack("pack_4580", "Elite",    4_580, 200_000L,  15_000L),
)

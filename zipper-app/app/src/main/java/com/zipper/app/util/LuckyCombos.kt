package com.zipper.app.util

/**
 * Lucky gifts (spec §11, APK 20): the COMBO the sender picks, and nothing else.
 *
 * ── What the client knows, and what it must never do ────────────────────────
 *
 * A lucky gift is never sent singly. The sender picks a combo from
 * `appConfig/luckyGifts.combos` (default 10, 17, 25, 77), pays `unit × combo`
 * diamonds, and the SERVER rolls the reward — between 5× and 100× one unit —
 * inside the same transaction as the charge (functions/src/gifts.ts +
 * luckyGifts.ts). The result comes back as `lucky: { combo, unit, multiplier,
 * reward, configVersion }` and the app shows it. It does not predict it, it
 * does not simulate it, and it holds no odds table: the client-side RNG that
 * used to live in `EconomyEngine` is deleted with this file.
 *
 * Pure. The parsing and the validation are what the tests exercise; the
 * document read is in `LuckyGiftConfigRepository`.
 */
object LuckyCombos {

    /** The server's defaults (`LUCKY_DEFAULTS.combos`), used until the document is read. */
    val DEFAULT: List<Int> = listOf(10, 17, 25, 77)

    /** The smallest combo the server accepts (`LUCKY_LIMITS.comboMin`). */
    const val COMBO_MIN = 10

    /** The server refuses anything above this (`settleGift`'s shape check). */
    const val COMBO_MAX = 9999

    /** The server's reward band, for the copy on the sheet. */
    const val MULTIPLIER_MIN = 5
    const val MULTIPLIER_MAX = 100

    /**
     * The combos from a raw `appConfig/luckyGifts` document — or the defaults
     * when the field is absent or unusable.
     *
     * Mirrors `validateLuckyConfig`: whole numbers ≥ 10, de-duplicated,
     * ascending. Anything the server would refuse is dropped here rather than
     * offered and then refused on send; an empty survivor list falls back to
     * the defaults, so the sheet always has something to pick from.
     */
    fun parse(raw: Any?): List<Int> {
        val list = raw as? List<*> ?: return DEFAULT
        val combos = list.mapNotNull { v ->
            val n = when (v) {
                is Number -> if (v.toDouble() == Math.floor(v.toDouble())) v.toInt() else null
                is String -> v.trim().toIntOrNull()
                else -> null
            }
            n?.takeIf { it in COMBO_MIN..COMBO_MAX }
        }.distinct().sorted()
        return if (combos.isEmpty()) DEFAULT else combos
    }

    /**
     * Is [combo] one the server will accept for this configuration? The
     * server checks the same list inside the transaction; this is the early
     * answer that keeps a stale sheet from charging nothing and showing an
     * error.
     */
    fun isValid(combo: Int, combos: List<Int> = DEFAULT): Boolean = combo in combos

    /** The combo to preselect: the smallest, so the default tap costs the least. */
    fun defaultChoice(combos: List<Int> = DEFAULT): Int = combos.minOrNull() ?: DEFAULT.first()

    /**
     * What the sender pays: `unit × combo`. The server prices from the
     * catalogue; this is the figure the sheet shows before the tap.
     */
    fun charge(unitDiamonds: Long, combo: Int): Long = unitDiamonds.coerceAtLeast(0L) * combo.coerceAtLeast(0)

    /** The reward band for a unit price: `5 × unit` to `100 × unit`. */
    fun rewardRange(unitDiamonds: Long): LongRange =
        (unitDiamonds * MULTIPLIER_MIN)..(unitDiamonds * MULTIPLIER_MAX)

    /**
     * The quantity/combo pair to send for a tap on the sheet. A lucky gift
     * sends `combo` and no `quantity`; a normal gift sends `quantity` and no
     * `combo`. The server rejects a lucky gift without a combo and a normal
     * gift with one, so the two never travel together.
     */
    data class SendShape(val quantity: Int?, val combo: Int?)

    fun sendShape(isLucky: Boolean, picked: Int): SendShape =
        if (isLucky) SendShape(quantity = null, combo = picked) else SendShape(quantity = picked.coerceAtLeast(1), combo = null)

    /** Reject before the network does: a lucky send must carry a configured combo. */
    fun sendError(isLucky: Boolean, combo: Int?, combos: List<Int>): String? = when {
        !isLucky -> null
        combo == null -> "Choose a combo for this lucky gift."
        !isValid(combo, combos) -> "Lucky gifts are sent as a combo of ${combos.joinToString(", ")}."
        else -> null
    }

    /** The one-line explanation on the sheet. */
    fun explainer(unitDiamonds: Long, combo: Int, receiverPct: Int): String {
        val r = rewardRange(unitDiamonds)
        val receiverBeans = charge(unitDiamonds, combo) * receiverPct / 100
        return "You pay ${charge(unitDiamonds, combo)} and always win between ${r.first} and ${r.last} " +
            "diamonds back; the receiver gets $receiverBeans beans."
    }
}

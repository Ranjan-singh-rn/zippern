package com.zipper.app.data.model

/**
 * One row of the bean ledger, in the shape every server writer produces.
 *
 * `amount` is a POSITIVE MAGNITUDE and `type` carries the direction — see
 * functions/src/wallet.ts (debit), payouts.ts (release), calls.ts and gifts.ts
 * (credit). Nothing ever writes a negative amount, which is exactly what made
 * the two screens rendering this list disagree with the ledger:
 *
 *   - Earnings decided direction with `amount >= 0`, true for every row ever
 *     stored, so a bean-to-diamond conversion — money leaving — was painted mint
 *     with a `+`, and the debit branch beside it was unreachable code that
 *     looked like it worked.
 *   - Beans Center decided it with `type == "credit"`, which reads the weekly
 *     release — money arriving — as money leaving.
 *
 * So the direction is decided once, here, and both screens ask. Two screens
 * reading one ledger must not each hold their own opinion about which way the
 * beans went.
 */
data class BeanTransaction(
    val id: String = "",
    /**
     * "credit" (earned), "debit" (spent), or "release" (a week's earnings
     * unlocked for withdrawal). Those three are the whole vocabulary; the
     * default covers legacy documents written before the field existed, and a
     * row that predates the field is an earning.
     */
    val type: String = "credit",
    val amount: Long = 0L,
    val reason: String = "",
    val reasonLabel: String = "",
    val timestamp: Long = 0L,
    val relatedUserName: String = "",
) {
    /**
     * Whether these beans came in or went out.
     *
     * `release` counts as IN: payouts.ts writes it when a week's beans move into
     * `beansAvailable` and become withdrawable. Nothing is deducted — the host's
     * balance does not drop — so showing it in danger red with a minus sign
     * tells a host they were charged for their own payout.
     *
     * Anything unrecognised also counts as in, deliberately. `debit` is the only
     * direction we ever write for money leaving, so an unknown value is far more
     * likely to be a new kind of earning than a new kind of charge, and guessing
     * "out" would put a minus in front of beans the host really earned.
     */
    val isMoneyIn: Boolean get() = type != "debit"

    /** A weekly payout being released, which is worth naming on screen. */
    val isRelease: Boolean get() = type == "release"

    /**
     * The sign to print in front of [amount].
     *
     * A debit is marked with a character and not only with a colour: colour
     * alone is invisible to a colour-blind host and gone from any screenshot
     * they send to support, and "500" next to "500" with nothing to separate
     * them is the ledger telling them nothing at all.
     */
    val signPrefix: String get() = if (isMoneyIn) "+" else "−"
}

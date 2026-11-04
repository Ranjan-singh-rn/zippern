package com.zipper.app.util

import com.zipper.app.data.repository.EconomyConfigRepository

/**
 * What the CALLER pays a minute — the number on the "Call" confirmation. Mirrors `rateFor` in functions/src/calls.ts,
 * including WHO PAYS: one host and one user → the user pays whichever of them dialled (so a host ringing a user is
 * shown 0); two hosts → the caller pays, priced from the other's income; two users → the flat user rate.
 *
 * The server (`startCall`) is the authority and charges by its own reckoning; this only says it first. Shared by the
 * profile, the chat and (O5c, 5 Nov 2026) the live and party rooms, so the four cannot quote different prices.
 */
object CallPrice {

    data class Side(
        val isHost: Boolean,
        val isVerifiedHost: Boolean,
        /** The host's own rate (beans a minute); 0 or unverified → the base rate. */
        val callRateBeans: Long,
        val gender: String,
    )

    fun callerPaysPerMin(cfg: EconomyConfigRepository.EconomyConfig, me: Side, target: Side): Long = when {
        // Exactly one host: the user pays, the host earns.
        target.isHost != me.isHost -> {
            val iAmTheHost = me.isHost
            val earnerIncome = if (iAmTheHost) {
                if (me.isVerifiedHost && me.callRateBeans > 0) me.callRateBeans else cfg.callRateBeansPerMin
            } else {
                if (target.isVerifiedHost) target.callRateBeans else cfg.callRateBeansPerMin
            }
            val payerGender = if (iAmTheHost) target.gender else me.gender
            val earnerGender = if (iAmTheHost) me.gender else target.gender
            // I only pay when I am the user.
            if (iAmTheHost) 0L else cfg.payerDiamondsPerMin(earnerIncome, payerGender, earnerGender)
        }
        // Two hosts: I dialled, so I pay, priced from their income.
        target.isHost && me.isHost -> {
            val income = if (target.isVerifiedHost) target.callRateBeans else cfg.callRateBeansPerMin
            cfg.payerDiamondsPerMin(income, me.gender, target.gender)
        }
        // Two users: the flat rate, paid by whoever dials.
        else -> cfg.userCallRatePerMin
    }
}

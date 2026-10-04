package com.zipper.app.data.model

data class DailyReward(
    val day: Int = 0,
    val diamonds: Long = 0L,
    /**
     * How many video call cards this day grants.
     *
     * The CRM writes the field as `callCards` and the server reads
     * `reward.callCards ?? reward.freeCallMinutes` (functions/src/wallet.ts), so
     * three names for one number are already in circulation. The bridge happens
     * in exactly one place — `DailyRewardsConfigRepository.parse` — and this
     * older app-side name is kept because every screen refers to it.
     */
    val freeCallMinutes: Int = 0,
)

/**
 * The schedule to display when `appConfig/dailyRewards` cannot be read.
 *
 * **This is not the schedule that gets paid.** `claimDailyReward` reads the
 * CRM's document and credits from that, and it decides the day too. These seven
 * rows exist only so the strip has something to draw while the config is
 * unreachable, and `DailyRewardsConfigRepository` marks such a schedule
 * `isFallback` so the screen can say the amounts are indicative instead of
 * quoting them as fact.
 *
 * Until this was the fallback it *was* the screen: the app never read
 * `appConfig/dailyRewards` at all, so an admin who raised day 5 to 400 diamonds
 * in the CRM changed what the server paid and nothing about what the app
 * promised.
 *
 * Kept identical to the server's own inline fallback (functions/src/wallet.ts,
 * in `claimDailyReward`) and to `DEFAULT_DAILY_REWARDS` in
 * zipper-crm/lib/appConfig.ts. If the three drift, an offline user is shown a
 * number nobody is going to pay them.
 */
val DAILY_REWARDS_OFFLINE_FALLBACK = listOf(
    DailyReward(1, diamonds = 50L),
    DailyReward(2, diamonds = 75L),
    DailyReward(3, diamonds = 100L, freeCallMinutes = 1),
    DailyReward(4, diamonds = 100L),
    DailyReward(5, diamonds = 150L, freeCallMinutes = 1),
    DailyReward(6, diamonds = 150L),
    DailyReward(7, diamonds = 200L, freeCallMinutes = 2),
)

package com.zipper.app.util

/**
 * Format a long number in Indian short format.
 * 999 -> "999"
 * 1_200 -> "1.2K"
 * 1_00_000 -> "1L"
 * 1_50_000 -> "1.5L"
 * 1_00_00_000 -> "1Cr"
 */
fun Long.toIndianShort(): String = when {
    this >= 1_00_00_000L -> String.format("%.1fCr", this / 1_00_00_000.0).removeSuffix(".0Cr") + "Cr"
    this >= 1_00_000L    -> String.format("%.1fL", this / 1_00_000.0).removeSuffix(".0L") + "L"
    this >= 1_000L       -> String.format("%.1fK", this / 1_000.0).removeSuffix(".0K") + "K"
    else                 -> this.toString()
}

fun Int.toIndianShort(): String = this.toLong().toIndianShort()

/**
 * Calculate diamonds to show caller per minute.
 * callerGender and hostGender: "male" or "female"
 */
fun calculateCallDiamondsPerMin(
    callRateBeans: Int,
    callerGender: String,
    hostGender: String,
): Int {
    val lCaller = callerGender.lowercase()
    val lHost   = hostGender.lowercase()
    return when {
        lCaller == "male"   && lHost == "female" -> (callRateBeans * 4)
        lCaller == "female" && lHost == "male"   -> (callRateBeans * 5)
        else                                      -> (callRateBeans * 6.67).toInt()
    }
}

/**
 * Calculate beans earned by host per minute of call.
 * Returns Pair(hostBeans, companyBeans).
 */
fun calculateCallBeansSplit(
    callRateBeans: Int,
    callerGender: String,
    hostGender: String,
): Pair<Int, Int> {
    val lCaller = callerGender.lowercase()
    val lHost   = hostGender.lowercase()
    return when {
        lCaller == "male"   && lHost == "female" ->
            Pair(callRateBeans, callRateBeans)
        lCaller == "female" && lHost == "male"   ->
            Pair(callRateBeans, (callRateBeans * 1.5).toInt())
        else ->
            Pair(callRateBeans, (callRateBeans * 2.33).toInt())
    }
}

const val MIN_CALL_RATE_BEANS       = 375     // Minimum host call rate (beans/min)
const val MIN_CALL_BALANCE_DIAMONDS = 1500    // Minimum diamonds to start a call
const val DIAMOND_TO_BEAN_RATE      = 0.5    // 1 diamond gifted = 0.5 beans to host
const val AGENCY_CUT_PERCENT        = 5       // 5% of host earnings go to agency
const val PAYOUT_THRESHOLD_BEANS    = 100_000 // 1L beans needed before payout
const val BEANS_PER_RUPEE_PAYOUT    = 100     // 100 beans = Rs.1 (i.e. 1L beans = Rs.1000)

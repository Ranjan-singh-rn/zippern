package com.zipper.app.data.repository

import javax.inject.Inject
import javax.inject.Singleton

/**
 * Beans → diamonds.
 *
 * The conversion itself is `convertBeans` in Cloud Functions. This class used
 * to do it in a client batch, with the rate hardcoded at 20 and a read-then-
 * write that two taps could interleave. It also decremented `beans` without
 * touching `beansAvailable`, so a host could convert their earnings to diamonds
 * and still withdraw the same beans in rupees.
 *
 * The rate now comes from the CRM's `beanToDiamondRate`, which is the point of
 * having it in the CRM.
 */
@Singleton
class BeanConversionRepository @Inject constructor(
    private val money: MoneyFunctions,
) {

    sealed interface ConvertResult {
        data class Ok(val diamondsGained: Long, val beansSpent: Long) : ConvertResult
        data class Failed(val message: String) : ConvertResult
    }

    /**
     * @param beansAmount whole beans to convert. The server rejects anything
     *        that is not a multiple of the configured rate and says so. The rate
     *        it takes the modulus against is `Math.trunc(beanToDiamondRate)`, and
     *        the client truncates the same double the same way — so a caller
     *        validating against `EconomyConfig.beanToDiamondRate.toLong()` is
     *        checking the same number the server will. Anything that offers an
     *        amount to a user should enforce that multiple before the call, or
     *        the only feedback is a refusal after the tap.
     * @param idempotencyKey one key per tap, reused across retries of that tap.
     */
    suspend fun convertBeans(
        beansAmount: Long,
        idempotencyKey: String = money.newIdempotencyKey(),
    ): ConvertResult = when (val res = money.convertBeans(beansAmount, idempotencyKey)) {
        is MoneyFunctions.Result.Ok ->
            ConvertResult.Ok(res.value.diamondsGained, res.value.beansSpent)
        is MoneyFunctions.Result.Failed ->
            ConvertResult.Failed(res.userMessage)
    }
}

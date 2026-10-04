package com.zipper.app.util

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.URL
import java.text.NumberFormat
import java.util.Currency
import java.util.Locale

/**
 * CurrencyConverter — shows the equivalent local-currency price alongside ₹ and $.
 *
 * Logic:
 *   - INR or USD device → returns null (₹ and $ are already shown on the card)
 *   - Any other device  → returns priceUsd converted to local currency at live rate
 *                         e.g.  "£22"  /  "€25"  /  "AED 103"
 *
 * Exchange rates: https://open.er-api.com/v6/latest/USD  (free, no API key)
 * Rates are cached in SharedPreferences for 24 hours.
 */
object CurrencyConverter {

    private const val PREFS_NAME     = "currency_cache"
    private const val KEY_RATES_JSON = "rates_json"
    private const val KEY_CACHED_AT  = "cached_at_ms"
    private const val CACHE_TTL_MS   = 24 * 60 * 60 * 1000L   // 24 hours
    private const val RATES_API      = "https://open.er-api.com/v6/latest/USD"

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    // ── Public API ─────────────────────────────────────────────────────────────

    /**
     * Returns the local-currency equivalent of [priceUsd], or null if the
     * device is already on INR or USD (no extra line needed in that case).
     *
     * e.g. UK user with $28 package → "£22"
     *
     * Call from a coroutine (suspends only on first fetch or after 24 h).
     */
    suspend fun localEquivalent(ctx: Context, priceUsd: Int): String? {
        val currency = deviceCurrency()
        if (currency.currencyCode == "INR" || currency.currencyCode == "USD") return null

        val rate   = rateForCurrency(ctx, currency.currencyCode) ?: return null
        val amount = priceUsd * rate
        return NumberFormat.getCurrencyInstance(Locale.getDefault()).format(amount)
    }

    /**
     * Pre-warm: fetch rates in background so the first screen load is instant.
     * Call once after login.
     */
    suspend fun prefetch(ctx: Context) {
        fetchRates(ctx)
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    private fun deviceCurrency(): Currency =
        try { Currency.getInstance(Locale.getDefault()) }
        catch (_: Exception) { Currency.getInstance("USD") }

    private suspend fun rateForCurrency(ctx: Context, code: String): Double? {
        val rates = fetchRates(ctx) ?: return null
        return rates.optDouble(code).takeIf { !it.isNaN() }
    }

    /** Returns cached or freshly-fetched rates JSON object (USD base). */
    private suspend fun fetchRates(ctx: Context): JSONObject? {
        val p      = prefs(ctx)
        val cached = p.getString(KEY_RATES_JSON, null)
        val age    = System.currentTimeMillis() - p.getLong(KEY_CACHED_AT, 0L)

        if (cached != null && age < CACHE_TTL_MS) {
            return try { JSONObject(cached).getJSONObject("rates") } catch (_: Exception) { null }
        }

        return withContext(Dispatchers.IO) {
            try {
                val json = URL(RATES_API).openConnection().apply {
                    connectTimeout = 8_000
                    readTimeout    = 8_000
                }.getInputStream().bufferedReader().readText()

                p.edit()
                    .putString(KEY_RATES_JSON, json)
                    .putLong(KEY_CACHED_AT, System.currentTimeMillis())
                    .apply()

                JSONObject(json).getJSONObject("rates")
            } catch (_: Exception) {
                // Return stale cache rather than nothing
                cached?.let { try { JSONObject(it).getJSONObject("rates") } catch (_: Exception) { null } }
            }
        }
    }
}

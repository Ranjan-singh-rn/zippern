package com.zipper.app.data.repository

import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.app.util.EconomyEngine
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Reads the economy configuration the CRM writes to `appConfig/economy`.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * The CRM exposes 36 economy settings. Before this repository the app read
 * exactly one of them (`minHostLevel`); every price, rate and threshold was a
 * `const` compiled into the APK. That meant:
 *
 *   • changing a diamond price needed a Play release and a review wait,
 *   • the CRM showed owners and the observer numbers the app was not using,
 *   • `sellerWholesalePriceInr` existed, was editable, and was ignored — so
 *     coin sellers bought at the same price users pay and earned nothing.
 *
 * Every value here is read from Firestore with the shipped constant as its
 * fallback, so behaviour is unchanged when the document is missing and
 * correctable the moment it is present.
 *
 * ── Field names ──────────────────────────────────────────────────────────────
 *
 * These mirror `zipper-crm/lib/economyConfig.ts` exactly. If a name drifts on
 * either side the value silently falls back to the constant and nobody notices
 * until the numbers are wrong, so treat that file as the schema of record.
 *
 * ── Reading it ───────────────────────────────────────────────────────────────
 *
 * Cached for [CACHE_TTL_MS]; economy values are read on every gift send, call
 * tick and balance render, and an uncached Firestore read on each of those is
 * both slow and billable. Call [invalidate] after a config change if the app
 * ever needs to react without waiting for the TTL.
 */
@Singleton
class EconomyConfigRepository @Inject constructor(
    private val firestore: FirebaseFirestore,
    private val auth: FirebaseAuth,
) {

    data class GiftRates(
        /** % of a normal gift's diamond cost the receiver earns as beans. */
        val normalReceiverPct: Int,
        val exclusiveReceiverPctMin: Int,
        val exclusiveReceiverPctMax: Int,
        val luckyReceiverPct: Int,
        /** Lucky-gift return multipliers, as multiples of the gift cost. */
        val luckyReturnMin: Int,
        val luckyReturnMax: Int,
        /** 1 bean = this many rupees. */
        val beanToInrRate: Double,
    )

    /**
     * Percentage of the caller's payment that reaches the receiver.
     *
     * The host's income is fixed; the CALLER's price is derived from it as
     * `hostIncome / pct`. So these change what a caller pays, not what a host
     * earns — every host earns the same beans per minute regardless of gender.
     *
     * Not yet present in the CRM. Defaults mirror the values currently
     * hardcoded in [EconomyEngine], so adding the fields to `appConfig/economy`
     * is all that is needed to make them editable.
     */
    /**
     * The earner's share of a call, by PAYER gender and EARNER gender.
     *
     * Read on the two genders and nothing else. Who dialled and who is a host
     * decide WHO PAYS, not the percentage — see [payerIsCaller] and [earnerPct].
     *
     *                 earner
     *   payer     male  female  trans
     *   male       30%    50%    40%
     *   female     40%    30%    40%
     *   trans      40%    40%    40%
     *
     * Mirrors `SPLIT_DEFAULTS` in functions/src/calls.ts and
     * `DEFAULT_CALL_SPLIT_MATRIX` in the CRM. This exists so the price on the
     * call button matches the price on the bill; the server remains the
     * authority and its answer is what is charged.
     */
    data class CallSplitMatrix(
        val rows: Map<String, Map<String, Int>>,
    ) {
        /** One cell, defaulted and bounds-checked exactly as the server does. */
        fun pct(payer: String, earner: String): Int {
            val p = normalise(payer)
            val e = normalise(earner)
            val v = rows[p]?.get(e)
            if (v != null && v in 1..100) return v
            return DEFAULTS[p]?.get(e) ?: 40
        }

        companion object {
            /**
             * An unrecorded gender is read as transgender — the middle row and
             * column. It never overpays, never badly underpays, and never
             * refuses to price a call.
             */
            fun normalise(g: String): String = when (g.trim().lowercase()) {
                "male" -> "male"
                "female" -> "female"
                else -> "transgender"
            }

            val DEFAULTS: Map<String, Map<String, Int>> = mapOf(
                "male"        to mapOf("male" to 30, "female" to 50, "transgender" to 40),
                "female"      to mapOf("male" to 40, "female" to 30, "transgender" to 40),
                "transgender" to mapOf("male" to 40, "female" to 40, "transgender" to 40),
            )

            val FALLBACK = CallSplitMatrix(DEFAULTS)
        }
    }

    data class EconomyConfig(
        // ── Diamond pricing, per 1,00,000 diamonds ────────────────────────────
        val diamondPackPriceInr: Int,
        val diamondPackPriceUsd: Int,
        /**
         * What a coin seller pays per lakh. Falls back to retail when unset,
         * zero, or above retail — charging a seller more than their own
         * customers pay is a typo, never a price. Matches the CRM's own
         * guard in `lib/rates.ts`.
         */
        val sellerWholesalePriceInr: Int,

        // ── Currency conversion ───────────────────────────────────────────────
        /** How many beans equal 1 diamond, converting beans back to diamonds. */
        val beanToDiamondRate: Double,

        // ── Host payouts ──────────────────────────────────────────────────────
        val weeklyMinPayoutInr: Int,
        /**
         * The "one lakh beans in a week" rule.
         *
         * **Null means the rule is not configured, and null is the default.**
         * The CRM deliberately never invents a number here, and neither does
         * this. Writing a plausible 100000 would apply a threshold nobody chose.
         */
        val weeklyMinPayoutBeans: Long?,

        // ── Call rates ────────────────────────────────────────────────────────
        /** Default host income in beans/min, set by the agency at registration. */
        val callRateBeansPerMin: Long,
        /** Flat diamonds/min for a user↔user call (no host on either side). Mirrors calls.ts. */
        val userCallRatePerMin: Long,
        /** Bounds on the host income an agency or host may set. */
        val minHostCallRate: Long,
        val maxHostCallRate: Long,

        val giftRates: GiftRates,
        val callSplitMatrix: CallSplitMatrix,

        val usdToInrRate: Double,

        /**
         * True when `appConfig/economy` could not be read and every value above
         * is a compiled-in fallback.
         *
         * Surface this. A screen that shows fallback numbers as though they were
         * live is the same failure the CRM already hit, where a permission error
         * rendered identically to a real zero.
         */
        val isFallback: Boolean,
        val updatedBy: String? = null,
    ) {
        /** Rupees per diamond at retail. */
        val inrPerDiamond: Double get() = diamondPackPriceInr / 100_000.0

        /** What Zipper actually collects per diamond from a coin seller. */
        val wholesaleInrPerDiamond: Double get() = sellerWholesalePriceInr / 100_000.0

        /** The seller's margin per lakh. Zero means the seller works for free. */
        val sellerMarginInrPerLakh: Int get() = diamondPackPriceInr - sellerWholesalePriceInr

        /**
         * Does the CALLER pay?
         *
         * The user always pays. One host and one user → the user pays whichever
         * of them dialled. Two users or two hosts → the caller pays.
         */
        fun payerIsCaller(callerIsHost: Boolean, receiverIsHost: Boolean): Boolean =
            if (callerIsHost != receiverIsHost) !callerIsHost else true

        /** The earner's share for a pairing, as a percentage. */
        fun earnerPct(payerGender: String, earnerGender: String): Int =
            callSplitMatrix.pct(payerGender, earnerGender)

        /**
         * Diamonds per minute the PAYER pays, derived from the earner's fixed
         * bean income. Ceiling division — never round in the payer's favour, or
         * the earner is short-paid by a diamond a minute.
         *
         * Mirrors `rateFor` in functions/src/calls.ts. The server is still the
         * authority: this only exists so the figure on the call button is the
         * figure on the bill.
         */
        fun payerDiamondsPerMin(
            earnerIncomeBeans: Long,
            payerGender: String,
            earnerGender: String,
        ): Long {
            val pct = earnerPct(payerGender, earnerGender).coerceAtLeast(1)
            return (earnerIncomeBeans * 100L + pct - 1L) / pct
        }

        /**
         * Rupee value of a bean balance.
         *
         * Deliberately does NOT return 0 below the payout threshold. The shipped
         * [EconomyEngine.beansToRupees] does, which is why a host sitting on
         * 99,999 beans is shown ₹0 and concludes the app has eaten their week.
         * Whether they may withdraw yet is a separate question — ask
         * [meetsPayoutThreshold].
         */
        fun beansToRupees(beans: Long): Double = beans * giftRates.beanToInrRate

        fun meetsPayoutThreshold(beans: Long): Boolean {
            val byRupees = beansToRupees(beans) >= weeklyMinPayoutInr
            val byBeans = weeklyMinPayoutBeans?.let { beans >= it } ?: true
            return byRupees && byBeans
        }
    }

    // ── Fallbacks: exactly what the APK ships today ───────────────────────────

    private fun fallback(): EconomyConfig = EconomyConfig(
        diamondPackPriceInr     = EconomyEngine.WHOLESALE_PRICE_PER_LAKH_INR,
        diamondPackPriceUsd     = 28,
        sellerWholesalePriceInr = EconomyEngine.WHOLESALE_PRICE_PER_LAKH_INR,
        // 20 beans = 1 diamond. Deliberate friction: without it,
        // gift -> convert -> re-gift mints diamonds nobody paid for.
        // Matches the CRM's own fallback in zipper-crm/lib/rates.ts.
        beanToDiamondRate       = 20.0,
        weeklyMinPayoutInr      = (EconomyEngine.MIN_WITHDRAWAL_BEANS / EconomyEngine.BEANS_PER_RUPEE).toInt(),
        weeklyMinPayoutBeans    = null,      // never invented — see the field doc
        callRateBeansPerMin     = 375L,
        userCallRatePerMin      = 1600L,
        minHostCallRate         = 100L,
        maxHostCallRate         = 12_000L,
        giftRates = GiftRates(
            normalReceiverPct       = 50,
            exclusiveReceiverPctMin = 50,
            exclusiveReceiverPctMax = 55,
            luckyReceiverPct        = 50,
            luckyReturnMin          = 0,
            luckyReturnMax          = 20,
            beanToInrRate           = 1.0 / EconomyEngine.BEANS_PER_RUPEE,
        ),
        callSplitMatrix = CallSplitMatrix.FALLBACK,
        usdToInrRate = 83.0,
        isFallback   = true,
    )

    // ── Cache ─────────────────────────────────────────────────────────────────

    private val mutex = Mutex()
    private var cached: EconomyConfig? = null
    private var fetchedAtMs: Long = 0L

    /** Returns the live config, or the shipped fallback if Firestore is unreachable. */
    suspend fun get(): EconomyConfig {
        mutex.withLock {
            val now = System.currentTimeMillis()
            val hit = cached
            if (hit != null && now - fetchedAtMs < CACHE_TTL_MS) return hit
            val fresh = fetch()
            // Only start the clock on a real read. Caching a fallback for five
            // minutes would keep serving stale constants through a brief outage
            // that has already ended.
            if (!fresh.isFallback) {
                cached = fresh
                fetchedAtMs = now
            }
            return fresh
        }
    }

    /** Drop the cache so the next [get] re-reads Firestore. */
    suspend fun invalidate() {
        mutex.withLock {
            cached = null
            fetchedAtMs = 0L
        }
    }

    /**
     * The config as a live stream — emits again whenever the CRM saves.
     *
     * [get] is a point-in-time read, so a screen opened before a price change
     * keeps showing the old number until it is reopened. For anything a user
     * acts on with money — a seller about to transfer rupees against a quoted
     * price — that is not good enough. This attaches a Firestore snapshot
     * listener, so changing a value in the CRM updates every open screen within
     * a second or so.
     *
     * The listener is detached when the collector stops, so it costs nothing
     * while no price is on screen.
     */
    /*
     * Only while somebody is signed in. `appConfig/economy` is readable by
     * signed-in users only, and MainActivity's activity-scoped ProfileViewModel
     * starts collecting this before anyone has signed in: the listener was
     * refused (PERMISSION_DENIED in every cold start's log) and a Firestore
     * listener that has failed never fires again, so that collector sat on the
     * fallback values for the rest of the process. The listener is now attached
     * when a user is signed in, and re-attached after every sign-in.
     */
    @OptIn(ExperimentalCoroutinesApi::class)
    fun observe(): Flow<EconomyConfig> = signedIn().flatMapLatest { signedIn ->
        if (signedIn) snapshots() else flowOf(cached ?: fallback())
    }.distinctUntilChanged()

    private fun signedIn(): Flow<Boolean> = callbackFlow {
        // An AuthStateListener is called once on registration with the current state.
        val listener = FirebaseAuth.AuthStateListener { trySend(it.currentUser != null) }
        auth.addAuthStateListener(listener)
        awaitClose { auth.removeAuthStateListener(listener) }
    }.distinctUntilChanged()

    private fun snapshots(): Flow<EconomyConfig> = callbackFlow {
        // Emit immediately from cache or fallback so the UI never renders empty
        // while the first snapshot is in flight.
        trySend(cached ?: fallback())

        val reg = firestore.collection("appConfig").document("economy")
            .addSnapshotListener { snap, err ->
                if (err != null || snap == null || !snap.exists()) {
                    trySend(fallback())
                    return@addSnapshotListener
                }
                val parsed = parse(snap)
                cached = parsed
                fetchedAtMs = System.currentTimeMillis()
                trySend(parsed)
            }
        awaitClose { reg.remove() }
    }

    private suspend fun fetch(): EconomyConfig = try {
        val doc = firestore.collection("appConfig").document("economy").get().await()
        if (doc.exists()) parse(doc) else fallback()
    } catch (_: Exception) {
        fallback()
    }

    /** One parser, shared by the one-shot read and the snapshot listener. */
    private fun parse(doc: DocumentSnapshot): EconomyConfig {
        val fb = fallback()
        return try {

            @Suppress("UNCHECKED_CAST")
            val gift = doc.get("giftRates") as? Map<String, Any?> ?: emptyMap()
            @Suppress("UNCHECKED_CAST")
            val comm = doc.get("commissionConfig") as? Map<String, Any?> ?: emptyMap()

            /*
             * The 3×3 split table, read cell by cell.
             *
             * Merged against the defaults per CELL rather than per document: a
             * config carrying four of the nine is a live config with nine
             * values, because the server fills a missing cell from its own
             * table. Reading it any other way would put a different price on
             * the button from the one on the bill.
             */
            @Suppress("UNCHECKED_CAST")
            val matrixRaw = doc.get("callSplitMatrix") as? Map<String, Any?> ?: emptyMap()
            val matrix = CallSplitMatrix(
                CallSplitMatrix.DEFAULTS.mapValues { (payer, defaults) ->
                    // Same unchecked cast as the one above, and safe for the
                    // same reason: `as?` yields null on anything that is not a
                    // map, and the row is then read cell by cell with a typed
                    // fallback — a malformed row prices from the defaults
                    // rather than throwing.
                    @Suppress("UNCHECKED_CAST")
                    val row = matrixRaw[payer] as? Map<String, Any?> ?: emptyMap()
                    defaults.mapValues { (earner, fallbackPct) ->
                        val v = (row[earner] as? Number)?.toInt()
                        if (v != null && v in 1..100) v else fallbackPct
                    }
                }
            )

            val retail = doc.getLong("diamondPackPriceInr")?.toInt() ?: fb.diamondPackPriceInr

            // Unset, zero, or above retail all mean "no discount". Mirrors the
            // CRM's guard so both sides agree on what a bad value means.
            val rawWholesale = doc.getLong("sellerWholesalePriceInr")?.toInt() ?: 0
            val wholesale = if (rawWholesale in 1..retail) rawWholesale else retail

            EconomyConfig(
                diamondPackPriceInr     = retail,
                diamondPackPriceUsd     = doc.getLong("diamondPackPriceUsd")?.toInt() ?: fb.diamondPackPriceUsd,
                sellerWholesalePriceInr = wholesale,
                beanToDiamondRate       = doc.getDouble("beanToDiamondRate") ?: fb.beanToDiamondRate,
                weeklyMinPayoutInr      = doc.getLong("weeklyMinPayoutInr")?.toInt() ?: fb.weeklyMinPayoutInr,
                // Absent stays absent. A missing key is "no rule", not "zero".
                weeklyMinPayoutBeans    = doc.getLong("weeklyMinPayoutBeans"),
                callRateBeansPerMin     = doc.getLong("callRateBeansPerMin") ?: fb.callRateBeansPerMin,
                userCallRatePerMin      = doc.getLong("userCallRatePerMin") ?: fb.userCallRatePerMin,
                minHostCallRate         = doc.getLong("minHostCallRate") ?: fb.minHostCallRate,
                maxHostCallRate         = doc.getLong("maxHostCallRate") ?: fb.maxHostCallRate,
                giftRates = GiftRates(
                    normalReceiverPct       = num(gift["normalReceiverPct"], fb.giftRates.normalReceiverPct),
                    exclusiveReceiverPctMin = num(gift["exclusiveReceiverPctMin"], fb.giftRates.exclusiveReceiverPctMin),
                    exclusiveReceiverPctMax = num(gift["exclusiveReceiverPctMax"], fb.giftRates.exclusiveReceiverPctMax),
                    luckyReceiverPct        = num(gift["luckyReceiverPct"], fb.giftRates.luckyReceiverPct),
                    luckyReturnMin          = num(gift["luckyReturnMin"], fb.giftRates.luckyReturnMin),
                    luckyReturnMax          = num(gift["luckyReturnMax"], fb.giftRates.luckyReturnMax),
                    beanToInrRate           = dbl(gift["beanToInrRate"], fb.giftRates.beanToInrRate),
                ),
                callSplitMatrix = matrix,
                usdToInrRate = dbl(comm["usdToInrRate"], fb.usdToInrRate),
                isFallback   = false,
                updatedBy    = doc.getString("updatedBy"),
            )
        } catch (_: Exception) {
            fb
        }
    }

    // Firestore hands back Long, Double or Int depending on how the value was
    // written. The CRM writes from TypeScript, so a whole number arrives as a
    // Long and a fractional one as a Double — read both rather than assuming.
    private fun num(v: Any?, fallback: Int): Int = when (v) {
        is Number -> v.toInt()
        is String -> v.toIntOrNull() ?: fallback
        else -> fallback
    }

    private fun dbl(v: Any?, fallback: Double): Double = when (v) {
        is Number -> v.toDouble()
        is String -> v.toDoubleOrNull() ?: fallback
        else -> fallback
    }

    companion object {
        /** Five minutes. Long enough to matter, short enough that a price fix lands the same session. */
        const val CACHE_TTL_MS = 5 * 60 * 1000L
    }
}

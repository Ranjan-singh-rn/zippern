package com.zipper.app.data.repository

import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.app.data.model.DAILY_REWARDS_OFFLINE_FALLBACK
import com.zipper.app.data.model.DailyReward
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Reads the daily check-in schedule the CRM writes to `appConfig/dailyRewards`.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `claimDailyReward` has read this document since the CRM gained the editor
 * (zipper-crm/app/app-config/daily-rewards). The app did not: it drew the strip,
 * the reward card and the confirmation toast from `DAILY_REWARDS_OFFLINE_FALLBACK`,
 * a list compiled into the APK. So an admin who changed day 5 from 150 diamonds
 * to 400 changed what the server credited and nothing about what the screen
 * promised, and the user was told the smaller number while the larger one landed
 * in their balance — or, worse, the other way round.
 *
 * It also fixed the length of the run at seven. The server wraps the streak on
 * `sched.length`, so a five-day or ten-day schedule is a perfectly valid thing
 * for an admin to save; the app treated 7 as a law of nature and broke in both
 * directions.
 *
 * ── Field names ──────────────────────────────────────────────────────────────
 *
 * `zipper-crm/lib/appConfig.ts` is the schema of record: `{ schedule: [{ day,
 * diamonds, callCards }] }`. `callCards` is the CRM's name for what this app
 * calls `freeCallMinutes`, and [parse] is the only place the two are bridged —
 * the same bridge the server makes with `reward.callCards ?? reward.freeCallMinutes`.
 *
 * ── Reading it ───────────────────────────────────────────────────────────────
 *
 * A snapshot listener and no cache, unlike [EconomyConfigRepository]: this is
 * read by one screen, which holds the listener only while it is open, and a
 * schedule the admin has just saved should be on screen before the user taps
 * Claim. Nothing else in the app has an opinion about daily rewards.
 */
@Singleton
class DailyRewardsConfigRepository @Inject constructor(
    private val firestore: FirebaseFirestore,
) {

    data class DailyRewardsConfig(
        val schedule: List<DailyReward>,
        /**
         * True when `appConfig/dailyRewards` could not be read, or could not be
         * read *whole*, and [schedule] is the compiled-in list.
         *
         * Surface it. Fallback amounts rendered as though they were live are the
         * failure this repository exists to end, and a screen that quietly
         * quotes 200 diamonds for day 7 when the CRM says 500 is no better than
         * the hardcoded table it replaced.
         */
        val isFallback: Boolean,
        val updatedBy: String? = null,
    )

    /**
     * The schedule as a live stream — emits again whenever the CRM saves.
     *
     * Deliberately emits nothing until Firestore answers, unlike
     * [EconomyConfigRepository.observe], which primes the stream with its
     * fallback. A primed fallback here would make the screen say "amounts are
     * indicative" for the frame or two before the real schedule lands, which is
     * a warning about nothing. The screen already renders the offline list as
     * its initial state, so there is nothing to fill in the gap.
     *
     * A listener always calls back, even with no network: Firestore serves an
     * empty snapshot from cache, which is read as a fallback below. So a
     * collector waiting on the first emission is not waiting forever.
     */
    fun observe(): Flow<DailyRewardsConfig> = callbackFlow {
        val reg = firestore.collection("appConfig").document("dailyRewards")
            .addSnapshotListener { snap, err ->
                if (err != null || snap == null) {
                    trySend(FALLBACK)
                    return@addSnapshotListener
                }
                if (!snap.exists()) {
                    /*
                     * The SERVER says there is no document: nobody has saved a
                     * schedule in the CRM yet. That is not a failure to read —
                     * `claimDailyReward` then pays its own FALLBACK_SCHEDULE,
                     * which is DAILY_REWARDS_OFFLINE_FALLBACK row for row, so
                     * the compiled-in list IS the live schedule and saying
                     * "amounts are indicative" would be wrong (QA, 3 Nov 2026:
                     * every user of a fresh project saw that warning). Only a
                     * miss answered from the local cache is a real unknown.
                     */
                    trySend(if (snap.metadata.isFromCache) FALLBACK else DEFAULT_SCHEDULE)
                    return@addSnapshotListener
                }
                trySend(parse(snap))
            }
        awaitClose { reg.remove() }
    }.distinctUntilChanged()

    private fun parse(doc: DocumentSnapshot): DailyRewardsConfig {
        return try {
            val rows = doc.get("schedule") as? List<*> ?: return FALLBACK
            if (rows.isEmpty()) return FALLBACK

            val schedule = rows.mapIndexedNotNull { idx, entry ->
                // Unchecked, and safe: `as?` yields null on anything that is not
                // a map, and every value is then read with a typed fallback, so a
                // map with unexpected key or value types reads as a row of
                // missing fields rather than throwing.
                @Suppress("UNCHECKED_CAST")
                val row = entry as? Map<String, Any?> ?: return@mapIndexedNotNull null
                DailyReward(
                    // Position is the day when the row does not say. The CRM
                    // editor always writes `day`, but the server matches on it
                    // and would fall back to day 1 for the whole run if it were
                    // missing, so guessing the obvious thing beats dropping the
                    // row and shortening the strip.
                    day             = int(row["day"]) ?: (idx + 1),
                    diamonds        = long(row["diamonds"]) ?: 0L,
                    freeCallMinutes = int(row["callCards"]) ?: int(row["freeCallMinutes"]) ?: 0,
                )
            }.sortedBy { it.day }

            // One unreadable row means the whole document is unusable, not that
            // the run is a day shorter. The server wraps the streak on the RAW
            // array length, so quietly dropping an entry would put the app one
            // day out of step with the server for every subsequent claim — the
            // strip would highlight day 4 while day 5 was being credited.
            if (schedule.size != rows.size) return FALLBACK

            DailyRewardsConfig(
                schedule   = schedule,
                isFallback = false,
                updatedBy  = doc.getString("updatedBy"),
            )
        } catch (_: Exception) {
            FALLBACK
        }
    }

    // The CRM writes from TypeScript, so a whole number arrives as a Long and a
    // fractional one as a Double. Read whatever turned up rather than assuming.
    private fun int(v: Any?): Int? = when (v) {
        is Number -> v.toInt()
        is String -> v.toIntOrNull()
        else -> null
    }

    private fun long(v: Any?): Long? = when (v) {
        is Number -> v.toLong()
        is String -> v.toLongOrNull()
        else -> null
    }

    private companion object {
        val FALLBACK = DailyRewardsConfig(
            schedule   = DAILY_REWARDS_OFFLINE_FALLBACK,
            isFallback = true,
        )
        /** No schedule saved yet: the server pays exactly this list (wallet.ts FALLBACK_SCHEDULE). */
        val DEFAULT_SCHEDULE = DailyRewardsConfig(
            schedule   = DAILY_REWARDS_OFFLINE_FALLBACK,
            isFallback = false,
        )
    }
}

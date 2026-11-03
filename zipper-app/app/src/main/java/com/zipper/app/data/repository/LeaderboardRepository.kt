package com.zipper.app.data.repository

import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import java.util.Date
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Rankings (B8, 3 Nov 2026) — read-only. Scores are written by the server where money moves
 * (functions/src/leaderboards.ts); the app only reads `leaderboards/{board}_{period}_{key}/entries` and the
 * Owner's reward tiers in `appConfig/leaderboards`.
 */
@Singleton
class LeaderboardRepository @Inject constructor(private val firestore: FirebaseFirestore) {

    data class Entry(val uid: String, val name: String, val photoUrl: String, val score: Long)
    data class Tier(val from: Int, val to: Int, val amount: Long)
    data class Rewards(val tiers: List<Tier>, val currency: String)
    data class Config(val enabled: Boolean, val boards: Map<String, Boolean>, val rewards: Map<String, Rewards>)

    /** Top 50, live. Empty on any error — the screen says "nobody yet" rather than crashing. */
    fun topFlow(board: String, period: String, now: Date = Date()): Flow<List<Entry>> = callbackFlow {
        val id = "${board}_${period}_${LeaderboardKeys.keyFor(period, now)}"
        val reg = firestore.collection("leaderboards").document(id).collection("entries")
            .orderBy("score", Query.Direction.DESCENDING).limit(50)
            .addSnapshotListener { snap, err ->
                trySend(
                    if (err != null || snap == null) emptyList()
                    else snap.documents.map {
                        Entry(it.id, it.getString("name").orEmpty(), it.getString("photoUrl").orEmpty(), it.getLong("score") ?: 0L)
                    }.filter { it.score > 0 },
                )
            }
        awaitClose { reg.remove() }
    }

    fun configFlow(): Flow<Config> = callbackFlow {
        val reg = firestore.collection("appConfig").document("leaderboards").addSnapshotListener { snap, _ ->
            trySend(LeaderboardKeys.configOf(snap?.data))
        }
        awaitClose { reg.remove() }
    }
}

/** The IST period keys the server uses, and the Owner's config read as the server reads it. Pure, for tests. */
object LeaderboardKeys {
    private const val IST_MS = 330L * 60 * 1000

    fun keyFor(period: String, now: Date): String {
        val ist = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC")).apply { timeInMillis = now.time + IST_MS }
        val y = ist.get(java.util.Calendar.YEAR)
        val m = ist.get(java.util.Calendar.MONTH) + 1
        val d = ist.get(java.util.Calendar.DAY_OF_MONTH)
        return when (period) {
            "daily" -> String.format(java.util.Locale.US, "%04d-%02d-%02d", y, m, d)
            "monthly" -> String.format(java.util.Locale.US, "%04d-%02d", y, m)
            else -> {
                // ISO week of the IST calendar date: the week-year is the year of that week's Thursday.
                val date = java.time.LocalDate.of(y, m, d)
                val wf = java.time.temporal.WeekFields.ISO
                String.format(java.util.Locale.US, "%04d-W%02d", date.get(wf.weekBasedYear()), date.get(wf.weekOfWeekBasedYear()))
            }
        }
    }

    fun configOf(raw: Map<String, Any?>?): LeaderboardRepository.Config {
        val boards = (raw?.get("boards") as? Map<*, *>).orEmpty()
        val enabledBoards = mutableMapOf<String, Boolean>()
        val rewards = mutableMapOf<String, LeaderboardRepository.Rewards>()
        for (b in listOf("hosts", "supporters", "lucky")) {
            val g = boards[b] as? Map<*, *>
            enabledBoards[b] = if (b == "lucky") g?.get("enabled") == true else g?.get("enabled") != false
            for (p in listOf("daily", "weekly", "monthly")) {
                val r = g?.get(p) as? Map<*, *>
                val tiers = (r?.get("tiers") as? List<*>).orEmpty().mapNotNull { t ->
                    val m = t as? Map<*, *> ?: return@mapNotNull null
                    val from = (m["from"] as? Number)?.toInt() ?: return@mapNotNull null
                    LeaderboardRepository.Tier(from, (m["to"] as? Number)?.toInt() ?: from, (m["amount"] as? Number)?.toLong() ?: 0L)
                }.filter { it.from in 1..50 && it.to in it.from..50 && it.amount > 0 }
                val currency = if (b == "hosts" && r?.get("currency") == "beans") "beans" else "diamonds"
                rewards["${b}_$p"] = LeaderboardRepository.Rewards(tiers, currency)
            }
        }
        return LeaderboardRepository.Config(raw?.get("enabled") != false, enabledBoards, rewards)
    }
}

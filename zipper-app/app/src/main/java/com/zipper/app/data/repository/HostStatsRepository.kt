package com.zipper.app.data.repository

import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await
import javax.inject.Inject
import javax.inject.Singleton

/**
 * What a host is shown about their own earning.
 *
 * Host Home needs today's figures, the week's, the level and its next rung, and
 * the payout position. `getHostHome` returns all of it in one call rather than
 * five parallel reads rendered in four loading states.
 */
@Singleton
class HostStatsRepository @Inject constructor(
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
    private val money: MoneyFunctions,
) {

    data class Today(
        val dayKey: String = "",
        val beans: Long = 0L,
        val giftBeans: Long = 0L,
        val callBeans: Long = 0L,
        val callSeconds: Long = 0L,
        val calls: Int = 0,
        val giftsReceived: Int = 0,
    )

    data class Week(
        val weekKey: String = "",
        val beans: Long = 0L,
        val giftBeans: Long = 0L,
        val callBeans: Long = 0L,
    )

    data class Level(
        val level: Int = 0,
        /**
         * The ceiling this host may set, in beans/min. Zero means they may not
         * set one at all — which is what an unverified host gets, because
         * `startCall` prices them at the base rate regardless of level.
         */
        val maxCallRateBeans: Long = 0L,
        val callRateBeans: Long = 0L,
        val nextLevel: Int? = null,
        val beansToNextLevel: Long = 0L,
        val nextLevelAt: Long? = null,
    )

    data class Payout(
        val beans: Long = 0L,
        val beansAvailable: Long = 0L,
        val isVerifiedHost: Boolean = false,
        val payoutHold: Boolean = false,
    ) {
        /** Earned but not yet released. Shown with its release date, never alone. */
        val beansPending: Long get() = (beans - beansAvailable).coerceAtLeast(0L)
    }

    data class HostHome(
        val today: Today = Today(),
        val week: Week = Week(),
        val lifetimeBeans: Long = 0L,
        val lifetimeCallBeans: Long = 0L,
        val lifetimeGiftBeans: Long = 0L,
        val level: Level = Level(),
        val payout: Payout = Payout(),
    )

    sealed interface Result {
        data class Ok(val home: HostHome) : Result
        data class Failed(val message: String) : Result
    }

    suspend fun hostHome(): Result = when (val res = money.getHostHome()) {
        is MoneyFunctions.Result.Ok -> Result.Ok(res.value)
        is MoneyFunctions.Result.Failed -> Result.Failed(res.userMessage)
    }

    /**
     * Weekly statements, newest first.
     *
     * Both released and held weeks. A held week appears with its reason —
     * "complete identity verification" — because a week that simply does not
     * appear reads as lost earnings, and one that appears as held reads as an
     * instruction.
     */
    data class Statement(
        val weekKey: String = "",
        val status: String = "",
        val heldReason: String = "",
        val beans: Long = 0L,
        val giftBeans: Long = 0L,
        val callBeans: Long = 0L,
        /**
         * Beans earned in this week that the host converted to diamonds. Not
         * payable — and the single most common reason a week looks short, which
         * is why the statement names it rather than leaving a gap.
         */
        val convertedBeans: Long = 0L,
        val amountInr: Double = 0.0,
    ) {
        val isHeld: Boolean get() = status == "held"
    }

    fun statementsFlow(limit: Long = 26): Flow<List<Statement>> = callbackFlow {
        val uid = auth.currentUser?.uid
        if (uid == null) { trySend(emptyList()); awaitClose { }; return@callbackFlow }

        val reg = firestore.collection("users").document(uid)
            .collection("weeklyStatements")
            // Week keys sort lexicographically — `2026-W37` after `2026-W09`.
            .orderBy("weekKey", Query.Direction.DESCENDING)
            .limit(limit)
            .addSnapshotListener { snap, _ ->
                val rows = snap?.documents.orEmpty().map { doc ->
                    Statement(
                        weekKey        = doc.getString("weekKey") ?: doc.id,
                        status         = doc.getString("status") ?: "",
                        heldReason     = doc.getString("heldReason") ?: "",
                        beans          = doc.getLong("beansReleased")
                            ?: doc.getLong("beansPending") ?: 0L,
                        giftBeans      = doc.getLong("giftBeans") ?: 0L,
                        callBeans      = doc.getLong("callBeans") ?: 0L,
                        convertedBeans = doc.getLong("convertedBeans") ?: 0L,
                        amountInr      = doc.getDouble("amountInr") ?: 0.0,
                    )
                }
                trySend(rows)
            }
        awaitClose { reg.remove() }
    }

    /**
     * The last [days] days of daily figures, for the earnings chart.
     *
     * Reads the day documents directly. There is no rollup to wait on and no
     * reset to have failed — a day that had no activity simply has no document,
     * and the caller fills the gap with zero.
     */
    suspend fun recentDays(days: Int = 14): Map<String, Today> = try {
        val uid = auth.currentUser?.uid
        if (uid == null) emptyMap()
        else firestore.collection("users").document(uid)
            .collection("dailyStats")
            .orderBy("dayKey", Query.Direction.DESCENDING)
            .limit(days.toLong())
            .get().await()
            .documents.associate { doc ->
                val key = doc.getString("dayKey") ?: doc.id
                key to Today(
                    dayKey        = key,
                    beans         = doc.getLong("beans") ?: 0L,
                    giftBeans     = doc.getLong("giftBeans") ?: 0L,
                    callBeans     = doc.getLong("callBeans") ?: 0L,
                    callSeconds   = doc.getLong("callSeconds") ?: 0L,
                    calls         = (doc.getLong("calls") ?: 0L).toInt(),
                    giftsReceived = (doc.getLong("giftsReceived") ?: 0L).toInt(),
                )
            }
    } catch (_: Exception) { emptyMap() }
}

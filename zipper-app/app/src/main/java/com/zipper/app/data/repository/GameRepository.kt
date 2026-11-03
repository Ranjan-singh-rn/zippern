package com.zipper.app.data.repository

import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.zipper.app.data.model.GameMatch
import com.zipper.app.data.model.GameResult
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Games — what the app WATCHES (B4/B5, 3 Nov 2026). Everything here is a read; the moves go through [GameFunctions].
 *
 * Every listener sends a value on error rather than closing the flow with it: a refused or broken listener must
 * leave the screen in a clear "could not load" state, never take the app down (the A3 lesson).
 */
@Singleton
class GameRepository @Inject constructor(
    private val firestore: FirebaseFirestore,
    private val auth: FirebaseAuth,
) {
    fun myUid(): String = auth.currentUser?.uid.orEmpty()

    /**
     * Whether the Games tab exists at all: the master switch in `appConfig/games` and at least one game switched on.
     * A game the owner has not switched on is invisible, not greyed out.
     */
    fun gamesVisibleFlow(): Flow<Boolean> = callbackFlow {
        val reg = firestore.collection("appConfig").document("games").addSnapshotListener { snap, _ ->
            val on = snap?.getBoolean("enabled") == true &&
                ((snap.get("games") as? Map<*, *>).orEmpty().values.any { (it as? Map<*, *>)?.get("enabled") == true })
            trySend(on)
        }
        awaitClose { reg.remove() }
    }.distinctUntilChanged()

    /** One match, live. Null when it does not exist or cannot be read. */
    fun matchFlow(matchId: String): Flow<GameMatch?> = callbackFlow {
        val reg = firestore.collection("gameMatches").document(matchId).addSnapshotListener { snap, err ->
            trySend(if (err != null || snap == null) null else GameMatch.from(snap))
        }
        awaitClose { reg.remove() }
    }

    /** Open public tables for a game, newest first — the lobby list. */
    fun openMatchesFlow(gameId: String): Flow<List<GameMatch>> = callbackFlow {
        val reg = firestore.collection("gameMatches")
            .whereEqualTo("gameId", gameId)
            .whereEqualTo("status", "waiting")
            .whereEqualTo("visibility", "public")
            .orderBy("createdAtMs", Query.Direction.DESCENDING)
            .limit(30)
            .addSnapshotListener { snap, err ->
                trySend(if (err != null || snap == null) emptyList() else snap.documents.mapNotNull { GameMatch.from(it) })
            }
        awaitClose { reg.remove() }
    }

    /** My recent results, newest first. */
    fun historyFlow(limit: Long = 30): Flow<List<GameResult>> = callbackFlow {
        val uid = myUid()
        if (uid.isBlank()) { trySend(emptyList()); awaitClose { }; return@callbackFlow }
        val reg = firestore.collection("users").document(uid).collection("gameHistory")
            .orderBy("at", Query.Direction.DESCENDING).limit(limit)
            .addSnapshotListener { snap, err ->
                trySend(if (err != null || snap == null) emptyList() else snap.documents.map { GameResult.from(it) })
            }
        awaitClose { reg.remove() }
    }

    /** My diamond balance, live. */
    fun diamondsFlow(): Flow<Long> = callbackFlow {
        val uid = myUid()
        if (uid.isBlank()) { trySend(0L); awaitClose { }; return@callbackFlow }
        val reg = firestore.collection("users").document(uid).addSnapshotListener { snap, _ ->
            trySend(snap?.getLong("diamonds") ?: 0L)
        }
        awaitClose { reg.remove() }
    }.distinctUntilChanged()
}

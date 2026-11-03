package com.zipper.app.data.repository

import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.FirebaseFunctionsException
import com.zipper.app.util.ServerRefusals
import com.zipper.app.util.SessionManager
import kotlinx.coroutines.tasks.await
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Games (B4/B5, 3 Nov 2026) — every call the app makes to play.
 *
 * The server decides everything that matters — the die, the reels, the drop, the crash point, the winner, every
 * diamond — and this class only asks. Each action that costs diamonds carries an idempotency key, made once per tap
 * and reused for its retries, so a lost answer can be asked for again without paying twice
 * (functions/src/games).
 */
@Singleton
class GameFunctions @Inject constructor(
    private val functions: FirebaseFunctions,
    private val sessionManager: SessionManager,
) {
    sealed interface Result<out T> {
        data class Ok<T>(val value: T) : Result<T>
        /** [detail] is the server's own refusal code: `INSUFFICIENT_DIAMONDS`, `GAME_DISABLED`, `BAD_INVITE` … */
        data class Failed(val code: String, val userMessage: String, val detail: String = "") : Result<Nothing>
    }

    fun newKey(): String = UUID.randomUUID().toString()

    // ── Catalogue ─────────────────────────────────────────────────────────────

    data class GameEntry(
        val gameId: String,
        val kind: String,
        val maintenance: Boolean,
        val playable: Boolean,
        val entryOptions: List<Long>,
        val minEntry: Long,
        val maxEntry: Long,
        val platformFeePct: Double,
        val modes: List<Int>,
        val turnSeconds: Int,
        /** Quick games: the house edge the Owner set — every table on the phone is computed from it, for display. */
        val houseEdgePct: Double = 3.0,
    )

    data class Catalog(val games: List<GameEntry>, val diamonds: Long)

    suspend fun catalog(): Result<Catalog> = call("gameCatalog", emptyMap()) { m ->
        Catalog(
            games = (m["games"] as? List<*>).orEmpty().mapNotNull { g ->
                val e = g as? Map<*, *> ?: return@mapNotNull null
                GameEntry(
                    gameId = e["gameId"] as? String ?: return@mapNotNull null,
                    kind = e["kind"] as? String ?: "instant",
                    maintenance = e["maintenance"] as? Boolean ?: false,
                    playable = e["playable"] as? Boolean ?: true,
                    entryOptions = (e["entryOptions"] as? List<*>).orEmpty().mapNotNull { (it as? Number)?.toLong() },
                    minEntry = (e["minEntry"] as? Number)?.toLong() ?: 10L,
                    maxEntry = (e["maxEntry"] as? Number)?.toLong() ?: 10_000L,
                    platformFeePct = (e["platformFeePct"] as? Number)?.toDouble() ?: 0.0,
                    modes = (e["modes"] as? List<*>).orEmpty().mapNotNull { (it as? Number)?.toInt() },
                    turnSeconds = (e["turnSeconds"] as? Number)?.toInt() ?: 30,
                    houseEdgePct = (e["houseEdgePct"] as? Number)?.toDouble() ?: 3.0,
                )
            },
            diamonds = (m["diamonds"] as? Number)?.toLong() ?: 0L,
        )
    }

    // ── Multiplayer matches ───────────────────────────────────────────────────

    data class MatchRef(val matchId: String, val inviteCode: String, val started: Boolean)

    private fun matchRefOf(m: Map<String, Any?>) = MatchRef(
        matchId = m["matchId"] as? String ?: "",
        inviteCode = m["inviteCode"] as? String ?: "",
        started = m["started"] as? Boolean ?: false,
    )

    suspend fun createMatch(gameId: String, players: Int, entry: Long, private: Boolean, key: String): Result<MatchRef> =
        call("createGameMatch", mapOf(
            "gameId" to gameId, "players" to players, "entry" to entry,
            "visibility" to if (private) "private" else "public", "idempotencyKey" to key,
        ), ::matchRefOf)

    suspend fun quickMatch(gameId: String, players: Int, entry: Long, key: String): Result<MatchRef> =
        call("quickGameMatch", mapOf("gameId" to gameId, "players" to players, "entry" to entry, "idempotencyKey" to key), ::matchRefOf)

    suspend fun joinMatch(matchId: String, inviteCode: String, key: String): Result<MatchRef> =
        call("joinGameMatch", buildMap {
            put("matchId", matchId); put("idempotencyKey", key)
            if (inviteCode.isNotBlank()) put("inviteCode", inviteCode)
        }, ::matchRefOf)

    suspend fun leaveMatch(matchId: String): Result<Boolean> =
        call("leaveGameMatch", mapOf("matchId" to matchId)) { m -> m["left"] as? Boolean ?: true }

    suspend fun rematch(matchId: String, key: String): Result<MatchRef> =
        call("rematchGameMatch", mapOf("matchId" to matchId, "idempotencyKey" to key), ::matchRefOf)

    /** `roll` or `move` (with [token]); [step] is the state the player was looking at — a stale tap does nothing. */
    suspend fun ludoAction(matchId: String, action: String, token: Int?, step: Int): Result<Boolean> =
        call("ludoAction", buildMap {
            put("matchId", matchId); put("action", action); put("step", step)
            if (token != null) put("token", token)
        }) { m -> m["applied"] as? Boolean ?: false }

    suspend fun claimTimeout(matchId: String, step: Int): Result<Boolean> =
        call("claimGameTimeout", mapOf("matchId" to matchId, "step" to step)) { m -> m["applied"] as? Boolean ?: false }

    suspend fun snakesRoll(matchId: String, step: Int): Result<Boolean> =
        call("snakesRoll", mapOf("matchId" to matchId, "step" to step)) { m -> m["applied"] as? Boolean ?: false }

    suspend fun fourRowDrop(matchId: String, col: Int, step: Int): Result<Boolean> =
        call("fourRowDrop", mapOf("matchId" to matchId, "col" to col, "step" to step)) { m -> m["applied"] as? Boolean ?: false }

    /** My three cards (empty until I have chosen to see them) and what they make. */
    data class MyCards(val cards: List<Int>, val hand: String)

    private fun myCardsOf(m: Map<String, Any?>) = MyCards(
        cards = (m["cards"] as? List<*>).orEmpty().mapNotNull { (it as? Number)?.toInt() },
        hand = m["hand"] as? String ?: "",
    )

    /** Teen Patti: `see` (any time — it answers with my cards), or on my turn `chaal`, `raise`, `pack`, `show`. */
    suspend fun teenPattiAction(matchId: String, action: String, step: Int): Result<MyCards> =
        call("teenPattiAction", mapOf("matchId" to matchId, "action" to action, "step" to step), ::myCardsOf)

    suspend fun teenPattiMyCards(matchId: String): Result<MyCards> =
        call("teenPattiMyCards", mapOf("matchId" to matchId), ::myCardsOf)

    /**
     * Carrom: where on my baseline ([x] 0…1, left to right as I see it), the direction ([angle], radians, as I see
     * the board — up is −π/2) and how hard ([power] 0…1). The server simulates the shot; the result arrives on the
     * match as frames to replay.
     */
    suspend fun carromShot(matchId: String, x: Float, angle: Float, power: Float, step: Int): Result<Boolean> =
        call("carromShot", mapOf(
            "matchId" to matchId, "x" to x.toDouble(), "angle" to angle.toDouble(), "power" to power.toDouble(), "step" to step,
        )) { m -> m["applied"] as? Boolean ?: false }

    // ── Instant rounds ────────────────────────────────────────────────────────

    /** Any instant round's answer: the server's outcome map is passed through for the screen to draw. */
    data class Round(
        val roundId: String,
        val status: String,
        val outcome: Map<String, Any?>,
        val multiplier: Double,
        val payout: Long,
        val balance: Long?,
        val phase: String,
        val serverNowMs: Long,
        val startsAtMs: Long,
        val stale: Boolean,
        val refused: String,
    )

    @Suppress("UNCHECKED_CAST")
    private fun roundOf(m: Map<String, Any?>): Round {
        val outcome = (m["outcome"] as? Map<String, Any?>).orEmpty()
        return Round(
            roundId = m["roundId"] as? String ?: "",
            status = m["status"] as? String ?: "settled",
            outcome = outcome,
            multiplier = (m["multiplier"] as? Number)?.toDouble() ?: 0.0,
            payout = (m["payout"] as? Number)?.toLong() ?: 0L,
            balance = (m["balance"] as? Number)?.toLong(),
            phase = m["phase"] as? String ?: "",
            serverNowMs = (m["serverNowMs"] as? Number)?.toLong() ?: 0L,
            startsAtMs = (m["startsAtMs"] as? Number)?.toLong() ?: ((outcome["startsAtMs"] as? Number)?.toLong() ?: 0L),
            stale = m["stale"] as? Boolean ?: false,
            refused = m["refused"] as? String ?: "",
        )
    }

    suspend fun playPlinko(entry: Long, rows: Int, risk: String, key: String) =
        call("playPlinko", mapOf("entry" to entry, "rows" to rows, "risk" to risk, "idempotencyKey" to key), ::roundOf)

    suspend fun spinSlots(entry: Long, key: String) =
        call("spinSlots", mapOf("entry" to entry, "idempotencyKey" to key), ::roundOf)

    suspend fun castFishing(entry: Long, key: String) =
        call("castFishing", mapOf("entry" to entry, "idempotencyKey" to key), ::roundOf)

    suspend fun chickenStart(entry: Long, difficulty: String, key: String) =
        call("chickenStart", mapOf("entry" to entry, "difficulty" to difficulty, "idempotencyKey" to key), ::roundOf)

    suspend fun chickenStep(roundId: String, lane: Int) =
        call("chickenStep", mapOf("roundId" to roundId, "lane" to lane), ::roundOf)

    suspend fun chickenCashout(roundId: String) = call("chickenCashout", mapOf("roundId" to roundId), ::roundOf)

    suspend fun crashStart(entry: Long, autoCashout: Double, key: String) =
        call("crashStart", mapOf("entry" to entry, "autoCashout" to autoCashout, "idempotencyKey" to key), ::roundOf)

    suspend fun crashPoll(roundId: String) = call("crashPoll", mapOf("roundId" to roundId), ::roundOf)

    suspend fun crashCashout(roundId: String) = call("crashCashout", mapOf("roundId" to roundId), ::roundOf)

    // Second set (B5, 3 Nov 2026) — functions/src/games/instant.ts.
    suspend fun playDice(entry: Long, chance: Int, direction: String, key: String) =
        call("playDice", mapOf("entry" to entry, "chance" to chance, "direction" to direction, "idempotencyKey" to key), ::roundOf)

    suspend fun tossCoin(entry: Long, side: String, key: String) =
        call("tossCoin", mapOf("entry" to entry, "side" to side, "idempotencyKey" to key), ::roundOf)

    suspend fun spinWheel(entry: Long, risk: String, key: String) =
        call("spinWheel", mapOf("entry" to entry, "risk" to risk, "idempotencyKey" to key), ::roundOf)

    suspend fun playKeno(entry: Long, picks: List<Int>, key: String) =
        call("playKeno", mapOf("entry" to entry, "picks" to picks, "idempotencyKey" to key), ::roundOf)

    suspend fun playLimbo(entry: Long, target: Double, key: String) =
        call("playLimbo", mapOf("entry" to entry, "target" to target, "idempotencyKey" to key), ::roundOf)

    suspend fun spinRoulette(entry: Long, bet: String, pick: Int, key: String) =
        call("spinRoulette", mapOf("entry" to entry, "bet" to bet, "pick" to pick, "idempotencyKey" to key), ::roundOf)

    suspend fun playDragonTiger(entry: Long, side: String, key: String) =
        call("playDragonTiger", mapOf("entry" to entry, "side" to side, "idempotencyKey" to key), ::roundOf)

    suspend fun playAndarBahar(entry: Long, side: String, key: String) =
        call("playAndarBahar", mapOf("entry" to entry, "side" to side, "idempotencyKey" to key), ::roundOf)

    suspend fun hiloStart(entry: Long, key: String) = call("hiloStart", mapOf("entry" to entry, "idempotencyKey" to key), ::roundOf)

    /** [step] is the card index the player was looking at: a stale tap does nothing. */
    suspend fun hiloGuess(roundId: String, guess: String, step: Int) =
        call("hiloGuess", mapOf("roundId" to roundId, "guess" to guess, "step" to step), ::roundOf)

    suspend fun hiloCashout(roundId: String) = call("hiloCashout", mapOf("roundId" to roundId), ::roundOf)

    suspend fun minesStart(entry: Long, mines: Int, key: String) =
        call("minesStart", mapOf("entry" to entry, "mines" to mines, "idempotencyKey" to key), ::roundOf)

    suspend fun minesReveal(roundId: String, tile: Int) = call("minesReveal", mapOf("roundId" to roundId, "tile" to tile), ::roundOf)

    suspend fun minesCashout(roundId: String) = call("minesCashout", mapOf("roundId" to roundId), ::roundOf)

    data class Fairness(val commit: String, val clientSeed: String, val nonce: Long)

    suspend fun fairness(): Result<Fairness> = call("gameFairness", emptyMap()) { m ->
        Fairness(m["commit"] as? String ?: "", m["clientSeed"] as? String ?: "", (m["nonce"] as? Number)?.toLong() ?: 0L)
    }

    // ── Plumbing ──────────────────────────────────────────────────────────────

    @Suppress("UNCHECKED_CAST")
    private suspend fun <T> call(name: String, payload: Map<String, Any>, parse: (Map<String, Any?>) -> T): Result<T> = try {
        val res = functions.getHttpsCallable(name).call(sessionManager.withSession(payload)).await()
        val map = res.data as? Map<String, Any?> ?: return Result.Failed("internal", "Unexpected response from the server.")
        Result.Ok(parse(map))
    } catch (e: FirebaseFunctionsException) {
        ServerRefusals.report(e)
        val detail = ((e.details as? Map<String, Any?>)?.get("code") as? String).orEmpty()
        Result.Failed(e.code.name, e.message ?: "Something went wrong.", detail)
    } catch (e: Exception) {
        Result.Failed("unavailable", "Could not reach the server. Check your connection.")
    }
}

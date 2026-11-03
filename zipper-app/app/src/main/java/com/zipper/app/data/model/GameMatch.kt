package com.zipper.app.data.model

import com.google.firebase.firestore.DocumentSnapshot

/**
 * A multiplayer game as the server keeps it (`gameMatches/{id}`, functions/src/games/matches.ts). Read-only here:
 * the app draws it; only the game functions change it.
 */
data class GameSeat(val uid: String, val name: String, val photoUrl: String, val level: Int)

/** Ludo's state (functions/src/games/ludoEngine.ts). Positions are relative to each player's start. */
data class LudoBoard(
    val arms: Int,
    val armOf: List<Int>,
    val tokens: List<List<Int>>,
    val turn: Int,
    val roll: Int?,
    val step: Int,
    val turnNumber: Int,
    val tokensToWin: Int,
    val out: List<Int>,
    val missed: List<Int>,
    val winner: Int?,
) {
    val ring: Int get() = arms * 13
    val track: Int get() = ring - 1
    val home: Int get() = track + 5

    /** The ring square (0 … ring-1) a relative position is on, or null off the shared track. */
    fun absSquare(player: Int, rel: Int): Int? =
        if (rel < 0 || rel >= track) null else (armOf[player] * 13 + rel) % ring

    /** The tokens [player] may move with [die] — the same rule as the server's, for highlighting only. */
    fun movable(player: Int, die: Int): List<Int> {
        val seen = mutableSetOf<Int>()
        return tokens[player].withIndex().filter { (_, rel) ->
            val ok = when {
                rel == home -> false
                rel == -1 -> die == 6
                else -> rel + die <= home
            }
            ok && seen.add(rel)
        }.map { it.index }
    }

    companion object {
        /** Tokens per player — functions/src/games/ludoEngine.ts TOKENS. */
        const val TOKENS = 4

        /**
         * The match document keeps the tokens FLAT, four per player (Firestore stores no array inside an array);
         * an older nested list is read as is.
         */
        fun tokensOf(raw: Any?, players: Int): List<List<Int>> {
            val list = (raw as? List<*>).orEmpty()
            if (list.firstOrNull() is List<*>) return list.map { t -> (t as? List<*>).orEmpty().map { (it as? Number)?.toInt() ?: -1 } }
            val flat = list.map { (it as? Number)?.toInt() ?: -1 }
            return List(players) { p -> List(TOKENS) { k -> flat.getOrElse(p * TOKENS + k) { -1 } } }
        }

        @Suppress("UNCHECKED_CAST")
        fun from(raw: Any?): LudoBoard? {
            val m = raw as? Map<String, Any?> ?: return null
            fun ints(v: Any?) = (v as? List<*>).orEmpty().map { (it as? Number)?.toInt() ?: 0 }
            return LudoBoard(
                arms = (m["arms"] as? Number)?.toInt() ?: 4,
                armOf = ints(m["armOf"]),
                tokens = tokensOf(m["tokens"], ints(m["armOf"]).size),
                turn = (m["turn"] as? Number)?.toInt() ?: 0,
                roll = (m["roll"] as? Number)?.toInt(),
                step = (m["step"] as? Number)?.toInt() ?: 0,
                turnNumber = (m["turnNumber"] as? Number)?.toInt() ?: 0,
                tokensToWin = (m["tokensToWin"] as? Number)?.toInt() ?: 4,
                out = ints(m["out"]),
                missed = ints(m["missed"]),
                winner = (m["winner"] as? Number)?.toInt(),
            )
        }
    }
}

/**
 * Teen Patti's table (functions/src/games/teenPattiEngine.ts). The hands are NOT here — they stay on the server until
 * the game is over; a player gets their own three cards only after choosing to see them.
 */
data class TeenPattiTable(
    val players: Int,
    val boot: Long,
    val stake: Long,
    val pot: Long,
    val potLimit: Long,
    val paid: List<Long>,
    val seen: List<Boolean>,
    val packed: List<Boolean>,
    val turn: Int,
    val step: Int,
    val winners: List<Int>?,
    val endedBy: String?,
) {
    fun stillIn(): List<Int> = packed.withIndex().filter { !it.value }.map { it.index }

    /** What a chaal costs [player] now (a raise: at the doubled stake) — the server's rule, for the buttons only. */
    fun chaalCost(player: Int, raise: Boolean): Long {
        val st = if (raise) stake * 2 else stake
        return if (seen.getOrElse(player) { false }) st * 2 else st
    }

    /** A show is only possible with exactly two players left. */
    val canShow: Boolean get() = stillIn().size == 2

    companion object {
        @Suppress("UNCHECKED_CAST")
        fun from(raw: Any?): TeenPattiTable? {
            val m = raw as? Map<String, Any?> ?: return null
            fun longs(v: Any?) = (v as? List<*>).orEmpty().map { (it as? Number)?.toLong() ?: 0L }
            fun bools(v: Any?) = (v as? List<*>).orEmpty().map { it as? Boolean ?: false }
            return TeenPattiTable(
                players = (m["players"] as? Number)?.toInt() ?: 2,
                boot = (m["boot"] as? Number)?.toLong() ?: 0L,
                stake = (m["stake"] as? Number)?.toLong() ?: 0L,
                pot = (m["pot"] as? Number)?.toLong() ?: 0L,
                potLimit = (m["potLimit"] as? Number)?.toLong() ?: 0L,
                paid = longs(m["paid"]),
                seen = bools(m["seen"]),
                packed = bools(m["packed"]),
                turn = (m["turn"] as? Number)?.toInt() ?: 0,
                step = (m["step"] as? Number)?.toInt() ?: 0,
                winners = (m["winners"] as? List<*>)?.mapNotNull { (it as? Number)?.toInt() },
                endedBy = m["endedBy"] as? String,
            )
        }
    }
}

/** Every hand, shown on the table once the game is over (`reveal` on the match). Cards are 0…51. */
data class TeenPattiReveal(val seat: Int, val cards: List<Int>, val hand: String) {
    companion object {
        fun listFrom(raw: Any?): List<TeenPattiReveal> = (raw as? List<*>).orEmpty().mapNotNull { r ->
            val m = r as? Map<*, *> ?: return@mapNotNull null
            TeenPattiReveal(
                seat = (m["seat"] as? Number)?.toInt() ?: return@mapNotNull null,
                cards = (m["cards"] as? List<*>).orEmpty().mapNotNull { (it as? Number)?.toInt() },
                hand = m["hand"] as? String ?: "",
            )
        }
    }
}

/** A playing card, 0…51: rank = card % 13 (0 = 2 … 12 = A), suit = card / 13 (♠ ♥ ♦ ♣). */
object Cards {
    private const val RANKS = "23456789TJQKA"
    private val SUITS = listOf("♠", "♥", "♦", "♣")
    fun rank(card: Int): String = RANKS[card % 13].let { if (it == 'T') "10" else it.toString() }
    fun suit(card: Int): String = SUITS[(card / 13).coerceIn(0, 3)]
    fun isRed(card: Int): Boolean = (card / 13) == 1 || (card / 13) == 2
}

/** One carrom piece where the server left it (millimetres on the 740 × 740 board, y down). */
data class CarromPiece(val kind: String, val x: Float, val y: Float, val on: Boolean)

/** Carrom's table (functions/src/games/carromEngine.ts). */
data class CarromTable(
    val players: Int,
    val sides: List<Int>,
    val pieces: List<CarromPiece>,
    val scores: List<Int>,
    val misses: List<Int>,
    val out: List<Boolean>,
    val turn: Int,
    val step: Int,
    val shots: Int,
    val maxShots: Int,
    val target: Int,
    val queenPendingBy: Int?,
    val winners: List<Int>?,
    val endedBy: String?,
) {
    companion object {
        const val BOARD = 740f
        const val PIECE_R = 15.9f
        const val STRIKER_R = 20.65f
        const val POCKET_R = 24f
        val POCKETS = listOf(22f to 22f, 718f to 22f, 718f to 718f, 22f to 718f)
        /** The baseline in the shooter's view: [BASE_V] from their edge, from [BASE_U_MIN] to [BASE_U_MAX] along it. */
        const val BASE_V = 105f
        const val BASE_U_MIN = 175f
        const val BASE_U_MAX = 565f

        @Suppress("UNCHECKED_CAST")
        fun from(raw: Any?): CarromTable? {
            val m = raw as? Map<String, Any?> ?: return null
            fun ints(v: Any?) = (v as? List<*>).orEmpty().map { (it as? Number)?.toInt() ?: 0 }
            return CarromTable(
                players = (m["players"] as? Number)?.toInt() ?: 2,
                sides = ints(m["sides"]),
                pieces = (m["pieces"] as? List<*>).orEmpty().mapNotNull { p ->
                    val pm = p as? Map<*, *> ?: return@mapNotNull null
                    CarromPiece(
                        kind = pm["kind"] as? String ?: "white",
                        x = (pm["x"] as? Number)?.toFloat() ?: 0f,
                        y = (pm["y"] as? Number)?.toFloat() ?: 0f,
                        on = pm["on"] as? Boolean ?: false,
                    )
                },
                scores = ints(m["scores"]),
                misses = ints(m["misses"]),
                out = (m["out"] as? List<*>).orEmpty().map { it as? Boolean ?: false },
                turn = (m["turn"] as? Number)?.toInt() ?: 0,
                step = (m["step"] as? Number)?.toInt() ?: 0,
                shots = (m["shots"] as? Number)?.toInt() ?: 0,
                maxShots = (m["maxShots"] as? Number)?.toInt() ?: 0,
                target = (m["target"] as? Number)?.toInt() ?: 160,
                queenPendingBy = (m["queenPendingBy"] as? Number)?.toInt(),
                winners = (m["winners"] as? List<*>)?.mapNotNull { (it as? Number)?.toInt() },
                endedBy = m["endedBy"] as? String,
            )
        }
    }
}

/**
 * The last shot as the server simulated it: [frames] are [x, y] of every body (the striker first, then the pieces)
 * every [frameMs]; −1, −1 once a body is in a pocket. The phone replays them — it never simulates.
 */
data class CarromReplay(val n: Int, val player: Int, val frameMs: Int, val bodies: Int, val frames: List<FloatArray>) {
    companion object {
        fun from(raw: Any?): CarromReplay? {
            val m = raw as? Map<*, *> ?: return null
            val bodies = (m["bodies"] as? Number)?.toInt() ?: return null
            val packed = m["frames"] as? String ?: return null
            return CarromReplay(
                n = (m["n"] as? Number)?.toInt() ?: 0,
                player = (m["player"] as? Number)?.toInt() ?: 0,
                frameMs = (m["frameMs"] as? Number)?.toInt() ?: 50,
                bodies = bodies,
                frames = unpack(packed, bodies),
            )
        }

        /** Little-endian int16 values, base64 — the server's `packFrames`. */
        fun unpack(b64: String, bodies: Int): List<FloatArray> {
            val bytes = try { java.util.Base64.getDecoder().decode(b64) } catch (_: IllegalArgumentException) { return emptyList() }
            val stride = bodies * 2
            if (stride == 0) return emptyList()
            val buf = java.nio.ByteBuffer.wrap(bytes).order(java.nio.ByteOrder.LITTLE_ENDIAN)
            val out = ArrayList<FloatArray>(bytes.size / (stride * 2))
            while (buf.remaining() >= stride * 2) out.add(FloatArray(stride) { buf.short.toFloat() })
            return out
        }
    }
}

/** Snakes & Ladders (functions/src/games/boardGames.ts). Positions 0 (off the board) … 100. */
data class SnakesTable(
    val players: Int,
    val positions: List<Int>,
    val turn: Int,
    val step: Int,
    val misses: List<Int>,
    val out: List<Boolean>,
    val winner: Int?,
) {
    companion object {
        /** Zipper's own board — the server's LADDERS and SNAKES. */
        val LADDERS = mapOf(3 to 20, 6 to 27, 11 to 33, 24 to 45, 37 to 58, 42 to 63, 55 to 74, 68 to 87, 79 to 96)
        val SNAKES = mapOf(17 to 4, 29 to 9, 47 to 21, 53 to 34, 66 to 48, 77 to 57, 85 to 64, 91 to 70, 97 to 78, 99 to 81)

        /** Square 1…100 → (row from the bottom 0…9, column 0…9), the rows snaking left-right, right-left. */
        fun cellOf(square: Int): Pair<Int, Int> {
            val i = (square - 1).coerceIn(0, 99)
            val row = i / 10
            val col = if (row % 2 == 0) i % 10 else 9 - i % 10
            return row to col
        }

        fun from(raw: Any?): SnakesTable? {
            val m = raw as? Map<*, *> ?: return null
            fun ints(v: Any?) = (v as? List<*>).orEmpty().map { (it as? Number)?.toInt() ?: 0 }
            return SnakesTable(
                players = (m["players"] as? Number)?.toInt() ?: 2,
                positions = ints(m["positions"]),
                turn = (m["turn"] as? Number)?.toInt() ?: 0,
                step = (m["step"] as? Number)?.toInt() ?: 0,
                misses = ints(m["misses"]),
                out = (m["out"] as? List<*>).orEmpty().map { it as? Boolean ?: false },
                winner = (m["winner"] as? Number)?.toInt(),
            )
        }
    }
}

/** Four in a Row (functions/src/games/boardGames.ts): 42 cells, row by row from the bottom; −1 empty. */
data class FourRowTable(
    val cells: List<Int>,
    val turn: Int,
    val step: Int,
    val misses: List<Int>,
    val winners: List<Int>?,
    val endedBy: String?,
    val line: List<Int>,
) {
    fun at(row: Int, col: Int): Int = cells.getOrElse(row * COLS + col) { -1 }
    fun columnFull(col: Int): Boolean = at(ROWS - 1, col) != -1

    companion object {
        const val COLS = 7
        const val ROWS = 6

        fun from(raw: Any?): FourRowTable? {
            val m = raw as? Map<*, *> ?: return null
            fun ints(v: Any?) = (v as? List<*>).orEmpty().map { (it as? Number)?.toInt() ?: -1 }
            return FourRowTable(
                cells = ints(m["cells"]),
                turn = (m["turn"] as? Number)?.toInt() ?: 0,
                step = (m["step"] as? Number)?.toInt() ?: 0,
                misses = ints(m["misses"]),
                winners = (m["winners"] as? List<*>)?.mapNotNull { (it as? Number)?.toInt() },
                endedBy = m["endedBy"] as? String,
                line = ints(m["line"]),
            )
        }
    }
}

/** The last thing that happened, for the board to animate (a roll, a move, a capture). */
data class LudoEvent(
    val kind: String,
    val player: Int,
    val die: Int,
    val passed: Boolean,
    val token: Int?,
    val from: Int?,
    val to: Int?,
    val captured: Int,
    val home: Boolean,
) {
    companion object {
        fun from(raw: Any?): LudoEvent? {
            val m = raw as? Map<*, *> ?: return null
            val move = (m["move"] as? Map<*, *>)
            return LudoEvent(
                kind = m["kind"] as? String ?: "",
                player = ((m["player"] ?: move?.get("player")) as? Number)?.toInt() ?: 0,
                die = (m["die"] as? Number)?.toInt() ?: 0,
                passed = m["passed"] as? Boolean ?: false,
                token = (move?.get("token") as? Number)?.toInt(),
                from = (move?.get("from") as? Number)?.toInt(),
                to = (move?.get("to") as? Number)?.toInt(),
                captured = (move?.get("captured") as? List<*>)?.size ?: 0,
                home = move?.get("home") as? Boolean ?: false,
            )
        }
    }
}

data class GameMatch(
    val id: String,
    val gameId: String,
    val capacity: Int,
    val entry: Long,
    val feePct: Double,
    val pool: Long,
    val visibility: String,
    val status: String,
    val seats: List<GameSeat>,
    val createdBy: String,
    val commit: String,
    val seed: String,
    val turnSeconds: Int,
    val deadlineMs: Long?,
    val ludo: LudoBoard?,
    val lastEvent: LudoEvent?,
    val teenPatti: TeenPattiTable? = null,
    val reveal: List<TeenPattiReveal> = emptyList(),
    val carrom: CarromTable? = null,
    val lastShot: CarromReplay? = null,
    val snakes: SnakesTable? = null,
    val fourRow: FourRowTable? = null,
    /** The server's last event as sent — each game's screen reads the fields it knows. */
    val lastEventRaw: Map<String, Any?> = emptyMap(),
    val winners: List<String>,
    val payouts: Map<String, Long>,
    val fee: Long,
    val rematchMatchId: String,
    val cancelReason: String,
) {
    val isWaiting get() = status == "waiting"
    val isPlaying get() = status == "playing"
    val isOver get() = status == "finished" || status == "cancelled"

    /** The step of whichever game this is — sent with every action and timeout claim so a stale tap does nothing. */
    val stateStep: Int? get() = ludo?.step ?: teenPatti?.step ?: carrom?.step ?: snakes?.step ?: fourRow?.step

    /** What the winner would receive with a full table — the server's split, for the lobby to show before entry. */
    fun prizeIfFull(): Long {
        val pool = entry * capacity
        val fee = Math.round(pool * feePct / 100.0)
        return pool - fee
    }

    companion object {
        private fun gameIdOf(doc: DocumentSnapshot): String = doc.getString("gameId") ?: ""

        @Suppress("UNCHECKED_CAST")
        fun from(doc: DocumentSnapshot): GameMatch? {
            if (!doc.exists()) return null
            val seats = (doc.get("seats") as? List<*>).orEmpty().mapNotNull { s ->
                val m = s as? Map<String, Any?> ?: return@mapNotNull null
                GameSeat(
                    uid = m["uid"] as? String ?: return@mapNotNull null,
                    name = m["name"] as? String ?: "Player",
                    photoUrl = m["photoUrl"] as? String ?: "",
                    level = (m["level"] as? Number)?.toInt() ?: 0,
                )
            }
            return GameMatch(
                id = doc.id,
                gameId = doc.getString("gameId") ?: "",
                capacity = (doc.getLong("capacity") ?: 2L).toInt(),
                entry = doc.getLong("entry") ?: 0L,
                feePct = doc.getDouble("feePct") ?: (doc.getLong("feePct")?.toDouble() ?: 0.0),
                pool = doc.getLong("pool") ?: 0L,
                visibility = doc.getString("visibility") ?: "public",
                status = doc.getString("status") ?: "waiting",
                seats = seats,
                createdBy = doc.getString("createdBy") ?: "",
                commit = doc.getString("commit") ?: "",
                seed = doc.getString("seed") ?: "",
                turnSeconds = (doc.getLong("turnSeconds") ?: 30L).toInt(),
                deadlineMs = doc.getLong("deadlineMs"),
                ludo = if (gameIdOf(doc) == "ludo") LudoBoard.from(doc.get("state")) else null,
                lastEvent = if (gameIdOf(doc) == "ludo") LudoEvent.from(doc.get("lastEvent")) else null,
                teenPatti = if (gameIdOf(doc) == "teen_patti") TeenPattiTable.from(doc.get("state")) else null,
                reveal = TeenPattiReveal.listFrom(doc.get("reveal")),
                carrom = if (gameIdOf(doc) == "carrom") CarromTable.from(doc.get("state")) else null,
                lastShot = if (gameIdOf(doc) == "carrom") CarromReplay.from(doc.get("lastShot")) else null,
                snakes = if (gameIdOf(doc) == "snakes") SnakesTable.from(doc.get("state")) else null,
                fourRow = if (gameIdOf(doc) == "four_row") FourRowTable.from(doc.get("state")) else null,
                lastEventRaw = (doc.get("lastEvent") as? Map<String, Any?>).orEmpty(),
                winners = (doc.get("winners") as? List<*>).orEmpty().mapNotNull { it as? String },
                payouts = (doc.get("payouts") as? Map<String, Any?>).orEmpty()
                    .mapNotNull { (k, v) -> (v as? Number)?.toLong()?.let { k to it } }.toMap(),
                fee = doc.getLong("fee") ?: 0L,
                rematchMatchId = doc.getString("rematchMatchId") ?: "",
                cancelReason = doc.getString("cancelReason") ?: "",
            )
        }
    }
}

/** One finished game or round on the player's own history (`users/{uid}/gameHistory`). */
data class GameResult(
    val id: String,
    val gameId: String,
    val result: String,
    val entry: Long,
    val payout: Long,
    val atMs: Long,
) {
    companion object {
        fun from(doc: DocumentSnapshot): GameResult = GameResult(
            id = doc.id,
            gameId = doc.getString("gameId") ?: "",
            result = doc.getString("result") ?: "",
            entry = doc.getLong("entry") ?: 0L,
            payout = doc.getLong("payout") ?: 0L,
            atMs = doc.getTimestamp("at")?.toDate()?.time ?: 0L,
        )
    }
}

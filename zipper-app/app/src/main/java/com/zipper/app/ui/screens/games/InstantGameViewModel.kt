package com.zipper.app.ui.screens.games

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.zipper.app.data.repository.GameFunctions
import com.zipper.app.data.repository.GameRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import javax.inject.Inject

data class InstantState(
    val gameId: String = "",
    val game: GameFunctions.GameEntry? = null,
    val entries: List<Long> = emptyList(),
    val entry: Long = 0L,
    val diamonds: Long = 0L,
    val busy: Boolean = false,
    val error: String? = null,
    /** The last settled round, for the result banner and the animation. */
    val last: GameFunctions.Round? = null,
    /** An open multi-step round (Lane Hopper, Zip Flight). */
    val open: GameFunctions.Round? = null,
    // Peg Drop
    val rows: Int = 12,
    val risk: String = "medium",
    // Lane Hopper
    val difficulty: String = "easy",
    // Zip Flight
    val autoCashout: Double = 0.0,
    val flightMultiplier: Double = 1.0,
    val flightPhase: String = "",
    val serverOffsetMs: Long = 0L,
    val commit: String = "",
    // Lucky Dice
    val diceChance: Int = 50,
    val diceOver: Boolean = false,
    // Toss Up
    val coinSide: String = "heads",
    // Fortune Wheel
    val wheelRisk: String = "medium",
    // Number Draw
    val kenoPicks: List<Int> = emptyList(),
    // Sky High
    val limboTarget: Double = 2.0,
    // Roulette
    val rouletteBet: String = "red",
    val roulettePick: Int = 1,
    // Dragon Tiger ("dragon" / "tiger" / "tie") and Andar Bahar ("andar" / "bahar")
    val sideBet: String = "",
    // Gem Field
    val mineCount: Int = 3,
) {
    /** The Owner's house edge for this game (display only — the server applies its own). */
    val edgePct: Double get() = game?.houseEdgePct ?: 3.0
}

/**
 * The instant games' shared view model (B5). Every result comes from the server; this keeps the entry, the
 * idempotency key of the tap in flight, and — for Zip Flight — polls the server while the flight is up, drawing
 * the curve from the server's clock between polls.
 */
@HiltViewModel
class InstantGameViewModel @Inject constructor(
    savedState: SavedStateHandle,
    private val fn: GameFunctions,
    private val repo: GameRepository,
) : ViewModel() {
    val gameId: String = savedState["gameId"] ?: "plinko"
    private val _state = MutableStateFlow(InstantState(gameId = gameId))
    val state: StateFlow<InstantState> = _state.asStateFlow()
    private var key: String? = null
    private var pollJob: Job? = null

    init {
        viewModelScope.launch {
            when (val r = fn.catalog()) {
                is GameFunctions.Result.Ok -> {
                    val g = r.value.games.firstOrNull { it.gameId == gameId }
                    val entries = g?.let { entriesFor(it) }.orEmpty()
                    _state.update { it.copy(game = g, entries = entries, entry = entries.firstOrNull() ?: 0L,
                        error = if (g == null) "This game is not available right now." else null) }
                }
                is GameFunctions.Result.Failed -> _state.update { it.copy(error = r.userMessage) }
            }
            (fn.fairness() as? GameFunctions.Result.Ok)?.let { f -> _state.update { it.copy(commit = f.value.commit) } }
        }
        viewModelScope.launch { repo.diamondsFlow().collect { d -> _state.update { it.copy(diamonds = d) } } }
    }

    private fun entriesFor(g: GameFunctions.GameEntry): List<Long> =
        g.entryOptions.ifEmpty { listOf(10L, 20L, 50L, 100L, 200L, 500L, 1000L, 5000L).filter { it in g.minEntry..g.maxEntry } }

    fun setEntry(e: Long) = _state.update { it.copy(entry = e) }
    fun setRows(n: Int) = _state.update { it.copy(rows = n) }
    fun setRisk(r: String) = _state.update { it.copy(risk = r) }
    fun setDifficulty(d: String) = _state.update { it.copy(difficulty = d) }
    fun setAutoCashout(x: Double) = _state.update { it.copy(autoCashout = x) }
    fun setDiceChance(v: Int) = _state.update { it.copy(diceChance = v.coerceIn(2, 95)) }
    fun setDiceOver(over: Boolean) = _state.update { it.copy(diceOver = over) }
    fun setCoinSide(side: String) = _state.update { it.copy(coinSide = side) }
    fun setWheelRisk(r: String) = _state.update { it.copy(wheelRisk = r) }
    fun toggleKenoPick(n: Int) = _state.update {
        val picks = it.kenoPicks
        it.copy(kenoPicks = if (n in picks) picks - n else if (picks.size < 10) (picks + n).sorted() else picks)
    }
    fun setKenoPicks(p: List<Int>) = _state.update { it.copy(kenoPicks = p.distinct().filter { n -> n in 1..40 }.take(10).sorted()) }
    fun setLimboTarget(x: Double) = _state.update { it.copy(limboTarget = x) }
    fun setRouletteBet(b: String) = _state.update { it.copy(rouletteBet = b, roulettePick = if (b == "straight") 0 else 1) }
    fun setRoulettePick(p: Int) = _state.update { it.copy(roulettePick = p) }
    fun setSideBet(side: String) = _state.update { it.copy(sideBet = side) }
    fun setMineCount(n: Int) = _state.update { it.copy(mineCount = n.coerceIn(1, 24)) }
    fun clearError() = _state.update { it.copy(error = null) }

    /** Start a round: one key per tap, kept for that tap's retries. */
    private fun start(call: suspend (key: String) -> GameFunctions.Result<GameFunctions.Round>) {
        if (_state.value.busy || _state.value.open != null) return
        val k = key ?: fn.newKey().also { key = it }
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            when (val r = call(k)) {
                is GameFunctions.Result.Ok -> {
                    key = null
                    val round = r.value
                    if (round.status == "open") {
                        _state.update { it.copy(busy = false, open = round, last = null, flightMultiplier = 1.0, flightPhase = "countdown") }
                        if (gameId == "crash") pollFlight(round.roundId)
                    } else {
                        _state.update { it.copy(busy = false, last = round, open = null) }
                    }
                }
                is GameFunctions.Result.Failed -> {
                    if (r.code != "unavailable") key = null
                    _state.update { it.copy(busy = false, error = r.userMessage) }
                }
            }
        }
    }

    fun playPlinko() { val s = _state.value; start { k -> fn.playPlinko(s.entry, s.rows, s.risk, k) } }
    fun spinSlots() { val s = _state.value; start { k -> fn.spinSlots(s.entry, k) } }
    fun castLine() { val s = _state.value; start { k -> fn.castFishing(s.entry, k) } }
    fun startChicken() { val s = _state.value; start { k -> fn.chickenStart(s.entry, s.difficulty, k) } }
    fun startFlight() { val s = _state.value; start { k -> fn.crashStart(s.entry, s.autoCashout, k) } }
    fun playDice() { val s = _state.value; start { k -> fn.playDice(s.entry, s.diceChance, if (s.diceOver) "over" else "under", k) } }
    fun tossCoin() { val s = _state.value; start { k -> fn.tossCoin(s.entry, s.coinSide, k) } }
    fun spinWheel() { val s = _state.value; start { k -> fn.spinWheel(s.entry, s.wheelRisk, k) } }
    fun playKeno() { val s = _state.value; if (s.kenoPicks.isEmpty()) return; start { k -> fn.playKeno(s.entry, s.kenoPicks, k) } }
    fun playLimbo() { val s = _state.value; start { k -> fn.playLimbo(s.entry, s.limboTarget, k) } }
    fun spinRoulette() { val s = _state.value; start { k -> fn.spinRoulette(s.entry, s.rouletteBet, s.roulettePick, k) } }
    fun playDragonTiger() { val s = _state.value; if (s.sideBet.isBlank()) return; start { k -> fn.playDragonTiger(s.entry, s.sideBet, k) } }
    fun playAndarBahar() { val s = _state.value; if (s.sideBet.isBlank()) return; start { k -> fn.playAndarBahar(s.entry, s.sideBet, k) } }
    fun startHilo() { val s = _state.value; start { k -> fn.hiloStart(s.entry, k) } }
    fun startMines() { val s = _state.value; start { k -> fn.minesStart(s.entry, s.mineCount, k) } }

    /** Higher or Lower: `higher`, `lower` or `skip`, naming the card index the player was looking at. */
    fun hiloGuess(guess: String) {
        val open = _state.value.open ?: return
        if (_state.value.busy) return
        val index = (open.outcome["index"] as? Number)?.toInt() ?: 0
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch { settle(fn.hiloGuess(open.roundId, guess, index)) }
    }

    fun hiloCashout() {
        val open = _state.value.open ?: return
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch { settle(fn.hiloCashout(open.roundId)) }
    }

    /** Gem Field: turn a tile (a tile already turned is ignored by the server). */
    fun revealTile(tile: Int) {
        val open = _state.value.open ?: return
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch { settle(fn.minesReveal(open.roundId, tile)) }
    }

    fun minesCashout() {
        val open = _state.value.open ?: return
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch { settle(fn.minesCashout(open.roundId)) }
    }

    private fun settle(r: GameFunctions.Result<GameFunctions.Round>) {
        when (r) {
            is GameFunctions.Result.Ok -> {
                val round = r.value
                if (round.status == "settled") _state.update { it.copy(busy = false, open = null, last = round) }
                else _state.update { it.copy(busy = false, open = if (round.outcome.isNotEmpty()) round else it.open) }
            }
            is GameFunctions.Result.Failed -> _state.update { it.copy(busy = false, error = r.userMessage) }
        }
    }

    fun hop() {
        val open = _state.value.open ?: return
        if (_state.value.busy) return
        val crossed = (open.outcome["crossed"] as? Number)?.toInt() ?: 0
        _state.update { it.copy(busy = true) }
        viewModelScope.launch { settle(fn.chickenStep(open.roundId, crossed + 1)) }
    }

    fun collect() {
        val open = _state.value.open ?: return
        if (_state.value.busy) return
        _state.update { it.copy(busy = true) }
        viewModelScope.launch {
            settle(if (gameId == "crash") fn.crashCashout(open.roundId) else fn.chickenCashout(open.roundId))
        }
    }

    /**
     * Zip Flight: ask the server where the flight is about every 700 ms; between answers, draw e^(k·t) from the
     * server's own clock. The server — not this loop — decides when it crashed and what a cash-out pays.
     */
    private fun pollFlight(roundId: String) {
        pollJob?.cancel()
        pollJob = viewModelScope.launch {
            while (isActive && _state.value.open?.roundId == roundId) {
                when (val r = fn.crashPoll(roundId)) {
                    is GameFunctions.Result.Ok -> {
                        val p = r.value
                        if (p.status == "settled") { _state.update { it.copy(open = null, last = p, flightPhase = "over") }; break }
                        val offset = if (p.serverNowMs > 0) p.serverNowMs - System.currentTimeMillis() else _state.value.serverOffsetMs
                        _state.update { it.copy(flightPhase = p.phase, serverOffsetMs = offset, flightMultiplier = if (p.multiplier > 0) p.multiplier else it.flightMultiplier) }
                    }
                    is GameFunctions.Result.Failed -> Unit
                }
                delay(700)
            }
        }
    }

    /** The multiplier to draw right now, from the server's clock (k = ln 2 / 10 s, as functions/src/games/instantMath.ts). */
    fun flightNow(startsAtMs: Long, nowLocalMs: Long): Double {
        val elapsed = nowLocalMs + _state.value.serverOffsetMs - startsAtMs
        if (elapsed <= 0) return 1.0
        return kotlin.math.floor(kotlin.math.exp(kotlin.math.ln(2.0) / 10.0 * elapsed / 1000.0) * 100) / 100
    }
}

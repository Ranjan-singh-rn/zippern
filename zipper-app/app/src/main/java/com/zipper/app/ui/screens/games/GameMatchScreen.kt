package com.zipper.app.ui.screens.games

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.zipper.app.data.model.GameMatch
import com.zipper.app.data.repository.GameFunctions
import com.zipper.app.data.repository.GameRepository
import com.zipper.app.ui.components.*
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/** Invite codes the lobby received when it opened a private table — kept in memory to show on the table. */
object InviteCodes {
    private val codes = mutableMapOf<String, String>()
    fun put(matchId: String, code: String) { if (code.isNotBlank()) codes[matchId] = code }
    fun get(matchId: String): String = codes[matchId].orEmpty()
}

data class MatchUiState(
    val match: GameMatch? = null,
    val myUid: String = "",
    val acting: Boolean = false,
    val error: String? = null,
    val rematchId: String? = null,
    val leftId: String? = null,
    /** Teen Patti: my three cards, once I have chosen to see them (the server holds them until then). */
    val myCards: GameFunctions.MyCards? = null,
)

@HiltViewModel
class GameMatchViewModel @Inject constructor(
    savedState: SavedStateHandle,
    private val fn: GameFunctions,
    private val repo: GameRepository,
) : ViewModel() {
    val matchId: String = savedState["matchId"] ?: ""
    private val _state = MutableStateFlow(MatchUiState(myUid = repo.myUid()))
    val state: StateFlow<MatchUiState> = _state.asStateFlow()
    private var fetchingCards = false

    init {
        viewModelScope.launch {
            repo.matchFlow(matchId).collect { m ->
                _state.update { it.copy(match = m) }
                // Back on a Teen Patti table where I had already looked: ask for my cards again.
                val tp = m?.teenPatti
                val me = m?.seats?.indexOfFirst { it.uid == _state.value.myUid } ?: -1
                if (tp != null && me >= 0 && tp.seen.getOrElse(me) { false } && _state.value.myCards == null && !fetchingCards) {
                    fetchingCards = true
                    val r = fn.teenPattiMyCards(matchId)
                    fetchingCards = false
                    if (r is GameFunctions.Result.Ok && r.value.cards.isNotEmpty()) _state.update { it.copy(myCards = r.value) }
                }
            }
        }
        // Somebody has to say "time's up" if the player whose turn it is has gone quiet: any of us, a little after
        // the deadline (the server checks the clock; a claim that is early does nothing).
        viewModelScope.launch {
            while (true) {
                delay(2_000)
                val m = _state.value.match ?: continue
                val d = m.deadlineMs ?: continue
                val step = m.stateStep ?: continue
                if (m.isPlaying && System.currentTimeMillis() > d + 1_500) fn.claimTimeout(matchId, step)
            }
        }
    }

    private fun act(block: suspend () -> GameFunctions.Result<Boolean>) {
        if (_state.value.acting) return
        _state.update { it.copy(acting = true, error = null) }
        viewModelScope.launch {
            val r = block()
            _state.update { it.copy(acting = false, error = (r as? GameFunctions.Result.Failed)?.userMessage) }
        }
    }

    fun roll() { val b = _state.value.match?.ludo ?: return; act { fn.ludoAction(matchId, "roll", null, b.step) } }

    /** Teen Patti: look at my cards (any time while I am in). */
    fun tpSee() {
        val t = _state.value.match?.teenPatti ?: return
        if (_state.value.acting) return
        _state.update { it.copy(acting = true, error = null) }
        viewModelScope.launch {
            when (val r = fn.teenPattiAction(matchId, "see", t.step)) {
                is GameFunctions.Result.Ok -> _state.update { it.copy(acting = false, myCards = r.value) }
                is GameFunctions.Result.Failed -> _state.update { it.copy(acting = false, error = r.userMessage) }
            }
        }
    }

    /** Teen Patti on my turn: `chaal`, `raise`, `pack` or `show`. */
    fun tpAct(action: String) {
        val t = _state.value.match?.teenPatti ?: return
        act {
            when (val r = fn.teenPattiAction(matchId, action, t.step)) {
                is GameFunctions.Result.Ok -> GameFunctions.Result.Ok(true)
                is GameFunctions.Result.Failed -> r
            }
        }
    }

    fun snakesRoll() { val b = _state.value.match?.snakes ?: return; act { fn.snakesRoll(matchId, b.step) } }
    fun fourRowDrop(col: Int) { val b = _state.value.match?.fourRow ?: return; act { fn.fourRowDrop(matchId, col, b.step) } }

    /** Carrom on my turn: the server simulates the shot; the frames come back on the match. */
    fun carromShoot(x: Float, angle: Float, power: Float) {
        val b = _state.value.match?.carrom ?: return
        act { fn.carromShot(matchId, x, angle, power, b.step) }
    }
    fun move(token: Int) { val b = _state.value.match?.ludo ?: return; act { fn.ludoAction(matchId, "move", token, b.step) } }
    fun leave() { act { fn.leaveMatch(matchId).also { if (it is GameFunctions.Result.Ok) _state.update { s -> s.copy(leftId = matchId) } } } }
    fun clearError() = _state.update { it.copy(error = null) }

    private var rematchKey: String? = null
    fun rematch() {
        if (_state.value.acting) return
        val existing = _state.value.match?.rematchMatchId.orEmpty()
        if (existing.isNotBlank()) { _state.update { it.copy(rematchId = existing) }; return }
        val key = rematchKey ?: fn.newKey().also { rematchKey = it }
        _state.update { it.copy(acting = true) }
        viewModelScope.launch {
            when (val r = fn.rematch(matchId, key)) {
                is GameFunctions.Result.Ok -> {
                    InviteCodes.put(r.value.matchId, r.value.inviteCode)
                    _state.update { it.copy(acting = false, rematchId = r.value.matchId) }
                }
                is GameFunctions.Result.Failed -> _state.update { it.copy(acting = false, error = r.userMessage) }
            }
        }
    }

    fun consumeRematch() = _state.update { it.copy(rematchId = null) }
}

/**
 * One multiplayer table (B4): waiting for players (seats, invite code, leave = refund), then the game, then the
 * result (payouts, rematch). Everything on it is the server's state; the only things sent are "roll", which token
 * to move, "leave" and "rematch".
 */
@Composable
fun GameMatchScreen(
    onBack: () -> Unit,
    onOpenMatch: (String) -> Unit,
    viewModel: GameMatchViewModel = hiltViewModel(),
) {
    val s by viewModel.state.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    val m = s.match
    var confirmLeave by remember { mutableStateOf(false) }

    LaunchedEffect(s.rematchId) { s.rematchId?.let { onOpenMatch(it); viewModel.consumeRematch() } }
    LaunchedEffect(s.leftId) { if (s.leftId != null) onBack() }

    ZipperScreen(topBar = {
        TopBar(m?.let { lookOf(it.gameId).name } ?: "Game", onBack = {
            if (m != null && (m.isWaiting || m.isPlaying) && m.seats.any { it.uid == s.myUid }) confirmLeave = true else onBack()
        })
    }) { _ ->
        if (m == null) { LoadingState(); return@ZipperScreen }
        val me = m.seats.indexOfFirst { it.uid == s.myUid }
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(Space.lg),
            verticalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            PrizeStrip(m)
            when {
                m.isWaiting -> WaitingTable(m, s.myUid)
                m.ludo != null -> {
                    PlayersRow(m, me)
                    LudoBoardView(m.ludo, me, Modifier.fillMaxWidth()) { t -> viewModel.move(t) }
                    TurnBar(m, me, s.acting, onRoll = viewModel::roll)
                }
                m.teenPatti != null -> TeenPattiTableView(
                    m, me, s.myCards, s.acting, onSee = viewModel::tpSee, onAct = viewModel::tpAct,
                )
                m.carrom != null -> CarromTableView(m, me, s.acting, onShoot = viewModel::carromShoot)
                m.snakes != null -> SnakesTableView(m, me, s.acting, onRoll = viewModel::snakesRoll)
                m.fourRow != null -> FourRowTableView(m, me, s.acting, onDrop = viewModel::fourRowDrop)
            }
            s.error?.let { Text(it, style = ZipperTheme.type.bodyS, color = c.statusDanger) }
            if (m.isOver) ResultCard(m, s.myUid, s.acting, onRematch = viewModel::rematch, onLeave = onBack)
            Spacer(Modifier.height(Space.x3l))
        }
    }

    if (confirmLeave && m != null) {
        val playing = m.isPlaying
        AlertDialog(
            onDismissRequest = { confirmLeave = false },
            title = { Text(if (playing) "Leave this game?" else "Leave this table?") },
            text = {
                val me = m.seats.indexOfFirst { it.uid == s.myUid }
                val putIn = m.teenPatti?.paid?.getOrNull(me) ?: m.entry
                Text(
                    when {
                        playing && m.teenPatti != null -> "You will pack and lose the ${diamondsText(putIn)} you have put in."
                        playing -> "You will forfeit and lose your entry of ${diamondsText(m.entry)}."
                        else -> "Your entry of ${diamondsText(m.entry)} will be returned."
                    },
                )
            },
            confirmButton = { TextButton({ confirmLeave = false; viewModel.leave() }) { Text(if (playing) "Forfeit" else "Leave") } },
            dismissButton = { TextButton({ confirmLeave = false }) { Text("Stay") } },
        )
    }
}

@Composable
private fun PrizeStrip(m: GameMatch) {
    val c = ZipperTheme.colors
    Row(
        Modifier.fillMaxWidth().background(c.tintGoldSubtle, RoundedCornerShape(Radius.md)).padding(Space.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            val tp = m.teenPatti
            if (tp != null) {
                Text("Boot ${diamondsText(m.entry)} · ${m.capacity} players", style = ZipperTheme.type.labelM, color = c.textPrimary)
                Text("Pot ${diamondsText(tp.pot)} · Zipper fee ${feeText(m.feePct)}", style = ZipperTheme.type.bodyS, color = c.currencyCoin)
            } else {
                Text("Entry ${diamondsText(m.entry)} · ${m.capacity} players", style = ZipperTheme.type.labelM, color = c.textPrimary)
                Text("Winner gets ${diamondsText(m.prizeIfFull())}", style = ZipperTheme.type.bodyS, color = c.currencyCoin)
            }
        }
        if (m.visibility == "private") Text("Private", style = ZipperTheme.type.labelS, color = c.textMuted)
    }
}

@Composable
private fun WaitingTable(m: GameMatch, myUid: String) {
    val c = ZipperTheme.colors
    val ctx = LocalContext.current
    Text("Waiting for players — ${m.seats.size} of ${m.capacity}", style = ZipperTheme.type.headingS, color = c.textPrimary)
    Row(horizontalArrangement = Arrangement.spacedBy(Space.md)) {
        for (i in 0 until m.capacity) {
            val seat = m.seats.getOrNull(i)
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                if (seat != null) Avatar(seat.photoUrl, size = AvatarSize.LG, initial = seat.name)
                else Box(Modifier.size(56.dp).border(2.dp, c.borderDefault, CircleShape), contentAlignment = Alignment.Center) {
                    Text("?", color = c.textMuted)
                }
                Text(seat?.name ?: "Open", style = ZipperTheme.type.caption, color = c.textSecondary, maxLines = 1)
            }
        }
    }
    val code = InviteCodes.get(m.id)
    if (m.visibility == "private" && m.createdBy == myUid && code.isNotBlank()) {
        Column(
            Modifier.fillMaxWidth().background(c.bgRaised, RoundedCornerShape(Radius.md)).padding(Space.md),
            verticalArrangement = Arrangement.spacedBy(Space.xs),
        ) {
            Text("Invite friends", style = ZipperTheme.type.labelM, color = c.textPrimary)
            Text("Table id: ${m.id}", style = ZipperTheme.type.bodyS, color = c.textSecondary)
            Text("Code: $code", style = ZipperTheme.type.headingM, color = c.textPrimary)
            ZipperButton("Copy invite", {
                val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("Zipper game invite", "Join my ${lookOf(m.gameId).name} table on Zipper — table id ${m.id}, code $code"))
            }, size = ButtonSize.Small, style = ButtonStyle.Secondary)
        }
    }
    Text(
        "The game starts as soon as every seat is taken. If it does not fill in time, every entry is returned.",
        style = ZipperTheme.type.caption, color = c.textMuted,
    )
}

@Composable
private fun PlayersRow(m: GameMatch, me: Int) {
    val c = ZipperTheme.colors
    val b = m.ludo ?: return
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
        m.seats.forEachIndexed { i, seat ->
            val colour = LUDO_COLOURS[b.armOf.getOrElse(i) { i } % LUDO_COLOURS.size]
            val active = b.turn == i && b.winner == null
            val gone = b.out.contains(i)
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Box(
                    Modifier.border(if (active) 3.dp else 1.dp, if (active) colour else c.borderSubtle, CircleShape).padding(3.dp),
                ) { Avatar(seat.photoUrl, size = AvatarSize.SM, initial = seat.name) }
                Text(
                    (if (i == me) "You" else seat.name) + if (gone) " · left" else "",
                    style = ZipperTheme.type.caption, color = if (gone) c.textMuted else c.textSecondary, maxLines = 1,
                )
                Box(Modifier.size(10.dp).background(colour, CircleShape))
            }
        }
    }
}

@Composable
private fun TurnBar(m: GameMatch, me: Int, acting: Boolean, onRoll: () -> Unit) {
    val c = ZipperTheme.colors
    val b = m.ludo ?: return
    if (b.winner != null || !m.isPlaying) return
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(m.deadlineMs) { while (true) { now = System.currentTimeMillis(); delay(250) } }
    val left = ((m.deadlineMs ?: now) - now).coerceAtLeast(0L) / 1000
    val myTurn = b.turn == me
    // The die tumbles for a moment before showing the server's number — the number itself only ever comes from it.
    val spin = remember { Animatable(0f) }
    val lastDie = m.lastEvent?.die ?: 0
    LaunchedEffect(m.lastEvent?.die, b.step) { spin.snapTo(0f); spin.animateTo(360f, tween(450)) }
    Row(
        Modifier.fillMaxWidth().background(c.bgRaised, RoundedCornerShape(Radius.md)).padding(Space.md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Text(dieFace(b.roll ?: lastDie), fontSize = 44.sp, modifier = Modifier.rotate(spin.value))
        Column(Modifier.weight(1f)) {
            Text(
                when {
                    myTurn && b.roll == null -> "Your turn — roll"
                    myTurn -> "Tap a glowing token"
                    else -> "${m.seats.getOrNull(b.turn)?.name ?: "Player"}'s turn"
                },
                style = ZipperTheme.type.labelL, color = c.textPrimary,
            )
            Text("${left}s left", style = ZipperTheme.type.caption, color = if (left <= 5) c.statusDanger else c.textMuted)
        }
        if (myTurn && b.roll == null) ZipperButton("Roll", onRoll, size = ButtonSize.Medium, gradient = true, loading = acting, enabled = !acting)
    }
}

@Composable
private fun ResultCard(m: GameMatch, myUid: String, acting: Boolean, onRematch: () -> Unit, onLeave: () -> Unit) {
    val c = ZipperTheme.colors
    val won = m.winners.contains(myUid)
    val inGame = m.seats.any { it.uid == myUid }
    Column(
        Modifier.fillMaxWidth().background(if (won) c.tintGoldSubtle else c.bgRaised, RoundedCornerShape(Radius.lg)).padding(Space.lg),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.sm),
    ) {
        val title = when {
            m.status == "cancelled" -> "Game cancelled — entries returned"
            won -> "You won ${diamondsText(m.payouts[myUid] ?: 0L)}!"
            inGame -> "You lost this one"
            else -> "${m.seats.firstOrNull { m.winners.contains(it.uid) }?.name ?: "Someone"} won"
        }
        Text(title, style = ZipperTheme.type.headingM, color = if (won) c.currencyCoin else c.textPrimary, textAlign = TextAlign.Center)
        if (m.status == "finished") {
            Text("Pool ${diamondsText(m.pool)} · ${if (m.payouts.size > 1) "shared" else "winner"} ${diamondsText(m.payouts.values.sum())} · Zipper fee ${diamondsText(m.fee)}",
                style = ZipperTheme.type.caption, color = c.textMuted, textAlign = TextAlign.Center)
            if (m.seed.isNotBlank()) Text("Fair play: seed revealed — ${m.seed.take(16)}…", style = ZipperTheme.type.caption, color = c.textMuted)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
            if (inGame && m.status == "finished") ZipperButton("Rematch", onRematch, size = ButtonSize.Medium, gradient = true, loading = acting)
            ZipperButton("Back", onLeave, size = ButtonSize.Medium, style = ButtonStyle.Secondary)
        }
    }
}

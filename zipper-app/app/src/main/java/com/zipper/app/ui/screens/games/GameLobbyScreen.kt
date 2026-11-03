package com.zipper.app.ui.screens.games

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
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
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class LobbyState(
    val gameId: String = "",
    val game: GameFunctions.GameEntry? = null,
    val players: Int = 2,
    val entry: Long = 0L,
    val diamonds: Long = 0L,
    val open: List<GameMatch> = emptyList(),
    val busy: Boolean = false,
    val error: String? = null,
    /** Set when the server has seated us: the screen navigates into the match. */
    val enteredMatchId: String? = null,
    val lastInviteCode: String = "",
)

@HiltViewModel
class GameLobbyViewModel @Inject constructor(
    savedState: SavedStateHandle,
    private val fn: GameFunctions,
    private val repo: GameRepository,
) : ViewModel() {
    private val gameId: String = savedState["gameId"] ?: "ludo"
    private val _state = MutableStateFlow(LobbyState(gameId = gameId))
    val state: StateFlow<LobbyState> = _state.asStateFlow()

    /** One key per tap, kept for that tap's retries (a lost answer must not enter twice). */
    private var pendingKey: String? = null

    init {
        viewModelScope.launch {
            when (val r = fn.catalog()) {
                is GameFunctions.Result.Ok -> {
                    val g = r.value.games.firstOrNull { it.gameId == gameId }
                    _state.update {
                        it.copy(
                            game = g,
                            players = g?.modes?.firstOrNull() ?: 2,
                            entry = g?.entryOptions?.firstOrNull() ?: 0L,
                            error = if (g == null) "This game is not available right now." else null,
                        )
                    }
                }
                is GameFunctions.Result.Failed -> _state.update { it.copy(error = r.userMessage) }
            }
        }
        viewModelScope.launch { repo.diamondsFlow().collect { d -> _state.update { it.copy(diamonds = d) } } }
        viewModelScope.launch { repo.openMatchesFlow(gameId).collect { list -> _state.update { it.copy(open = list) } } }
    }

    fun setPlayers(n: Int) = _state.update { it.copy(players = n) }
    fun setEntry(e: Long) = _state.update { it.copy(entry = e) }
    fun clearError() = _state.update { it.copy(error = null) }
    fun consumeEntered() = _state.update { it.copy(enteredMatchId = null) }

    private fun run(block: suspend (key: String) -> GameFunctions.Result<GameFunctions.MatchRef>) {
        if (_state.value.busy) return
        val key = pendingKey ?: fn.newKey().also { pendingKey = it }
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            when (val r = block(key)) {
                is GameFunctions.Result.Ok -> {
                    pendingKey = null
                    _state.update { it.copy(busy = false, enteredMatchId = r.value.matchId, lastInviteCode = r.value.inviteCode) }
                }
                is GameFunctions.Result.Failed -> {
                    // A refusal is final for this tap; a network failure keeps the key for the retry.
                    if (r.code != "unavailable") pendingKey = null
                    _state.update { it.copy(busy = false, error = r.userMessage) }
                }
            }
        }
    }

    fun quickMatch() { val s = _state.value; run { k -> fn.quickMatch(gameId, s.players, s.entry, k) } }
    fun createPrivate() { val s = _state.value; run { k -> fn.createMatch(gameId, s.players, s.entry, true, k) } }
    fun createPublic() { val s = _state.value; run { k -> fn.createMatch(gameId, s.players, s.entry, false, k) } }
    fun join(matchId: String, code: String = "") { run { k -> fn.joinMatch(matchId, code, k) } }
}

/**
 * A multiplayer game's lobby (B6): choose the table size and the entry, see exactly what the winner gets, then play
 * now with anyone (quick match), open a private table for friends (an invite code), join one with a code, or pick
 * an open table from the list.
 */
@Composable
fun GameLobbyScreen(
    onBack: () -> Unit,
    onEnterMatch: (String) -> Unit,
    onRecharge: () -> Unit,
    viewModel: GameLobbyViewModel = hiltViewModel(),
) {
    val s by viewModel.state.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    val look = lookOf(s.gameId)
    var codeMatch by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }

    LaunchedEffect(s.enteredMatchId) {
        s.enteredMatchId?.let { onEnterMatch(it); viewModel.consumeEntered() }
    }

    ZipperScreen(topBar = {
        TopBar(look.name, onBack = onBack, actions = { CurrencyPill(Currency.Diamond, s.diamonds, onClick = onRecharge) })
    }) { _ ->
        val g = s.game
        if (g == null) {
            if (s.error != null) EmptyState(Icons.Outlined.Groups, "Not available", s.error ?: "") else LoadingState()
            return@ZipperScreen
        }
        val pool = s.entry * s.players
        val fee = Math.round(pool * g.platformFeePct / 100.0)
        val prize = pool - fee
        LazyColumn(
            contentPadding = PaddingValues(Space.lg),
            verticalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            item {
                GameTile(look, Modifier.fillMaxWidth().height(120.dp)) { }
            }
            item {
                Text("Players", style = ZipperTheme.type.labelM, color = c.textSecondary)
                Spacer(Modifier.height(Space.xs))
                ChoiceRow(g.modes, s.players, { "$it players" }, enabled = !s.busy) { viewModel.setPlayers(it) }
            }
            item {
                Text("Entry", style = ZipperTheme.type.labelM, color = c.textSecondary)
                Spacer(Modifier.height(Space.xs))
                ChoiceRow(g.entryOptions, s.entry, { diamondsText(it) }, enabled = !s.busy) { viewModel.setEntry(it) }
            }
            item {
                // What the server will do with the pool, shown before anybody pays.
                Column(
                    Modifier.fillMaxWidth().background(c.bgRaised, RoundedCornerShape(Radius.md)).padding(Space.md),
                    verticalArrangement = Arrangement.spacedBy(Space.xs),
                ) {
                    if (g.gameId == "teen_patti") {
                        // Teen Patti's pot grows with every bet: show the boot and how the pot is split, not a fixed prize.
                        Row { Text("Boot (to sit down)", Modifier.weight(1f), color = c.textSecondary); Text(diamondsText(s.entry), color = c.textPrimary) }
                        Row { Text("Starting pot", Modifier.weight(1f), color = c.textSecondary); Text(diamondsText(pool), color = c.textPrimary) }
                        Text(
                            "Every chaal adds to the pot. The best hand — or the last player in — takes the pot, less Zipper's " +
                                "${feeText(g.platformFeePct)} fee.",
                            style = ZipperTheme.type.caption, color = c.textMuted,
                        )
                    } else {
                        Row { Text("Pool", Modifier.weight(1f), color = c.textSecondary); Text(diamondsText(pool), color = c.textPrimary) }
                        Row { Text("Winner gets", Modifier.weight(1f), color = c.textSecondary); Text(diamondsText(prize), color = c.currencyCoin, style = ZipperTheme.type.labelL) }
                        Row { Text("Zipper fee", Modifier.weight(1f), color = c.textSecondary); Text(diamondsText(fee), color = c.textMuted) }
                    }
                    if (s.diamonds < s.entry) {
                        Text("You need ${diamondsText(s.entry)} to enter.", style = ZipperTheme.type.caption, color = c.statusDanger)
                    }
                }
            }
            s.error?.let { e ->
                item { Text(e, style = ZipperTheme.type.bodyS, color = c.statusDanger) }
            }
            item {
                ZipperButton("Play now", viewModel::quickMatch, fullWidth = true, gradient = true, loading = s.busy,
                    enabled = !s.busy && s.diamonds >= s.entry)
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    ZipperButton("Private table", viewModel::createPrivate, Modifier.weight(1f), style = ButtonStyle.Secondary,
                        size = ButtonSize.Medium, enabled = !s.busy && s.diamonds >= s.entry)
                    ZipperButton("Open table", viewModel::createPublic, Modifier.weight(1f), style = ButtonStyle.Secondary,
                        size = ButtonSize.Medium, enabled = !s.busy && s.diamonds >= s.entry)
                }
            }
            item {
                Text("Join with a code", style = ZipperTheme.type.labelM, color = c.textSecondary)
                Spacer(Modifier.height(Space.xs))
                Row(horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(codeMatch, { codeMatch = it.trim() }, Modifier.weight(1.4f), singleLine = true,
                        label = { Text("Table id") })
                    OutlinedTextField(code, { v -> code = v.filter { it.isDigit() }.take(6) }, Modifier.weight(1f), singleLine = true,
                        label = { Text("Code") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword))
                }
                Spacer(Modifier.height(Space.xs))
                ZipperButton("Join", { viewModel.join(codeMatch, code) }, size = ButtonSize.Medium,
                    enabled = !s.busy && codeMatch.isNotBlank() && code.length == 6)
            }
            item { Text("Open tables", style = ZipperTheme.type.headingS, color = c.textPrimary) }
            if (s.open.isEmpty()) {
                item { Text("No open tables right now — Play now opens one.", style = ZipperTheme.type.bodyS, color = c.textMuted) }
            }
            items(s.open, key = { it.id }) { m ->
                Row(
                    Modifier.fillMaxWidth().background(c.bgRaised, RoundedCornerShape(Radius.md)).padding(Space.md),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Space.md),
                ) {
                    Avatar(m.seats.firstOrNull()?.photoUrl, size = AvatarSize.SM, initial = m.seats.firstOrNull()?.name ?: "")
                    Column(Modifier.weight(1f)) {
                        Text("${m.seats.size}/${m.capacity} · ${diamondsText(m.entry)}", style = ZipperTheme.type.labelM, color = c.textPrimary)
                        Text(
                            if (m.gameId == "teen_patti") "Boot ${diamondsText(m.entry)} · pot grows with every bet"
                            else "Winner gets ${diamondsText(m.prizeIfFull())}",
                            style = ZipperTheme.type.caption, color = c.textMuted,
                        )
                    }
                    ZipperButton("Join", { viewModel.join(m.id) }, size = ButtonSize.Small, enabled = !s.busy && s.diamonds >= m.entry)
                }
            }
            item { Spacer(Modifier.height(Space.x3l)) }
        }
    }
}

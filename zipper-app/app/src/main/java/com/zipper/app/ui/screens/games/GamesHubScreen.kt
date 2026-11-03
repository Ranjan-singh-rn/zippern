package com.zipper.app.ui.screens.games

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.SportsEsports
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.zipper.app.data.model.GameResult
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
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import javax.inject.Inject

data class GamesHubState(
    val loading: Boolean = true,
    val games: List<GameFunctions.GameEntry> = emptyList(),
    val diamonds: Long = 0L,
    val history: List<GameResult> = emptyList(),
    val error: String? = null,
)

@HiltViewModel
class GamesHubViewModel @Inject constructor(
    private val fn: GameFunctions,
    private val repo: GameRepository,
) : ViewModel() {
    private val _state = MutableStateFlow(GamesHubState())
    val state: StateFlow<GamesHubState> = _state.asStateFlow()

    init {
        refresh()
        viewModelScope.launch { repo.diamondsFlow().collect { d -> _state.update { it.copy(diamonds = d) } } }
        viewModelScope.launch { repo.historyFlow(20).collect { h -> _state.update { it.copy(history = h) } } }
    }

    fun refresh() {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            when (val r = fn.catalog()) {
                is GameFunctions.Result.Ok -> _state.update { it.copy(loading = false, games = r.value.games) }
                is GameFunctions.Result.Failed -> _state.update { it.copy(loading = false, error = r.userMessage) }
            }
        }
    }
}

/**
 * The Games tab (B6, 3 Nov 2026): every game the owner has switched on, the player's balance and their recent
 * results. A game that is switched off is not shown at all; one closed for maintenance says so.
 */
@Composable
fun GamesHubScreen(
    onOpenGame: (gameId: String, multiplayer: Boolean) -> Unit,
    onRecharge: () -> Unit,
    viewModel: GamesHubViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    ZipperScreen(topBar = {
        TopBar("Games", actions = { CurrencyPill(Currency.Diamond, state.diamonds, onClick = onRecharge) })
    }) { _ ->
        when {
            state.loading && state.games.isEmpty() -> LoadingState()
            state.error != null && state.games.isEmpty() -> EmptyState(
                Icons.Outlined.SportsEsports, "Games could not load", state.error ?: "", actionLabel = "Try again",
                onAction = viewModel::refresh,
            )
            state.games.isEmpty() -> EmptyState(
                Icons.Outlined.SportsEsports, "No games right now", "Games will appear here when they are switched on.",
            )
            else -> LazyColumn(
                contentPadding = PaddingValues(horizontal = Space.lg, vertical = Space.md),
                verticalArrangement = Arrangement.spacedBy(Space.md),
            ) {
                val multi = state.games.filter { it.kind == "multiplayer" }
                val instant = state.games.filter { it.kind != "multiplayer" }
                if (multi.isNotEmpty()) {
                    item { Text("Play with others", style = ZipperTheme.type.headingS, color = c.textPrimary) }
                    items(multi.chunked(2)) { pair -> TileRow(pair, onOpenGame) }
                }
                if (instant.isNotEmpty()) {
                    item { Text("Quick games", style = ZipperTheme.type.headingS, color = c.textPrimary) }
                    items(instant.chunked(2)) { pair -> TileRow(pair, onOpenGame) }
                }
                if (state.history.isNotEmpty()) {
                    item { Text("Your recent games", style = ZipperTheme.type.headingS, color = c.textPrimary) }
                    items(state.history, key = { it.id }) { h -> HistoryRow(h) }
                }
                item { Spacer(Modifier.height(Space.x3l)) }
            }
        }
    }
}

@Composable
private fun TileRow(pair: List<GameFunctions.GameEntry>, onOpenGame: (String, Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.md)) {
        pair.forEach { g ->
            val look = lookOf(g.gameId)
            val badge = when {
                g.maintenance -> "Maintenance"
                !g.playable -> "Coming soon"
                else -> null
            }
            GameTile(
                look, Modifier.weight(1f).height(150.dp), badge = badge,
            ) { if (!g.maintenance && g.playable) onOpenGame(g.gameId, g.kind == "multiplayer") }
        }
        if (pair.size == 1) Spacer(Modifier.weight(1f))
    }
}

@Composable
private fun HistoryRow(h: GameResult) {
    val c = ZipperTheme.colors
    val look = lookOf(h.gameId)
    val fmt = remember { SimpleDateFormat("d MMM, h:mm a", Locale("en", "IN")) }
    Row(
        Modifier.fillMaxWidth().background(c.bgRaised, RoundedCornerShape(Radius.md)).padding(Space.md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Text(look.glyph, style = ZipperTheme.type.headingM)
        Column(Modifier.weight(1f)) {
            Text(look.name, style = ZipperTheme.type.labelM, color = c.textPrimary)
            Text(if (h.atMs > 0) fmt.format(Date(h.atMs)) else "", style = ZipperTheme.type.caption, color = c.textMuted)
        }
        val (label, color) = when (h.result) {
            "won" -> "+${indianGroup(h.payout)}" to c.statusSuccess
            "refunded" -> "Refunded" to c.textSecondary
            else -> "−${indianGroup(h.entry)}" to c.textMuted
        }
        Text(label, style = ZipperTheme.type.labelL, color = color)
    }
}

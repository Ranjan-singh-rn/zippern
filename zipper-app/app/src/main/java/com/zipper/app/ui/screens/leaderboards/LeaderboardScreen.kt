package com.zipper.app.ui.screens.leaderboards

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.EmojiEvents
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.FirebaseAuth
import com.zipper.app.data.repository.LeaderboardRepository
import com.zipper.app.ui.components.*
import com.zipper.app.ui.screens.games.ChoiceRow
import com.zipper.app.ui.screens.games.indianGroup
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import javax.inject.Inject

data class RankingsState(
    val board: String = "hosts",
    val period: String = "weekly",
    val entries: List<LeaderboardRepository.Entry> = emptyList(),
    val config: LeaderboardRepository.Config? = null,
    val myUid: String = "",
)

@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class LeaderboardViewModel @Inject constructor(
    private val repo: LeaderboardRepository,
    auth: FirebaseAuth,
) : ViewModel() {
    private val board = MutableStateFlow("hosts")
    private val period = MutableStateFlow("weekly")
    private val myUid = auth.currentUser?.uid.orEmpty()

    val state: StateFlow<RankingsState> = combine(board, period, repo.configFlow()) { b, p, cfg -> Triple(b, p, cfg) }
        .flatMapLatest { (b, p, cfg) -> repo.topFlow(b, p).map { entries -> RankingsState(b, p, entries, cfg, myUid) } }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), RankingsState(myUid = myUid))

    fun setBoard(b: String) { board.value = b }
    fun setPeriod(p: String) { period.value = p }
}

private val MEDALS = listOf(Color(0xFFFFC107), Color(0xFFB0BEC5), Color(0xFFCD7F32))

/**
 * Rankings (B8): Top hosts and Top supporters — today, this week, this month (IST) — with the rewards the Owner has
 * set for each rank. Everything here is read from the server; nothing on this screen changes a score.
 */
@Composable
fun LeaderboardScreen(
    onBack: () -> Unit,
    onOpenProfile: (String) -> Unit,
    viewModel: LeaderboardViewModel = hiltViewModel(),
) {
    val s by viewModel.state.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    val cfg = s.config
    ZipperScreen(topBar = { TopBar("Rankings", onBack = onBack) }) { _ ->
        if (cfg != null && !cfg.enabled) {
            EmptyState(Icons.Default.EmojiEvents, "Rankings are off", "Check back soon.")
            return@ZipperScreen
        }
        val boards = listOf("hosts", "supporters", "lucky").filter { cfg?.boards?.get(it) ?: (it != "lucky") }
        val rewards = cfg?.rewards?.get("${s.board}_${s.period}")
        val myRank = s.entries.indexOfFirst { it.uid == s.myUid }.takeIf { it >= 0 }?.plus(1)
        LazyColumn(contentPadding = PaddingValues(Space.lg), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            item {
                ChoiceRow(boards, s.board, { when (it) { "hosts" -> "Top hosts"; "supporters" -> "Top supporters"; else -> "Lucky gifters" } }) { viewModel.setBoard(it) }
                Spacer(Modifier.height(Space.sm))
                ChoiceRow(listOf("daily", "weekly", "monthly"), s.period, { when (it) { "daily" -> "Today"; "weekly" -> "This week"; else -> "This month" } }) { viewModel.setPeriod(it) }
            }
            if (rewards != null && rewards.tiers.isNotEmpty()) {
                item {
                    Column(Modifier.fillMaxWidth().background(c.tintGoldSubtle, RoundedCornerShape(Radius.md)).padding(Space.md)) {
                        Text("Rewards", style = ZipperTheme.type.labelM, color = c.textPrimary)
                        Text(
                            rewards.tiers.joinToString(" · ") { t ->
                                (if (t.from == t.to) "#${t.from}" else "#${t.from}–${t.to}") + " ${if (rewards.currency == "beans") "🫘" else "◆"} ${indianGroup(t.amount)}"
                            },
                            style = ZipperTheme.type.bodyS, color = c.currencyCoin,
                        )
                        Text("Paid after the period closes (midnight IST).", style = ZipperTheme.type.caption, color = c.textMuted)
                    }
                }
            }
            if (myRank != null) item { Text("You are #$myRank", style = ZipperTheme.type.labelL, color = c.brandPrimary) }
            if (s.entries.isEmpty()) item { Text("Nobody on this board yet.", style = ZipperTheme.type.bodyS, color = c.textMuted) }
            itemsIndexed(s.entries, key = { _, e -> e.uid }) { i, e ->
                Row(
                    Modifier.fillMaxWidth()
                        .background(if (e.uid == s.myUid) c.tintBrandSubtle else c.bgRaised, RoundedCornerShape(Radius.md))
                        .clickableNoRipple { onOpenProfile(e.uid) }
                        .padding(Space.sm),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Space.md),
                ) {
                    Box(Modifier.size(30.dp).background(MEDALS.getOrNull(i) ?: c.bgElevated, CircleShape), contentAlignment = Alignment.Center) {
                        Text("${i + 1}", style = ZipperTheme.type.labelM, color = if (i < 3) Color.Black else c.textPrimary, fontWeight = FontWeight.Bold)
                    }
                    Avatar(e.photoUrl, size = AvatarSize.SM, initial = e.name)
                    Text(e.name.ifBlank { "Zipper user" }, Modifier.weight(1f), style = ZipperTheme.type.labelL, color = c.textPrimary, maxLines = 1)
                    Text(
                        (if (s.board == "hosts") "🫘 " else "◆ ") + indianGroup(e.score),
                        style = ZipperTheme.type.labelM, color = c.currencyCoin,
                    )
                }
            }
            item { Spacer(Modifier.height(Space.x3l)) }
        }
    }
}

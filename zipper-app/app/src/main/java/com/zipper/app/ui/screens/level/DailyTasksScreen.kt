package com.zipper.app.ui.screens.level

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.ListenerRegistration
import com.zipper.app.data.model.DailyTaskDef
import com.zipper.app.data.model.DailyTaskRow
import com.zipper.app.data.model.DailyTasks
import com.zipper.app.data.repository.MoneyFunctions
import com.zipper.app.ui.components.*
import com.zipper.app.ui.screens.profile.GlassCard
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/** O8 (5 Nov 2026): today's daily tasks — progress counted by the server, Claim pays once. */
data class DailyTasksUiState(
    val loading: Boolean = true,
    val enabled: Boolean = false,
    val rows: List<DailyTaskRow> = emptyList(),
    val claiming: String? = null,
    val message: String? = null,
)

@HiltViewModel
class DailyTasksViewModel @Inject constructor(
    private val firestore: FirebaseFirestore,
    private val auth: FirebaseAuth,
    private val money: MoneyFunctions,
) : ViewModel() {
    private val _state = MutableStateFlow(DailyTasksUiState())
    val state: StateFlow<DailyTasksUiState> = _state.asStateFlow()

    private var enabled = false
    private var defs: List<DailyTaskDef> = emptyList()
    private var progress: Map<String, Any?>? = null
    private var isHost = false
    private val listeners = mutableListOf<ListenerRegistration>()

    init { start() }

    private fun recompute() {
        _state.update { it.copy(loading = false, enabled = enabled, rows = DailyTasks.rows(enabled, defs, progress, isHost)) }
    }

    private fun start() {
        val uid = auth.currentUser?.uid
        if (uid == null) { _state.update { it.copy(loading = false) }; return }
        val day = DailyTasks.istDateKey()
        listeners += firestore.collection("appConfig").document("dailyTasks").addSnapshotListener { snap, err ->
            if (err != null) { _state.update { it.copy(loading = false, message = "Could not load today's tasks.") }; return@addSnapshotListener }
            val (on, list) = DailyTasks.parseConfig(snap?.data)
            enabled = on; defs = list; recompute()
        }
        listeners += firestore.collection("users").document(uid).collection("dailyTasks").document(day).addSnapshotListener { snap, _ ->
            progress = snap?.data; recompute()
        }
        listeners += firestore.collection("users").document(uid).addSnapshotListener { snap, _ ->
            isHost = snap?.getBoolean("isHost") == true; recompute()
        }
    }

    fun claim(row: DailyTaskRow) {
        if (!row.canClaim || _state.value.claiming != null) return
        _state.update { it.copy(claiming = row.def.id) }
        viewModelScope.launch {
            val msg = when (val r = money.claimDailyTask(row.def.id)) {
                is MoneyFunctions.Result.Ok -> "You got ${DailyTasks.rewardText(row.def.copy(rewardDiamonds = r.value.diamonds, rewardBeans = r.value.beans))}."
                is MoneyFunctions.Result.Failed -> r.userMessage
            }
            _state.update { it.copy(claiming = null, message = msg) }
        }
    }

    fun messageShown() { _state.update { it.copy(message = null) } }

    override fun onCleared() {
        listeners.forEach { it.remove() }
        listeners.clear()
        super.onCleared()
    }
}

@Composable
fun DailyTasksScreen(
    onBack: () -> Unit = {},
    viewModel: DailyTasksViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(state.message) {
        state.message?.let { snackbar.showSnackbar(it); viewModel.messageShown() }
    }
    ZipperScreen(topBar = { TopBar("Daily tasks", onBack = onBack) }) { pad ->
        Box(Modifier.fillMaxSize().padding(pad)) {
            when {
                state.loading -> Text("Loading…", Modifier.align(Alignment.Center), color = c.textMuted)
                !state.enabled || state.rows.isEmpty() -> Text(
                    "No daily tasks today. Check back tomorrow.",
                    Modifier.align(Alignment.Center).padding(Space.xl), color = c.textMuted, style = ZipperTheme.type.bodyM,
                )
                else -> LazyColumn(
                    contentPadding = PaddingValues(Space.lg),
                    verticalArrangement = Arrangement.spacedBy(Space.md),
                ) {
                    item {
                        Text("Tasks reset at midnight (IST). Finish one and tap Claim.", color = c.textMuted, style = ZipperTheme.type.caption)
                    }
                    items(state.rows, key = { it.def.id }) { row -> TaskCard(row, state.claiming == row.def.id) { viewModel.claim(row) } }
                }
            }
            SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter))
        }
    }
}

@Composable
private fun TaskCard(row: DailyTaskRow, claiming: Boolean, onClaim: () -> Unit) {
    val c = ZipperTheme.colors
    val unit = DailyTasks.UNITS[row.def.metric].orEmpty()
    GlassCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(row.def.title, style = ZipperTheme.type.labelM, color = c.textPrimary)
                Text(
                    "${minOf(row.progress, row.def.target)} / ${row.def.target} $unit · ${DailyTasks.rewardText(row.def)}",
                    style = ZipperTheme.type.caption, color = c.textMuted,
                )
            }
            Spacer(Modifier.width(Space.sm))
            when {
                row.claimed -> Text("Claimed", style = ZipperTheme.type.labelM, color = c.statusSuccess)
                else -> ZipperButton(
                    "Claim", onClaim, size = ButtonSize.Small,
                    enabled = row.canClaim, loading = claiming,
                )
            }
        }
        Spacer(Modifier.height(Space.sm))
        LinearProgressIndicator(progress = { row.fraction }, modifier = Modifier.fillMaxWidth().height(6.dp))
    }
}

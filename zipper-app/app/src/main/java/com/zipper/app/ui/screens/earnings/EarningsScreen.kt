package com.zipper.app.ui.screens.earnings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.zipper.app.R
import com.zipper.app.data.model.BeanTransaction
import com.zipper.app.data.repository.HostStatsRepository
import com.zipper.app.ui.theme.*
import com.zipper.app.ui.components.*
import com.zipper.app.ui.screens.profile.GlassCard
import com.zipper.app.ui.screens.messages.timeAgo
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.text.style.TextOverflow
import com.zipper.app.util.millis
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import java.text.SimpleDateFormat
import javax.inject.Inject

data class EarningsUiState(
    val currentBeans: Long = 0L,
    val totalBeansEarned: Long = 0L,
    val callRateBeans: Long = 0L,
    val transactions: List<BeanTransaction> = emptyList(),
    val isLoading: Boolean = true,
    /**
     * Today, this week, the level and the payout position.
     *
     * These had no source at all before: `hostLevel` was written as 0 at signup
     * and never updated by anything, so every host was pinned to the level-0
     * rate ceiling with no way to move, and there was nothing anywhere that
     * knew what a host had earned today.
     */
    val home: HostStatsRepository.HostHome? = null,
    val statements: List<HostStatsRepository.Statement> = emptyList(),
    val error: String? = null,
    /**
     * Spec §10 / F-16: the host level card and the rate items are drawn for a
     * HOST only. Read from the account, not inferred from `home` — the server
     * refuses `getHostHome` to a non-host anyway, but the card must not depend
     * on a refusal to stay hidden.
     */
    val isHost: Boolean = false,
)

@HiltViewModel
class EarningsViewModel @Inject constructor(
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
    private val hostStats: HostStatsRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(EarningsUiState())
    val state: StateFlow<EarningsUiState> = _state.asStateFlow()

    init {
        load()
        loadHostFigures()
        observeStatements()
    }

    /** One call for today, the week, the level and the payout position. */
    fun loadHostFigures() {
        viewModelScope.launch {
            when (val res = hostStats.hostHome()) {
                is HostStatsRepository.Result.Ok ->
                    _state.update { it.copy(home = res.home, error = null) }
                is HostStatsRepository.Result.Failed ->
                    // A non-host calling this is refused, which is correct and
                    // not worth surfacing — the screen simply has no host block.
                    _state.update { it.copy(home = null) }
            }
        }
    }

    /**
     * Weekly statements, including held weeks.
     *
     * A held week is shown with its reason rather than omitted: a week that
     * does not appear reads as lost earnings, and the beans are not lost —
     * the release skips them and picks them up once the block clears.
     */
    private fun observeStatements() {
        viewModelScope.launch {
            hostStats.statementsFlow().collect { rows ->
                _state.update { it.copy(statements = rows) }
            }
        }
    }

    private fun load() {
        val uid = auth.currentUser?.uid ?: return
        // Load user summary
        viewModelScope.launch {
            try {
                val snap = firestore.collection("users").document(uid).get().await()
                _state.update {
                    it.copy(
                        currentBeans    = snap.getLong("beans") ?: 0L,
                        totalBeansEarned = snap.getLong("totalBeansEarned") ?: 0L,
                        callRateBeans   = snap.getLong("callRateBeans") ?: 375L,
                        isHost          = snap.getBoolean("isHost") == true,
                    )
                }
            } catch (_: Exception) {}
        }
        // Real-time transactions
        viewModelScope.launch {
            callbackFlow {
                val listener = firestore.collection("users").document(uid)
                    .collection("beanTransactions")
                    .orderBy("timestamp", Query.Direction.DESCENDING)
                    .limit(100)
                    .addSnapshotListener { snap, _ ->
                        val list = snap?.documents?.mapNotNull { doc ->
                            BeanTransaction(
                                id           = doc.id,
                                // `type` is the only thing in the document that
                                // says which way the beans went — `amount` is
                                // always a positive magnitude. Leaving it out of
                                // this mapper left every row on its "credit"
                                // default, so the screen below could not have
                                // drawn a debit correctly even if it had asked.
                                type         = doc.getString("type") ?: "credit",
                                amount       = doc.getLong("amount") ?: 0L,
                                reason       = doc.getString("reason") ?: "",
                                reasonLabel  = doc.getString("reasonLabel") ?: "",
                                timestamp    = doc.millis("timestamp"),
                            )
                        } ?: emptyList()
                        trySend(list)
                    }
                awaitClose { listener.remove() }
            }.collect { txns ->
                _state.update { it.copy(transactions = txns, isLoading = false) }
            }
        }
    }
}

/*
 * Host home / Earnings — Figma "09 Host / 02 Host home" (107:119) and
 * "06 Payout" (112:256).
 *
 *   Hero card: today's beans (numeric L, mint), calls · gifts · minutes.
 *   Week card: this week's beans with gift/call split, payout position
 *   (available now vs pending release, hold reason if any).
 *   Level card: current level, rate ceiling, progress to next level.
 *   Statements: one row per week (Released / Held with reason / Pending),
 *   beans → ₹ at the CRM rate, converted beans called out.
 *   Recent bean transactions.
 */
@Composable
fun EarningsScreen(
    onBack: () -> Unit,
    onConvertBeans: () -> Unit = {},
    onEditRate: () -> Unit = {},
    viewModel: EarningsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    // Spec §10 / F-16: host figures — today, the week, the HOST LEVEL card —
    // are for a host only. A normal user sees the bean activity below and
    // nothing host-level.
    val showHost = com.zipper.app.util.LevelVisibility.showHostEarnings(state.isHost, state.home != null)
    val home = state.home?.takeIf { showHost }

    ZipperScreen(topBar = { TopBar("Earnings", onBack = onBack) { CurrencyPill(Currency.Bean, state.currentBeans, onClick = onConvertBeans) } }) { _ ->
        if (state.isLoading && home == null) { LoadingState(); return@ZipperScreen }
        LazyColumn(contentPadding = PaddingValues(horizontal = Space.lg, vertical = Space.md), verticalArrangement = Arrangement.spacedBy(Space.md)) {
            if (home != null) {
                item {
                    // Today
                    Column(
                        Modifier.fillMaxWidth().background(Brush.linearGradient(listOf(Color(0xFF16C77E).copy(0.22f), Color(0xFF8B5CF6).copy(0.18f))), RoundedCornerShape(Radius.xl))
                            .border(1.dp, c.tintSuccessSubtle, RoundedCornerShape(Radius.xl)).padding(Space.xl),
                        verticalArrangement = Arrangement.spacedBy(Space.sm),
                    ) {
                        Text("Today", style = ZipperTheme.type.caption, color = c.textSecondary)
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                            CurrencyDisc(Currency.Bean, 24.dp)
                            Text(indianGrouping(home.today.beans), style = ZipperTheme.type.numericL, color = c.currencyBean)
                            Text("beans", style = ZipperTheme.type.bodyM, color = c.textSecondary)
                        }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Stat("Calls", home.today.calls.toString())
                            Stat("Minutes", (home.today.callSeconds / 60).toString())
                            Stat("Gifts", home.today.giftsReceived.toString())
                            Stat("From calls", indianGrouping(home.today.callBeans))
                        }
                    }
                }
                item {
                    GlassCard {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text("This week", style = ZipperTheme.type.caption, color = c.textSecondary)
                                Text("${indianGrouping(home.week.beans)} beans", style = ZipperTheme.type.numericM, color = c.textPrimary)
                            }
                            Column(horizontalAlignment = Alignment.End) {
                                Text("Gifts ${indianGrouping(home.week.giftBeans)}", style = ZipperTheme.type.caption, color = c.textSecondary)
                                Text("Calls ${indianGrouping(home.week.callBeans)}", style = ZipperTheme.type.caption, color = c.textSecondary)
                            }
                        }
                        HairlineDivider()
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Column { Text("Available now", style = ZipperTheme.type.caption, color = c.textSecondary); Text(indianGrouping(home.payout.beansAvailable), style = ZipperTheme.type.numericM, color = c.currencyBean) }
                            Column(horizontalAlignment = Alignment.End) { Text("Pending release", style = ZipperTheme.type.caption, color = c.textSecondary); Text(indianGrouping(home.payout.beansPending), style = ZipperTheme.type.numericM, color = c.textPrimary) }
                        }
                        Text("Each week's beans are released the following week. Converting to diamonds is instant but makes those beans non-payable.", style = ZipperTheme.type.caption, color = c.textMuted)
                        when {
                            !home.payout.isVerifiedHost -> Notice("Verification pending — payouts unlock once your identity is approved.", c.statusWarning)
                            home.payout.payoutHold -> Notice("Payouts are on hold for this account. Contact support from Feedback.", c.statusDanger)
                        }
                        ZipperButton("Convert beans to diamonds", onConvertBeans, style = ButtonStyle.Secondary, fullWidth = true, size = ButtonSize.Medium)
                    }
                }
                item {
                    val lv = home.level
                    GlassCard {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
                            Box(Modifier.size(44.dp).background(Brush.linearGradient(listOf(Color(0xFFFFE08A), Color(0xFFE89806))), CircleShape), contentAlignment = Alignment.Center) {
                                Text("${lv.level}", style = ZipperTheme.type.headingS, color = Color(0xFF0E0F21))
                            }
                            Column(Modifier.weight(1f)) {
                                Text("Host level ${lv.level}", style = ZipperTheme.type.labelL, color = c.textPrimary)
                                Text(
                                    if (lv.maxCallRateBeans > 0) "Rate ${indianGrouping(lv.callRateBeans)} / min · ceiling ${indianGrouping(lv.maxCallRateBeans)}" else "Base rate until verified",
                                    style = ZipperTheme.type.caption, color = c.textSecondary,
                                )
                            }
                            if (lv.maxCallRateBeans > 0) Text("Edit rate", style = ZipperTheme.type.labelS, color = c.textBrand, modifier = Modifier.clickableNoRipple(onEditRate))
                        }
                        if (lv.nextLevel != null && lv.nextLevelAt != null && lv.nextLevelAt > 0) {
                            val progress = ((lv.nextLevelAt - lv.beansToNextLevel).toFloat() / lv.nextLevelAt).coerceIn(0f, 1f)
                            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Box(Modifier.fillMaxWidth().height(6.dp).background(c.bgElevated, CircleShape)) {
                                    Box(Modifier.fillMaxWidth(progress).fillMaxHeight().background(Brush.horizontalGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), CircleShape))
                                }
                                Text("${indianGrouping(lv.beansToNextLevel)} more beans to level ${lv.nextLevel}", style = ZipperTheme.type.caption, color = c.textSecondary)
                            }
                        }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Stat("Lifetime", indianGrouping(home.lifetimeBeans))
                            Stat("From calls", indianGrouping(home.lifetimeCallBeans))
                            Stat("From gifts", indianGrouping(home.lifetimeGiftBeans))
                        }
                    }
                }
            } else if (state.isHost) {
                item { Notice("Host figures unavailable — the server couldn't be reached. Pull down or come back in a moment.", c.textSecondary) }
            }

            if (state.statements.isNotEmpty()) {
                item { SectionHeader("Weekly statements", Modifier.padding(top = Space.sm)) }
                items(state.statements, key = { it.weekKey }) { st ->
                    val (tint, label) = when (st.status) {
                        "released" -> c.statusSuccess to "Released"
                        "held" -> c.statusDanger to "Held"
                        else -> c.statusWarning to "Pending"
                    }
                    GlassCard(padding = PaddingValues(Space.md)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text("Week ${st.weekKey.substringAfter("-W")} · ${st.weekKey.take(4)}", style = ZipperTheme.type.labelM, color = c.textPrimary)
                                Text("Gifts ${indianGrouping(st.giftBeans)} · Calls ${indianGrouping(st.callBeans)}" + (if (st.convertedBeans > 0) " · Converted ${indianGrouping(st.convertedBeans)}" else ""), style = ZipperTheme.type.caption, color = c.textSecondary)
                                if (st.status == "held" && st.heldReason.isNotBlank()) Text(st.heldReason, style = ZipperTheme.type.caption, color = c.statusDanger)
                            }
                            Column(horizontalAlignment = Alignment.End) {
                                Text("₹${"%,.0f".format(st.amountInr)}", style = ZipperTheme.type.numericM, color = c.textPrimary)
                                Chip(label, tint = tint.copy(0.14f), contentColor = tint)
                            }
                        }
                    }
                }
            }

            if (state.transactions.isNotEmpty()) {
                item { SectionHeader("Recent activity", Modifier.padding(top = Space.sm)) }
                items(state.transactions.take(30), key = { it.id }) { t ->
                    // Direction comes from `type`, via the model, and never from
                    // the sign of `amount`: this row used to read
                    // `t.amount >= 0`, which every stored row satisfies, so a
                    // conversion that spent the host's beans was shown as a
                    // green credit with a `+` in the one place they check what
                    // happened to their money.
                    val moneyIn = t.isMoneyIn
                    Row(Modifier.fillMaxWidth().padding(vertical = Space.sm), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
                        Box(Modifier.size(36.dp).background(if (moneyIn) c.tintSuccessSubtle else c.tintDangerSubtle, CircleShape), contentAlignment = Alignment.Center) {
                            CurrencyDisc(Currency.Bean, 14.dp)
                        }
                        Column(Modifier.weight(1f)) {
                            Text(t.reasonLabel.ifBlank { t.reason.replace('_', ' ').replaceFirstChar { ch -> ch.uppercase() } }, style = ZipperTheme.type.bodyM, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                                Text(timeAgo(t.timestamp), style = ZipperTheme.type.caption, color = c.textMuted)
                                // A release is not a new earning, it is last
                                // week's earnings becoming withdrawable, and a
                                // host comparing this list against the
                                // statements above needs to see which row is
                                // which. Same word the statements use.
                                if (t.isRelease) Chip("Released", tint = c.statusSuccess.copy(0.14f), contentColor = c.statusSuccess)
                            }
                        }
                        Text(t.signPrefix + indianGrouping(t.amount), style = ZipperTheme.type.numericS, color = if (moneyIn) c.currencyBean else c.statusDanger)
                    }
                    HairlineDivider()
                }
            }
            item { Spacer(Modifier.navigationBarsPadding()) }
        }
    }
}

@Composable
private fun Stat(label: String, value: String) {
    val c = ZipperTheme.colors
    Column { Text(label, style = ZipperTheme.type.caption, color = c.textSecondary); Text(value, style = ZipperTheme.type.numericS, color = c.textPrimary) }
}

@Composable
private fun Notice(text: String, tint: Color) {
    Row(Modifier.fillMaxWidth().background(tint.copy(0.12f), RoundedCornerShape(Radius.md)).border(1.dp, tint.copy(0.5f), RoundedCornerShape(Radius.md)).padding(Space.md)) {
        Text(text, style = ZipperTheme.type.bodyS, color = tint)
    }
}

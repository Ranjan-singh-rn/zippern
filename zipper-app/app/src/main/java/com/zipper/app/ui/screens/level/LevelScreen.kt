package com.zipper.app.ui.screens.level

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.app.data.repository.LevelConfigRepository
import com.zipper.app.ui.components.*
import com.zipper.app.ui.screens.profile.GlassCard
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import com.zipper.app.util.LevelEngine
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import javax.inject.Inject

// ─────────────────────────────────────────────────────────────────────────────
// ViewModel
// ─────────────────────────────────────────────────────────────────────────────

internal data class LevelScreenState(
    val loading: Boolean = true,
    val userLevels: List<LevelConfigRepository.UserLevelConfig> = emptyList(),
    val hostLevels: List<LevelConfigRepository.HostLevelConfig> = emptyList(),
    val userThresholds: LongArray = LevelEngine.USER_THRESHOLDS,
    val hostThresholds: LongArray = LevelEngine.HOST_THRESHOLDS,
    // Current user data (loaded from Firestore users/{uid})
    val totalXp: Long = 0L,
    val totalBeansEarned: Long = 0L,
    val isHost: Boolean = false,
)

@HiltViewModel
class LevelScreenViewModel @Inject constructor(
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
    private val levelRepo: LevelConfigRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(LevelScreenState())
    internal val state: StateFlow<LevelScreenState> = _state.asStateFlow()

    init {
        load()
    }

    private fun load() {
        viewModelScope.launch {
            // Load level config and user data in parallel
            val userLevelsDeferred  = launch { loadLevelConfig() }
            val userDataDeferred    = launch { loadUserData() }
            userLevelsDeferred.join()
            userDataDeferred.join()
            _state.update { it.copy(loading = false) }
        }
    }

    private suspend fun loadLevelConfig() {
        val userLevels  = levelRepo.getUserLevels()
        val hostLevels  = levelRepo.getHostLevels()
        _state.update { it.copy(
            userLevels       = userLevels,
            hostLevels       = hostLevels,
            userThresholds   = userLevels.map { l -> l.xpRequired }.toLongArray(),
            hostThresholds   = hostLevels.map { l -> l.beansRequired }.toLongArray(),
        ) }
    }

    private suspend fun loadUserData() {
        val uid = auth.currentUser?.uid ?: return
        try {
            val doc = firestore.collection("users").document(uid).get().await()
            _state.update { it.copy(
                totalXp          = doc.getLong("totalXp") ?: 0L,
                totalBeansEarned = doc.getLong("totalBeansEarned") ?: 0L,
                isHost           = doc.getBoolean("isHost") ?: false,
            ) }
        } catch (_: Exception) { /* keep defaults */ }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen
// ─────────────────────────────────────────────────────────────────────────────

/*
 * My Level — spending (wealth) level, plus the host ladder for hosts.
 *
 *   Hero: 72dp gold level disc, frame name, XP/beans figure, brand-gradient
 *   progress bar and "n more to Level x".
 *   Ladder: one glass row per level — LevelChip, threshold (Indian grouping),
 *   perks caption. The current level row is outlined in brand.
 *   Rules: expandable glass card.
 */
@Composable
fun LevelScreen(
    onBack: () -> Unit = {},
    viewModel: LevelScreenViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    var selectedTab by remember { mutableIntStateOf(0) }

    // Derive current level from dynamic thresholds
    val userInfo = remember(state.totalXp, state.userThresholds) { LevelEngine.computeUserLevel(state.totalXp, state.userThresholds) }
    val hostInfo = remember(state.totalBeansEarned, state.hostThresholds) { LevelEngine.computeHostLevel(state.totalBeansEarned, state.hostThresholds) }

    // Spec §10 / F-16: the host tab exists for a HOST only, and a non-host can
    // never land on it — whatever `selectedTab` says (a revoked host mid-session).
    val visibility = com.zipper.app.util.LevelVisibility.decide(state.isHost, selectedTab)
    val isHostTab = visibility.effectiveTab == com.zipper.app.util.LevelVisibility.TAB_HOST
    val levels: List<LevelConfigRepository.LevelConfig> = if (isHostTab) state.hostLevels else state.userLevels
    val current = if (isHostTab) hostInfo.level else userInfo.level
    val spending = if (isHostTab) state.totalBeansEarned else state.totalXp

    val currentLevelData = levels.firstOrNull { it.level == current }
    val nextLevelData = levels.firstOrNull { it.level == current + 1 }
    val currentThreshold = currentLevelData?.threshold() ?: 0L
    val nextThreshold = nextLevelData?.threshold() ?: 0L
    val progress = if (nextLevelData != null && nextThreshold > currentThreshold) {
        ((spending - currentThreshold).toFloat() / (nextThreshold - currentThreshold).toFloat()).coerceIn(0f, 1f)
    } else if (nextLevelData == null) 1f else 0f
    val unit = if (isHostTab) "beans" else "XP"

    ZipperScreen(topBar = { TopBar("My Level", onBack = onBack) }) { _ ->
        if (state.loading) { LoadingState(); return@ZipperScreen }
        LazyColumn(contentPadding = PaddingValues(horizontal = Space.lg, vertical = Space.md), verticalArrangement = Arrangement.spacedBy(Space.md)) {
            if (visibility.showHostLevel) {
                item {
                    Row(Modifier.fillMaxWidth().height(38.dp).background(c.bgRaised, CircleShape).padding(2.dp), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                        listOf("Wealth level", "Host level").forEachIndexed { i, t ->
                            val on = selectedTab == i
                            Box(
                                Modifier.weight(1f).fillMaxHeight()
                                    .then(if (on) Modifier.background(Brush.horizontalGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), CircleShape) else Modifier)
                                    .clickableNoRipple { selectedTab = i },
                                contentAlignment = Alignment.Center,
                            ) { Text(t, style = ZipperTheme.type.labelM, color = if (on) Color.White else c.textMuted) }
                        }
                    }
                }
            }

            // Hero
            item {
                GlassCard(padding = PaddingValues(Space.xl)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.lg)) {
                        Box(
                            Modifier.size(72.dp).background(Brush.linearGradient(listOf(Color(0xFFFFE08A), Color(0xFFFFB627), Color(0xFFE89806))), CircleShape)
                                .border(2.dp, Color.White.copy(alpha = 0.35f), CircleShape),
                            contentAlignment = Alignment.Center,
                        ) { Text("$current", style = ZipperTheme.type.displayM, color = Color(0xFF0E0F21)) }
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Space.xxs)) {
                            Text(if (isHostTab) "Host level $current" else "Level $current", style = ZipperTheme.type.headingS, color = c.textPrimary)
                            val frame = currentLevelData?.frameName.orEmpty()
                            if (frame.isNotBlank()) Text(frame, style = ZipperTheme.type.bodyS, color = c.textBrand)
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
                                if (isHostTab) CurrencyDisc(Currency.Bean, 14.dp) else CurrencyDisc(Currency.Diamond, 14.dp)
                                Text(indianGrouping(spending), style = ZipperTheme.type.numericM, color = if (isHostTab) c.currencyBean else c.currencyDiamond)
                                Text(unit, style = ZipperTheme.type.caption, color = c.textSecondary)
                            }
                        }
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Box(Modifier.fillMaxWidth().height(6.dp).background(c.bgElevated, CircleShape)) {
                            Box(Modifier.fillMaxWidth(progress).fillMaxHeight().background(Brush.horizontalGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), CircleShape))
                        }
                        if (nextLevelData != null) {
                            val remaining = (nextThreshold - spending).coerceAtLeast(0L)
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("${indianGrouping(remaining)} more $unit to level ${nextLevelData.level}", style = ZipperTheme.type.caption, color = c.textSecondary)
                                Text("${indianGrouping(spending)} / ${indianGrouping(nextThreshold)}", style = ZipperTheme.type.caption, color = c.textMuted)
                            }
                        } else {
                            Text("Max level reached", style = ZipperTheme.type.labelS, color = c.currencyCoin)
                        }
                    }
                }
            }

            // Ladder
            item { SectionHeader("Level ladder", Modifier.padding(top = Space.xs)) }
            items(levels, key = { it.level }) { lvl ->
                val isCurrent = lvl.level == current
                val reached = lvl.level <= current
                Row(
                    Modifier.fillMaxWidth()
                        .background(Brush.verticalGradient(listOf(Color(0x12FFFFFF), Color(0x05FFFFFF))), RoundedCornerShape(Radius.lg))
                        .border(1.dp, if (isCurrent) c.brandPrimary else c.borderSubtle, RoundedCornerShape(Radius.lg))
                        .padding(horizontal = Space.lg, vertical = Space.md),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md),
                ) {
                    LevelChip(lvl.level)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text("${indianGrouping(lvl.threshold())} $unit", style = ZipperTheme.type.labelM, color = if (reached) c.textPrimary else c.textSecondary)
                        Text(perksText(lvl), style = ZipperTheme.type.caption, color = c.textMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    if (isCurrent) Chip("Current") else if (reached) Chip("Reached", tint = c.tintSuccessSubtle, contentColor = c.statusSuccess)
                }
            }

            item { LevelRulesCard(isHost = isHostTab) }
            item { Spacer(Modifier.navigationBarsPadding()) }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Level rules expandable card
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun LevelRulesCard(isHost: Boolean) {
    val c = ZipperTheme.colors
    var expanded by remember { mutableStateOf(false) }
    GlassCard(Modifier.animateContentSize().clickableNoRipple { expanded = !expanded }) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text("Level rules", style = ZipperTheme.type.labelL, color = c.textPrimary)
            Icon(if (expanded) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown, null, tint = c.textMuted)
        }
        AnimatedVisibility(visible = expanded, enter = expandVertically(), exit = shrinkVertically()) {
            Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                if (!isHost) {
                    BulletText("Calls: 100% of diamonds spent")
                    BulletText("Gifts: 100% of diamonds spent")
                    BulletText("Lucky Gifts & Games: 1% of cost counted")
                } else {
                    BulletText("Based on total beans earned from calls and gifting")
                    BulletText("Withdrawals do not reset your level progress")
                }
            }
        }
    }
}

@Composable
private fun BulletText(text: String) {
    val c = ZipperTheme.colors
    Row(verticalAlignment = Alignment.Top) {
        Text("• ", style = ZipperTheme.type.bodyS, color = c.textBrand)
        Text(text, style = ZipperTheme.type.bodyS, color = c.textSecondary)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

private fun LevelConfigRepository.LevelConfig.threshold(): Long = when (this) {
    is LevelConfigRepository.HostLevelConfig -> beansRequired
    is LevelConfigRepository.UserLevelConfig -> xpRequired
    else -> 0L
}

private fun perksText(info: LevelConfigRepository.LevelConfig): String {
    val perks = mutableListOf<String>()
    if (info.frameName.isNotBlank()) perks += "Frame: ${info.frameName}"
    if (info.entranceName.isNotBlank()) perks += "Entrance: ${info.entranceName}"
    when (info) {
        is LevelConfigRepository.UserLevelConfig -> {
            if (info.profileCard.isNotBlank()) perks += "Card: ${info.profileCard}"
            if (info.bonusDiamonds > 0L) perks += "+${indianGrouping(info.bonusDiamonds)} diamonds"
        }
        is LevelConfigRepository.HostLevelConfig -> {
            if (info.bonusDiamonds > 0L) perks += "+${indianGrouping(info.bonusDiamonds)} diamonds"
            if (info.bonusBeans > 0L) perks += "+${indianGrouping(info.bonusBeans)} beans"
            if (info.maxCallRateBeans > 0L) perks += "Rate ceiling ${indianGrouping(info.maxCallRateBeans)}/min"
        }
    }
    return if (perks.isEmpty()) "Starting level — keep going to unlock perks" else perks.joinToString(" · ")
}

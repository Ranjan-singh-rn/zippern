package com.zipper.app.ui.screens.level

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Videocam
import androidx.compose.material3.Icon
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.zipper.app.data.model.DAILY_REWARDS_OFFLINE_FALLBACK
import com.zipper.app.data.model.DailyReward
import com.zipper.app.data.repository.DailyClaimResult
import com.zipper.app.data.repository.DailyRewardsConfigRepository
import com.zipper.app.data.repository.ProfileRepository
import com.zipper.app.ui.components.*
import com.zipper.app.ui.screens.profile.GlassCard
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

// ── ViewModel ─────────────────────────────────────────────────────────────────

data class DailyRewardsUiState(
    val streak: Int = 0,
    val todayClaimed: Boolean = false,
    /**
     * Yesterday was claimed, so today continues the run instead of restarting
     * it. The server decides this from `lastDailyClaimDate == yesterday`; this
     * mirrors that read so the strip highlights the day that will actually be
     * credited.
     */
    val streakContinues: Boolean = false,
    /**
     * What the CRM says the run is. Starts as the offline list so the strip is
     * never empty, and is replaced by `appConfig/dailyRewards` the moment
     * Firestore answers.
     */
    val schedule: List<DailyReward> = DAILY_REWARDS_OFFLINE_FALLBACK,
    val scheduleIsFallback: Boolean = true,
    val isUserLoading: Boolean = true,
    val isScheduleLoading: Boolean = true,
    val isClaiming: Boolean = false,
    val toastMessage: String? = null,
) {
    /**
     * Both halves in. Used to decide whether the fallback notice is worth
     * showing — NOT to gate the Claim button, which must not wait on a display
     * config the server does not consult.
     */
    val isLoading: Boolean get() = isUserLoading || isScheduleLoading

    /**
     * How many days the run is.
     *
     * Was the literal 7 — in the streak latch, in the claim toast's day
     * arithmetic, in the card's "all 7 days" copy, and in the length of the
     * compiled-in table the strip was drawn from. The server wraps the streak on
     * `sched.length`, so a five-day or a ten-day schedule is a legitimate thing
     * for an admin to save, and a hardcoded 7 breaks in both directions: it
     * shows days that do not exist, and it hides days that do.
     */
    val scheduleLength: Int get() = schedule.size.coerceAtLeast(1)

    /**
     * Which day of the run today is, by the server's own arithmetic
     * (`claimDailyReward`, functions/src/wallet.ts).
     *
     * Once claimed, `dailyStreak` IS today's day — the server wrote it. Before
     * claiming it is the next rung, wrapped, or day 1 if the run has lapsed.
     * The old `streak + 1` was right for six days out of seven and then said
     * "day 8" of a seven-day schedule, at which point no cell matched, every
     * cell rendered as already claimed, and the reward card showed nothing.
     */
    val todayDay: Int get() = when {
        todayClaimed    -> streak.coerceIn(1, scheduleLength)
        streakContinues -> (streak % scheduleLength) + 1
        else            -> 1
    }

    /** The day a claim tomorrow would land on, wrapped the same way. */
    val tomorrowDay: Int get() = (todayDay % scheduleLength) + 1

    /**
     * Today's row, or the first row.
     *
     * The `?: firstOrNull` is not padding — it is what the server falls back to
     * (`sched.find(...) ?? sched[0]`), so a schedule with a gap in its day
     * numbering still shows the reward that will actually be paid.
     */
    val todayReward: DailyReward? get() =
        schedule.find { it.day == todayDay } ?: schedule.firstOrNull()
}

@HiltViewModel
class DailyRewardsViewModel @Inject constructor(
    private val repo: ProfileRepository,
    private val rewardsConfig: DailyRewardsConfigRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(DailyRewardsUiState())
    val state: StateFlow<DailyRewardsUiState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            repo.currentUserFlow().collect { user ->
                if (user == null) {
                    _state.update { it.copy(isUserLoading = false) }
                    return@collect
                }
                // Compare IST calendar days, the same way the server does. This
                // is display only — the server refuses a second claim whatever
                // the button looks like, and grants the day IT computes.
                val today = istDateKey()
                val yesterday = istDateKey(daysAgo = 1)
                _state.update {
                    it.copy(
                        streak          = user.dailyStreak,
                        todayClaimed    = user.lastDailyClaimDate == today,
                        streakContinues = user.lastDailyClaimDate == yesterday,
                        isUserLoading   = false,
                    )
                }
            }
        }

        // The payout table, from the CRM. Live rather than one-shot: an admin who
        // corrects an amount should see the app agree with the CRM without a
        // release, which is the entire point of moving it off the APK.
        viewModelScope.launch {
            rewardsConfig.observe().collect { cfg ->
                _state.update {
                    it.copy(
                        schedule           = cfg.schedule,
                        scheduleIsFallback = cfg.isFallback,
                        isScheduleLoading  = false,
                    )
                }
            }
        }
    }

    /** A day in IST as `yyyy-MM-dd` — matches the server's day key. */
    private fun istDateKey(daysAgo: Int = 0): String {
        val fmt = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US)
        fmt.timeZone = java.util.TimeZone.getTimeZone("Asia/Kolkata")
        return fmt.format(java.util.Date(System.currentTimeMillis() - daysAgo * 24L * 60 * 60 * 1000))
    }

    fun claim() {
        if (_state.value.isClaiming) return
        viewModelScope.launch {
            _state.update { it.copy(isClaiming = true) }
            // Every number in this message comes from the server's reply.
            // It used to recompute the day as `(streakBeforeClaim % 7) + 1` and
            // read the amount out of the app's own table, so the toast and the
            // balance disagreed the moment the CRM changed either one — and the
            // streak had to be captured before suspending because the local
            // recomputation raced the user-document listener. Nothing local is
            // computed now, so there is no race left to lose.
            val msg = when (val result = repo.claimDailyReward()) {
                is DailyClaimResult.Claimed -> buildString {
                    append("Day ${result.day} claimed! +${indianGrouping(result.diamonds)} 💎")
                    if (result.videoCards > 0) {
                        append(" +${result.videoCards} video card${if (result.videoCards > 1) "s" else ""} 📹")
                    }
                }
                is DailyClaimResult.Error -> result.message
            }
            _state.update { it.copy(isClaiming = false, toastMessage = msg) }
        }
    }

    fun clearToast() = _state.update { it.copy(toastMessage = null) }
}

// ── Screen ────────────────────────────────────────────────────────────────────

/*
 * Daily rewards — the day strip (today = brand gradient, claimed days a mint
 * check, future days glass with a lock), today's reward card, and a gradient
 * Claim button that is disabled once today is claimed.
 *
 * The strip is as long as `appConfig/dailyRewards` says, and the only thing that
 * disables Claim is having already claimed today. There used to be a second
 * latch — `streak >= 7` — and it was a trap: reaching day 7 disabled the button
 * permanently, while the only thing that would have moved the streak off 7 was
 * the claim the button now refused to make. The wrap belongs to the server, and
 * the server has always done it.
 */
@Composable
fun DailyRewardsScreen(
    onBack: () -> Unit = {},
    viewModel: DailyRewardsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(state.toastMessage) {
        val msg = state.toastMessage
        if (msg != null) {
            snackbarHostState.showSnackbar(msg)
            viewModel.clearToast()
        }
    }

    val streak = state.streak
    val todayClaimed = state.todayClaimed
    val todayDay = state.todayDay
    val todayReward = state.todayReward

    ZipperScreen(topBar = { TopBar("Daily rewards", onBack = onBack) }) { _ ->
        Box(Modifier.fillMaxSize()) {
            Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = Space.lg, vertical = Space.md),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(Space.lg),
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.xs)) {
                    Text(
                        if (streak == 0) "Start your streak" else "Day $streak streak",
                        style = ZipperTheme.type.headingL, color = if (streak == 0) c.textPrimary else c.textBrand, textAlign = TextAlign.Center,
                    )
                    Text("Check in daily to earn diamonds and free call cards", style = ZipperTheme.type.bodyS, color = c.textSecondary, textAlign = TextAlign.Center)
                }

                DayStrip(schedule = state.schedule, todayDay = todayDay, todayClaimed = todayClaimed)

                // Reward details
                GlassCard {
                    if (todayReward != null) {
                        Text(
                            if (todayClaimed) "Day $todayDay · claimed" else "Day $todayDay reward",
                            style = ZipperTheme.type.caption, color = c.textSecondary,
                        )
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                            CurrencyDisc(Currency.Diamond, 24.dp)
                            Text(indianGrouping(todayReward.diamonds), style = ZipperTheme.type.numericL, color = c.currencyDiamond)
                            Text("diamonds", style = ZipperTheme.type.bodyM, color = c.textSecondary)
                        }
                        if (todayReward.freeCallMinutes > 0) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
                                Icon(Icons.Outlined.Videocam, null, tint = c.currencyDiamond, modifier = Modifier.size(16.dp))
                                Text("+${todayReward.freeCallMinutes} free video call card${if (todayReward.freeCallMinutes > 1) "s" else ""}", style = ZipperTheme.type.bodyS, color = c.textPrimary)
                            }
                        }
                    } else {
                        Text("Today's reward", style = ZipperTheme.type.caption, color = c.textSecondary)
                        Text("Claim to find out — the server decides the amount.", style = ZipperTheme.type.labelL, color = c.textPrimary)
                    }

                    // The amounts on this card are what the CRM has on record.
                    // When that document cannot be read they are the list built
                    // into this build instead, and saying so is the difference
                    // between a stale number and a lie.
                    if (state.scheduleIsFallback && !state.isLoading) {
                        Text(
                            "Amounts are indicative — the live schedule could not be read. You will be credited whatever Zipper has on record.",
                            style = ZipperTheme.type.caption, color = c.statusWarning,
                        )
                    }

                    val bottomNote = when {
                        todayClaimed -> "Come back tomorrow for the Day ${state.tomorrowDay} reward."
                        streak > 0 && !state.streakContinues ->
                            "Your last streak lapsed, so today starts again at Day 1."
                        else -> "Rewards grow every day you check in. Miss a day and the streak starts over."
                    }
                    Text(bottomNote, style = ZipperTheme.type.caption, color = c.textMuted)
                }

                ZipperButton(
                    if (todayClaimed) "Claimed today" else "Claim today's reward",
                    onClick = { viewModel.claim() },
                    // Only "have I already claimed today?". Not "is my streak at
                    // its maximum" — that question has no answer, because the run
                    // repeats. Deliberately does not wait on the schedule load:
                    // the server does not consult it to decide what to pay.
                    enabled = !state.isUserLoading && !todayClaimed && !state.isClaiming,
                    loading = state.isClaiming,
                    gradient = true, fullWidth = true,
                )
                Spacer(Modifier.navigationBarsPadding())
            }
            SnackbarHost(snackbarHostState, Modifier.align(Alignment.BottomCenter).navigationBarsPadding())
        }
    }
}

// ── Day strip ─────────────────────────────────────────────────────────────────

/** Days that still fit the screen width when each cell takes an equal share. */
private const val STRIP_FIT_MAX = 7
private val STRIP_CELL_WIDTH = 46.dp

/**
 * The run, one cell per configured day.
 *
 * Weighted cells fill the width for a schedule of ordinary length, and a longer
 * one scrolls. A CRM admin may configure ten days, and ten weighted cells are
 * thin enough that "Day 10" and its diamond count no longer fit inside one.
 */
@Composable
private fun DayStrip(schedule: List<DailyReward>, todayDay: Int, todayClaimed: Boolean) {
    if (schedule.size <= STRIP_FIT_MAX) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
            schedule.forEach { reward ->
                DayCell(reward = reward, todayDay = todayDay, todayClaimed = todayClaimed, modifier = Modifier.weight(1f))
            }
        }
    } else {
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(Space.xs),
        ) {
            schedule.forEach { reward ->
                DayCell(reward = reward, todayDay = todayDay, todayClaimed = todayClaimed, modifier = Modifier.width(STRIP_CELL_WIDTH))
            }
        }
    }
}

// ── Day cell ──────────────────────────────────────────────────────────────────

private enum class DayCellState { PAST, TODAY_UNCLAIMED, TODAY_CLAIMED, FUTURE }

@Composable
private fun DayCell(reward: DailyReward, todayDay: Int, todayClaimed: Boolean, modifier: Modifier = Modifier) {
    val c = ZipperTheme.colors
    val cell = when {
        reward.day < todayDay                   -> DayCellState.PAST
        reward.day == todayDay && todayClaimed  -> DayCellState.TODAY_CLAIMED
        reward.day == todayDay && !todayClaimed -> DayCellState.TODAY_UNCLAIMED
        else                                    -> DayCellState.FUTURE
    }
    val isToday = cell == DayCellState.TODAY_UNCLAIMED || cell == DayCellState.TODAY_CLAIMED
    val claimed = cell == DayCellState.PAST || cell == DayCellState.TODAY_CLAIMED
    val shape = RoundedCornerShape(Radius.md)
    val labelColor = when (cell) {
        DayCellState.FUTURE -> c.textMuted
        DayCellState.PAST -> c.currencyBean
        else -> Color.White
    }

    Column(
        modifier.aspectRatio(0.72f)
            .then(
                if (isToday) Modifier.background(Brush.verticalGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), shape)
                else Modifier.background(Brush.verticalGradient(listOf(Color(0x12FFFFFF), Color(0x05FFFFFF))), shape).border(1.dp, if (claimed) c.currencyBean.copy(0.5f) else c.borderSubtle, shape)
            )
            .padding(horizontal = Space.xxs, vertical = Space.sm),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.SpaceBetween,
    ) {
        Text("Day ${reward.day}", style = ZipperTheme.type.overline, color = labelColor, textAlign = TextAlign.Center, maxLines = 1)
        Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) {
            when {
                claimed -> Box(Modifier.size(18.dp).background(c.currencyBean, CircleShape), contentAlignment = Alignment.Center) {
                    Icon(Icons.Filled.Check, null, tint = c.textInverse, modifier = Modifier.size(12.dp))
                }
                cell == DayCellState.FUTURE -> Icon(Icons.Outlined.Lock, null, tint = c.textMuted, modifier = Modifier.size(14.dp))
                else -> CurrencyDisc(Currency.Diamond, 16.dp)
            }
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(reward.diamonds.toString(), style = ZipperTheme.type.numericS, color = if (isToday) Color.White else if (cell == DayCellState.FUTURE) c.textMuted else c.textPrimary, textAlign = TextAlign.Center, maxLines = 1)
            if (reward.freeCallMinutes > 0) Icon(Icons.Outlined.Videocam, null, tint = if (isToday) Color.White else c.currencyDiamond.copy(if (cell == DayCellState.FUTURE) 0.4f else 0.9f), modifier = Modifier.size(12.dp))
        }
    }
}

package com.zipper.app.ui.screens.live

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.zipper.app.data.model.GiftLeaderboardEntry
import com.zipper.app.ui.components.*
import com.zipper.app.ui.screens.auth.AmbientGlows
import com.zipper.app.ui.screens.profile.GlassCard
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme

/**
 * What a finished broadcast came to, carried from Go Live to this card.
 *
 * One object rather than five positional arguments: the callback already had
 * three that were easy to transpose — a String and two Longs — and the card
 * needed two more figures that were being faked at the call site.
 */
data class LiveSessionSummary(
    val roomId: String = "",
    val durationSeconds: Long = 0L,
    /** The host's session earnings, in BEANS. Never diamonds; they differ 20x. */
    val totalBeans: Long = 0L,
    /**
     * The most people watching AT ONCE. Not a session total, and the card names
     * it a peak for that reason. See GoLiveUiState.peakViewers for why there is
     * no cumulative figure to put here instead.
     */
    val peakViewers: Int = 0,
    /** Distinct people who gifted. Not [topGifters].size, which stops at 20. */
    val gifterCount: Int = 0,
    val topGifters: List<GiftLeaderboardEntry> = emptyList(),
)

/**
 * The gifter rows for the card, in transit between the two screens.
 *
 * Every FIGURE the card prints travels as a navigation argument, where it
 * survives process death and belongs unambiguously to one session. The rows
 * cannot go that way: a navigation argument is a string, and a SavedStateHandle
 * rejects any value a Bundle cannot hold, which a GiftLeaderboardEntry is. What
 * stood here before was a comment at the call site claiming the leaderboard was
 * "passed via savedStateHandle below" with nothing below it, so the card was
 * handed an empty list and told every host they had 0 gifters.
 *
 * Read, not consumed, so recomposition and a configuration change both still
 * find it. Nothing numeric is derived from it — the "Gifters" stat comes from
 * the route — so if the process dies between the two screens the worst case is
 * that the Top gifters card is missing rather than wrong.
 */
object LiveSummaryGifters {
    @Volatile
    var rows: List<GiftLeaderboardEntry> = emptyList()
        private set

    fun handOff(gifters: List<GiftLeaderboardEntry>) { rows = gifters }
}

/*
 * Post-live summary — a glass card over the ambient glows: beans earned
 * (numeric L, mint) with duration · peak viewers · gifters, then the top three
 * gifters and a gradient "Done".
 */
@Composable
fun LiveSummaryScreen(
    durationSeconds: Long,
    totalBeans: Long,
    peakViewers: Int,
    gifterCount: Int,
    topGifters: List<GiftLeaderboardEntry>,
    onDone: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = ZipperTheme.colors
    Box(modifier.fillMaxSize().background(c.bgBase)) {
        AmbientGlows()
        Column(
            Modifier.fillMaxSize().statusBarsPadding().padding(horizontal = Space.lg, vertical = Space.x3l),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Space.xl),
        ) {
            Spacer(Modifier.weight(1f))
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.xs)) {
                Text("Live ended", style = ZipperTheme.type.displayM, color = c.textPrimary, textAlign = TextAlign.Center)
                Text("Here's how it went", style = ZipperTheme.type.bodyM, color = c.textSecondary, textAlign = TextAlign.Center)
            }

            GlassCard {
                Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.xs)) {
                    Text("Beans earned", style = ZipperTheme.type.caption, color = c.textSecondary)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                        CurrencyDisc(Currency.Bean, 24.dp)
                        Text(indianGrouping(totalBeans), style = ZipperTheme.type.numericL, color = c.currencyBean)
                    }
                }
                HairlineDivider()
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                    Stat("Duration", formatDuration(durationSeconds))
                    /*
                     * "Peak viewers", not "Viewers".
                     *
                     * The number is the highest concurrent audience the stream
                     * reached, and nothing in the app records a cumulative or
                     * unique-viewer total to print instead. Under the old label
                     * a host whose stream 400 people passed through would read
                     * the dozen who were still there at the end as the whole
                     * night's audience, and conclude nobody came.
                     */
                    Stat("Peak viewers", indianGrouping(peakViewers.toLong()))
                    // Distinct gifters, counted before the leaderboard was cut
                    // to 20 — topGifters.size would say 20 for a room where a
                    // hundred people gifted, and 0 whenever the rows went
                    // missing in transit.
                    Stat("Gifters", indianGrouping(gifterCount.toLong()))
                }
            }

            if (topGifters.isNotEmpty()) {
                GlassCard {
                    Text("Top gifters", style = ZipperTheme.type.headingS, color = c.textPrimary)
                    topGifters.take(3).forEachIndexed { idx, gifter -> GifterRow(rank = idx + 1, gifter = gifter) }
                }
            }

            Text("Thank you for streaming — keep up the great content.", style = ZipperTheme.type.bodyM, color = c.textSecondary, textAlign = TextAlign.Center)
            Spacer(Modifier.weight(1f))
            ZipperButton("Done", onDone, gradient = true, fullWidth = true)
            Spacer(Modifier.navigationBarsPadding())
        }
    }
}

@Composable
private fun Stat(label: String, value: String) {
    val c = ZipperTheme.colors
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value, style = ZipperTheme.type.numericM, color = c.textPrimary)
        Text(label, style = ZipperTheme.type.caption, color = c.textSecondary)
    }
}

@Composable
private fun GifterRow(rank: Int, gifter: GiftLeaderboardEntry) {
    val c = ZipperTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
        Box(
            Modifier.size(24.dp).then(
                if (rank == 1) Modifier.background(Brush.horizontalGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), CircleShape)
                else Modifier.background(c.bgElevated, CircleShape)
            ),
            contentAlignment = Alignment.Center,
        ) { Text("$rank", style = ZipperTheme.type.labelS, color = if (rank == 1) c.textOnBrand else c.textSecondary) }
        Avatar(gifter.photoUrl.ifBlank { null }, size = AvatarSize.SM, initial = gifter.name)
        Text(gifter.name.ifBlank { "User" }, style = ZipperTheme.type.labelM, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Price(Currency.Diamond, gifter.totalDiamonds, color = c.currencyDiamond)
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

private fun formatDuration(seconds: Long): String {
    val h = seconds / 3600
    val m = (seconds % 3600) / 60
    val s = seconds % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}

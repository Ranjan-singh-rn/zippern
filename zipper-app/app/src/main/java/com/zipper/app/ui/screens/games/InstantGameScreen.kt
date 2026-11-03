package com.zipper.app.ui.screens.games

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Info
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.zipper.app.data.repository.GameFunctions
import com.zipper.app.ui.components.*
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import kotlinx.coroutines.delay

/**
 * The quick games (B5): Peg Drop, Mela Reels, Lucky Catch, Lane Hopper, Zip Flight. One screen, one view model, a
 * different board in the middle. Every animation shows a result the server has already decided.
 */
@Composable
fun InstantGameScreen(
    onBack: () -> Unit,
    onRecharge: () -> Unit,
    viewModel: InstantGameViewModel = hiltViewModel(),
) {
    val s by viewModel.state.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    val look = lookOf(s.gameId)
    ZipperScreen(topBar = {
        TopBar(look.name, onBack = onBack, actions = { CurrencyPill(Currency.Diamond, s.diamonds, onClick = onRecharge) })
    }) { _ ->
        if (s.game == null) {
            if (s.error != null) EmptyState(Icons.Default.Info, "Not available", s.error ?: "")
            else LoadingState()
            return@ZipperScreen
        }
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(Space.lg),
            verticalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            Box(
                Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(look.from, look.to)), RoundedCornerShape(Radius.lg)).padding(Space.md),
            ) {
                when (s.gameId) {
                    "plinko" -> PlinkoBoard(s)
                    "slots" -> SlotsBoard(s)
                    "fishing" -> FishingBoard(s)
                    "chicken_road" -> ChickenBoard(s)
                    "crash" -> FlightBoard(s, viewModel)
                    else -> MoreGameBoard(s, viewModel)
                }
            }
            s.last?.let { r -> ResultBanner(r.payout, s.entry, r.multiplier) }
            s.error?.let { Text(it, style = ZipperTheme.type.bodyS, color = c.statusDanger) }
            val locked = s.busy || s.open != null
            Text("Entry", style = ZipperTheme.type.labelM, color = c.textSecondary)
            ChoiceRow(s.entries, s.entry, { diamondsText(it) }, enabled = !locked) { viewModel.setEntry(it) }
            GameOptions(s, viewModel, locked)
            Actions(s, viewModel)
            Text(rulesFor(s.gameId), style = ZipperTheme.type.caption, color = c.textMuted)
            s.game?.let { g -> Text("Returns ${feeText(100 - g.houseEdgePct)} of play over time.", style = ZipperTheme.type.caption, color = c.textMuted) }
            Text(FAIRNESS_LINE + if (s.commit.isNotBlank()) " Current commitment: ${s.commit.take(16)}…" else "",
                style = ZipperTheme.type.caption, color = c.textMuted)
            Spacer(Modifier.height(Space.x3l))
        }
    }
}

@Composable
private fun GameOptions(s: InstantState, vm: InstantGameViewModel, locked: Boolean) {
    val c = ZipperTheme.colors
    when (s.gameId) {
        "plinko" -> {
            Text("Rows", style = ZipperTheme.type.labelM, color = c.textSecondary)
            ChoiceRow(listOf(8, 12, 16), s.rows, { "$it" }, enabled = !locked) { vm.setRows(it) }
            Text("Risk", style = ZipperTheme.type.labelM, color = c.textSecondary)
            ChoiceRow(listOf("low", "medium", "high"), s.risk, { it.replaceFirstChar { ch -> ch.uppercase() } }, enabled = !locked) { vm.setRisk(it) }
        }
        "chicken_road" -> {
            Text("Difficulty", style = ZipperTheme.type.labelM, color = c.textSecondary)
            ChoiceRow(listOf("easy", "medium", "hard", "daredevil"), s.difficulty, { it.replaceFirstChar { ch -> ch.uppercase() } }, enabled = !locked) { vm.setDifficulty(it) }
        }
        "crash" -> {
            Text("Auto cash-out", style = ZipperTheme.type.labelM, color = c.textSecondary)
            ChoiceRow(listOf(0.0, 1.5, 2.0, 3.0, 5.0, 10.0), s.autoCashout, { if (it == 0.0) "Off" else multText(it) }, enabled = !locked) { vm.setAutoCashout(it) }
        }
        else -> MoreGameOptions(s, vm, locked)
    }
}

@Composable
private fun Actions(s: InstantState, vm: InstantGameViewModel) {
    val canPay = s.diamonds >= s.entry && s.entry > 0
    when (s.gameId) {
        "plinko" -> ZipperButton("Drop the ball", vm::playPlinko, fullWidth = true, gradient = true, loading = s.busy, enabled = canPay && !s.busy)
        "slots" -> ZipperButton("Spin", vm::spinSlots, fullWidth = true, gradient = true, loading = s.busy, enabled = canPay && !s.busy)
        "fishing" -> ZipperButton("Cast the line", vm::castLine, fullWidth = true, gradient = true, loading = s.busy, enabled = canPay && !s.busy)
        "chicken_road" -> if (s.open == null) {
            ZipperButton("Start crossing", vm::startChicken, fullWidth = true, gradient = true, loading = s.busy, enabled = canPay && !s.busy)
        } else {
            val crossed = (s.open.outcome["crossed"] as? Number)?.toInt() ?: 0
            val ladder = (s.open.outcome["ladder"] as? List<*>).orEmpty().mapNotNull { (it as? Number)?.toDouble() }
            Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                ZipperButton("Hop to lane ${crossed + 1}", vm::hop, Modifier.weight(1f), gradient = true, loading = s.busy, enabled = !s.busy)
                ZipperButton(
                    if (crossed > 0) "Collect ${diamondsText((s.entry * (ladder.getOrNull(crossed - 1) ?: 1.0)).toLong())}" else "Collect",
                    vm::collect, Modifier.weight(1f), style = ButtonStyle.Secondary, enabled = !s.busy && crossed > 0,
                )
            }
        }
        "crash" -> if (s.open == null) {
            ZipperButton("Take off", vm::startFlight, fullWidth = true, gradient = true, loading = s.busy, enabled = canPay && !s.busy)
        } else {
            ZipperButton("Cash out", vm::collect, fullWidth = true, gradient = true, loading = s.busy,
                enabled = !s.busy && s.flightPhase == "flying")
        }
        else -> MoreGameActions(s, vm)
    }
}

private fun rulesFor(gameId: String): String = when (gameId) {
    "plinko" -> "The ball bounces left or right on every row and lands in a bin; the bin's multiplier pays your entry. " +
        "More rows and higher risk mean bigger edges and smaller middles."
    "slots" -> "Five reels, three rows, ten lines. Three, four or five matching symbols from the left on a line pay that " +
        "line's prize; all winning lines add up."
    "fishing" -> "Each cast catches one thing — from an old boot to the golden fish. What you catch decides the multiplier."
    "chicken_road" -> "Hop across one lane at a time. Every safe lane raises the multiplier; one lane is lost and ends the " +
        "round with nothing. Collect whenever you like."
    "crash" -> "The flight's multiplier rises until it flies away at a point the server fixed before take-off. Cash out " +
        "before it does to win your entry × the multiplier; if it flies away first, the entry is lost."
    else -> moreRulesFor(gameId)
}

// ── Peg Drop ──────────────────────────────────────────────────────────────────

@Composable
private fun PlinkoBoard(s: InstantState) {
    val r = s.last?.takeIf { it.outcome["path"] != null }
    val rows = (r?.outcome?.get("rows") as? Number)?.toInt() ?: s.rows
    val path = (r?.outcome?.get("path") as? List<*>).orEmpty().mapNotNull { (it as? Number)?.toInt() }
    val table = (r?.outcome?.get("table") as? List<*>).orEmpty().mapNotNull { (it as? Number)?.toDouble() }
    val progress = remember { Animatable(0f) }
    LaunchedEffect(r?.roundId) { progress.snapTo(0f); if (r != null) progress.animateTo(1f, tween(1400, easing = LinearEasing)) }
    Column {
        Canvas(Modifier.fillMaxWidth().aspectRatio(1.1f)) {
            val w = size.width
            val h = size.height * 0.92f
            val gapY = h / (rows + 1)
            val gapX = w / (rows + 2)
            for (row in 0 until rows) {
                for (k in 0..row + 1) {
                    val x = w / 2 + (k - (row + 1) / 2f) * gapX
                    drawCircle(Color.White.copy(alpha = 0.85f), w * 0.008f, Offset(x, gapY * (row + 1)))
                }
            }
            if (path.isNotEmpty()) {
                // The ball follows the server's bounces: after row i it is (rights so far − i/2) gaps from centre.
                val t = progress.value * rows
                val i = t.toInt().coerceAtMost(rows - 1)
                val frac = t - i
                fun xAt(row: Int): Float { val rights = path.take(row).sum(); return w / 2 + (rights - row / 2f) * gapX }
                val x = xAt(i) + (xAt(i + 1) - xAt(i)) * frac
                val y = gapY * (i + frac) + gapY * 0.5f
                drawCircle(Color(0xFFFFD54F), w * 0.022f, Offset(x, y))
            }
        }
        if (table.isNotEmpty()) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                val bin = (r?.outcome?.get("bin") as? Number)?.toInt()
                table.forEachIndexed { k, m ->
                    Text(
                        if (m >= 10) "${m.toInt()}" else String.format(java.util.Locale.US, "%.1f", m),
                        Modifier.weight(1f).background(if (k == bin && progress.value >= 1f) Color(0xFFFFD54F) else Color.White.copy(alpha = 0.2f), RoundedCornerShape(4.dp)).padding(vertical = 2.dp),
                        fontSize = 9.sp, color = Color.White, textAlign = TextAlign.Center, maxLines = 1,
                    )
                }
            }
        }
    }
}

// ── Mela Reels ────────────────────────────────────────────────────────────────

/**
 * The server's grid, reel by reel. It arrives FLAT (`grid` with `reels` × `rows`, index = reel × rows + row) because
 * Firestore stores no array inside an array; a nested grid is read as is.
 */
fun slotGrid(outcome: Map<String, Any?>?): List<List<Int>> {
    val raw = (outcome?.get("grid") as? List<*>).orEmpty()
    if (raw.firstOrNull() is List<*>) return raw.map { col -> (col as? List<*>).orEmpty().mapNotNull { (it as? Number)?.toInt() } }
    val reels = (outcome?.get("reels") as? Number)?.toInt() ?: 5
    val rows = (outcome?.get("rows") as? Number)?.toInt() ?: 3
    val flat = raw.mapNotNull { (it as? Number)?.toInt() }
    if (flat.size < reels * rows) return emptyList()
    return List(reels) { reel -> List(rows) { row -> flat[reel * rows + row] } }
}

private val SLOT_GLYPHS = mapOf(
    "marigold" to "🌼", "kite" to "🪁", "drum" to "🥁", "lantern" to "🏮", "peacock" to "🦚", "elephant" to "🐘",
)

@Composable
private fun SlotsBoard(s: InstantState) {
    val r = s.last
    val grid = slotGrid(r?.outcome)
    val symbols = (r?.outcome?.get("symbols") as? List<*>).orEmpty().map { it.toString() }
    val wins = (r?.outcome?.get("wins") as? List<*>).orEmpty().size
    var spinning by remember { mutableStateOf(false) }
    LaunchedEffect(r?.roundId) { if (r != null) { spinning = true; delay(900); spinning = false } }
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
            for (reel in 0 until 5) {
                Column(Modifier.background(Color.White.copy(alpha = 0.15f), RoundedCornerShape(8.dp)).padding(4.dp)) {
                    for (row in 0 until 3) {
                        val sym = grid.getOrNull(reel)?.getOrNull(row)
                        val glyph = if (spinning || sym == null) listOf("🌼", "🪁", "🥁", "🏮", "🦚", "🐘")[(reel + row + (System.nanoTime() / 1_000_000 % 6).toInt()) % 6]
                        else SLOT_GLYPHS[symbols.getOrNull(sym)] ?: "❔"
                        Text(glyph, fontSize = 30.sp)
                    }
                }
            }
        }
        if (r != null && !spinning) Text(if (wins > 0) "$wins winning line${if (wins > 1) "s" else ""}" else "No line this spin",
            color = Color.White, style = ZipperTheme.type.labelM)
    }
}

// ── Lucky Catch ───────────────────────────────────────────────────────────────

private val CATCH_GLYPHS = mapOf(
    "boot" to "🥾", "minnow" to "🐟", "rohu" to "🐠", "catla" to "🐡", "puffer" to "🐡", "octopus" to "🐙",
    "turtle" to "🐢", "golden" to "🌟",
)

@Composable
private fun FishingBoard(s: InstantState) {
    val r = s.last
    val bob = remember { Animatable(0f) }
    LaunchedEffect(r?.roundId) { if (r != null) { bob.snapTo(0f); bob.animateTo(1f, tween(900, easing = FastOutSlowInEasing)) } }
    Column(Modifier.fillMaxWidth().height(200.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        if (r == null) Text("🎣", fontSize = 64.sp)
        else {
            Text(CATCH_GLYPHS[r.outcome["catch"] as? String] ?: "🐟", fontSize = (40 + 40 * bob.value).sp)
            Text(r.outcome["name"] as? String ?: "", color = Color.White, style = ZipperTheme.type.headingS)
        }
    }
}

// ── Lane Hopper ───────────────────────────────────────────────────────────────

@Composable
private fun ChickenBoard(s: InstantState) {
    val round = s.open ?: s.last
    val crossed = (round?.outcome?.get("crossed") as? Number)?.toInt() ?: 0
    val lanes = (round?.outcome?.get("lanes") as? Number)?.toInt() ?: 20
    val lostAt = (round?.outcome?.get("lostAt") as? Number)?.toInt()
    val ladder = (round?.outcome?.get("ladder") as? List<*>).orEmpty().mapNotNull { (it as? Number)?.toDouble() }
    Column(verticalArrangement = Arrangement.spacedBy(Space.xs)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            for (lane in 0..minOf(lanes, 10)) {
                val here = lane == crossed && lostAt == null
                val dead = lostAt != null && lane == lostAt
                Box(
                    Modifier.weight(1f).height(84.dp).background(
                        when { dead -> Color(0xFFD32F2F); lane == 0 -> Color(0xFF3E2723); lane <= crossed -> Color(0xFF66BB6A); else -> Color(0xFF424242) },
                        RoundedCornerShape(4.dp),
                    ),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(if (here) "🐔" else if (dead) "💥" else if (lane > 0) "🚗".takeIf { lane > crossed + 1 } ?: "" else "", fontSize = 16.sp)
                }
            }
        }
        if (ladder.isNotEmpty()) {
            Text(
                ladder.take(10).mapIndexed { i, m -> (if (i + 1 == crossed) "▶" else "") + multText(m) }.joinToString("  "),
                color = Color.White, fontSize = 11.sp, maxLines = 2,
            )
        }
        if (lostAt != null) Text("Lost at lane $lostAt", color = Color.White, style = ZipperTheme.type.labelM)
    }
}

// ── Zip Flight ────────────────────────────────────────────────────────────────

@Composable
private fun FlightBoard(s: InstantState, vm: InstantGameViewModel) {
    val open = s.open
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(open?.roundId) { while (open != null) { now = System.currentTimeMillis(); delay(50) } }
    val startsAt = open?.startsAtMs ?: 0L
    val m = if (open != null) vm.flightNow(startsAt, now) else (s.last?.outcome?.get("crashAt") as? Number)?.toDouble() ?: 1.0
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Canvas(Modifier.fillMaxWidth().height(180.dp)) {
            val w = size.width; val h = size.height
            val maxM = maxOf(2.0, m * 1.2)
            val p = Path()
            p.moveTo(0f, h)
            val steps = 60
            for (i in 1..steps) {
                val mm = 1.0 + (m - 1.0) * i / steps
                val x = w * i / steps
                val y = h - ((mm - 1.0) / (maxM - 1.0)).toFloat() * h
                p.lineTo(x, y.coerceIn(0f, h))
            }
            drawPath(p, Color.White, style = Stroke(width = 5f))
        }
        val crashed = s.last?.outcome?.get("crashed") == true
        val label = when {
            open != null && s.flightPhase == "countdown" -> "Get ready…"
            open != null -> multText(m)
            crashed -> "Flew away at ${multText(m)}"
            s.last != null -> "Cashed out at ${multText(s.last.multiplier)} · flew away at ${multText(m)}"
            else -> "×1.00"
        }
        Text(label, color = Color.White, fontSize = 30.sp, fontWeight = FontWeight.Bold)
    }
}

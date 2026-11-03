package com.zipper.app.ui.screens.games

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zipper.app.ui.components.*
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import kotlinx.coroutines.delay
import kotlin.math.floor

/**
 * The second set of quick games (B5, 3 Nov 2026): Lucky Dice, Toss Up, Fortune Wheel, Number Draw, Sky High,
 * Roulette, Dragon Tiger, Andar Bahar, Higher or Lower, Gem Field. As with the first set, the server decides every
 * result (functions/src/games/instant.ts, moreMath.ts); [QuickOdds] only repeats its tables so a player sees what a
 * choice pays BEFORE paying — the payout itself always comes from the server's answer.
 */
object QuickOdds {
    fun floor2(x: Double): Double = floor(x * 100 + 1e-9) / 100

    fun dice(chance: Int, edge: Double): Double = floor2((100 - edge) / chance)
    fun coin(edge: Double): Double = floor2(2 * (1 - edge / 100))

    private val WHEEL = mapOf(
        "low" to listOf(1.5, 1.2, 1.2, 1.2, 0.0, 1.2, 1.2, 1.2, 1.2, 0.0, 1.5, 1.2, 1.2, 1.2, 0.0, 1.2, 1.2, 1.2, 1.2, 0.0),
        "medium" to listOf(0.0, 1.5, 0.0, 2.0, 0.0, 1.5, 0.0, 3.0, 0.0, 1.5, 0.0, 2.0, 0.0, 1.5, 0.0, 4.0, 0.0, 1.5, 0.0, 1.7),
        "high" to List(19) { 0.0 } + listOf(19.8),
    )
    val WHEEL_RISKS = listOf("low", "medium", "high")

    fun wheel(risk: String, edge: Double): List<Double> {
        val base = WHEEL[risk] ?: WHEEL.getValue("medium")
        val k = (1 - edge / 100) / (base.sum() / base.size)
        return base.map { if (it > 0) floor2(it * k) else 0.0 }
    }

    private fun choose(n: Int, k: Int): Double {
        if (k < 0 || k > n) return 0.0
        var r = 1.0
        for (i in 1..k) r = r * (n - k + i) / i
        return r
    }

    fun kenoHit(picks: Int, hits: Int): Double = choose(picks, hits) * choose(40 - picks, 10 - hits) / choose(40, 10)

    fun keno(picks: Int, edge: Double): List<Double> {
        val k0 = if (picks <= 2) 1 else (picks + 1) / 2
        val base = List(picks + 1) { h -> if (h < k0) 0.0 else Math.pow(2.0, (h - k0).toDouble()) * (if (h == picks) 3 else 1) }
        val ev = base.withIndex().sumOf { (h, m) -> m * kenoHit(picks, h) }
        val k = (1 - edge / 100) / ev
        return base.map { if (it > 0) floor2(it * k) else 0.0 }
    }

    fun rouletteCovers(bet: String): Int = when (bet) { "straight" -> 1; "dozen", "column" -> 12; else -> 18 }
    fun roulette(bet: String, edge: Double): Double = floor2(37.0 / rouletteCovers(bet) * (1 - edge / 100) + 1e-6)
    val RED = setOf(1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36)

    /** Dragon or Tiger, and the tie bet. */
    fun dragonTiger(edge: Double): Pair<Double, Double> {
        val rtp = 1 - edge / 100
        return floor2((rtp - 0.5 * 3.0 / 51) / (24.0 / 51)) to floor2(rtp / (3.0 / 51))
    }

    const val ANDAR_CHANCE = 10725.0 / 20825.0
    fun andarBahar(edge: Double): Pair<Double, Double> {
        val rtp = 1 - edge / 100
        return floor2(rtp / ANDAR_CHANCE) to floor2(rtp / (1 - ANDAR_CHANCE))
    }

    /** "Higher" includes the same rank; "lower" too. Rank 0 = 2 … 12 = A. */
    fun hiloChance(card: Int, higher: Boolean): Double { val r = card % 13; return if (higher) (13 - r) / 13.0 else (r + 1) / 13.0 }
    fun hiloNext(current: Double, card: Int, higher: Boolean, edge: Double): Double = floor2(current * (1 - edge / 100) / hiloChance(card, higher))

    fun mines(mines: Int, safe: Int, edge: Double): Double {
        if (safe <= 0) return 1.0
        var m = 1.0
        for (i in 0 until safe) m *= (25.0 - i) / (25.0 - mines - i)
        return floor2(m * (1 - edge / 100))
    }
}

private fun Map<String, Any?>.num(key: String): Double? = (this[key] as? Number)?.toDouble()
private fun Map<String, Any?>.int(key: String): Int? = (this[key] as? Number)?.toInt()
private fun Map<String, Any?>.ints(key: String): List<Int> = (this[key] as? List<*>).orEmpty().mapNotNull { (it as? Number)?.toInt() }
private fun Map<String, Any?>.doubles(key: String): List<Double> = (this[key] as? List<*>).orEmpty().mapNotNull { (it as? Number)?.toDouble() }

private val WHITE = Color.White
private fun x2(m: Double) = multText(m)

// ══════════════════════════════════════════════════════════════════════════════
//  Boards
// ══════════════════════════════════════════════════════════════════════════════

@Composable
fun MoreGameBoard(s: InstantState, vm: InstantGameViewModel) {
    when (s.gameId) {
        "dice" -> DiceBoard(s)
        "coin_toss" -> CoinBoard(s)
        "wheel" -> WheelBoard(s)
        "keno" -> KenoBoard(s, vm)
        "limbo" -> LimboBoard(s)
        "roulette" -> RouletteBoard(s)
        "dragon_tiger" -> DragonTigerBoard(s)
        "andar_bahar" -> AndarBaharBoard(s)
        "hilo" -> HiloBoard(s)
        "mines" -> MinesBoard(s, vm)
    }
}

@Composable
private fun DiceBoard(s: InstantState) {
    val o = s.last?.outcome
    val roll = o?.num("roll")
    val chance = o?.int("chance") ?: s.diceChance
    val over = (o?.get("direction") as? String)?.let { it == "over" } ?: s.diceOver
    val shown = remember { Animatable(0f) }
    LaunchedEffect(s.last?.roundId) { if (roll != null) { shown.snapTo(0f); shown.animateTo(roll.toFloat(), tween(700, easing = FastOutSlowInEasing)) } }
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        Text(if (roll == null) "—" else String.format(java.util.Locale.US, "%.2f", shown.value), color = WHITE, fontSize = 44.sp, fontWeight = FontWeight.Bold)
        Canvas(Modifier.fillMaxWidth().height(28.dp)) {
            val w = size.width
            drawRect(Color.White.copy(alpha = 0.2f), size = Size(w, size.height))
            val winFrom = if (over) w * (100 - chance) / 100f else 0f
            val winTo = if (over) w else w * chance / 100f
            drawRect(Color(0xFF66BB6A), topLeft = Offset(winFrom, 0f), size = Size(winTo - winFrom, size.height))
            if (roll != null) drawRect(WHITE, topLeft = Offset(w * shown.value / 100f - 3f, -4f), size = Size(6f, size.height + 8f))
        }
        Text(
            "${if (over) "Over" else "Under"} ${if (over) 100 - chance else chance} · win chance $chance% · pays ${x2(QuickOdds.dice(chance, s.edgePct))}",
            color = WHITE, style = ZipperTheme.type.labelM,
        )
    }
}

@Composable
private fun CoinBoard(s: InstantState) {
    val landed = s.last?.outcome?.get("landed") as? String
    val spin = remember { Animatable(0f) }
    LaunchedEffect(s.last?.roundId) { if (landed != null) { spin.snapTo(0f); spin.animateTo(1080f, tween(900, easing = FastOutSlowInEasing)) } }
    Column(Modifier.fillMaxWidth().height(180.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Box(
            Modifier.size(110.dp).rotate(spin.value).background(Color(0xFFFFC107), CircleShape).border(4.dp, Color(0xFFFF8F00), CircleShape),
            contentAlignment = Alignment.Center,
        ) { Text(if (landed == "tails") "T" else "H", color = Color(0xFF6D4C00), fontSize = 44.sp, fontWeight = FontWeight.Bold) }
        if (landed != null) Text(landed.replaceFirstChar { it.uppercase() }, color = WHITE, style = ZipperTheme.type.headingS)
    }
}

private val SEGMENT_COLOURS = listOf(Color(0xFF455A64), Color(0xFF26A69A), Color(0xFF42A5F5), Color(0xFF7E57C2), Color(0xFFFFCA28), Color(0xFFEF5350))

private fun segmentColour(m: Double): Color = when {
    m <= 0.0 -> SEGMENT_COLOURS[0]
    m < 1.3 -> SEGMENT_COLOURS[1]
    m < 1.8 -> SEGMENT_COLOURS[2]
    m < 2.5 -> SEGMENT_COLOURS[3]
    m < 5 -> SEGMENT_COLOURS[4]
    else -> SEGMENT_COLOURS[5]
}

@Composable
private fun WheelBoard(s: InstantState) {
    val o = s.last?.outcome
    val table = o?.doubles("table")?.takeIf { it.size == 20 } ?: QuickOdds.wheel(s.wheelRisk, s.edgePct)
    val segment = o?.int("segment")
    // Land the drawn segment under the pointer at the top: a few full turns, then its angle.
    val angle = remember { Animatable(0f) }
    LaunchedEffect(s.last?.roundId) {
        if (segment != null) {
            val target = 360f * 5 + (360f - (segment + 0.5f) * 18f)
            angle.snapTo(0f)
            angle.animateTo(target, tween(1800, easing = FastOutSlowInEasing))
        }
    }
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.fillMaxWidth().aspectRatio(1.2f), contentAlignment = Alignment.Center) {
            Canvas(Modifier.fillMaxHeight().aspectRatio(1f).rotate(angle.value)) {
                val r = size.minDimension / 2
                table.forEachIndexed { i, m ->
                    drawArc(segmentColour(m), startAngle = -90f + i * 18f, sweepAngle = 18f, useCenter = true,
                        topLeft = Offset(center.x - r, center.y - r), size = Size(2 * r, 2 * r))
                }
                drawCircle(Color.White, r * 0.12f, center)
            }
            Canvas(Modifier.size(24.dp).align(Alignment.TopCenter)) {
                val p = Path().apply { moveTo(0f, 0f); lineTo(size.width, 0f); lineTo(size.width / 2, size.height); close() }
                drawPath(p, Color.White)
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
            table.distinct().sorted().forEach { m ->
                Text(if (m == 0.0) "×0" else x2(m), color = WHITE, fontSize = 11.sp,
                    modifier = Modifier.background(segmentColour(m), RoundedCornerShape(4.dp)).padding(horizontal = 4.dp, vertical = 2.dp))
            }
        }
    }
}

@Composable
private fun KenoBoard(s: InstantState, vm: InstantGameViewModel) {
    val o = s.last?.outcome
    val drawn = o?.ints("drawn").orEmpty()
    val locked = s.busy
    val picks = s.kenoPicks
    var revealCount by remember { mutableIntStateOf(10) }
    LaunchedEffect(s.last?.roundId) { if (drawn.isNotEmpty()) { revealCount = 0; repeat(10) { delay(120); revealCount++ } } }
    val shownDrawn = drawn.take(revealCount)
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        for (row in 0 until 5) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                for (col in 0 until 8) {
                    val n = row * 8 + col + 1
                    val picked = n in picks
                    val hit = picked && n in shownDrawn
                    val bg = when { hit -> Color(0xFFFFD54F); n in shownDrawn -> Color(0xFF80CBC4); picked -> Color(0xFF00897B); else -> Color.White.copy(alpha = 0.15f) }
                    Text(
                        "$n", color = if (hit) Color(0xFF3E2723) else WHITE, textAlign = TextAlign.Center, fontSize = 13.sp,
                        modifier = Modifier.weight(1f).background(bg, RoundedCornerShape(6.dp))
                            .then(if (!locked) Modifier.clickableNoRipple { vm.toggleKenoPick(n) } else Modifier)
                            .padding(vertical = 6.dp),
                    )
                }
            }
        }
        val table = QuickOdds.keno(picks.size.coerceAtLeast(1), s.edgePct)
        if (picks.isNotEmpty()) {
            Text(
                table.withIndex().filter { it.value > 0 }.joinToString("   ") { "${it.index} hit${if (it.index == 1) "" else "s"} ${x2(it.value)}" },
                color = WHITE, fontSize = 11.sp,
            )
        } else Text("Tap up to ten numbers.", color = WHITE, style = ZipperTheme.type.labelM)
    }
}

@Composable
private fun LimboBoard(s: InstantState) {
    val o = s.last?.outcome
    val result = o?.num("result")
    val target = o?.num("target") ?: s.limboTarget
    val shown = remember { Animatable(1f) }
    LaunchedEffect(s.last?.roundId) { if (result != null) { shown.snapTo(1f); shown.animateTo(result.toFloat(), tween(900, easing = FastOutSlowInEasing)) } }
    Column(Modifier.fillMaxWidth().height(170.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        val won = result != null && result >= target
        Text(
            if (result == null) "×1.00" else x2(QuickOdds.floor2(shown.value.toDouble())),
            color = when { result == null -> WHITE; won -> Color(0xFFB9F6CA); else -> Color(0xFFFF8A80) },
            fontSize = 48.sp, fontWeight = FontWeight.Bold,
        )
        Text("Target ${x2(target)} · win chance ${String.format(java.util.Locale.US, "%.2f", (100 - s.edgePct) / target)}%",
            color = WHITE, style = ZipperTheme.type.labelM)
    }
}

@Composable
private fun RouletteBoard(s: InstantState) {
    val pocket = s.last?.outcome?.int("pocket")
    var ticker by remember { mutableIntStateOf(0) }
    var spinning by remember { mutableStateOf(false) }
    LaunchedEffect(s.last?.roundId) {
        if (pocket != null) { spinning = true; repeat(18) { ticker = (ticker + 7) % 37; delay(60L + it * 6) }; spinning = false }
    }
    val n = if (spinning) ticker else pocket
    val colour = when { n == null -> Color.White.copy(alpha = 0.2f); n == 0 -> Color(0xFF2E7D32); n in QuickOdds.RED -> Color(0xFFC62828); else -> Color(0xFF212121) }
    Column(Modifier.fillMaxWidth().height(180.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Box(Modifier.size(110.dp).background(colour, CircleShape).border(4.dp, Color(0xFFFFD54F), CircleShape), contentAlignment = Alignment.Center) {
            Text(n?.toString() ?: "?", color = WHITE, fontSize = 44.sp, fontWeight = FontWeight.Bold)
        }
        if (pocket != null && !spinning) {
            Text(
                when { pocket == 0 -> "Zero"; pocket in QuickOdds.RED -> "Red ${if (pocket % 2 == 1) "· odd" else "· even"}"; else -> "Black ${if (pocket % 2 == 1) "· odd" else "· even"}" },
                color = WHITE, style = ZipperTheme.type.labelM,
            )
        }
    }
}

@Composable
private fun DragonTigerBoard(s: InstantState) {
    val o = s.last?.outcome
    val dragon = o?.int("dragon")
    val tiger = o?.int("tiger")
    val winner = o?.get("winner") as? String
    var flipped by remember { mutableIntStateOf(2) }
    LaunchedEffect(s.last?.roundId) { if (dragon != null) { flipped = 0; delay(350); flipped = 1; delay(450); flipped = 2 } }
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("🐉 Dragon", color = WHITE, style = ZipperTheme.type.labelM)
                PlayingCard(dragon ?: -1, faceUp = dragon != null && flipped >= 1, width = 72.dp)
            }
            Text("vs", color = WHITE, style = ZipperTheme.type.headingS)
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("🐯 Tiger", color = WHITE, style = ZipperTheme.type.labelM)
                PlayingCard(tiger ?: -1, faceUp = tiger != null && flipped >= 2, width = 72.dp)
            }
        }
        if (winner != null && flipped >= 2) Text(if (winner == "tie") "Tie!" else "${winner.replaceFirstChar { it.uppercase() }} wins", color = WHITE, style = ZipperTheme.type.headingS)
        Text("Ace is low, king is high.", color = WHITE.copy(alpha = 0.8f), fontSize = 11.sp)
    }
}

@Composable
private fun AndarBaharBoard(s: InstantState) {
    val o = s.last?.outcome
    val joker = o?.int("joker")
    val dealt = o?.ints("dealt").orEmpty()
    val winner = o?.get("winner") as? String
    var shownCount by remember { mutableIntStateOf(Int.MAX_VALUE) }
    LaunchedEffect(s.last?.roundId) { if (dealt.isNotEmpty()) { shownCount = 0; for (i in dealt.indices) { delay(140); shownCount = i + 1 } } }
    val shown = dealt.take(shownCount)
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        Text("Joker", color = WHITE, style = ZipperTheme.type.labelM)
        PlayingCard(joker ?: -1, faceUp = joker != null, width = 56.dp)
        for ((side, parity) in listOf("Andar" to 0, "Bahar" to 1)) {
            val cards = shown.withIndex().filter { it.index % 2 == parity }.map { it.value }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(side, color = WHITE, style = ZipperTheme.type.labelM, modifier = Modifier.width(52.dp))
                cards.takeLast(9).forEach { PlayingCard(it, faceUp = true, width = 26.dp) }
            }
        }
        if (winner != null && shownCount >= dealt.size) Text("${winner.replaceFirstChar { it.uppercase() }} wins after ${dealt.size} cards", color = WHITE, style = ZipperTheme.type.headingS)
    }
}

@Composable
private fun HiloBoard(s: InstantState) {
    val round = s.open ?: s.last
    val o = round?.outcome
    val current = o?.int("current")
    val trail = (o?.get("trail") as? List<*>).orEmpty().mapNotNull { (it as? Map<*, *>)?.let { m -> (m["card"] as? Number)?.toInt() to (m["correct"] as? Boolean) } }
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        PlayingCard(current ?: -1, faceUp = current != null, width = 96.dp)
        if (o != null) {
            Text("${x2(o.num("multiplier") ?: 1.0)} · ${o.int("guesses") ?: 0} right", color = WHITE, style = ZipperTheme.type.headingS)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            trail.takeLast(10).forEach { (card, correct) ->
                if (card != null) Box(Modifier.border(2.dp, when (correct) { true -> Color(0xFF66BB6A); false -> Color(0xFFEF5350); null -> Color.Transparent }, RoundedCornerShape(4.dp))) {
                    PlayingCard(card, faceUp = true, width = 24.dp)
                }
            }
        }
        if (s.last?.outcome?.get("lost") == true && s.open == null) Text("Wrong guess — the round is over", color = WHITE, style = ZipperTheme.type.labelM)
    }
}

@Composable
private fun MinesBoard(s: InstantState, vm: InstantGameViewModel) {
    val round = s.open ?: s.last
    val o = round?.outcome
    val revealed = o?.ints("revealed").orEmpty()
    val mines = o?.ints("minePositions").orEmpty()
    val hit = o?.int("hit")
    val open = s.open != null
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        for (row in 0 until 5) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                for (col in 0 until 5) {
                    val t = row * 5 + col
                    val gem = t in revealed
                    val mine = t in mines
                    Box(
                        Modifier.weight(1f).aspectRatio(1f)
                            .background(
                                when { t == hit -> Color(0xFFD32F2F); gem -> Color(0xFF26C6DA); mine -> Color(0xFF5D4037); else -> Color.White.copy(alpha = 0.18f) },
                                RoundedCornerShape(8.dp),
                            )
                            .then(if (open && !gem && !s.busy) Modifier.clickableNoRipple { vm.revealTile(t) } else Modifier),
                        contentAlignment = Alignment.Center,
                    ) { Text(when { gem -> "💎"; mine -> "💣"; else -> "" }, fontSize = 22.sp) }
                }
            }
        }
        if (o != null) {
            val count = o.int("mineCount") ?: s.mineCount
            val now = o.num("multiplier") ?: 1.0
            Text(
                if (open) "Now ${x2(now)} · next gem ${x2(QuickOdds.mines(count, revealed.size + 1, o.num("edgePct") ?: s.edgePct))}"
                else if (hit != null) "A mine — the round is over" else "Cashed out at ${x2(now)}",
                color = WHITE, style = ZipperTheme.type.labelM,
            )
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Options and actions
// ══════════════════════════════════════════════════════════════════════════════

@Composable
fun MoreGameOptions(s: InstantState, vm: InstantGameViewModel, locked: Boolean) {
    val c = ZipperTheme.colors
    @Composable fun label(t: String) = Text(t, style = ZipperTheme.type.labelM, color = c.textSecondary)
    when (s.gameId) {
        "dice" -> {
            label("Win chance: ${s.diceChance}% · pays ${x2(QuickOdds.dice(s.diceChance, s.edgePct))}")
            Slider(value = s.diceChance.toFloat(), onValueChange = { vm.setDiceChance(it.toInt()) }, valueRange = 2f..95f, enabled = !locked)
            ChoiceRow(listOf(false, true), s.diceOver, { if (it) "Roll over" else "Roll under" }, enabled = !locked) { vm.setDiceOver(it) }
        }
        "coin_toss" -> {
            label("Your call · pays ${x2(QuickOdds.coin(s.edgePct))}")
            ChoiceRow(listOf("heads", "tails"), s.coinSide, { it.replaceFirstChar { ch -> ch.uppercase() } }, enabled = !locked) { vm.setCoinSide(it) }
        }
        "wheel" -> {
            label("Risk")
            ChoiceRow(QuickOdds.WHEEL_RISKS, s.wheelRisk, { it.replaceFirstChar { ch -> ch.uppercase() } }, enabled = !locked) { vm.setWheelRisk(it) }
        }
        "keno" -> {
            Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                ZipperButton("Quick pick", { vm.setKenoPicks((1..40).shuffled().take(5)) }, size = ButtonSize.Small, style = ButtonStyle.Secondary, enabled = !locked)
                ZipperButton("Clear", { vm.setKenoPicks(emptyList()) }, size = ButtonSize.Small, style = ButtonStyle.Ghost, enabled = !locked)
            }
        }
        "limbo" -> {
            label("Target")
            ChoiceRow(listOf(1.5, 2.0, 3.0, 5.0, 10.0, 50.0, 100.0), s.limboTarget, { x2(it) }, enabled = !locked) { vm.setLimboTarget(it) }
        }
        "roulette" -> {
            label("Bet · pays ${x2(QuickOdds.roulette(s.rouletteBet, s.edgePct))}")
            ChoiceRow(listOf("red", "black", "odd", "even", "low", "high", "dozen", "column", "straight"), s.rouletteBet, {
                when (it) { "low" -> "1–18"; "high" -> "19–36"; "straight" -> "Number"; else -> it.replaceFirstChar { ch -> ch.uppercase() } }
            }, enabled = !locked) { vm.setRouletteBet(it) }
            if (s.rouletteBet == "dozen" || s.rouletteBet == "column") {
                ChoiceRow(listOf(1, 2, 3), s.roulettePick, { if (s.rouletteBet == "dozen") listOf("1–12", "13–24", "25–36")[it - 1] else "Column $it" }, enabled = !locked) { vm.setRoulettePick(it) }
            }
            if (s.rouletteBet == "straight") ChoiceRow((0..36).toList(), s.roulettePick, { "$it" }, enabled = !locked) { vm.setRoulettePick(it) }
        }
        "dragon_tiger" -> {
            val (side, tie) = QuickOdds.dragonTiger(s.edgePct)
            label("Dragon or Tiger pays ${x2(side)} (a tie returns half) · Tie pays ${x2(tie)}")
            ChoiceRow(listOf("dragon", "tie", "tiger"), s.sideBet.ifBlank { null }, { it.replaceFirstChar { ch -> ch.uppercase() } }, enabled = !locked) { vm.setSideBet(it) }
        }
        "andar_bahar" -> {
            val (andar, bahar) = QuickOdds.andarBahar(s.edgePct)
            label("Andar pays ${x2(andar)} · Bahar pays ${x2(bahar)} (the first card goes to Andar)")
            ChoiceRow(listOf("andar", "bahar"), s.sideBet.ifBlank { null }, { it.replaceFirstChar { ch -> ch.uppercase() } }, enabled = !locked) { vm.setSideBet(it) }
        }
        "mines" -> {
            label("Mines")
            ChoiceRow(listOf(1, 3, 5, 10, 15, 20, 24), s.mineCount, { "$it" }, enabled = !locked) { vm.setMineCount(it) }
        }
    }
}

@Composable
fun MoreGameActions(s: InstantState, vm: InstantGameViewModel) {
    val canPay = s.diamonds >= s.entry && s.entry > 0
    @Composable fun go(text: String, onClick: () -> Unit, enabled: Boolean = true) =
        ZipperButton(text, onClick, fullWidth = true, gradient = true, loading = s.busy, enabled = canPay && !s.busy && enabled)
    when (s.gameId) {
        "dice" -> go("Roll", vm::playDice)
        "coin_toss" -> go("Flip", vm::tossCoin)
        "wheel" -> go("Spin", vm::spinWheel)
        "keno" -> go(if (s.kenoPicks.isEmpty()) "Pick numbers first" else "Draw (${s.kenoPicks.size} picked)", vm::playKeno, s.kenoPicks.isNotEmpty())
        "limbo" -> go("Fly to ${x2(s.limboTarget)}", vm::playLimbo)
        "roulette" -> go("Spin", vm::spinRoulette)
        "dragon_tiger" -> go(if (s.sideBet.isBlank()) "Choose a side" else "Deal", vm::playDragonTiger, s.sideBet in listOf("dragon", "tiger", "tie"))
        "andar_bahar" -> go(if (s.sideBet.isBlank()) "Choose a side" else "Deal", vm::playAndarBahar, s.sideBet in listOf("andar", "bahar"))
        "hilo" -> if (s.open == null) go("Start", vm::startHilo) else {
            val o = s.open.outcome
            val card = o.int("current") ?: 0
            val now = o.num("multiplier") ?: 1.0
            val edge = o.num("edgePct") ?: s.edgePct
            Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    val canHigher = QuickOdds.hiloChance(card, true) < 1
                    val canLower = QuickOdds.hiloChance(card, false) < 1
                    ZipperButton("Higher ${x2(QuickOdds.hiloNext(now, card, true, edge))}", { vm.hiloGuess("higher") }, Modifier.weight(1f),
                        size = ButtonSize.Medium, gradient = true, enabled = !s.busy && canHigher)
                    ZipperButton("Lower ${x2(QuickOdds.hiloNext(now, card, false, edge))}", { vm.hiloGuess("lower") }, Modifier.weight(1f),
                        size = ButtonSize.Medium, gradient = true, enabled = !s.busy && canLower)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    ZipperButton("Skip card", { vm.hiloGuess("skip") }, Modifier.weight(1f), size = ButtonSize.Medium, style = ButtonStyle.Secondary, enabled = !s.busy)
                    val guesses = o.int("guesses") ?: 0
                    ZipperButton(if (guesses > 0) "Cash out ${diamondsText((s.entry * now).toLong())}" else "Cash out", vm::hiloCashout, Modifier.weight(1f),
                        size = ButtonSize.Medium, style = ButtonStyle.Secondary, enabled = !s.busy && guesses > 0)
                }
            }
        }
        "mines" -> if (s.open == null) go("Start", vm::startMines) else {
            val o = s.open.outcome
            val found = o.ints("revealed").size
            val now = o.num("multiplier") ?: 1.0
            ZipperButton(if (found > 0) "Cash out ${diamondsText((s.entry * now).toLong())}" else "Turn a tile", vm::minesCashout,
                fullWidth = true, style = ButtonStyle.Secondary, enabled = !s.busy && found > 0)
        }
    }
}

fun moreRulesFor(gameId: String): String = when (gameId) {
    "dice" -> "Choose your win chance and whether to roll under or over. The server rolls 0.00–99.99; inside your range " +
        "you win entry × the multiplier shown."
    "coin_toss" -> "Call heads or tails. Call it right and you win entry × the multiplier shown."
    "wheel" -> "Twenty segments, each with a multiplier. Low risk wins often and small; high risk wins rarely and big."
    "keno" -> "Pick 1 to 10 numbers from 40. The server draws 10. The more of yours it draws, the more you win — the " +
        "table shows exactly what each count of hits pays."
    "limbo" -> "Choose a target. The server draws a result; if it reaches your target you win entry × the target."
    "roulette" -> "One zero, 37 pockets. Bet on a number, a colour, odd or even, a half, a dozen or a column. The zero " +
        "loses every bet except a straight bet on 0."
    "dragon_tiger" -> "One card to Dragon, one to Tiger; the higher wins (ace low, king high). On a tie, Dragon and Tiger " +
        "bets get half back; a Tie bet wins big."
    "andar_bahar" -> "A joker card is turned. Cards are dealt to Andar and Bahar in turn, Andar first, until one matches " +
        "the joker's rank. Bet on the side it lands on."
    "hilo" -> "Guess whether the next card is higher or lower (the same rank counts as right). Every right guess raises " +
        "the multiplier; a wrong one ends the round. Skip a card whenever you like; cash out whenever you like."
    "mines" -> "25 tiles hide gems and the mines you choose. Every gem raises the multiplier; a mine ends the round. Cash " +
        "out whenever you like."
    else -> ""
}

val MORE_INSTANT_GAMES = setOf("dice", "coin_toss", "wheel", "keno", "limbo", "roulette", "dragon_tiger", "andar_bahar", "hilo", "mines")

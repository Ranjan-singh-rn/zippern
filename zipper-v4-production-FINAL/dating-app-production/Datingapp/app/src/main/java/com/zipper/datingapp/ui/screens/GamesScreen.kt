package com.zipper.datingapp.ui.screens

import android.annotation.SuppressLint
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.material3.TabRowDefaults.tabIndicatorOffset
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import coil.compose.AsyncImage
import com.google.firebase.firestore.Query
import com.zipper.datingapp.ui.DatingViewModel
import com.zipper.datingapp.ui.theme.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlin.math.*
import kotlin.random.Random

// ─────────────────────────────────────────────────────────────────────────────
// Game catalog model
// ─────────────────────────────────────────────────────────────────────────────

data class GameItem(
    val id: String,
    val name: String,
    val emoji: String,
    val gradientColors: List<Color>,
    val description: String,
    val isHot: Boolean = false,
    val isNew: Boolean = false,
    /**
     * WebView URL for this game. When non-empty the game loads in a full-screen WebView
     * (per spec: "Full-screen WebView-based games"). When empty, falls back to built-in
     * demo mini-game. Replace these URLs with real game-server endpoints.
     */
    val webUrl: String = "",
)

// ---------------------------------------------------------------------------
// Game catalog. Set webUrl = "https://your-game-server.com/game/aviator"
// (etc.) for each game once you have a game provider integration.
// ---------------------------------------------------------------------------
val GAME_CATALOG = listOf(
    GameItem("aviator",    "Aviator",      "✈️",
        listOf(Color(0xFF1a1a2e), Color(0xFF16213e)),
        "Fly higher & cash out!", isHot = true),
    GameItem("lucky_wheel","Lucky Wheel",  "🎡",
        listOf(Color(0xFF11998e), Color(0xFF38ef7d)),
        "Spin to win diamonds!", isNew = true),
    GameItem("slots",      "Slots",        "🎰",
        listOf(Color(0xFFf39c12), Color(0xFFe74c3c)),
        "Match symbols, win big!"),
    GameItem("dice",       "Dice Duel",    "🎲",
        listOf(Color(0xFF4776e6), Color(0xFF8e54e9)),
        "Guess high or low!"),
    GameItem("mines",      "Mines",        "💣",
        listOf(Color(0xFF373b44), Color(0xFF4286f4)),
        "Avoid the mines!"),
    GameItem("coin_flip",  "Coin Flip",    "🪙",
        listOf(Color(0xFFf7971e), Color(0xFFffd200)),
        "Heads or tails?"),
    GameItem("teen_patti", "Teen Patti",   "🃏",
        listOf(Color(0xFF7b2d8b), Color(0xFFe91e8c)),
        "Indian poker classic!", isHot = true),
    GameItem("crash",      "Rocket Crash", "🚀",
        listOf(Color(0xFF8e0e00), Color(0xFF1f1c18)),
        "Cash out before crash!"),
    GameItem("plinko",     "Plinko",       "⚪",
        listOf(Color(0xFFfc5c7d), Color(0xFF6a3093)),
        "Drop & multiply!", isNew = true),
    GameItem("blackjack",  "Black Jack",   "♠️",
        listOf(Color(0xFF1a1a1a), Color(0xFF2d2d2d)),
        "Beat the dealer!"),
    GameItem("roulette",   "Roulette",     "🎯",
        listOf(Color(0xFF0f2027), Color(0xFF203a43)),
        "Red, black or zero!"),
    GameItem("baccarat",   "Baccarat",     "🎴",
        listOf(Color(0xFF134e5e), Color(0xFF71b280)),
        "Player vs Banker!"),
)

val BET_PRESETS = listOf(10, 50, 100, 500, 1000, 5000)

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GamesScreen(viewModel: DatingViewModel, onBack: () -> Unit) {
    val uiState by viewModel.uiState.collectAsState()
    var selectedGame by remember { mutableStateOf<GameItem?>(null) }
    var selectedTab by remember { mutableStateOf(0) }

    if (selectedGame != null) {
        GamePlayScreen(
            game = selectedGame!!,
            diamondBalance = uiState.coinBalance,
            onResult = { gId, gName, bet, win -> viewModel.processGameResult(gId, gName, bet, win) },
            onBack = { selectedGame = null },
        )
        return
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Games Center", color = TextPrimary, fontWeight = FontWeight.Bold, fontSize = 18.sp) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = TextPrimary)
                    }
                },
                actions = {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .padding(end = 12.dp)
                            .clip(RoundedCornerShape(20.dp))
                            .background(Color(0xFF7C4DFF).copy(alpha = 0.15f))
                            .padding(horizontal = 12.dp, vertical = 6.dp),
                    ) {
                        Text("💎", fontSize = 14.sp)
                        Spacer(Modifier.width(4.dp))
                        Text(
                            text = "%,d".format(uiState.coinBalance),
                            color = Color(0xFF7C4DFF),
                            fontWeight = FontWeight.Bold,
                            fontSize = 13.sp,
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = AppSurface),
            )
        },
        containerColor = AppBackground,
    ) { paddingValues ->
        Column(modifier = Modifier.fillMaxSize().padding(paddingValues)) {
            val tabs = listOf("Games", "Ranking", "History")
            TabRow(
                selectedTabIndex = selectedTab,
                containerColor = AppSurface,
                contentColor = BrandPink,
                indicator = { tabPositions ->
                    TabRowDefaults.Indicator(
                        modifier = Modifier.tabIndicatorOffset(tabPositions[selectedTab]),
                        color = BrandPink,
                    )
                },
            ) {
                tabs.forEachIndexed { index, title ->
                    Tab(
                        selected = selectedTab == index,
                        onClick = { selectedTab = index },
                        text = {
                            Text(
                                title,
                                color = if (selectedTab == index) BrandPink else TextSecondary,
                                fontWeight = if (selectedTab == index) FontWeight.SemiBold else FontWeight.Normal,
                                fontSize = 14.sp,
                            )
                        },
                    )
                }
            }
            when (selectedTab) {
                0 -> GamesTabContent(onGameClick = { selectedGame = it })
                1 -> GamesRankingTab(viewModel)
                2 -> GamesHistoryTab(viewModel)
            }
        }
    }
}

@Composable
private fun GamesTabContent(onGameClick: (GameItem) -> Unit) {
    LazyVerticalGrid(
        columns = GridCells.Fixed(2),
        contentPadding = PaddingValues(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        items(GAME_CATALOG) { game ->
            GameCard(game = game, onClick = { onGameClick(game) })
        }
    }
}

@Composable
private fun GameCard(game: GameItem, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .aspectRatio(0.85f)
            .clip(RoundedCornerShape(16.dp))
            .background(Brush.linearGradient(game.gradientColors))
            .clickable(onClick = onClick)
            .padding(12.dp),
    ) {
        if (game.isHot) {
            Box(
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .clip(RoundedCornerShape(8.dp))
                    .background(Color(0xFFFF4081))
                    .padding(horizontal = 6.dp, vertical = 2.dp),
            ) { Text("HOT", color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Bold) }
        }
        if (game.isNew) {
            Box(
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .clip(RoundedCornerShape(8.dp))
                    .background(Color(0xFF00E676))
                    .padding(horizontal = 6.dp, vertical = 2.dp),
            ) { Text("NEW", color = Color.Black, fontSize = 9.sp, fontWeight = FontWeight.Bold) }
        }
        Column(modifier = Modifier.align(Alignment.BottomStart)) {
            Text(game.emoji, fontSize = 36.sp)
            Spacer(Modifier.height(6.dp))
            Text(game.name, color = Color.White, fontWeight = FontWeight.Bold, fontSize = 14.sp)
            Text(game.description, color = Color.White.copy(alpha = 0.7f), fontSize = 11.sp, maxLines = 1)
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ranking + History tabs
// ─────────────────────────────────────────────────────────────────────────────

// ─── Ranking row data ────────────────────────────────────────────────────────
private data class RankEntry(val rank: Int, val userId: String, val name: String, val photoUrl: String, val coins: Long)
// ─── History row data ─────────────────────────────────────────────────────────
private data class GameHistoryEntry(val gameName: String, val bet: Long, val win: Long, val net: Long, val timestamp: Long)

@Composable
private fun GamesRankingTab(viewModel: DatingViewModel) {
    val uiState by viewModel.uiState.collectAsState()
    val myUid = remember { com.google.firebase.auth.FirebaseAuth.getInstance().currentUser?.uid.orEmpty() }

    var entries by remember { mutableStateOf<List<RankEntry>>(emptyList()) }
    var isLoading by remember { mutableStateOf(true) }
    var myRank by remember { mutableIntStateOf(0) }

    LaunchedEffect(Unit) {
        isLoading = true
        runCatching {
            val db = com.google.firebase.firestore.FirebaseFirestore.getInstance()
            val snap = db.collection("users")
                .orderBy("coins", com.google.firebase.firestore.Query.Direction.DESCENDING)
                .limit(20)
                .get()
                .await()
            entries = snap.documents.mapIndexedNotNull { idx, doc ->
                val uid = doc.id
                val name = (doc.getString("name") ?: doc.getString("displayName") ?: "User").ifBlank { "User" }
                val photo = doc.getString("photoUrl") ?: doc.getString("profilePhotoUrl") ?: ""
                val coins = doc.getLong("coins") ?: 0L
                RankEntry(rank = idx + 1, userId = uid, name = name, photoUrl = photo, coins = coins)
            }
            myRank = entries.indexOfFirst { it.userId == myUid }.let { if (it >= 0) it + 1 else 0 }
        }
        isLoading = false
    }

    if (isLoading) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(color = BrandPink)
        }
        return
    }

    if (entries.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("🏆", fontSize = 48.sp)
                Spacer(Modifier.height(12.dp))
                Text("No rankings yet", color = TextSecondary, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                Text("Play games to appear on the leaderboard", color = TextMuted, fontSize = 13.sp)
            }
        }
        return
    }

    LazyColumn(
        contentPadding = PaddingValues(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.fillMaxSize()
    ) {
        if (myRank > 0) {
            item {
                Surface(
                    shape = RoundedCornerShape(10.dp),
                    color = BrandPurple.copy(alpha = 0.15f),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(
                        "Your rank: #$myRank",
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                        color = BrandPurple,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 14.sp
                    )
                }
            }
        }
        items(entries) { entry ->
            val medalEmoji = when (entry.rank) { 1 -> "🥇"; 2 -> "🥈"; 3 -> "🥉"; else -> null }
            Surface(
                shape = RoundedCornerShape(12.dp),
                color = if (entry.userId == myUid) BrandPink.copy(alpha = 0.08f)
                         else androidx.compose.material3.MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f),
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Text(
                        medalEmoji ?: "#${entry.rank}",
                        fontSize = if (medalEmoji != null) 24.sp else 14.sp,
                        fontWeight = FontWeight.Bold,
                        color = GoldAccent,
                        modifier = Modifier.width(32.dp),
                        textAlign = TextAlign.Center
                    )
                    Box(
                        modifier = Modifier
                            .size(40.dp)
                            .clip(CircleShape)
                            .background(BrandPurple.copy(0.3f)),
                        contentAlignment = Alignment.Center
                    ) {
                        if (entry.photoUrl.isNotBlank()) {
                            coil.compose.AsyncImage(
                                model = entry.photoUrl,
                                contentDescription = null,
                                modifier = Modifier.fillMaxSize().clip(CircleShape),
                                contentScale = androidx.compose.ui.layout.ContentScale.Crop
                            )
                        } else {
                            Text(entry.name.take(1).uppercase(), color = Color.White, fontWeight = FontWeight.Bold)
                        }
                    }
                    Text(
                        entry.name,
                        color = TextPrimary,
                        fontWeight = if (entry.userId == myUid) FontWeight.Bold else FontWeight.Normal,
                        fontSize = 14.sp,
                        modifier = Modifier.weight(1f),
                        maxLines = 1
                    )
                    Text(
                        "💎 %,d".format(entry.coins),
                        color = GoldAccent,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 13.sp
                    )
                }
            }
        }
    }
}

@Composable
private fun GamesHistoryTab(viewModel: DatingViewModel) {
    val myUid = remember { com.google.firebase.auth.FirebaseAuth.getInstance().currentUser?.uid.orEmpty() }

    var entries by remember { mutableStateOf<List<GameHistoryEntry>>(emptyList()) }
    var isLoading by remember { mutableStateOf(true) }

    LaunchedEffect(Unit) {
        isLoading = true
        runCatching {
            val db = com.google.firebase.firestore.FirebaseFirestore.getInstance()
            val snap = db.collection("game_transactions")
                .whereEqualTo("userId", myUid)
                .orderBy("timestamp", com.google.firebase.firestore.Query.Direction.DESCENDING)
                .limit(30)
                .get()
                .await()
            entries = snap.documents.mapNotNull { doc ->
                val gameName = doc.getString("gameName") ?: doc.getString("gameId") ?: "Unknown"
                val bet = doc.getLong("betAmount") ?: 0L
                val win = doc.getLong("winAmount") ?: 0L
                val net = doc.getLong("net") ?: (win - bet)
                val ts = (doc.getTimestamp("timestamp")?.toDate()?.time) ?: doc.getLong("timestamp") ?: 0L
                GameHistoryEntry(gameName = gameName, bet = bet, win = win, net = net, timestamp = ts)
            }
        }
        isLoading = false
    }

    if (isLoading) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(color = BrandPink)
        }
        return
    }

    if (entries.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("🎮", fontSize = 48.sp)
                Spacer(Modifier.height(12.dp))
                Text("No game history yet", color = TextSecondary, fontSize = 16.sp)
                Text("Play a game to see your history here", color = TextMuted, fontSize = 13.sp)
            }
        }
        return
    }

    LazyColumn(
        contentPadding = PaddingValues(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.fillMaxSize()
    ) {
        items(entries) { entry ->
            val isWin = entry.net > 0
            val isLoss = entry.net < 0
            Surface(
                shape = RoundedCornerShape(12.dp),
                color = when {
                    isWin  -> Color(0xFF1B5E20).copy(alpha = 0.25f)
                    isLoss -> Color(0xFFB71C1C).copy(alpha = 0.20f)
                    else   -> androidx.compose.material3.MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f)
                },
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        when {
                            isWin  -> "✅"
                            isLoss -> "❌"
                            else   -> "➖"
                        },
                        fontSize = 22.sp,
                        modifier = Modifier.width(32.dp)
                    )
                    Spacer(Modifier.width(12.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(entry.gameName, color = TextPrimary, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                        Text(
                            "Bet: 💎${entry.bet}  Win: 💎${entry.win}",
                            color = TextMuted,
                            fontSize = 12.sp
                        )
                    }
                    Text(
                        "${if (isWin) "+" else ""}${entry.net}",
                        color = when {
                            isWin  -> Color(0xFF4CAF50)
                            isLoss -> Color(0xFFEF5350)
                            else   -> TextSecondary
                        },
                        fontWeight = FontWeight.Bold,
                        fontSize = 15.sp
                    )
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// GamePlayScreen — WebView (spec) or native demo fallback
// ─────────────────────────────────────────────────────────────────────────────

@Composable
fun GamePlayScreen(
    game: GameItem,
    diamondBalance: Int,
    onResult: (gameId: String, gameName: String, bet: Int, win: Int) -> Boolean,
    onBack: () -> Unit,
) {
    BackHandler(onBack = onBack)
    // Per spec: games are WebView-based. Load webUrl when configured.
    if (game.webUrl.isNotBlank()) {
        WebViewGame(game = game, diamondBalance = diamondBalance, onBack = onBack)
        return
    }
    // No URL configured yet → native demo game (placeholder until real game server is set up)
    when (game.id) {
        "aviator", "crash" -> AviatorGame(game, diamondBalance, onResult, onBack)
        "lucky_wheel"      -> LuckyWheelGame(game, diamondBalance, onResult, onBack)
        "slots"            -> SlotsGame(game, diamondBalance, onResult, onBack)
        "dice"             -> DiceGame(game, diamondBalance, onResult, onBack)
        "mines"            -> MinesGame(game, diamondBalance, onResult, onBack)
        "coin_flip"        -> CoinFlipGame(game, diamondBalance, onResult, onBack)
        "plinko"           -> PlinkoGame(game, diamondBalance, onResult, onBack)
        "teen_patti"       -> TeenPattiGame(game, diamondBalance, onResult, onBack)
        "blackjack"        -> BlackjackGame(game, diamondBalance, onResult, onBack)
        "roulette"         -> RouletteGame(game, diamondBalance, onResult, onBack)
        "baccarat"         -> BaccaratGame(game, diamondBalance, onResult, onBack)
        else               -> AviatorGame(game, diamondBalance, onResult, onBack)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// WebViewGame — full-screen WebView player (production path per spec)
// ─────────────────────────────────────────────────────────────────────────────

@SuppressLint("SetJavaScriptEnabled")
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun WebViewGame(
    game: GameItem,
    diamondBalance: Int,
    onBack: () -> Unit,
) {
    var isLoading by remember { mutableStateOf(true) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("${game.emoji}  ${game.name}", color = TextPrimary, fontWeight = FontWeight.Bold, fontSize = 17.sp)
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, null, tint = TextPrimary)
                    }
                },
                actions = {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .padding(end = 12.dp)
                            .clip(RoundedCornerShape(20.dp))
                            .background(Color(0xFF7C4DFF).copy(alpha = 0.15f))
                            .padding(horizontal = 12.dp, vertical = 6.dp),
                    ) {
                        Text("💎", fontSize = 13.sp)
                        Spacer(Modifier.width(4.dp))
                        Text("%,d".format(diamondBalance), color = Color(0xFF7C4DFF), fontWeight = FontWeight.Bold, fontSize = 13.sp)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = game.gradientColors.first()),
            )
        },
        containerColor = AppBackground,
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding)) {
            AndroidView(
                factory = { ctx ->
                    WebView(ctx).apply {
                        layoutParams = ViewGroup.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT,
                        )
                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = true
                        settings.mediaPlaybackRequiresUserGesture = false
                        webViewClient = object : WebViewClient() {
                            override fun onPageFinished(view: WebView?, url: String?) {
                                isLoading = false
                            }
                        }
                        webChromeClient = WebChromeClient()
                        loadUrl(game.webUrl)
                    }
                },
                modifier = Modifier.fillMaxSize(),
            )
            if (isLoading) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator(color = BrandPink)
                        Spacer(Modifier.height(12.dp))
                        Text("Loading ${game.name}…", color = TextSecondary, fontSize = 14.sp)
                    }
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Common Game Shell
// ─────────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun GameShell(
    game: GameItem,
    diamondBalance: Int,
    onBack: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("${game.emoji}  ${game.name}", color = TextPrimary, fontWeight = FontWeight.Bold, fontSize = 17.sp) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, null, tint = TextPrimary) } },
                actions = {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .padding(end = 12.dp)
                            .clip(RoundedCornerShape(20.dp))
                            .background(Color(0xFF7C4DFF).copy(alpha = 0.15f))
                            .padding(horizontal = 12.dp, vertical = 6.dp),
                    ) {
                        Text("💎", fontSize = 13.sp)
                        Spacer(Modifier.width(4.dp))
                        Text("%,d".format(diamondBalance), color = Color(0xFF7C4DFF), fontWeight = FontWeight.Bold, fontSize = 13.sp)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = game.gradientColors.first()),
            )
        },
        containerColor = AppBackground,
    ) { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            content = content,
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared widgets
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun BetSelector(bet: Int, onBetChange: (Int) -> Unit, maxBet: Int) {
    Column {
        Text("Bet Amount", color = TextSecondary, fontSize = 13.sp)
        Spacer(Modifier.height(6.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            BET_PRESETS.filter { it <= maxBet.coerceAtLeast(BET_PRESETS.first()) }.forEach { preset ->
                val selected = bet == preset
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (selected) BrandPink else AppSurface)
                        .border(1.dp, if (selected) BrandPink else OutlineDefault, RoundedCornerShape(8.dp))
                        .clickable { onBetChange(preset) }
                        .padding(horizontal = 10.dp, vertical = 6.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = if (preset >= 1000) "${preset / 1000}K" else "$preset",
                        color = if (selected) Color.White else TextPrimary,
                        fontSize = 12.sp,
                        fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                    )
                }
            }
        }
    }
}

@Composable
private fun ResultBanner(won: Boolean?, message: String) {
    if (won == null) return
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(if (won) Color(0xFF00C853) else Color(0xFFD50000))
            .padding(16.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(message, color = Color.White, fontWeight = FontWeight.Bold, fontSize = 14.sp, textAlign = TextAlign.Center)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. AVIATOR / CRASH GAME
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun AviatorGame(
    game: GameItem,
    diamondBalance: Int,
    onResult: (String, String, Int, Int) -> Boolean,
    onBack: () -> Unit,
) {
    var bet by remember { mutableStateOf(50) }
    var multiplier by remember { mutableStateOf(1.00f) }
    var isFlying by remember { mutableStateOf(false) }
    var hasCashedOut by remember { mutableStateOf(false) }
    var crashed by remember { mutableStateOf(false) }
    var crashPoint by remember { mutableStateOf(1.0f) }
    var resultMsg by remember { mutableStateOf<String?>(null) }
    var won by remember { mutableStateOf<Boolean?>(null) }
    val scope = rememberCoroutineScope()

    val planeProgress by animateFloatAsState(
        targetValue = if (isFlying) 1f else 0f,
        animationSpec = tween(durationMillis = 3000, easing = LinearEasing),
        label = "plane",
    )

    GameShell(game = game, diamondBalance = diamondBalance, onBack = onBack) {
        // Multiplier display
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(200.dp)
                .clip(RoundedCornerShape(20.dp))
                .background(Brush.verticalGradient(listOf(Color(0xFF0d0d1a), Color(0xFF1a1a2e)))),
            contentAlignment = Alignment.Center,
        ) {
            Canvas(modifier = Modifier.fillMaxSize()) {
                if (isFlying || hasCashedOut) {
                    val path = androidx.compose.ui.graphics.Path().apply {
                        moveTo(0f, size.height * 0.9f)
                        quadraticBezierTo(
                            size.width * planeProgress * 0.5f, size.height * 0.5f,
                            size.width * planeProgress, size.height * (0.9f - planeProgress * 0.7f),
                        )
                    }
                    drawPath(path = path, color = Color(0xFF00E5FF).copy(alpha = 0.4f), style = Stroke(width = 3f))
                }
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                if (isFlying) {
                    Text("✈️", fontSize = 40.sp,
                        modifier = Modifier.offset(
                            x = (planeProgress * 100 - 50).dp,
                            y = (-planeProgress * 60).dp,
                        ))
                }
                Text(
                    text = "%.2fx".format(multiplier),
                    color = when {
                        crashed      -> Color(0xFFFF1744)
                        hasCashedOut -> Color(0xFF00E676)
                        isFlying     -> Color(0xFF00E5FF)
                        else         -> TextPrimary
                    },
                    fontSize = 52.sp,
                    fontWeight = FontWeight.ExtraBold,
                )
                if (crashed) Text("💥 CRASHED!", color = Color(0xFFFF1744), fontSize = 16.sp, fontWeight = FontWeight.Bold)
            }
        }

        Spacer(Modifier.height(16.dp))
        resultMsg?.let { ResultBanner(won = won, message = it) }
        Spacer(Modifier.height(12.dp))

        if (!isFlying) {
            BetSelector(bet = bet, onBetChange = { bet = it }, maxBet = diamondBalance)
            Spacer(Modifier.height(16.dp))
            Button(
                onClick = {
                    if (diamondBalance < bet) return@Button
                    isFlying = true; hasCashedOut = false; crashed = false
                    multiplier = 1.00f; resultMsg = null; won = null
                    crashPoint = when {
                        Random.nextFloat() < 0.30f -> 1.0f + Random.nextFloat() * 1.0f
                        Random.nextFloat() < 0.60f -> 2.0f + Random.nextFloat() * 3.0f
                        else                       -> 5.0f + Random.nextFloat() * 15.0f
                    }
                    scope.launch {
                        var cur = 1.00f
                        while (cur < crashPoint && !hasCashedOut) {
                            delay(80)
                            cur += cur * 0.015f
                            multiplier = cur
                        }
                        if (!hasCashedOut) {
                            crashed = true; isFlying = false
                            onResult(game.id, game.name, bet, 0)
                            won = false
                            resultMsg = "Crashed at %.2fx! Lost 💎$bet".format(crashPoint)
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth().height(52.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF00C6FF)),
                shape = RoundedCornerShape(14.dp),
            ) {
                Text("🚀  FLY  (Bet 💎$bet)", fontWeight = FontWeight.Bold, fontSize = 16.sp, color = Color.Black)
            }
        } else if (!hasCashedOut && !crashed) {
            Button(
                onClick = {
                    hasCashedOut = true; isFlying = false
                    val win = (bet * multiplier).toInt()
                    onResult(game.id, game.name, bet, win)
                    won = true
                    resultMsg = "Cashed out at %.2fx! Won 💎$win".format(multiplier)
                },
                modifier = Modifier.fillMaxWidth().height(52.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF00E676)),
                shape = RoundedCornerShape(14.dp),
            ) {
                Text("💰  CASH OUT  (%.2fx = 💎${(bet * multiplier).toInt()})".format(multiplier),
                    fontWeight = FontWeight.Bold, fontSize = 15.sp, color = Color.Black)
            }
        } else {
            Button(
                onClick = { isFlying = false; hasCashedOut = false; crashed = false; multiplier = 1f; resultMsg = null; won = null },
                modifier = Modifier.fillMaxWidth().height(52.dp),
                colors = ButtonDefaults.buttonColors(containerColor = AppSurface),
                shape = RoundedCornerShape(14.dp),
            ) { Text("Play Again", color = TextPrimary, fontWeight = FontWeight.Bold, fontSize = 16.sp) }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. LUCKY WHEEL
// ─────────────────────────────────────────────────────────────────────────────

private data class WheelSector(val label: String, val multiplier: Float, val color: Color)

private val WHEEL_SECTORS = listOf(
    WheelSector("2x",   2f,   Color(0xFF7C4DFF)),
    WheelSector("LOSE", 0f,   Color(0xFF424242)),
    WheelSector("1.5x", 1.5f, Color(0xFF00BCD4)),
    WheelSector("LOSE", 0f,   Color(0xFF424242)),
    WheelSector("5x",   5f,   Color(0xFFFF4081)),
    WheelSector("LOSE", 0f,   Color(0xFF424242)),
    WheelSector("1x",   1f,   Color(0xFF4CAF50)),
    WheelSector("10x",  10f,  Color(0xFFFFD700)),
)

@Composable
private fun LuckyWheelGame(
    game: GameItem,
    diamondBalance: Int,
    onResult: (String, String, Int, Int) -> Boolean,
    onBack: () -> Unit,
) {
    var bet by remember { mutableStateOf(50) }
    var targetRotation by remember { mutableStateOf(0f) }
    var spinning by remember { mutableStateOf(false) }
    var resultMsg by remember { mutableStateOf<String?>(null) }
    var won by remember { mutableStateOf<Boolean?>(null) }

    val animatedRotation by animateFloatAsState(
        targetValue = targetRotation,
        animationSpec = tween(durationMillis = 3000, easing = FastOutSlowInEasing),
        finishedListener = {
            if (spinning) {
                spinning = false
                val normalized = (targetRotation % 360f + 360f) % 360f
                val sectorAngle = 360f / WHEEL_SECTORS.size
                val idx = ((360f - normalized) / sectorAngle).toInt() % WHEEL_SECTORS.size
                val sector = WHEEL_SECTORS[idx.coerceIn(0, WHEEL_SECTORS.size - 1)]
                val win = (bet * sector.multiplier).toInt()
                onResult(game.id, game.name, bet, win)
                won = win > 0
                resultMsg = if (win > 0) "🎉 ${sector.label}! Won 💎$win" else "😔 No luck! Lost 💎$bet"
            }
        },
        label = "wheel",
    )

    GameShell(game = game, diamondBalance = diamondBalance, onBack = onBack) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.size(260.dp)) {
            Canvas(modifier = Modifier.size(240.dp).rotate(animatedRotation)) {
                val sectorAngle = 360f / WHEEL_SECTORS.size
                WHEEL_SECTORS.forEachIndexed { i, sector ->
                    drawArc(color = sector.color, startAngle = i * sectorAngle - 90f, sweepAngle = sectorAngle, useCenter = true)
                    drawLine(
                        color = Color.Black.copy(alpha = 0.4f), start = center,
                        end = Offset(
                            center.x + size.width / 2 * cos(Math.toRadians((i * sectorAngle - 90.0))).toFloat(),
                            center.y + size.height / 2 * sin(Math.toRadians((i * sectorAngle - 90.0))).toFloat(),
                        ),
                        strokeWidth = 3f,
                    )
                }
                drawCircle(color = Color.White, radius = 24f, center = center)
                drawCircle(color = Color(0xFF212121), radius = 18f, center = center)
            }
            Text("▼", color = Color(0xFFFFD700), fontSize = 28.sp,
                modifier = Modifier.align(Alignment.TopCenter).offset(y = (-4).dp))
        }

        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            WHEEL_SECTORS.filter { it.multiplier > 0 }.distinctBy { it.label }.take(4).forEach { s ->
                Box(
                    modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(s.color)
                        .padding(horizontal = 8.dp, vertical = 4.dp),
                ) { Text(s.label, color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold) }
            }
        }

        Spacer(Modifier.height(12.dp))
        resultMsg?.let { ResultBanner(won = won, message = it) }
        Spacer(Modifier.height(12.dp))

        BetSelector(bet = bet, onBetChange = { if (!spinning) bet = it }, maxBet = diamondBalance)
        Spacer(Modifier.height(16.dp))

        Button(
            onClick = {
                if (spinning || diamondBalance < bet) return@Button
                spinning = true; resultMsg = null; won = null
                targetRotation += 360f * (5 + Random.nextInt(5)) + Random.nextFloat() * 360f
            },
            enabled = !spinning && diamondBalance >= bet,
            modifier = Modifier.fillMaxWidth().height(52.dp),
            colors = ButtonDefaults.buttonColors(containerColor = BrandPink),
            shape = RoundedCornerShape(14.dp),
        ) {
            Text(if (spinning) "Spinning..." else "🎡  SPIN  (Bet 💎$bet)",
                fontWeight = FontWeight.Bold, fontSize = 16.sp)
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. SLOTS
// ─────────────────────────────────────────────────────────────────────────────

private val SLOT_SYMBOLS = listOf("🍒", "🍋", "🍊", "🍇", "💎", "7️⃣", "⭐", "🔔")

@Composable
private fun SlotsGame(
    game: GameItem,
    diamondBalance: Int,
    onResult: (String, String, Int, Int) -> Boolean,
    onBack: () -> Unit,
) {
    var bet by remember { mutableStateOf(50) }
    var reels by remember { mutableStateOf(listOf("🍒", "🍋", "🍊")) }
    var spinning by remember { mutableStateOf(false) }
    var resultMsg by remember { mutableStateOf<String?>(null) }
    var won by remember { mutableStateOf<Boolean?>(null) }
    val scope = rememberCoroutineScope()

    GameShell(game = game, diamondBalance = diamondBalance, onBack = onBack) {
        Spacer(Modifier.height(16.dp))
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(20.dp))
                .background(Color(0xFF1a0a00))
                .padding(24.dp),
        ) {
            Row(horizontalArrangement = Arrangement.SpaceEvenly, modifier = Modifier.fillMaxWidth()) {
                reels.forEachIndexed { idx, symbol ->
                    val infiniteTransition = rememberInfiniteTransition(label = "slot$idx")
                    val spinY by infiniteTransition.animateFloat(
                        initialValue = 0f, targetValue = 8f,
                        animationSpec = infiniteRepeatable(tween(100 + idx * 20), RepeatMode.Restart),
                        label = "reel$idx",
                    )
                    Box(
                        modifier = Modifier
                            .size(80.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .background(Color(0xFF2d1a00))
                            .border(2.dp, Color(0xFFFFD700), RoundedCornerShape(12.dp)),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = if (spinning) SLOT_SYMBOLS[spinY.toInt() % SLOT_SYMBOLS.size] else symbol,
                            fontSize = 36.sp,
                        )
                    }
                }
            }
        }

        Spacer(Modifier.height(16.dp))
        Column(
            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(AppSurface).padding(12.dp),
        ) {
            Text("Payouts", color = GoldAccent, fontWeight = FontWeight.Bold, fontSize = 13.sp)
            Spacer(Modifier.height(4.dp))
            listOf("💎💎💎 = 50x", "7️⃣7️⃣7️⃣ = 25x", "⭐⭐⭐ = 15x", "3 of any = 10x", "2 of any = 2x").forEach {
                Text(it, color = TextSecondary, fontSize = 12.sp)
            }
        }

        Spacer(Modifier.height(12.dp))
        resultMsg?.let { ResultBanner(won = won, message = it) }
        Spacer(Modifier.height(12.dp))

        BetSelector(bet = bet, onBetChange = { if (!spinning) bet = it }, maxBet = diamondBalance)
        Spacer(Modifier.height(16.dp))

        Button(
            onClick = {
                if (spinning || diamondBalance < bet) return@Button
                spinning = true; resultMsg = null; won = null
                scope.launch {
                    delay(1500)
                    val r1 = SLOT_SYMBOLS.random(); val r2 = SLOT_SYMBOLS.random(); val r3 = SLOT_SYMBOLS.random()
                    reels = listOf(r1, r2, r3); spinning = false
                    val mult = when {
                        r1 == r2 && r2 == r3 -> when (r1) { "💎" -> 50; "7️⃣" -> 25; "⭐" -> 15; else -> 10 }
                        r1 == r2 || r2 == r3 || r1 == r3 -> 2
                        else -> 0
                    }
                    val win = bet * mult
                    onResult(game.id, game.name, bet, win)
                    won = win > 0
                    resultMsg = if (win > 0) "🎉 ${mult}x match! Won 💎$win!" else "No match. Lost 💎$bet"
                }
            },
            enabled = !spinning && diamondBalance >= bet,
            modifier = Modifier.fillMaxWidth().height(52.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFf39c12)),
            shape = RoundedCornerShape(14.dp),
        ) {
            Text(if (spinning) "Spinning..." else "🎰  SPIN  (Bet 💎$bet)",
                fontWeight = FontWeight.Bold, fontSize = 16.sp, color = Color.Black)
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. DICE DUEL
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun DiceGame(
    game: GameItem,
    diamondBalance: Int,
    onResult: (String, String, Int, Int) -> Boolean,
    onBack: () -> Unit,
) {
    var bet by remember { mutableStateOf(50) }
    var guess by remember { mutableStateOf<String?>(null) }
    var dice by remember { mutableStateOf(listOf(1, 1)) }
    var rolling by remember { mutableStateOf(false) }
    var resultMsg by remember { mutableStateOf<String?>(null) }
    var won by remember { mutableStateOf<Boolean?>(null) }
    val scope = rememberCoroutineScope()

    val diceFaces = listOf("⚀", "⚁", "⚂", "⚃", "⚄", "⚅")

    GameShell(game = game, diamondBalance = diamondBalance, onBack = onBack) {
        Spacer(Modifier.height(16.dp))
        Row(horizontalArrangement = Arrangement.SpaceEvenly, modifier = Modifier.fillMaxWidth()) {
            dice.forEachIndexed { idx, face ->
                val infiniteTransition = rememberInfiniteTransition(label = "die$idx")
                val roll by infiniteTransition.animateFloat(
                    initialValue = 0f, targetValue = 6f,
                    animationSpec = infiniteRepeatable(tween(120 + idx * 30), RepeatMode.Restart),
                    label = "die$idx",
                )
                Box(
                    modifier = Modifier.size(90.dp).clip(RoundedCornerShape(16.dp))
                        .background(Color.White).border(2.dp, OutlineDefault, RoundedCornerShape(16.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = if (rolling) diceFaces[roll.toInt() % 6] else diceFaces[(face - 1).coerceIn(0, 5)],
                        fontSize = 48.sp,
                    )
                }
            }
        }

        if (!rolling) {
            Spacer(Modifier.height(8.dp))
            Text("Sum: ${dice.sum()}", color = TextSecondary, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        }

        Spacer(Modifier.height(16.dp))
        Text("Your Guess:", color = TextSecondary, fontSize = 13.sp)
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            listOf("LOW" to "LOW\n2-6\n2x", "LUCKY7" to "LUCKY 7\n=7\n5x", "HIGH" to "HIGH\n8-12\n2x").forEach { (key, label) ->
                val selected = guess == key
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(10.dp))
                        .background(if (selected) BrandPurple else AppSurface)
                        .border(1.dp, if (selected) BrandPurple else OutlineDefault, RoundedCornerShape(10.dp))
                        .clickable { if (!rolling) guess = key }
                        .padding(vertical = 10.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(label, color = if (selected) Color.White else TextPrimary, fontSize = 11.sp,
                        fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal, textAlign = TextAlign.Center)
                }
            }
        }

        Spacer(Modifier.height(12.dp))
        resultMsg?.let { ResultBanner(won = won, message = it) }
        Spacer(Modifier.height(12.dp))

        BetSelector(bet = bet, onBetChange = { if (!rolling) bet = it }, maxBet = diamondBalance)
        Spacer(Modifier.height(16.dp))

        Button(
            onClick = {
                if (rolling || guess == null || diamondBalance < bet) return@Button
                rolling = true; resultMsg = null; won = null
                scope.launch {
                    delay(1200)
                    val d1 = Random.nextInt(1, 7); val d2 = Random.nextInt(1, 7)
                    dice = listOf(d1, d2); rolling = false
                    val total = d1 + d2
                    val userWon = when (guess) {
                        "LOW" -> total in 2..6; "HIGH" -> total in 8..12; "LUCKY7" -> total == 7; else -> false
                    }
                    val win = if (userWon) bet * (if (guess == "LUCKY7") 5 else 2) else 0
                    onResult(game.id, game.name, bet, win)
                    won = userWon
                    resultMsg = if (userWon) "🎲 Rolled $total! Won 💎$win!" else "Rolled $total. Lost 💎$bet"
                }
            },
            enabled = !rolling && guess != null && diamondBalance >= bet,
            modifier = Modifier.fillMaxWidth().height(52.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF4776e6)),
            shape = RoundedCornerShape(14.dp),
        ) {
            Text(if (rolling) "Rolling..." else "🎲  ROLL  (Bet 💎$bet)",
                fontWeight = FontWeight.Bold, fontSize = 16.sp)
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. MINES
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun MinesGame(
    game: GameItem,
    diamondBalance: Int,
    onResult: (String, String, Int, Int) -> Boolean,
    onBack: () -> Unit,
) {
    val gridSize = 5; val mineCount = 5
    var bet by remember { mutableStateOf(50) }
    var mines by remember { mutableStateOf(emptySet<Int>()) }
    var revealed by remember { mutableStateOf(emptySet<Int>()) }
    var gameOver by remember { mutableStateOf(false) }
    var gameStarted by remember { mutableStateOf(false) }
    var resultMsg by remember { mutableStateOf<String?>(null) }
    var won by remember { mutableStateOf<Boolean?>(null) }

    val safeCount = revealed.size
    val currentMult = 1.0f + safeCount * 0.35f

    GameShell(game = game, diamondBalance = diamondBalance, onBack = onBack) {
        if (gameStarted) {
            Row(
                horizontalArrangement = Arrangement.SpaceBetween,
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(AppSurface).padding(12.dp),
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Safe", color = TextSecondary, fontSize = 11.sp)
                    Text("$safeCount", color = Color(0xFF00E676), fontWeight = FontWeight.Bold, fontSize = 18.sp)
                }
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Multiplier", color = TextSecondary, fontSize = 11.sp)
                    Text("%.2fx".format(currentMult), color = GoldAccent, fontWeight = FontWeight.Bold, fontSize = 18.sp)
                }
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Potential Win", color = TextSecondary, fontSize = 11.sp)
                    Text("💎${(bet * currentMult).toInt()}", color = BrandPink, fontWeight = FontWeight.Bold, fontSize = 18.sp)
                }
            }
            Spacer(Modifier.height(12.dp))
        }

        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            repeat(gridSize) { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
                    repeat(gridSize) { col ->
                        val idx = row * gridSize + col
                        val isRevealed = idx in revealed
                        val isMine = idx in mines
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .aspectRatio(1f)
                                .clip(RoundedCornerShape(10.dp))
                                .background(
                                    when {
                                        isRevealed && isMine -> Color(0xFFD50000)
                                        isRevealed           -> Color(0xFF00C853)
                                        gameStarted && !gameOver -> Color(0xFF37474F)
                                        gameOver && isMine   -> Color(0xFFD50000).copy(alpha = 0.5f)
                                        else                 -> AppSurface
                                    }
                                )
                                .border(1.dp, OutlineDefault, RoundedCornerShape(10.dp))
                                .clickable(enabled = gameStarted && !gameOver && !isRevealed) {
                                    if (isMine) {
                                        revealed = revealed + idx; gameOver = true
                                        onResult(game.id, game.name, bet, 0)
                                        won = false; resultMsg = "💣 BOOM! Hit a mine! Lost 💎$bet"
                                    } else {
                                        revealed = revealed + idx
                                    }
                                },
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                text = when {
                                    isRevealed && isMine -> "💣"
                                    isRevealed           -> "💎"
                                    gameOver && isMine   -> "💣"
                                    gameStarted && !gameOver -> "?"
                                    else -> ""
                                },
                                fontSize = 20.sp,
                            )
                        }
                    }
                }
            }
        }

        Spacer(Modifier.height(12.dp))
        resultMsg?.let { ResultBanner(won = won, message = it) }
        Spacer(Modifier.height(12.dp))

        if (!gameStarted || gameOver) {
            BetSelector(bet = bet, onBetChange = { bet = it }, maxBet = diamondBalance)
            Spacer(Modifier.height(12.dp))
            Button(
                onClick = {
                    if (diamondBalance < bet) return@Button
                    mines = (0 until gridSize * gridSize).toList().shuffled().take(mineCount).toSet()
                    revealed = emptySet(); gameOver = false; gameStarted = true; resultMsg = null; won = null
                },
                modifier = Modifier.fillMaxWidth().height(52.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF4286f4)),
                shape = RoundedCornerShape(14.dp),
            ) {
                Text(if (gameStarted) "Play Again  (Bet 💎$bet)" else "💣  START  (Bet 💎$bet)",
                    fontWeight = FontWeight.Bold, fontSize = 16.sp)
            }
        } else {
            Button(
                onClick = {
                    val win = (bet * currentMult).toInt()
                    onResult(game.id, game.name, bet, win)
                    gameOver = true; won = true; resultMsg = "🎉 Cashed out $safeCount tiles! Won 💎$win"
                },
                modifier = Modifier.fillMaxWidth().height(52.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF00C853)),
                shape = RoundedCornerShape(14.dp),
            ) {
                Text("💰  CASH OUT  (💎${(bet * currentMult).toInt()})",
                    fontWeight = FontWeight.Bold, fontSize = 16.sp, color = Color.Black)
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. COIN FLIP
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun CoinFlipGame(
    game: GameItem,
    diamondBalance: Int,
    onResult: (String, String, Int, Int) -> Boolean,
    onBack: () -> Unit,
) {
    var bet by remember { mutableStateOf(50) }
    var choice by remember { mutableStateOf<String?>(null) }
    var flipping by remember { mutableStateOf(false) }
    var flipResult by remember { mutableStateOf<String?>(null) }
    var resultMsg by remember { mutableStateOf<String?>(null) }
    var won by remember { mutableStateOf<Boolean?>(null) }
    val scope = rememberCoroutineScope()

    val rotation by animateFloatAsState(
        targetValue = if (flipping) 720f else 0f,
        animationSpec = tween(durationMillis = 1000, easing = FastOutSlowInEasing),
        label = "coin",
    )

    GameShell(game = game, diamondBalance = diamondBalance, onBack = onBack) {
        Spacer(Modifier.height(32.dp))
        Box(
            modifier = Modifier.size(160.dp).rotate(rotation).clip(CircleShape)
                .background(Brush.radialGradient(colors = listOf(Color(0xFFFFD700), Color(0xFFFF8C00)))),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = when (flipResult) { "HEADS" -> "👑"; "TAILS" -> "⚡"; else -> if (choice == "HEADS") "👑" else if (choice == "TAILS") "⚡" else "🪙" },
                fontSize = 64.sp,
            )
        }

        Spacer(Modifier.height(24.dp))
        Text("Choose:", color = TextSecondary, fontSize = 14.sp)
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            listOf("HEADS" to "👑", "TAILS" to "⚡").forEach { (key, icon) ->
                val selected = choice == key
                Box(
                    modifier = Modifier.size(100.dp).clip(CircleShape)
                        .background(if (selected) BrandPurple else AppSurface)
                        .border(2.dp, if (selected) BrandPurple else OutlineDefault, CircleShape)
                        .clickable { if (!flipping) choice = key },
                    contentAlignment = Alignment.Center,
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(icon, fontSize = 32.sp)
                        Text(key, color = if (selected) Color.White else TextSecondary, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }

        Spacer(Modifier.height(20.dp))
        resultMsg?.let { ResultBanner(won = won, message = it) }
        Spacer(Modifier.height(12.dp))

        BetSelector(bet = bet, onBetChange = { if (!flipping) bet = it }, maxBet = diamondBalance)
        Spacer(Modifier.height(16.dp))

        Button(
            onClick = {
                if (flipping || choice == null || diamondBalance < bet) return@Button
                flipping = true; resultMsg = null; won = null; flipResult = null
                scope.launch {
                    delay(1100)
                    val flip = if (Random.nextBoolean()) "HEADS" else "TAILS"
                    flipResult = flip; flipping = false
                    val userWon = flip == choice
                    val win = if (userWon) bet * 2 else 0
                    onResult(game.id, game.name, bet, win)
                    won = userWon
                    resultMsg = if (userWon) "🎉 $flip! Won 💎$win!" else "😔 $flip! Lost 💎$bet"
                }
            },
            enabled = !flipping && choice != null && diamondBalance >= bet,
            modifier = Modifier.fillMaxWidth().height(52.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFf7971e)),
            shape = RoundedCornerShape(14.dp),
        ) {
            Text(if (flipping) "Flipping..." else "🪙  FLIP  (Bet 💎$bet)",
                fontWeight = FontWeight.Bold, fontSize = 16.sp, color = Color.Black)
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. PLINKO
// ─────────────────────────────────────────────────────────────────────────────

private val PLINKO_MULTIPLIERS = listOf(10f, 3f, 1.5f, 0.5f, 1.5f, 3f, 10f)

@Composable
private fun PlinkoGame(
    game: GameItem,
    diamondBalance: Int,
    onResult: (String, String, Int, Int) -> Boolean,
    onBack: () -> Unit,
) {
    var bet by remember { mutableStateOf(50) }
    var dropping by remember { mutableStateOf(false) }
    var ballX by remember { mutableStateOf(0.5f) }
    var ballProgress by remember { mutableStateOf(0f) }
    var landedSlot by remember { mutableStateOf<Int?>(null) }
    var resultMsg by remember { mutableStateOf<String?>(null) }
    var won by remember { mutableStateOf<Boolean?>(null) }
    val scope = rememberCoroutineScope()

    val animBallProgress by animateFloatAsState(
        targetValue = ballProgress,
        animationSpec = tween(durationMillis = if (dropping) 2000 else 0, easing = LinearEasing),
        label = "ball",
    )

    GameShell(game = game, diamondBalance = diamondBalance, onBack = onBack) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(240.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(Color(0xFF0d0d1a)),
        ) {
            Canvas(modifier = Modifier.fillMaxSize()) {
                // Pegs
                val cols = 7; val rows = 6
                repeat(rows) { r ->
                    val offsetX = if (r % 2 != 0) size.width / (cols * 2) else 0f
                    val pegsInRow = if (r % 2 == 0) cols else cols - 1
                    repeat(pegsInRow) { c ->
                        val x = offsetX + (c + 1) * size.width / (cols + 1)
                        val y = (r + 1) * size.height * 0.8f / (rows + 1)
                        drawCircle(color = Color(0xFF00E5FF), radius = 7f, center = Offset(x, y))
                    }
                }
                // Ball
                if (dropping || landedSlot != null) {
                    val bx = size.width * ballX
                    val by = size.height * animBallProgress * 0.82f
                    drawCircle(color = Color(0xFFFF4081), radius = 12f, center = Offset(bx, by))
                }
            }
            // Slot labels
            Row(
                horizontalArrangement = Arrangement.SpaceEvenly,
                modifier = Modifier.fillMaxWidth().align(Alignment.BottomCenter).padding(4.dp),
            ) {
                PLINKO_MULTIPLIERS.forEachIndexed { i, mult ->
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .height(28.dp)
                            .padding(1.dp)
                            .clip(RoundedCornerShape(4.dp))
                            .background(
                                when {
                                    i == 0 || i == PLINKO_MULTIPLIERS.size - 1 -> Color(0xFF7C4DFF)
                                    mult >= 3f -> Color(0xFFFF4081)
                                    else -> AppSurface
                                }
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text("${mult.toInt()}x", color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }

        Spacer(Modifier.height(16.dp))
        resultMsg?.let { ResultBanner(won = won, message = it) }
        Spacer(Modifier.height(12.dp))

        BetSelector(bet = bet, onBetChange = { if (!dropping) bet = it }, maxBet = diamondBalance)
        Spacer(Modifier.height(16.dp))

        Button(
            onClick = {
                if (dropping || diamondBalance < bet) return@Button
                dropping = true; resultMsg = null; won = null; landedSlot = null
                ballX = 0.5f; ballProgress = 0f
                scope.launch {
                    var x = 0.5f
                    repeat(12) {
                        delay(160)
                        x += (Random.nextFloat() - 0.5f) * 0.12f
                        x = x.coerceIn(0.07f, 0.93f)
                        ballX = x
                    }
                    ballProgress = 1f
                    delay(400)
                    val slot = ((x * PLINKO_MULTIPLIERS.size).toInt()).coerceIn(0, PLINKO_MULTIPLIERS.size - 1)
                    landedSlot = slot; dropping = false
                    val mult = PLINKO_MULTIPLIERS[slot]
                    val win = (bet * mult).toInt()
                    onResult(game.id, game.name, bet, win)
                    won = win > 0
                    resultMsg = if (win > bet) "🎉 ${mult}x! Won 💎$win!" else if (win == 0) "😔 Missed! Lost 💎$bet" else "Landed ${mult}x. Got 💎$win"
                }
            },
            enabled = !dropping && diamondBalance >= bet,
            modifier = Modifier.fillMaxWidth().height(52.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFfc5c7d)),
            shape = RoundedCornerShape(14.dp),
        ) {
            Text(if (dropping) "Dropping..." else "⚪  DROP BALL  (Bet 💎$bet)",
                fontWeight = FontWeight.Bold, fontSize = 16.sp)
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Card utilities (shared by Teen Patti, Blackjack, Baccarat)
// ─────────────────────────────────────────────────────────────────────────────

private val CARD_SUITS = listOf("♠", "♥", "♦", "♣")
private val CARD_RANKS = listOf("2","3","4","5","6","7","8","9","10","J","Q","K","A")

private data class Card(val rank: String, val suit: String) {
    val isRed get() = suit == "♥" || suit == "♦"
}

private fun randomCard() = Card(CARD_RANKS.random(), CARD_SUITS.random())

@Composable
private fun CardView(card: Card?, faceDown: Boolean) {
    Box(
        modifier = Modifier
            .size(width = 58.dp, height = 78.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(if (faceDown || card == null) Color(0xFF1a237e) else Color.White)
            .border(1.dp, OutlineDefault, RoundedCornerShape(8.dp)),
        contentAlignment = Alignment.Center,
    ) {
        if (faceDown || card == null) {
            Text("🂠", fontSize = 28.sp)
        } else {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(card.rank, color = if (card.isRed) Color(0xFFD32F2F) else Color.Black, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                Text(card.suit, color = if (card.isRed) Color(0xFFD32F2F) else Color.Black, fontSize = 18.sp)
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. TEEN PATTI (3-card Indian poker)
// ─────────────────────────────────────────────────────────────────────────────

private fun cardRankValue(card: Card) = CARD_RANKS.indexOf(card.rank)

private fun handScore(cards: List<Card>): Int {
    val sorted = cards.sortedByDescending { cardRankValue(it) }
    val ranks = sorted.map { cardRankValue(it) }
    val suits = sorted.map { it.suit }
    val isFlush = suits.all { it == suits[0] }
    val isStraight = ranks[0] - ranks[2] == 2 && ranks[0] - ranks[1] == 1
    return when {
        isFlush && isStraight             -> 6
        ranks[0] == ranks[1] && ranks[1] == ranks[2] -> 5
        isStraight                        -> 4
        isFlush                           -> 3
        ranks[0] == ranks[1] || ranks[1] == ranks[2] -> 2
        else                              -> 1
    }
}

private val handNames = listOf("", "High Card", "Pair", "Flush", "Straight", "3 of a Kind", "Straight Flush")

@Composable
private fun TeenPattiGame(
    game: GameItem,
    diamondBalance: Int,
    onResult: (String, String, Int, Int) -> Boolean,
    onBack: () -> Unit,
) {
    var bet by remember { mutableStateOf(50) }
    var playerCards by remember { mutableStateOf(emptyList<Card>()) }
    var dealerCards by remember { mutableStateOf(emptyList<Card>()) }
    var revealed by remember { mutableStateOf(false) }
    var playing by remember { mutableStateOf(false) }
    var resultMsg by remember { mutableStateOf<String?>(null) }
    var won by remember { mutableStateOf<Boolean?>(null) }

    GameShell(game = game, diamondBalance = diamondBalance, onBack = onBack) {
        Spacer(Modifier.height(8.dp))
        Text("Dealer", color = TextSecondary, fontSize = 13.sp)
        Spacer(Modifier.height(6.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            repeat(3) { i ->
                CardView(card = if (revealed && i < dealerCards.size) dealerCards[i] else null, faceDown = !revealed || i >= dealerCards.size)
            }
        }

        Spacer(Modifier.height(20.dp))
        Text("You", color = TextPrimary, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(6.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            repeat(3) { i ->
                CardView(card = if (i < playerCards.size) playerCards[i] else null, faceDown = i >= playerCards.size)
            }
        }

        Spacer(Modifier.height(16.dp))
        resultMsg?.let { ResultBanner(won = won, message = it) }
        Spacer(Modifier.height(12.dp))

        if (!playing || revealed) {
            BetSelector(bet = bet, onBetChange = { bet = it }, maxBet = diamondBalance)
            Spacer(Modifier.height(12.dp))
            Button(
                onClick = {
                    if (diamondBalance < bet) return@Button
                    playing = true; revealed = false; resultMsg = null; won = null
                    playerCards = listOf(randomCard(), randomCard(), randomCard())
                    dealerCards = listOf(randomCard(), randomCard(), randomCard())
                },
                modifier = Modifier.fillMaxWidth().height(52.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF7b2d8b)),
                shape = RoundedCornerShape(14.dp),
            ) {
                Text(if (revealed) "Deal Again  (Bet 💎$bet)" else "🃏  DEAL  (Bet 💎$bet)",
                    fontWeight = FontWeight.Bold, fontSize = 16.sp)
            }
        }

        if (playing && !revealed) {
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(
                    onClick = {
                        revealed = true
                        val pScore = handScore(playerCards); val dScore = handScore(dealerCards)
                        val userWon = pScore > dScore; val tie = pScore == dScore
                        val win = if (userWon) bet * 2 else if (tie) bet else 0
                        onResult(game.id, game.name, bet, win)
                        won = userWon || tie
                        resultMsg = when {
                            userWon -> "🎉 ${handNames[pScore]} beats ${handNames[dScore]}! Won 💎${bet * 2}"
                            tie     -> "🤝 Tie (${handNames[pScore]}) — Bet returned"
                            else    -> "😔 Dealer: ${handNames[dScore]}. Lost 💎$bet"
                        }
                    },
                    modifier = Modifier.weight(1f).height(48.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFe91e8c)),
                    shape = RoundedCornerShape(12.dp),
                ) { Text("Chaal (Call)", fontWeight = FontWeight.Bold, fontSize = 13.sp) }

                Button(
                    onClick = {
                        revealed = true
                        onResult(game.id, game.name, bet, 0)
                        won = false; resultMsg = "You packed. Lost 💎$bet"
                    },
                    modifier = Modifier.weight(1f).height(48.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = AppSurface),
                    shape = RoundedCornerShape(12.dp),
                ) { Text("Pack (Fold)", color = TextPrimary, fontWeight = FontWeight.Bold, fontSize = 13.sp) }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. BLACKJACK
// ─────────────────────────────────────────────────────────────────────────────

private fun blackjackValue(card: Card) = when (card.rank) { "A" -> 11; "J", "Q", "K" -> 10; else -> card.rank.toIntOrNull() ?: 0 }

private fun handTotal(cards: List<Card>): Int {
    var total = cards.sumOf { blackjackValue(it) }
    var aces = cards.count { it.rank == "A" }
    while (total > 21 && aces > 0) { total -= 10; aces-- }
    return total
}

@Composable
private fun BlackjackGame(
    game: GameItem,
    diamondBalance: Int,
    onResult: (String, String, Int, Int) -> Boolean,
    onBack: () -> Unit,
) {
    var bet by remember { mutableStateOf(50) }
    var playerHand by remember { mutableStateOf(emptyList<Card>()) }
    var dealerHand by remember { mutableStateOf(emptyList<Card>()) }
    var standing by remember { mutableStateOf(false) }
    var started by remember { mutableStateOf(false) }
    var resultMsg by remember { mutableStateOf<String?>(null) }
    var won by remember { mutableStateOf<Boolean?>(null) }

    val playerTotal = handTotal(playerHand)
    val dealerTotal = handTotal(dealerHand)
    val bust = playerTotal > 21

    GameShell(game = game, diamondBalance = diamondBalance, onBack = onBack) {
        Spacer(Modifier.height(8.dp))
        Text("Dealer: ${if (standing || bust) dealerTotal.toString() else "?"}", color = TextSecondary, fontSize = 13.sp)
        Spacer(Modifier.height(6.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            dealerHand.forEachIndexed { i, c ->
                CardView(card = c, faceDown = i == 1 && !standing && !bust)
            }
        }

        Spacer(Modifier.height(20.dp))
        Text(
            text = "You: $playerTotal${if (bust) " (BUST)" else ""}",
            color = if (bust) Color(0xFFFF1744) else TextPrimary,
            fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
        )
        Spacer(Modifier.height(6.dp))
        Row(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier.horizontalScroll(rememberScrollState()),
        ) { playerHand.forEach { CardView(card = it, faceDown = false) } }

        Spacer(Modifier.height(16.dp))
        resultMsg?.let { ResultBanner(won = won, message = it) }
        Spacer(Modifier.height(12.dp))

        if (!started || standing || bust || resultMsg != null) {
            BetSelector(bet = bet, onBetChange = { bet = it }, maxBet = diamondBalance)
            Spacer(Modifier.height(12.dp))
            Button(
                onClick = {
                    if (diamondBalance < bet) return@Button
                    started = true; standing = false; resultMsg = null; won = null
                    playerHand = listOf(randomCard(), randomCard())
                    dealerHand = listOf(randomCard(), randomCard())
                },
                modifier = Modifier.fillMaxWidth().height(52.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF212121)),
                shape = RoundedCornerShape(14.dp),
            ) {
                Text(if (started) "Deal Again  (Bet 💎$bet)" else "♠️  DEAL  (Bet 💎$bet)",
                    fontWeight = FontWeight.Bold, fontSize = 16.sp)
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(
                    onClick = {
                        val newHand = playerHand + randomCard()
                        playerHand = newHand
                        if (handTotal(newHand) > 21) {
                            onResult(game.id, game.name, bet, 0)
                            won = false; resultMsg = "💥 Bust (${ handTotal(newHand)})! Lost 💎$bet"
                        }
                    },
                    modifier = Modifier.weight(1f).height(48.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF1565C0)),
                    shape = RoundedCornerShape(12.dp),
                ) { Text("Hit", fontWeight = FontWeight.Bold) }

                Button(
                    onClick = {
                        standing = true
                        var dh = dealerHand.toMutableList()
                        while (handTotal(dh) < 17) dh.add(randomCard())
                        dealerHand = dh
                        val pv = playerTotal; val dv = handTotal(dh)
                        val userWon = pv > dv || dv > 21; val tie = pv == dv
                        val win = if (userWon) bet * 2 else if (tie) bet else 0
                        onResult(game.id, game.name, bet, win)
                        won = userWon || tie
                        resultMsg = when {
                            dv > 21  -> "🎉 Dealer bust! Won 💎${bet * 2}"
                            userWon  -> "🎉 $pv vs $dv — You win! Won 💎${bet * 2}"
                            tie      -> "🤝 Push $pv = $dv — Bet returned"
                            else     -> "😔 Dealer $dv vs $pv. Lost 💎$bet"
                        }
                    },
                    modifier = Modifier.weight(1f).height(48.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2E7D32)),
                    shape = RoundedCornerShape(12.dp),
                ) { Text("Stand", fontWeight = FontWeight.Bold) }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. ROULETTE
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun RouletteGame(
    game: GameItem,
    diamondBalance: Int,
    onResult: (String, String, Int, Int) -> Boolean,
    onBack: () -> Unit,
) {
    var bet by remember { mutableStateOf(50) }
    var betType by remember { mutableStateOf<String?>(null) }
    var spinning by remember { mutableStateOf(false) }
    var landedNumber by remember { mutableStateOf<Int?>(null) }
    var resultMsg by remember { mutableStateOf<String?>(null) }
    var won by remember { mutableStateOf<Boolean?>(null) }
    val scope = rememberCoroutineScope()

    val redNumbers = setOf(1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36)

    var rotationTarget by remember { mutableStateOf(0f) }
    val rotation by animateFloatAsState(
        targetValue = rotationTarget,
        animationSpec = tween(durationMillis = 3000, easing = FastOutSlowInEasing),
        finishedListener = {
            if (spinning) {
                spinning = false
                val n = Random.nextInt(0, 37)
                landedNumber = n
                val isRed = n in redNumbers
                val userWon = when (betType) {
                    "RED" -> isRed && n != 0; "BLACK" -> !isRed && n != 0
                    "GREEN" -> n == 0; "ODD" -> n % 2 == 1 && n != 0
                    "EVEN" -> n % 2 == 0 && n != 0; "LOW" -> n in 1..18; "HIGH" -> n in 19..36
                    else -> false
                }
                val mult = if (betType == "GREEN") 18 else 2
                val win = if (userWon) bet * mult else 0
                onResult(game.id, game.name, bet, win)
                won = userWon
                resultMsg = if (userWon) "🎉 $n ${if (isRed) "Red" else if (n==0) "Green" else "Black"}! Won 💎$win"
                    else "😔 $n ${if (isRed) "Red" else if (n==0) "Green" else "Black"}. Lost 💎$bet"
            }
        },
        label = "roulette",
    )

    GameShell(game = game, diamondBalance = diamondBalance, onBack = onBack) {
        Box(modifier = Modifier.size(200.dp), contentAlignment = Alignment.Center) {
            Canvas(modifier = Modifier.size(200.dp).rotate(rotation)) {
                val sectors = 37; val angle = 360f / sectors
                (0..36).forEach { n ->
                    val color = when { n == 0 -> Color(0xFF00C853); n in redNumbers -> Color(0xFFD32F2F); else -> Color(0xFF212121) }
                    drawArc(color = color, startAngle = n * angle - 90f, sweepAngle = angle, useCenter = true)
                    drawArc(color = Color.Black, startAngle = n * angle - 90f, sweepAngle = angle, useCenter = true, style = Stroke(1f))
                }
                drawCircle(color = Color(0xFF795548), radius = 28f, center = center)
            }
            Text(
                text = landedNumber?.toString() ?: "?",
                color = Color.White, fontWeight = FontWeight.Bold, fontSize = 20.sp,
            )
            Text("▼", color = GoldAccent, fontSize = 20.sp,
                modifier = Modifier.align(Alignment.TopCenter).offset(y = (-8).dp))
        }

        Spacer(Modifier.height(16.dp))
        val betOptions = listOf("RED" to "Red 2x", "BLACK" to "Black 2x", "GREEN" to "0️⃣ 18x",
            "ODD" to "Odd 2x", "EVEN" to "Even 2x", "LOW" to "1-18 2x", "HIGH" to "19-36 2x")
        Text("Bet On:", color = TextSecondary, fontSize = 13.sp)
        Spacer(Modifier.height(8.dp))
        LazyVerticalGrid(
            columns = GridCells.Fixed(3),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier.height(80.dp),
        ) {
            items(betOptions) { (key, label) ->
                val selected = betType == key
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .background(
                            if (selected) when (key) { "RED" -> Color(0xFFD32F2F); "GREEN" -> Color(0xFF00C853); else -> BrandPurple }
                            else AppSurface
                        )
                        .border(1.dp, OutlineDefault, RoundedCornerShape(8.dp))
                        .clickable { if (!spinning) betType = key }
                        .padding(6.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(label, color = if (selected) Color.White else TextPrimary, fontSize = 10.sp,
                        fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal, textAlign = TextAlign.Center)
                }
            }
        }

        Spacer(Modifier.height(8.dp))
        resultMsg?.let { ResultBanner(won = won, message = it) }
        Spacer(Modifier.height(8.dp))

        BetSelector(bet = bet, onBetChange = { if (!spinning) bet = it }, maxBet = diamondBalance)
        Spacer(Modifier.height(12.dp))

        Button(
            onClick = {
                if (spinning || betType == null || diamondBalance < bet) return@Button
                spinning = true; resultMsg = null; won = null; landedNumber = null
                rotationTarget += 1440f + Random.nextFloat() * 360f
            },
            enabled = !spinning && betType != null && diamondBalance >= bet,
            modifier = Modifier.fillMaxWidth().height(52.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF1a6b4a)),
            shape = RoundedCornerShape(14.dp),
        ) {
            Text(if (spinning) "Spinning..." else "🎯  SPIN  (Bet 💎$bet)",
                fontWeight = FontWeight.Bold, fontSize = 16.sp)
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. BACCARAT
// ─────────────────────────────────────────────────────────────────────────────

private fun baccaratCardValue(card: Card) = minOf(blackjackValue(card), 10)
private fun baccaratHandValue(cards: List<Card>) = cards.sumOf { baccaratCardValue(it) } % 10

@Composable
private fun BaccaratGame(
    game: GameItem,
    diamondBalance: Int,
    onResult: (String, String, Int, Int) -> Boolean,
    onBack: () -> Unit,
) {
    var bet by remember { mutableStateOf(50) }
    var betOn by remember { mutableStateOf<String?>(null) }
    var playerHand by remember { mutableStateOf(emptyList<Card>()) }
    var bankerHand by remember { mutableStateOf(emptyList<Card>()) }
    var revealed by remember { mutableStateOf(false) }
    var resultMsg by remember { mutableStateOf<String?>(null) }
    var won by remember { mutableStateOf<Boolean?>(null) }

    GameShell(game = game, diamondBalance = diamondBalance, onBack = onBack) {
        Spacer(Modifier.height(8.dp))
        Text("Bet On:", color = TextSecondary, fontSize = 13.sp)
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("PLAYER" to "Player\n2x", "BANKER" to "Banker\n1.95x", "TIE" to "Tie\n8x").forEach { (key, label) ->
                val selected = betOn == key
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(10.dp))
                        .background(if (selected) BrandPurple else AppSurface)
                        .border(1.dp, OutlineDefault, RoundedCornerShape(10.dp))
                        .clickable { if (!revealed) betOn = key }
                        .padding(vertical = 10.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(label, color = if (selected) Color.White else TextPrimary, fontSize = 12.sp,
                        fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal, textAlign = TextAlign.Center)
                }
            }
        }

        Spacer(Modifier.height(16.dp))
        if (playerHand.isNotEmpty()) {
            val pv = baccaratHandValue(playerHand)
            val bv = baccaratHandValue(bankerHand)
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Player${if (revealed) " ($pv)" else ""}", color = TextPrimary, fontSize = 13.sp)
                    Spacer(Modifier.height(6.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        playerHand.forEach { CardView(it, false) }
                    }
                }
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Banker${if (revealed) " ($bv)" else ""}", color = TextSecondary, fontSize = 13.sp)
                    Spacer(Modifier.height(6.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        bankerHand.forEachIndexed { i, c -> CardView(c, !revealed && i == 1) }
                    }
                }
            }
            Spacer(Modifier.height(16.dp))
        }

        resultMsg?.let { ResultBanner(won = won, message = it) }
        Spacer(Modifier.height(12.dp))

        BetSelector(bet = bet, onBetChange = { bet = it }, maxBet = diamondBalance)
        Spacer(Modifier.height(12.dp))

        Button(
            onClick = {
                if (betOn == null || diamondBalance < bet) return@Button
                val ph = listOf(randomCard(), randomCard())
                val bh = listOf(randomCard(), randomCard())
                playerHand = ph; bankerHand = bh; revealed = true
                val pv = baccaratHandValue(ph); val bv = baccaratHandValue(bh)
                val winner = when { pv > bv -> "PLAYER"; bv > pv -> "BANKER"; else -> "TIE" }
                val userWon = betOn == winner
                val win = when {
                    !userWon -> 0
                    betOn == "TIE"    -> bet * 8
                    betOn == "BANKER" -> (bet * 1.95f).toInt()
                    else              -> bet * 2
                }
                onResult(game.id, game.name, bet, win)
                won = userWon
                resultMsg = if (userWon) "🎉 $winner wins! P:$pv B:$bv — Won 💎$win"
                    else "😔 $winner wins! P:$pv B:$bv — Lost 💎$bet"
            },
            modifier = Modifier.fillMaxWidth().height(52.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF134e5e)),
            shape = RoundedCornerShape(14.dp),
        ) {
            Text(if (revealed) "Deal Again  (Bet 💎$bet)" else "🎴  DEAL  (Bet 💎$bet)",
                fontWeight = FontWeight.Bold, fontSize = 16.sp)
        }
    }
}

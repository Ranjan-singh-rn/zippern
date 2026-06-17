package com.zipper.datingapp.ui.screens

import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.google.firebase.auth.FirebaseAuth
import com.zipper.datingapp.data.CoinPackage
import com.zipper.datingapp.data.DiamondPackage
import com.zipper.datingapp.data.ResellAgent
import com.zipper.datingapp.data.Transaction
import com.zipper.datingapp.data.TransactionType
import com.zipper.datingapp.data.coinPackages
import com.zipper.datingapp.economy.VirtualEconomyMath
import com.zipper.datingapp.ui.DatingUiState
import com.zipper.datingapp.ui.DatingViewModel
import com.zipper.datingapp.ui.paddingWithNavigationBars
import com.zipper.datingapp.ui.theme.AppBackground
import com.zipper.datingapp.ui.theme.AppContainer
import com.zipper.datingapp.ui.theme.AppResponsiveContentMaxWidth
import com.zipper.datingapp.ui.theme.AppSurface
import com.zipper.datingapp.ui.theme.BrandPink
import com.zipper.datingapp.ui.theme.BrandPurple
import com.zipper.datingapp.ui.theme.GoldAccent
import com.zipper.datingapp.ui.theme.LocalWindowWidthClass
import com.zipper.datingapp.ui.theme.OutlineDefault
import com.zipper.datingapp.ui.theme.TextMuted
import com.zipper.datingapp.ui.theme.TextPrimary
import com.zipper.datingapp.ui.theme.TextSecondary
import com.zipper.datingapp.ui.theme.defaultHorizontalContentPadding
import java.text.NumberFormat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY COMPOSABLES — kept intact for backward-compat with MainActivity,
// LiveStreamActivity, and VideoCallScreen which use DatingUiState.
// ─────────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DiamondShopScreen(uiState: DatingUiState, onBack: () -> Unit, @Suppress("UNUSED_PARAMETER") onBuyDiamonds: (CoinPackage) -> Unit) {
    var showResellDialog by remember { mutableStateOf(false) }
    BackHandler {
        if (showResellDialog) showResellDialog = false else onBack()
    }
    val context = LocalContext.current
    val scheme = MaterialTheme.colorScheme
    val widthClass = LocalWindowWidthClass.current
    val hPad = widthClass.defaultHorizontalContentPadding()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(scheme.background)
    ) {
        TopAppBar(
            title = { Text("Diamond Shop", fontWeight = FontWeight.Bold) },
            navigationIcon = {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                }
            },
            actions = {
                TextButton(
                    onClick = { showResellDialog = true },
                    modifier = Modifier.defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
                ) {
                    Icon(Icons.Default.SupportAgent, contentDescription = null, tint = scheme.primary)
                    Spacer(Modifier.width(4.dp))
                    Text("Reselling", color = scheme.primary, fontWeight = FontWeight.Bold)
                }
            },
            colors = TopAppBarDefaults.topAppBarColors(
                containerColor = scheme.background,
                titleContentColor = scheme.onBackground,
                navigationIconContentColor = scheme.onBackground
            )
        )

        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
            contentAlignment = Alignment.TopCenter,
        ) {
            Column(
                modifier = Modifier
                    .widthIn(max = AppResponsiveContentMaxWidth)
                    .fillMaxHeight()
                    .padding(start = hPad, top = 16.dp, end = hPad)
            ) {
            // Balance Card
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = scheme.surfaceContainer,
                shape = RoundedCornerShape(20.dp)
            ) {
                Row(
                    modifier = Modifier.padding(24.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("Current Balance", color = scheme.onSurface.copy(alpha = 0.6f), fontSize = 14.sp)
                        Spacer(Modifier.height(4.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("${uiState.coinBalance}", color = scheme.onSurface, fontSize = 28.sp, fontWeight = FontWeight.Black)
                            Spacer(Modifier.width(8.dp))
                            Text("💎", fontSize = 24.sp)
                        }
                    }
                }
            }

            Spacer(Modifier.height(32.dp))
            Text("Select Package", color = scheme.onSurface, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            Text("Contact resellers for special offers", color = scheme.onSurface.copy(alpha = 0.5f), fontSize = 12.sp)
            Spacer(Modifier.height(16.dp))

            LazyVerticalGrid(
                columns = GridCells.Adaptive(minSize = 120.dp),
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth(),
                contentPadding = paddingWithNavigationBars(bottomExtra = 24.dp),
                horizontalArrangement = Arrangement.spacedBy(16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                items(coinPackages) { pkg ->
                    DiamondPackageCard(pkg = pkg, onClick = {
                        android.widget.Toast.makeText(context, "Please contact Reseller to buy diamonds", android.widget.Toast.LENGTH_LONG).show()
                    })
                }
            }
            }
        }
    }

    if (showResellDialog) {
        AlertDialog(
            onDismissRequest = { showResellDialog = false },
            title = { Text("Diamond Resellers", color = scheme.onSurface) },
            containerColor = scheme.surfaceContainer,
            text = {
                Column {
                    Text("Contact official agents to buy/resell diamonds.", color = scheme.onSurface.copy(alpha = 0.7f), fontSize = 14.sp)
                    Spacer(Modifier.height(16.dp))
                    LazyColumn(
                        modifier = Modifier.heightIn(max = 400.dp),
                        contentPadding = paddingWithNavigationBars()
                    ) {
                        items(uiState.resellAgents) { agent ->
                            ResellerItem(agent = agent, onClick = {
                                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(agent.whatsappLink))
                                context.startActivity(intent)
                            })
                            HorizontalDivider(color = scheme.outline.copy(alpha = 0.2f))
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = { showResellDialog = false },
                    modifier = Modifier.defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
                ) {
                    Text("Close", color = scheme.primary)
                }
            }
        )
    }
}

@Composable
fun ResellerItem(agent: ResellAgent, onClick: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = 48.dp)
            .clickable { onClick() }
            .padding(vertical = 12.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(agent.flag, fontSize = 24.sp, modifier = Modifier.padding(end = 16.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                agent.country,
                color = scheme.onSurface,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            Text(
                agent.resellerName,
                color = scheme.onSurface.copy(alpha = 0.5f),
                fontSize = 12.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
        Text(
            text = "WhatsApp",
            color = scheme.primary,
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(start = 8.dp)
        )
    }
}

@Composable
fun DiamondPackageCard(pkg: CoinPackage, onClick: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val total = pkg.totalDiamonds
    val bonusGold = Color(0xFFFFC107)
    val bonusGreen = Color(0xFF69F0AE)
    Surface(
        onClick = onClick,
        color = scheme.surfaceContainer,
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = 48.dp)
            .aspectRatio(0.88f)
    ) {
        Box(modifier = Modifier.fillMaxSize()) {
            if (pkg.isPopular) {
                Surface(
                    color = scheme.primary,
                    shape = RoundedCornerShape(bottomStart = 8.dp),
                    modifier = Modifier.align(Alignment.TopEnd)
                ) {
                    Text(
                        "HOT",
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                        color = scheme.onPrimary,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
            }

            Column(
                modifier = Modifier
                    .padding(horizontal = 12.dp, vertical = 14.dp)
                    .fillMaxSize(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center
            ) {
                Text("💎", fontSize = 26.sp)
                Spacer(Modifier.height(4.dp))
                Text(
                    text = total.toString(),
                    color = scheme.onSurface,
                    fontSize = 26.sp,
                    fontWeight = FontWeight.Black,
                    textAlign = TextAlign.Center,
                    maxLines = 1
                )
                Text(
                    text = "Diamonds",
                    color = scheme.onSurface.copy(alpha = 0.65f),
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Medium
                )
                if (pkg.bonus > 0) {
                    Spacer(Modifier.height(8.dp))
                    Surface(
                        color = bonusGold.copy(alpha = 0.22f),
                        shape = RoundedCornerShape(10.dp),
                        border = BorderStroke(1.dp, bonusGreen.copy(alpha = 0.85f))
                    ) {
                        Text(
                            text = "Bonus +${pkg.bonus}",
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                            color = bonusGreen,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }
                }
                Spacer(Modifier.weight(1f))
                Surface(
                    color = scheme.primaryContainer.copy(alpha = 0.95f),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    Text(
                        text = "₹${pkg.priceInr}",
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                        color = scheme.onPrimaryContainer,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.Black
                    )
                }
            }
        }
    }
}

/** In-call overlay: full diamond shop UI without leaving WebRTC (dialog over the call). */
@Composable
fun DiamondShopPopup(
    uiState: DatingUiState,
    onDismiss: () -> Unit,
    onBuyDiamonds: (CoinPackage) -> Unit
) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            decorFitsSystemWindows = false
        )
    ) {
        Surface(
            modifier = Modifier
                .fillMaxWidth(0.94f)
                .fillMaxHeight(0.92f),
            shape = RoundedCornerShape(20.dp),
            shadowElevation = 8.dp
        ) {
            DiamondShopScreen(
                uiState = uiState,
                onBack = onDismiss,
                onBuyDiamonds = onBuyDiamonds
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCREEN 1: DiamondShopScreen (ViewModel edition)
// Users buy diamonds via offline coin sellers. This screen shows packages,
// explains the process, and provides a contact bottom sheet per package.
// ─────────────────────────────────────────────────────────────────────────────

private val BrandGradient = listOf(BrandPink, BrandPurple)

/** Format a Long amount with Indian-style comma grouping (e.g. 1,00,000). */
private fun formatIndianNumber(n: Long): String =
    NumberFormat.getNumberInstance(Locale("en", "IN")).format(n)

/** Compact label for diamond amounts shown in package cards. */
private fun formatDiamondAmount(n: Long): String = when {
    n >= 1_00_000L -> "${(n / 1_00_000.0).let { if (it == it.toLong().toDouble()) "${it.toLong()}L" else String.format("%.1fL", it) }}"
    n >= 1_000L    -> "${(n / 1_000.0).let { if (it == it.toLong().toDouble()) "${it.toLong()}K" else String.format("%.1fK", it) }}"
    else           -> n.toString()
}

private fun formatTimestamp(ts: Long): String {
    if (ts == 0L) return ""
    return try {
        SimpleDateFormat("dd MMM, h:mm a", Locale.getDefault()).format(Date(ts))
    } catch (_: Exception) { "" }
}

private fun txIconAndColor(type: String): Pair<ImageVector, Color> = when (type) {
    TransactionType.RECHARGE.name          -> Icons.Default.AddCard          to Color(0xFF4CAF50)
    TransactionType.GIFT_SEND.name         -> Icons.Default.CardGiftcard      to BrandPink
    TransactionType.GIFT_RECEIVE.name      -> Icons.Default.CardGiftcard      to Color(0xFF4CAF50)
    TransactionType.CALL_CHARGE.name       -> Icons.Default.Call              to BrandPurple
    TransactionType.CALL_EARN.name         -> Icons.Default.Call              to Color(0xFF4CAF50)
    TransactionType.BEANS_CONVERT.name     -> Icons.Default.SwapHoriz         to GoldAccent
    TransactionType.GAME_BET.name          -> Icons.Default.Casino            to BrandPink
    TransactionType.GAME_WIN.name          -> Icons.Default.EmojiEvents       to Color(0xFF4CAF50)
    TransactionType.GAME_LOSS.name         -> Icons.Default.Casino            to Color(0xFFFF6B6B)
    TransactionType.PK_SUPPORT_SEND.name   -> Icons.Default.StarBorder        to BrandPurple
    TransactionType.PK_SUPPORT_RECEIVE.name-> Icons.Default.Star              to Color(0xFF4CAF50)
    else                                   -> Icons.Default.Receipt            to TextSecondary
}

private fun txLabel(tx: Transaction): String = when (tx.type) {
    TransactionType.RECHARGE.name           -> "Diamond Recharge"
    TransactionType.GIFT_SEND.name          -> "Gift Sent${tx.counterpartName?.let { " to $it" } ?: ""}"
    TransactionType.GIFT_RECEIVE.name       -> "Gift Received${tx.counterpartName?.let { " from $it" } ?: ""}"
    TransactionType.CALL_CHARGE.name        -> "Call Charge${tx.counterpartName?.let { " — ${it}" } ?: ""}"
    TransactionType.CALL_EARN.name          -> "Call Earnings${tx.counterpartName?.let { " from $it" } ?: ""}"
    TransactionType.BEANS_CONVERT.name      -> "Beans Converted"
    TransactionType.GAME_BET.name           -> "Game Bet"
    TransactionType.GAME_WIN.name           -> "Game Win"
    TransactionType.GAME_LOSS.name          -> "Game Loss"
    TransactionType.PK_SUPPORT_SEND.name    -> "PK Battle Support Sent"
    TransactionType.PK_SUPPORT_RECEIVE.name -> "PK Battle Support Received"
    else                                    -> tx.note.ifBlank { "Transaction" }
}

/**
 * DiamondShopScreen — ViewModel edition.
 *
 * Shows diamond packages sourced from [viewModel.diamondPackages].
 * Tapping a package opens an instruction sheet explaining how to pay a coin
 * seller offline and get diamonds credited. Includes the last 10 transactions
 * from [viewModel.transactionHistory] and a "How to Recharge" explainer.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DiamondShopScreen(
    viewModel: DatingViewModel,
    onBack: () -> Unit,
) {
    LaunchedEffect(Unit) { viewModel.loadTransactionHistory() }

    val diamonds by viewModel.diamonds.collectAsState()
    val transactions by viewModel.transactionHistory.collectAsState()
    val packages = viewModel.diamondPackages
    val currentUser by viewModel.currentUser.collectAsState()
    val userId = currentUser?.id
        ?: FirebaseAuth.getInstance().currentUser?.uid
        ?: "—"

    var selectedPackage by remember { mutableStateOf<DiamondPackage?>(null) }

    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val clipboardManager = LocalClipboardManager.current
    val context = LocalContext.current

    BackHandler {
        if (selectedPackage != null) selectedPackage = null else onBack()
    }

    // ── Root scaffold ─────────────────────────────────────────────────────────
    Scaffold(
        topBar = {
            // Gradient top bar
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Brush.horizontalGradient(BrandGradient))
                    .windowInsetsPadding(WindowInsets.statusBars)
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(56.dp)
                        .padding(horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Color.White)
                    }
                    Text(
                        "Diamond Shop",
                        color = Color.White,
                        fontWeight = FontWeight.Bold,
                        fontSize = 20.sp,
                        modifier = Modifier.weight(1f)
                    )
                    // Diamonds balance pill in header
                    Surface(
                        shape = RoundedCornerShape(50),
                        color = Color.White.copy(alpha = 0.2f),
                        modifier = Modifier.padding(end = 12.dp)
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text("💎", fontSize = 14.sp)
                            Spacer(Modifier.width(4.dp))
                            Text(
                                formatIndianNumber(diamonds),
                                color = Color.White,
                                fontWeight = FontWeight.Bold,
                                fontSize = 14.sp
                            )
                        }
                    }
                }
            }
        },
        containerColor = AppBackground
    ) { innerPad ->

        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPad),
            contentPadding = PaddingValues(bottom = 40.dp),
            verticalArrangement = Arrangement.spacedBy(0.dp)
        ) {

            // ── Balance hero card ─────────────────────────────────────────────
            item {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp)
                        .clip(RoundedCornerShape(20.dp))
                        .background(Brush.linearGradient(BrandGradient))
                        .padding(24.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            "Current Balance",
                            color = Color.White.copy(alpha = 0.8f),
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Medium
                        )
                        Spacer(Modifier.height(8.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("💎", fontSize = 32.sp)
                            Spacer(Modifier.width(10.dp))
                            Text(
                                formatIndianNumber(diamonds),
                                color = Color.White,
                                fontSize = 42.sp,
                                fontWeight = FontWeight.Black
                            )
                        }
                        Spacer(Modifier.height(4.dp))
                        Text(
                            "diamonds",
                            color = Color.White.copy(alpha = 0.7f),
                            fontSize = 13.sp
                        )
                    }
                }
            }

            // ── Section heading ───────────────────────────────────────────────
            item {
                Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                    Text(
                        "Choose a Package",
                        color = TextPrimary,
                        fontWeight = FontWeight.Bold,
                        fontSize = 17.sp
                    )
                    Text(
                        "Tap a package, then contact a coin seller to complete your purchase",
                        color = TextSecondary,
                        fontSize = 12.sp,
                        lineHeight = 17.sp
                    )
                }
            }

            // ── Package grid (2-column) ───────────────────────────────────────
            // LazyColumn doesn't compose nested lazy grids — inline grid manually
            val rows = packages.chunked(2)
            items(rows) { row ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    row.forEach { pkg ->
                        DiamondShopPackageCard(
                            pkg = pkg,
                            modifier = Modifier.weight(1f),
                            onClick = { selectedPackage = pkg }
                        )
                    }
                    // If odd number of packages in last row, fill the gap
                    if (row.size == 1) {
                        Spacer(Modifier.weight(1f))
                    }
                }
            }

            // ── How to recharge explainer ─────────────────────────────────────
            item {
                Spacer(Modifier.height(16.dp))
                HowToRechargeCard(modifier = Modifier.padding(horizontal = 16.dp))
            }

            // ── Contact coin seller button ─────────────────────────────────────
            item {
                Spacer(Modifier.height(12.dp))
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp)
                ) {
                    Button(
                        onClick = {
                            // WhatsApp placeholder — open wa.me link
                            val intent = Intent(
                                Intent.ACTION_VIEW,
                                Uri.parse("https://wa.me/919999999999?text=Hi,%20I%20want%20to%20buy%20diamonds%20on%20Zipper")
                            )
                            try { context.startActivity(intent) }
                            catch (_: Exception) {
                                Toast.makeText(context, "WhatsApp not installed", Toast.LENGTH_SHORT).show()
                            }
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(52.dp),
                        shape = RoundedCornerShape(14.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF25D366))
                    ) {
                        Icon(Icons.Default.Chat, null, tint = Color.White, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(10.dp))
                        Text(
                            "Contact Coin Seller on WhatsApp",
                            color = Color.White,
                            fontWeight = FontWeight.Bold,
                            fontSize = 15.sp
                        )
                    }
                }
            }

            // ── Transaction history ───────────────────────────────────────────
            item {
                Spacer(Modifier.height(24.dp))
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        "Recent Transactions",
                        color = TextPrimary,
                        fontWeight = FontWeight.Bold,
                        fontSize = 17.sp,
                        modifier = Modifier.weight(1f)
                    )
                    Icon(
                        Icons.Default.History,
                        null,
                        tint = TextSecondary,
                        modifier = Modifier.size(18.dp)
                    )
                }
                Spacer(Modifier.height(8.dp))
            }

            val displayTx = transactions.take(10)
            if (displayTx.isEmpty()) {
                item {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp)
                            .clip(RoundedCornerShape(16.dp))
                            .background(AppSurface)
                            .padding(32.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text("💎", fontSize = 32.sp)
                            Spacer(Modifier.height(8.dp))
                            Text(
                                "No transactions yet",
                                color = TextMuted,
                                fontSize = 14.sp,
                                textAlign = TextAlign.Center
                            )
                        }
                    }
                }
            } else {
                items(displayTx) { tx ->
                    DiamondTransactionRow(
                        tx = tx,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)
                    )
                }
            }
        }
    }

    // ── Package instruction bottom sheet ──────────────────────────────────────
    selectedPackage?.let { pkg ->
        ModalBottomSheet(
            onDismissRequest = { selectedPackage = null },
            sheetState = sheetState,
            containerColor = AppSurface,
            dragHandle = {
                Box(
                    modifier = Modifier
                        .padding(top = 12.dp, bottom = 8.dp)
                        .size(width = 40.dp, height = 4.dp)
                        .clip(RoundedCornerShape(50))
                        .background(OutlineDefault)
                )
            }
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp)
                    .padding(bottom = 40.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                // Package summary header
                Box(
                    modifier = Modifier
                        .size(72.dp)
                        .clip(CircleShape)
                        .background(Brush.linearGradient(BrandGradient)),
                    contentAlignment = Alignment.Center
                ) {
                    Text("💎", fontSize = 32.sp)
                }
                Spacer(Modifier.height(16.dp))
                Text(
                    pkg.label.ifBlank { "Diamond Package" },
                    color = TextPrimary,
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 22.sp
                )
                Spacer(Modifier.height(4.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        formatIndianNumber(pkg.diamonds),
                        color = BrandPink,
                        fontWeight = FontWeight.Black,
                        fontSize = 28.sp
                    )
                    Text(
                        " diamonds",
                        color = TextSecondary,
                        fontSize = 16.sp
                    )
                }
                if (pkg.bonusDiamonds > 0) {
                    Spacer(Modifier.height(4.dp))
                    Surface(
                        shape = RoundedCornerShape(8.dp),
                        color = Color(0xFF4CAF50).copy(alpha = 0.12f),
                        border = BorderStroke(1.dp, Color(0xFF4CAF50).copy(alpha = 0.35f))
                    ) {
                        Text(
                            "+ ${formatIndianNumber(pkg.bonusDiamonds)} bonus diamonds",
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                            color = Color(0xFF4CAF50),
                            fontSize = 13.sp,
                            fontWeight = FontWeight.SemiBold
                        )
                    }
                }

                Spacer(Modifier.height(24.dp))
                HorizontalDivider(color = OutlineDefault)
                Spacer(Modifier.height(20.dp))

                // Step-by-step instructions
                Text(
                    "How to complete this purchase",
                    color = TextPrimary,
                    fontWeight = FontWeight.Bold,
                    fontSize = 16.sp,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(14.dp))

                InstructionStep(
                    number = "1",
                    text = "Contact a coin seller and tell them you want to pay:"
                )
                Spacer(Modifier.height(8.dp))

                // Price highlight box
                Surface(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(14.dp),
                    color = BrandPink.copy(alpha = 0.08f),
                    border = BorderStroke(1.5.dp, BrandPink.copy(alpha = 0.35f))
                ) {
                    Row(
                        modifier = Modifier.padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text("₹", fontSize = 24.sp, color = BrandPink, fontWeight = FontWeight.Black)
                        Text(
                            NumberFormat.getNumberInstance(Locale("en", "IN")).format(pkg.priceRs),
                            fontSize = 36.sp,
                            color = BrandPink,
                            fontWeight = FontWeight.Black
                        )
                        Spacer(Modifier.weight(1f))
                        Text(
                            "for\n${formatDiamondAmount(pkg.diamonds + pkg.bonusDiamonds)} 💎",
                            color = TextSecondary,
                            fontSize = 14.sp,
                            textAlign = TextAlign.End,
                            lineHeight = 20.sp
                        )
                    }
                }

                Spacer(Modifier.height(14.dp))
                InstructionStep(
                    number = "2",
                    text = "Give the seller your account ID so they can credit your diamonds:"
                )
                Spacer(Modifier.height(8.dp))

                // User ID copy box
                Surface(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(14.dp),
                    color = BrandPurple.copy(alpha = 0.08f),
                    border = BorderStroke(1.5.dp, BrandPurple.copy(alpha = 0.3f))
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable {
                                clipboardManager.setText(AnnotatedString(userId))
                                Toast.makeText(context, "Account ID copied!", Toast.LENGTH_SHORT).show()
                            }
                            .padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text("Your Account ID", color = TextSecondary, fontSize = 12.sp)
                            Spacer(Modifier.height(2.dp))
                            Text(
                                userId,
                                color = BrandPurple,
                                fontWeight = FontWeight.Bold,
                                fontSize = 15.sp,
                                letterSpacing = 0.5.sp
                            )
                        }
                        Surface(
                            shape = RoundedCornerShape(8.dp),
                            color = BrandPurple.copy(alpha = 0.15f)
                        ) {
                            Row(
                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Icon(
                                    Icons.Default.ContentCopy,
                                    null,
                                    tint = BrandPurple,
                                    modifier = Modifier.size(16.dp)
                                )
                                Spacer(Modifier.width(4.dp))
                                Text(
                                    "Copy ID",
                                    color = BrandPurple,
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.SemiBold
                                )
                            }
                        }
                    }
                }

                Spacer(Modifier.height(14.dp))
                InstructionStep(
                    number = "3",
                    text = "The coin seller will verify your payment and credit ${formatDiamondAmount(pkg.diamonds + pkg.bonusDiamonds)} diamonds to your account within a few minutes."
                )

                Spacer(Modifier.height(24.dp))

                // Disclaimer
                Surface(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(12.dp),
                    color = AppContainer
                ) {
                    Row(
                        modifier = Modifier.padding(12.dp),
                        verticalAlignment = Alignment.Top
                    ) {
                        Icon(
                            Icons.Default.Info,
                            null,
                            tint = TextMuted,
                            modifier = Modifier.size(16.dp).padding(top = 1.dp)
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(
                            "Only use official Zipper coin sellers. Never share your password. Diamonds are credited manually and may take up to 10 minutes.",
                            color = TextMuted,
                            fontSize = 11.sp,
                            lineHeight = 16.sp
                        )
                    }
                }

                Spacer(Modifier.height(20.dp))

                // Close button
                OutlinedButton(
                    onClick = { selectedPackage = null },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(50.dp),
                    shape = RoundedCornerShape(14.dp),
                    border = BorderStroke(1.dp, OutlineDefault),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = TextSecondary)
                ) {
                    Text("Close", fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

@Composable
private fun DiamondShopPackageCard(
    pkg: DiamondPackage,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val totalDiamonds = pkg.diamonds + pkg.bonusDiamonds

    Surface(
        onClick = onClick,
        modifier = modifier.defaultMinSize(minHeight = 48.dp),
        shape = RoundedCornerShape(16.dp),
        color = AppSurface,
        border = BorderStroke(
            width = if (pkg.isBestValue) 2.dp else 1.dp,
            brush = if (pkg.isBestValue)
                Brush.linearGradient(BrandGradient)
            else
                Brush.linearGradient(listOf(OutlineDefault, OutlineDefault))
        )
    ) {
        Box(modifier = Modifier.fillMaxWidth()) {
            // Badge
            when {
                pkg.isBestValue -> {
                    Box(
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .clip(RoundedCornerShape(bottomStart = 10.dp))
                            .background(Brush.linearGradient(BrandGradient))
                            .padding(horizontal = 8.dp, vertical = 3.dp)
                    ) {
                        Text(
                            "BEST VALUE",
                            color = Color.White,
                            fontSize = 9.sp,
                            fontWeight = FontWeight.ExtraBold,
                            letterSpacing = 0.5.sp
                        )
                    }
                }
                pkg.isPopular -> {
                    Surface(
                        modifier = Modifier.align(Alignment.TopEnd),
                        color = BrandPink,
                        shape = RoundedCornerShape(bottomStart = 10.dp)
                    ) {
                        Text(
                            "HOT",
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                            color = Color.White,
                            fontSize = 9.sp,
                            fontWeight = FontWeight.ExtraBold
                        )
                    }
                }
            }

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 14.dp, vertical = 18.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text("💎", fontSize = 28.sp)
                Spacer(Modifier.height(6.dp))
                Text(
                    formatDiamondAmount(pkg.diamonds),
                    color = TextPrimary,
                    fontSize = 22.sp,
                    fontWeight = FontWeight.Black,
                    textAlign = TextAlign.Center
                )
                Text(
                    "diamonds",
                    color = TextMuted,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Medium
                )
                if (pkg.bonusDiamonds > 0) {
                    Spacer(Modifier.height(6.dp))
                    Surface(
                        shape = RoundedCornerShape(8.dp),
                        color = Color(0xFF4CAF50).copy(alpha = 0.1f)
                    ) {
                        Text(
                            "+${formatDiamondAmount(pkg.bonusDiamonds)} bonus",
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                            color = Color(0xFF4CAF50),
                            fontSize = 11.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }
                }
                if (pkg.label.isNotBlank()) {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        pkg.label,
                        color = TextSecondary,
                        fontSize = 11.sp
                    )
                }
                Spacer(Modifier.height(12.dp))
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(10.dp))
                        .background(Brush.linearGradient(BrandGradient))
                        .padding(vertical = 10.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        "₹${NumberFormat.getNumberInstance(Locale("en", "IN")).format(pkg.priceRs)}",
                        color = Color.White,
                        fontWeight = FontWeight.Black,
                        fontSize = 15.sp
                    )
                }
            }
        }
    }
}

@Composable
private fun HowToRechargeCard(modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        color = AppSurface,
        border = BorderStroke(1.dp, OutlineDefault)
    ) {
        Column(modifier = Modifier.padding(18.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(36.dp)
                        .clip(CircleShape)
                        .background(Brush.linearGradient(BrandGradient)),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(Icons.Default.HelpOutline, null, tint = Color.White, modifier = Modifier.size(18.dp))
                }
                Spacer(Modifier.width(12.dp))
                Text(
                    "How to Recharge",
                    color = TextPrimary,
                    fontWeight = FontWeight.Bold,
                    fontSize = 15.sp
                )
            }
            Spacer(Modifier.height(14.dp))
            HowToStep(number = "1", text = "Choose a diamond package above that fits your budget.")
            Spacer(Modifier.height(10.dp))
            HowToStep(number = "2", text = "Tap the package and note the price in Indian Rupees (₹).")
            Spacer(Modifier.height(10.dp))
            HowToStep(number = "3", text = "Contact an official Zipper coin seller via WhatsApp or phone.")
            Spacer(Modifier.height(10.dp))
            HowToStep(number = "4", text = "Share your Account ID and pay the amount via UPI, cash, or transfer.")
            Spacer(Modifier.height(10.dp))
            HowToStep(number = "5", text = "Diamonds are credited to your account within minutes after payment.")
            Spacer(Modifier.height(14.dp))
            Surface(
                shape = RoundedCornerShape(10.dp),
                color = GoldAccent.copy(alpha = 0.08f),
                border = BorderStroke(1.dp, GoldAccent.copy(alpha = 0.25f))
            ) {
                Row(
                    modifier = Modifier.padding(10.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text("⚠️", fontSize = 14.sp)
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "Only use official Zipper coin sellers. Do not pay strangers.",
                        color = GoldAccent,
                        fontSize = 11.sp,
                        lineHeight = 16.sp,
                        fontWeight = FontWeight.Medium
                    )
                }
            }
        }
    }
}

@Composable
private fun HowToStep(number: String, text: String) {
    Row(verticalAlignment = Alignment.Top) {
        Box(
            modifier = Modifier
                .size(22.dp)
                .clip(CircleShape)
                .background(BrandPink.copy(alpha = 0.15f)),
            contentAlignment = Alignment.Center
        ) {
            Text(number, color = BrandPink, fontSize = 11.sp, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.width(10.dp))
        Text(text, color = TextSecondary, fontSize = 13.sp, lineHeight = 18.sp)
    }
}

@Composable
private fun InstructionStep(number: String, text: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.Top
    ) {
        Box(
            modifier = Modifier
                .size(24.dp)
                .clip(CircleShape)
                .background(Brush.linearGradient(BrandGradient)),
            contentAlignment = Alignment.Center
        ) {
            Text(number, color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.width(10.dp))
        Text(text, color = TextSecondary, fontSize = 13.sp, lineHeight = 18.sp, modifier = Modifier.weight(1f))
    }
}

@Composable
private fun DiamondTransactionRow(tx: Transaction, modifier: Modifier = Modifier) {
    val isDiamondCredit = tx.diamonds > 0
    val isDiamondDebit = tx.diamonds < 0
    val (icon, color) = txIconAndColor(tx.type)

    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        color = AppSurface,
        border = BorderStroke(1.dp, OutlineDefault)
    ) {
        Row(
            modifier = Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                modifier = Modifier
                    .size(42.dp)
                    .clip(CircleShape)
                    .background(color.copy(alpha = 0.12f)),
                contentAlignment = Alignment.Center
            ) {
                Icon(icon, null, tint = color, modifier = Modifier.size(20.dp))
            }
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    txLabel(tx),
                    color = TextPrimary,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 14.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                if (tx.note.isNotBlank()) {
                    Text(tx.note, color = TextSecondary, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (tx.timestamp > 0) {
                    Text(formatTimestamp(tx.timestamp), color = TextMuted, fontSize = 11.sp)
                }
            }
            Spacer(Modifier.width(8.dp))
            if (tx.diamonds != 0L) {
                val prefix = if (tx.diamonds > 0) "+" else ""
                Text(
                    "$prefix${formatIndianNumber(tx.diamonds)} 💎",
                    color = if (isDiamondCredit) Color(0xFF4CAF50) else if (isDiamondDebit) Color(0xFFFF6B6B) else TextSecondary,
                    fontWeight = FontWeight.Bold,
                    fontSize = 14.sp
                )
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCREEN 2: BeanCenterScreen (ViewModel edition)
// For HOST users — shows bean balance, INR equivalent, payout rates,
// earning breakdown, and host level progress.
// ─────────────────────────────────────────────────────────────────────────────

private val BeanGradient = listOf(Color(0xFFFF8C42), Color(0xFFE91E63))

/**
 * BeanCenterScreen — shows HOST payout information and bean earnings.
 *
 * Economy: 1,00,000 beans = ₹1,000 payout → [VirtualEconomyMath.beansToRupees].
 * Agency earns ₹25 per lakh beans the host earns.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BeanCenterScreen(
    viewModel: DatingViewModel,
    onBack: () -> Unit,
) {
    LaunchedEffect(Unit) { viewModel.loadTransactionHistory() }

    val beans by viewModel.beans.collectAsState()
    val currentUser by viewModel.currentUser.collectAsState()
    val transactions by viewModel.transactionHistory.collectAsState()

    val rupeesEquivalent = VirtualEconomyMath.beansToRupees(beans)

    val totalBeansEarned = currentUser?.totalBeansEarned ?: 0L
    val hostLevel = VirtualEconomyMath.hostLevelFromBeans(totalBeansEarned)
    val levelProgress = VirtualEconomyMath.hostLevelProgress(totalBeansEarned)
    val beansToNext = VirtualEconomyMath.beansToNextHostLevel(totalBeansEarned)
    val nextLevel = hostLevel + 1

    // Filter to gift/call earn transactions only
    val earningTxs = transactions
        .filter { it.type == TransactionType.GIFT_RECEIVE.name || it.type == TransactionType.CALL_EARN.name }
        .take(10)

    BackHandler(onBack = onBack)

    Scaffold(
        topBar = {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Brush.horizontalGradient(BeanGradient))
                    .windowInsetsPadding(WindowInsets.statusBars)
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(56.dp)
                        .padding(horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Color.White)
                    }
                    Text(
                        "Bean Center",
                        color = Color.White,
                        fontWeight = FontWeight.Bold,
                        fontSize = 20.sp,
                        modifier = Modifier.weight(1f)
                    )
                    // Bean balance pill in top bar
                    Surface(
                        shape = RoundedCornerShape(50),
                        color = Color.White.copy(alpha = 0.2f),
                        modifier = Modifier.padding(end = 12.dp)
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text("🫘", fontSize = 14.sp)
                            Spacer(Modifier.width(4.dp))
                            Text(
                                VirtualEconomyMath.formatBalance(beans),
                                color = Color.White,
                                fontWeight = FontWeight.Bold,
                                fontSize = 14.sp
                            )
                        }
                    }
                }
            }
        },
        containerColor = AppBackground
    ) { innerPad ->

        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPad),
            contentPadding = PaddingValues(bottom = 40.dp),
            verticalArrangement = Arrangement.spacedBy(0.dp)
        ) {

            // ── Bean balance hero card ─────────────────────────────────────────
            item {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp)
                        .clip(RoundedCornerShape(24.dp))
                        .background(Brush.linearGradient(BeanGradient))
                        .padding(28.dp)
                ) {
                    Column(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Text(
                            "Bean Balance",
                            color = Color.White.copy(alpha = 0.85f),
                            fontSize = 13.sp
                        )
                        Spacer(Modifier.height(8.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("🫘", fontSize = 34.sp)
                            Spacer(Modifier.width(10.dp))
                            Text(
                                formatIndianNumber(beans),
                                color = Color.White,
                                fontSize = 44.sp,
                                fontWeight = FontWeight.Black
                            )
                        }
                        Spacer(Modifier.height(6.dp))
                        // Rupee equivalent
                        Surface(
                            shape = RoundedCornerShape(50),
                            color = Color.White.copy(alpha = 0.18f)
                        ) {
                            Text(
                                "= ₹${String.format(Locale.getDefault(), "%,.2f", rupeesEquivalent)}",
                                modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                                color = Color.White,
                                fontWeight = FontWeight.SemiBold,
                                fontSize = 15.sp
                            )
                        }

                        Spacer(Modifier.height(20.dp))
                        // Quick stats row
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(10.dp)
                        ) {
                            BeanStatChip(
                                modifier = Modifier.weight(1f),
                                label = "Total Earned",
                                value = VirtualEconomyMath.formatBalance(totalBeansEarned),
                                icon = Icons.Default.TrendingUp
                            )
                            BeanStatChip(
                                modifier = Modifier.weight(1f),
                                label = "Host Level",
                                value = "Level $hostLevel",
                                icon = Icons.Default.Star
                            )
                        }
                    }
                }
            }

            // ── Level progress ────────────────────────────────────────────────
            item {
                BeanLevelProgressCard(
                    hostLevel = hostLevel,
                    levelProgress = levelProgress,
                    beansToNext = beansToNext,
                    nextLevel = nextLevel,
                    modifier = Modifier.padding(horizontal = 16.dp)
                )
                Spacer(Modifier.height(12.dp))
            }

            // ── Payout rate info cards ────────────────────────────────────────
            item {
                Column(
                    modifier = Modifier.padding(horizontal = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    Text(
                        "Payout Rates",
                        color = TextPrimary,
                        fontWeight = FontWeight.Bold,
                        fontSize = 17.sp
                    )
                    Spacer(Modifier.height(2.dp))
                    PayoutInfoCard(
                        icon = Icons.Default.AccountBalanceWallet,
                        iconTint = Color(0xFF4CAF50),
                        title = "1 Lakh Beans = ₹1,000 Payout",
                        subtitle = "Platform rate: 1,00,000 beans → ₹1,000 (1 bean = 1 paisa)"
                    )
                    PayoutInfoCard(
                        icon = Icons.Default.Groups,
                        iconTint = BrandPurple,
                        title = "Agency Earns ₹25 per Lakh Beans",
                        subtitle = "Your agency receives ₹25 for every 1 lakh beans you earn"
                    )
                    PayoutInfoCard(
                        icon = Icons.Default.CalendarMonth,
                        iconTint = BrandPink,
                        title = "Payout on Request",
                        subtitle = "Contact your agency to request a payout at any time"
                    )
                }
                Spacer(Modifier.height(16.dp))
            }

            // ── Payout request section ────────────────────────────────────────
            item {
                BeanPayoutRequestSection(
                    beans = beans,
                    rupeesEquivalent = rupeesEquivalent,
                    modifier = Modifier.padding(horizontal = 16.dp)
                )
                Spacer(Modifier.height(20.dp))
            }

            // ── Earning breakdown header ──────────────────────────────────────
            item {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        "Earning Breakdown",
                        color = TextPrimary,
                        fontWeight = FontWeight.Bold,
                        fontSize = 17.sp,
                        modifier = Modifier.weight(1f)
                    )
                    Icon(Icons.Default.Receipt, null, tint = TextSecondary, modifier = Modifier.size(18.dp))
                }
                Spacer(Modifier.height(4.dp))
                Text(
                    "Recent gifts received and call earnings",
                    color = TextSecondary,
                    fontSize = 12.sp,
                    modifier = Modifier.padding(horizontal = 16.dp)
                )
                Spacer(Modifier.height(10.dp))
            }

            // ── Bean earning transactions ─────────────────────────────────────
            if (earningTxs.isEmpty()) {
                item {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp)
                            .clip(RoundedCornerShape(16.dp))
                            .background(AppSurface)
                            .padding(32.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text("🫘", fontSize = 32.sp)
                            Spacer(Modifier.height(8.dp))
                            Text(
                                "No earnings yet — go live or take calls\nto start earning beans!",
                                color = TextMuted,
                                fontSize = 13.sp,
                                textAlign = TextAlign.Center,
                                lineHeight = 18.sp
                            )
                        }
                    }
                }
            } else {
                items(earningTxs) { tx ->
                    BeanEarningRow(
                        tx = tx,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)
                    )
                }
            }

            item { Spacer(Modifier.height(16.dp)) }
        }
    }
}

@Composable
private fun BeanStatChip(
    modifier: Modifier = Modifier,
    label: String,
    value: String,
    icon: ImageVector,
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(12.dp),
        color = Color.White.copy(alpha = 0.15f)
    ) {
        Column(
            modifier = Modifier.padding(12.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Icon(icon, null, tint = Color.White, modifier = Modifier.size(18.dp))
            Spacer(Modifier.height(4.dp))
            Text(value, color = Color.White, fontWeight = FontWeight.Bold, fontSize = 14.sp)
            Text(label, color = Color.White.copy(alpha = 0.75f), fontSize = 11.sp)
        }
    }
}

@Composable
private fun BeanLevelProgressCard(
    hostLevel: Int,
    levelProgress: Float,
    beansToNext: Long,
    nextLevel: Int,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        color = AppSurface,
        border = BorderStroke(1.dp, OutlineDefault)
    ) {
        Column(modifier = Modifier.padding(18.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(44.dp)
                        .clip(CircleShape)
                        .background(Brush.linearGradient(BeanGradient)),
                    contentAlignment = Alignment.Center
                ) {
                    Text("$hostLevel", color = Color.White, fontWeight = FontWeight.Black, fontSize = 18.sp)
                }
                Spacer(Modifier.width(12.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        "Host Level $hostLevel",
                        color = TextPrimary,
                        fontWeight = FontWeight.Bold,
                        fontSize = 15.sp
                    )
                    if (beansToNext > 0) {
                        Text(
                            "${formatIndianNumber(beansToNext)} beans to Level $nextLevel",
                            color = TextSecondary,
                            fontSize = 12.sp
                        )
                    } else {
                        Text("Maximum level reached!", color = Color(0xFFFFD700), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
                if (beansToNext > 0) {
                    Text(
                        "${(levelProgress * 100).toInt()}%",
                        color = BrandPink,
                        fontWeight = FontWeight.Bold,
                        fontSize = 14.sp
                    )
                }
            }
            Spacer(Modifier.height(14.dp))
            LinearProgressIndicator(
                progress = { levelProgress },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(8.dp)
                    .clip(RoundedCornerShape(50)),
                color = BrandPink,
                trackColor = OutlineDefault,
            )
            if (beansToNext > 0) {
                Spacer(Modifier.height(6.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("Level $hostLevel", color = TextMuted, fontSize = 11.sp)
                    Text("Level $nextLevel", color = TextMuted, fontSize = 11.sp)
                }
            }
        }
    }
}

@Composable
private fun PayoutInfoCard(
    icon: ImageVector,
    iconTint: Color,
    title: String,
    subtitle: String,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        color = AppSurface,
        border = BorderStroke(1.dp, OutlineDefault)
    ) {
        Row(
            modifier = Modifier.padding(14.dp),
            verticalAlignment = Alignment.Top
        ) {
            Box(
                modifier = Modifier
                    .size(38.dp)
                    .clip(CircleShape)
                    .background(iconTint.copy(alpha = 0.12f)),
                contentAlignment = Alignment.Center
            ) {
                Icon(icon, null, tint = iconTint, modifier = Modifier.size(19.dp))
            }
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(title, color = TextPrimary, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                Spacer(Modifier.height(2.dp))
                Text(subtitle, color = TextSecondary, fontSize = 12.sp, lineHeight = 17.sp)
            }
        }
    }
}

@Composable
private fun BeanPayoutRequestSection(
    beans: Long,
    rupeesEquivalent: Double,
    modifier: Modifier = Modifier,
) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        color = AppSurface,
        border = BorderStroke(1.5.dp, Brush.linearGradient(BeanGradient))
    ) {
        Column(
            modifier = Modifier.padding(18.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(
                "Request Payout",
                color = TextPrimary,
                fontWeight = FontWeight.Bold,
                fontSize = 16.sp
            )
            Spacer(Modifier.height(4.dp))
            Text(
                "Your current balance is worth ₹${String.format(Locale.getDefault(), "%,.2f", rupeesEquivalent)}",
                color = TextSecondary,
                fontSize = 13.sp,
                textAlign = TextAlign.Center
            )
            Spacer(Modifier.height(14.dp))

            // Minimum payout notice
            val minPayoutBeans = 100_000L // 1 lakh beans = ₹1000
            val canRequestPayout = beans >= minPayoutBeans

            if (!canRequestPayout) {
                val shortfall = minPayoutBeans - beans
                Surface(
                    shape = RoundedCornerShape(10.dp),
                    color = GoldAccent.copy(alpha = 0.08f),
                    border = BorderStroke(1.dp, GoldAccent.copy(alpha = 0.25f)),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        modifier = Modifier.padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text("⚠️", fontSize = 14.sp)
                        Spacer(Modifier.width(8.dp))
                        Text(
                            "You need ${formatIndianNumber(shortfall)} more beans\n(₹${String.format(Locale.getDefault(), "%,.2f", VirtualEconomyMath.beansToRupees(shortfall))} more) to reach minimum payout.",
                            color = GoldAccent,
                            fontSize = 12.sp,
                            lineHeight = 17.sp
                        )
                    }
                }
                Spacer(Modifier.height(12.dp))
            }

            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(10.dp),
                color = BrandPurple.copy(alpha = 0.07f),
                border = BorderStroke(1.dp, BrandPurple.copy(alpha = 0.2f))
            ) {
                Row(
                    modifier = Modifier.padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(Icons.Default.Info, null, tint = BrandPurple, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "Contact your agency directly to request a payout. Minimum payout: ₹1,000 (1 Lakh beans).",
                        color = TextSecondary,
                        fontSize = 12.sp,
                        lineHeight = 17.sp
                    )
                }
            }

            Spacer(Modifier.height(14.dp))

            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(14.dp))
                    .background(
                        if (canRequestPayout)
                            Brush.linearGradient(BeanGradient)
                        else
                            Brush.linearGradient(listOf(OutlineDefault, OutlineDefault))
                    )
                    .clickable(enabled = canRequestPayout) {
                        val myId = com.google.firebase.auth.FirebaseAuth.getInstance().currentUser?.uid.orEmpty()
                        val msgText = "Hi, I would like to request a payout.\nUser ID: $myId\nBean Balance: ${beans}\nEquivalent: ₹${String.format(java.util.Locale.getDefault(), "%,.2f", rupeesEquivalent)}"
                        val encoded = android.net.Uri.encode(msgText)
                        val url = "https://wa.me/919999999999?text=$encoded"
                        try {
                            ctx.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url)))
                        } catch (_: Exception) {
                            android.widget.Toast.makeText(ctx, "WhatsApp not installed", android.widget.Toast.LENGTH_SHORT).show()
                        }
                    }
                    .padding(vertical = 14.dp),
                contentAlignment = Alignment.Center
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        Icons.Default.AccountBalance,
                        null,
                        tint = if (canRequestPayout) Color.White else TextMuted,
                        modifier = Modifier.size(18.dp)
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "Contact Agency for Payout",
                        color = if (canRequestPayout) Color.White else TextMuted,
                        fontWeight = FontWeight.Bold,
                        fontSize = 15.sp
                    )
                }
            }
        }
    }
}

@Composable
private fun BeanEarningRow(tx: Transaction, modifier: Modifier = Modifier) {
    val isGift = tx.type == TransactionType.GIFT_RECEIVE.name
    val isCall = tx.type == TransactionType.CALL_EARN.name

    val icon = when {
        isGift -> Icons.Default.CardGiftcard
        isCall -> Icons.Default.Call
        else   -> Icons.Default.Receipt
    }
    val iconColor = when {
        isGift -> BrandPink
        isCall -> BrandPurple
        else   -> TextSecondary
    }

    val label = when {
        isGift -> "Gift Received${tx.counterpartName?.let { " from $it" } ?: ""}"
        isCall -> "Call Earnings${tx.counterpartName?.let { " from $it" } ?: ""}"
        else   -> txLabel(tx)
    }

    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        color = AppSurface,
        border = BorderStroke(1.dp, OutlineDefault)
    ) {
        Row(
            modifier = Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                modifier = Modifier
                    .size(42.dp)
                    .clip(CircleShape)
                    .background(iconColor.copy(alpha = 0.12f)),
                contentAlignment = Alignment.Center
            ) {
                Icon(icon, null, tint = iconColor, modifier = Modifier.size(20.dp))
            }
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    label,
                    color = TextPrimary,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 14.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                if (tx.note.isNotBlank()) {
                    Text(tx.note, color = TextSecondary, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (tx.timestamp > 0) {
                    Text(formatTimestamp(tx.timestamp), color = TextMuted, fontSize = 11.sp)
                }
            }
            Spacer(Modifier.width(8.dp))
            if (tx.beans != 0L) {
                val prefix = if (tx.beans > 0) "+" else ""
                Text(
                    "$prefix${formatIndianNumber(tx.beans)} 🫘",
                    color = if (tx.beans > 0) Color(0xFF4CAF50) else Color(0xFFFF6B6B),
                    fontWeight = FontWeight.Bold,
                    fontSize = 14.sp
                )
            }
        }
    }
}

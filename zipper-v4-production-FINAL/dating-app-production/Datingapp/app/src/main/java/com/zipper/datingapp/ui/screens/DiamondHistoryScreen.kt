package com.zipper.datingapp.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zipper.datingapp.data.Transaction
import com.zipper.datingapp.data.TransactionType
import com.zipper.datingapp.ui.DatingViewModel
import com.zipper.datingapp.ui.theme.*
import java.text.SimpleDateFormat
import java.util.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DiamondHistoryScreen(
    viewModel: DatingViewModel,
    onBack: () -> Unit,
    onBuyDiamonds: () -> Unit,
) {
    LaunchedEffect(Unit) { viewModel.loadTransactionHistory() }

    val diamonds by viewModel.diamonds.collectAsState()
    val transactions by viewModel.transactionHistory.collectAsState()

    BackHandler(onBack = onBack)

    // Only transactions that moved diamonds (positive or negative)
    val diamondTxs = transactions.filter { it.diamonds != 0L }
    val totalCredit = diamondTxs.filter { it.diamonds > 0 }.sumOf { it.diamonds }
    val totalDebit  = diamondTxs.filter { it.diamonds < 0 }.sumOf { -it.diamonds }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Diamond Wallet", fontWeight = FontWeight.Bold, fontSize = 20.sp) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
    ) { pad ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(pad),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // Balance hero card
            item {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(24.dp))
                        .background(Brush.linearGradient(listOf(Color(0xFFFFD700), Color(0xFFFFA000))))
                        .padding(24.dp),
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("Current Balance", color = Color.White.copy(.85f), fontSize = 14.sp)
                        Spacer(Modifier.height(6.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Default.Diamond, null, tint = Color.White, modifier = Modifier.size(32.dp))
                            Spacer(Modifier.width(8.dp))
                            Text(
                                "$diamonds",
                                color = Color.White,
                                fontWeight = FontWeight.ExtraBold,
                                fontSize = 40.sp,
                            )
                        }
                        Spacer(Modifier.height(20.dp))
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Surface(
                                modifier = Modifier.weight(1f),
                                shape = RoundedCornerShape(14.dp),
                                color = Color.White.copy(.2f),
                            ) {
                                Column(
                                    modifier = Modifier.padding(12.dp),
                                    horizontalAlignment = Alignment.CenterHorizontally,
                                ) {
                                    Icon(Icons.Default.TrendingUp, null, tint = Color.White, modifier = Modifier.size(18.dp))
                                    Spacer(Modifier.height(4.dp))
                                    Text("+$totalCredit", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 16.sp)
                                    Text("Credits", color = Color.White.copy(.7f), fontSize = 11.sp)
                                }
                            }
                            Surface(
                                modifier = Modifier.weight(1f),
                                shape = RoundedCornerShape(14.dp),
                                color = Color.White.copy(.2f),
                            ) {
                                Column(
                                    modifier = Modifier.padding(12.dp),
                                    horizontalAlignment = Alignment.CenterHorizontally,
                                ) {
                                    Icon(Icons.Default.TrendingDown, null, tint = Color.White, modifier = Modifier.size(18.dp))
                                    Spacer(Modifier.height(4.dp))
                                    Text("-$totalDebit", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 16.sp)
                                    Text("Spent", color = Color.White.copy(.7f), fontSize = 11.sp)
                                }
                            }
                        }
                        Spacer(Modifier.height(16.dp))
                        Button(
                            onClick = onBuyDiamonds,
                            modifier = Modifier.fillMaxWidth().height(50.dp),
                            shape = RoundedCornerShape(14.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = Color.White, contentColor = GoldAccent),
                        ) {
                            Icon(Icons.Default.Diamond, null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(8.dp))
                            Text("Buy Diamonds", fontWeight = FontWeight.Bold, fontSize = 15.sp)
                        }
                    }
                }
            }

            // Section header
            item {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "Transaction History",
                        fontWeight = FontWeight.Bold,
                        fontSize = 16.sp,
                        modifier = Modifier.weight(1f),
                    )
                    Icon(Icons.Default.History, null, tint = TextSecondary, modifier = Modifier.size(18.dp))
                }
            }

            if (diamondTxs.isEmpty()) {
                item {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 32.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text("No transactions yet", color = TextSecondary, fontSize = 14.sp)
                    }
                }
            } else {
                itemsIndexed(
                    diamondTxs,
                    key = { _, tx -> tx.id.ifBlank { tx.timestamp.toString() } },
                ) { _, tx ->
                    DiamondTxRow(tx)
                }
            }

            item { Spacer(Modifier.height(24.dp)) }
        }
    }
}

@Composable
private fun DiamondTxRow(tx: Transaction) {
    val dateFmt = remember { SimpleDateFormat("MMM d, yyyy · h:mm a", Locale.getDefault()) }
    val isCredit = tx.diamonds > 0
    val color = if (isCredit) Color(0xFF4CAF50) else MaterialTheme.colorScheme.error
    val (icon, label) = txTypeIconAndLabel(tx.type)
    val prefix = if (isCredit) "+" else ""

    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(.4f),
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(.1f)),
    ) {
        Row(
            modifier = Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(44.dp)
                    .background(color.copy(.12f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(icon, null, tint = color, modifier = Modifier.size(22.dp))
            }
            Spacer(Modifier.width(14.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(label, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                val subtext = when {
                    tx.note.isNotBlank() -> tx.note
                    !tx.counterpartName.isNullOrBlank() -> tx.counterpartName
                    else -> null
                }
                if (subtext != null) {
                    Text(subtext, color = TextSecondary, fontSize = 12.sp)
                }
                if (tx.timestamp > 0) {
                    Text(
                        dateFmt.format(Date(tx.timestamp)),
                        color = TextSecondary.copy(.6f),
                        fontSize = 11.sp,
                    )
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Diamond, null, tint = color, modifier = Modifier.size(12.dp))
                Spacer(Modifier.width(3.dp))
                Text(
                    "$prefix${tx.diamonds}",
                    color = color,
                    fontWeight = FontWeight.Bold,
                    fontSize = 15.sp,
                )
            }
        }
    }
}

private fun txTypeIconAndLabel(type: String): Pair<ImageVector, String> = when (type) {
    TransactionType.GIFT_SEND.name     -> Icons.Default.CardGiftcard    to "Gift Sent"
    TransactionType.GIFT_RECEIVE.name  -> Icons.Default.CardGiftcard    to "Gift Received"
    TransactionType.CALL_CHARGE.name   -> Icons.Default.Videocam        to "Call Charge"
    TransactionType.CALL_EARN.name     -> Icons.Default.Videocam        to "Call Earnings"
    TransactionType.RECHARGE.name      -> Icons.Default.AddCard         to "Diamond Top-up"
    TransactionType.BEANS_CONVERT.name -> Icons.Default.Stars           to "Beans Conversion"
    TransactionType.GAME_BET.name      -> Icons.Default.WorkspacePremium to "Game Bet"
    TransactionType.GAME_WIN.name      -> Icons.Default.WorkspacePremium to "Game Win"
    else                                -> Icons.Default.Diamond         to "Transaction"
}

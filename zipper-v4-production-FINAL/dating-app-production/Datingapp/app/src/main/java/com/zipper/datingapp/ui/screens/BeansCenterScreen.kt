package com.zipper.datingapp.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zipper.datingapp.data.TransactionType
import com.zipper.datingapp.ui.DatingUiState
import com.zipper.datingapp.ui.DatingViewModel
import com.zipper.datingapp.ui.theme.*
import java.text.SimpleDateFormat
import java.util.*

/** 20 beans = 1 diamond */
private const val BEANS_PER_DIAMOND = 20

data class BeansTx(
    val id: String,
    val label: String,
    val subLabel: String,
    val amount: Int,          // positive = credit, negative = debit
    val icon: ImageVector,
    val timestamp: String
)

private val beanDateFmt = SimpleDateFormat("MMM d · h:mm a", Locale.getDefault())

private fun beansTxIconAndLabel(type: String): Pair<ImageVector, String> = when (type) {
    TransactionType.GIFT_RECEIVE.name  -> Icons.Default.CardGiftcard to "Gift Received"
    TransactionType.CALL_EARN.name     -> Icons.Default.Call         to "Call Earnings"
    TransactionType.BEANS_CONVERT.name -> Icons.Default.SwapHoriz   to "Converted to Diamonds"
    else                                -> Icons.Default.Star         to "Beans"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BeansCenterScreen(
    viewModel: DatingViewModel,
    uiState: DatingUiState,
    onBack: () -> Unit,
    onConvertBeans: (Int) -> Unit = {}   // convert N beans → N/BEANS_PER_DIAMOND diamonds
) {
    BackHandler(onBack = onBack)

    LaunchedEffect(Unit) { viewModel.loadTransactionHistory() }

    val allTransactions by viewModel.transactionHistory.collectAsState()

    val beansBalance = uiState.beans

    // Map real bean transactions to display model
    val txs = remember(allTransactions) {
        allTransactions
            .filter { it.beans != 0L }
            .map { tx ->
                val (icon, label) = beansTxIconAndLabel(tx.type)
                val subLabel = when {
                    tx.note.isNotBlank()              -> tx.note
                    !tx.counterpartName.isNullOrBlank() -> tx.counterpartName!!
                    else                              -> ""
                }
                BeansTx(
                    id        = tx.id.ifBlank { tx.timestamp.toString() },
                    label     = label,
                    subLabel  = subLabel,
                    amount    = tx.beans.toInt(),
                    icon      = icon,
                    timestamp = if (tx.timestamp > 0) beanDateFmt.format(Date(tx.timestamp)) else "—",
                )
            }
    }

    val totalCredit = txs.filter { it.amount > 0 }.sumOf { it.amount }
    val totalDebit  = txs.filter { it.amount < 0 }.sumOf { -it.amount }

    var showConvertSheet by remember { mutableStateOf(false) }
    var convertAmount by remember { mutableStateOf("") }
    val convertBeans = convertAmount.toIntOrNull() ?: 0
    val diamondsToGet = convertBeans / BEANS_PER_DIAMOND

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Beans Center", fontWeight = FontWeight.Bold, fontSize = 20.sp) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background)
            )
        }
    ) { pad ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(pad),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {

            // ── Balance hero card ─────────────────────────────────────────────
            item {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(24.dp))
                        .background(
                            Brush.linearGradient(listOf(Color(0xFFFF7043), Color(0xFFE91E63)))
                        )
                        .padding(24.dp)
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text("Beans Balance", color = Color.White.copy(.85f), fontSize = 14.sp)
                        Spacer(Modifier.height(6.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("🟡", fontSize = 28.sp)
                            Spacer(Modifier.width(8.dp))
                            Text(
                                "$beansBalance",
                                color = Color.White,
                                fontWeight = FontWeight.ExtraBold,
                                fontSize = 40.sp
                            )
                        }
                        Spacer(Modifier.height(8.dp))
                        Text(
                            "= ${beansBalance / BEANS_PER_DIAMOND} Diamonds at current rate",
                            color = Color.White.copy(.7f),
                            fontSize = 12.sp,
                            textAlign = TextAlign.Center
                        )

                        Spacer(Modifier.height(20.dp))

                        // Stats row
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            Surface(
                                modifier = Modifier.weight(1f),
                                shape = RoundedCornerShape(14.dp),
                                color = Color.White.copy(.2f)
                            ) {
                                Column(
                                    modifier = Modifier.padding(12.dp),
                                    horizontalAlignment = Alignment.CenterHorizontally
                                ) {
                                    Icon(Icons.Default.TrendingUp, null, tint = Color.White, modifier = Modifier.size(18.dp))
                                    Spacer(Modifier.height(4.dp))
                                    Text("+$totalCredit", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 15.sp)
                                    Text("Earned", color = Color.White.copy(.7f), fontSize = 11.sp)
                                }
                            }
                            Surface(
                                modifier = Modifier.weight(1f),
                                shape = RoundedCornerShape(14.dp),
                                color = Color.White.copy(.2f)
                            ) {
                                Column(
                                    modifier = Modifier.padding(12.dp),
                                    horizontalAlignment = Alignment.CenterHorizontally
                                ) {
                                    Icon(Icons.Default.TrendingDown, null, tint = Color.White, modifier = Modifier.size(18.dp))
                                    Spacer(Modifier.height(4.dp))
                                    Text("-$totalDebit", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 15.sp)
                                    Text("Used", color = Color.White.copy(.7f), fontSize = 11.sp)
                                }
                            }
                        }

                        Spacer(Modifier.height(16.dp))

                        // Convert button
                        Button(
                            onClick = { showConvertSheet = true },
                            modifier = Modifier.fillMaxWidth().height(50.dp),
                            shape = RoundedCornerShape(14.dp),
                            colors = ButtonDefaults.buttonColors(
                                containerColor = Color.White,
                                contentColor = Color(0xFFE91E63)
                            )
                        ) {
                            Icon(Icons.Default.SwapHoriz, null, modifier = Modifier.size(20.dp))
                            Spacer(Modifier.width(8.dp))
                            Text(
                                "Convert to Diamonds  (20 🟡 = 1 💎)",
                                fontWeight = FontWeight.Bold,
                                fontSize = 14.sp
                            )
                        }
                    }
                }
            }

            // ── Rate info card ────────────────────────────────────────────────
            item {
                Surface(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(16.dp),
                    color = BrandPurple.copy(.07f),
                    border = androidx.compose.foundation.BorderStroke(1.dp, BrandPurple.copy(.2f))
                ) {
                    Row(
                        modifier = Modifier.padding(14.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(Icons.Default.Info, null, tint = BrandPurple, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(12.dp))
                        Column {
                            Text("Conversion Rate", fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                            Text(
                                "20 Beans = 1 Diamond · Minimum 20 Beans to convert · No fees",
                                fontSize = 12.sp,
                                color = TextSecondary,
                                lineHeight = 17.sp
                            )
                        }
                    }
                }
            }

            // ── Transaction history header ─────────────────────────────────
            item {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        "Transaction History",
                        fontWeight = FontWeight.Bold,
                        fontSize = 16.sp,
                        modifier = Modifier.weight(1f)
                    )
                    Icon(Icons.Default.History, null, tint = TextSecondary, modifier = Modifier.size(18.dp))
                }
            }

            // ── Transactions ──────────────────────────────────────────────────
            itemsIndexed(txs, key = { _, tx -> tx.id }) { _, tx ->
                BeansTxRow(tx)
            }

            item { Spacer(Modifier.height(32.dp)) }
        }
    }

    // ── Convert dialog ────────────────────────────────────────────────────────
    if (showConvertSheet) {
        AlertDialog(
            onDismissRequest = { showConvertSheet = false; convertAmount = "" },
            icon = {
                Box(
                    modifier = Modifier.size(52.dp).background(
                        Brush.linearGradient(listOf(Color(0xFFFF7043), Color(0xFFE91E63))),
                        CircleShape
                    ),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(Icons.Default.SwapHoriz, null, tint = Color.White, modifier = Modifier.size(28.dp))
                }
            },
            title = { Text("Convert Beans to Diamonds", fontWeight = FontWeight.Bold, textAlign = TextAlign.Center) },
            text = {
                Column {
                    // Balance pill
                    Surface(
                        shape = RoundedCornerShape(50),
                        color = Color(0xFFFF7043).copy(.1f)
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.Center
                        ) {
                            Text("🟡", fontSize = 16.sp)
                            Spacer(Modifier.width(6.dp))
                            Text(
                                "Available: $beansBalance Beans",
                                fontWeight = FontWeight.SemiBold,
                                fontSize = 14.sp,
                                color = Color(0xFFFF7043)
                            )
                        }
                    }
                    Spacer(Modifier.height(16.dp))

                    OutlinedTextField(
                        value = convertAmount,
                        onValueChange = {
                            if (it.isEmpty() || it.all { c -> c.isDigit() }) convertAmount = it
                        },
                        label = { Text("Beans to convert (min 20)") },
                        modifier = Modifier.fillMaxWidth(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        singleLine = true,
                        leadingIcon = { Text("🟡", fontSize = 18.sp, modifier = Modifier.padding(start = 4.dp)) }
                    )

                    AnimatedVisibility(visible = convertBeans >= BEANS_PER_DIAMOND) {
                        Spacer(Modifier.height(12.dp))
                        Surface(
                            shape = RoundedCornerShape(12.dp),
                            color = GoldAccent.copy(.1f),
                            border = androidx.compose.foundation.BorderStroke(1.dp, GoldAccent.copy(.3f)),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Column(
                                modifier = Modifier.padding(14.dp),
                                horizontalAlignment = Alignment.CenterHorizontally
                            ) {
                                Text("You will receive", color = TextSecondary, fontSize = 12.sp)
                                Spacer(Modifier.height(4.dp))
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Icon(Icons.Default.Diamond, null, tint = GoldAccent, modifier = Modifier.size(22.dp))
                                    Spacer(Modifier.width(6.dp))
                                    Text(
                                        "$diamondsToGet Diamonds",
                                        fontWeight = FontWeight.ExtraBold,
                                        fontSize = 20.sp,
                                        color = GoldAccent
                                    )
                                }
                                if (convertBeans % BEANS_PER_DIAMOND != 0) {
                                    Text(
                                        "${convertBeans % BEANS_PER_DIAMOND} beans remainder will stay",
                                        color = TextSecondary,
                                        fontSize = 11.sp
                                    )
                                }
                            }
                        }
                    }

                    if (convertBeans > beansBalance) {
                        Spacer(Modifier.height(8.dp))
                        Text(
                            "Not enough beans!",
                            color = MaterialTheme.colorScheme.error,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Medium
                        )
                    }
                    if (convertBeans in 1 until BEANS_PER_DIAMOND) {
                        Spacer(Modifier.height(8.dp))
                        Text(
                            "Minimum $BEANS_PER_DIAMOND beans required",
                            color = MaterialTheme.colorScheme.error,
                            fontSize = 12.sp
                        )
                    }
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        if (diamondsToGet > 0 && convertBeans <= beansBalance) {
                            onConvertBeans(convertBeans)
                            showConvertSheet = false
                            convertAmount = ""
                        }
                    },
                    enabled = diamondsToGet > 0 && convertBeans <= beansBalance,
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFE91E63))
                ) {
                    Text("Convert Now")
                }
            },
            dismissButton = {
                TextButton(onClick = { showConvertSheet = false; convertAmount = "" }) {
                    Text("Cancel")
                }
            }
        )
    }
}

@Composable
private fun BeansTxRow(tx: BeansTx) {
    val isCredit = tx.amount > 0
    val isConvert = tx.label.contains("Convert", ignoreCase = true)
    val color = when {
        isConvert -> GoldAccent
        isCredit  -> Color(0xFF4CAF50)
        else      -> MaterialTheme.colorScheme.error
    }

    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(.4f),
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(.1f))
    ) {
        Row(modifier = Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier.size(44.dp).background(color.copy(.12f), CircleShape),
                contentAlignment = Alignment.Center
            ) {
                Icon(tx.icon, null, tint = color, modifier = Modifier.size(22.dp))
            }
            Spacer(Modifier.width(14.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(tx.label, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                Text(tx.subLabel, color = TextSecondary, fontSize = 12.sp)
                Text(tx.timestamp, color = TextSecondary.copy(.6f), fontSize = 11.sp)
            }
            Text(
                "${if (isCredit) "+" else ""}${tx.amount} 🟡",
                color = color,
                fontWeight = FontWeight.Bold,
                fontSize = 14.sp
            )
        }
    }
}

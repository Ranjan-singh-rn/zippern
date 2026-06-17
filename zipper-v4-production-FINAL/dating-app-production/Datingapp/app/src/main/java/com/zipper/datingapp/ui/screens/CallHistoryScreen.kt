package com.zipper.datingapp.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.SubcomposeAsyncImage
import com.zipper.datingapp.data.TransactionType
import com.zipper.datingapp.ui.DatingViewModel
import com.zipper.datingapp.ui.theme.*
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import java.text.SimpleDateFormat
import java.util.*

enum class CallType { INCOMING, OUTGOING, MISSED, DECLINED }

data class CallHistoryEntry(
    val id: String,
    val name: String,
    val photoUrl: String,
    val type: CallType,
    val duration: String,      // e.g. "5m 23s" or "Missed"
    val timestamp: String,
    val userId: String = ""
)

// Timestamp format used for call rows
private val callDateFmt = SimpleDateFormat("MMM d · h:mm a", Locale.getDefault())

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CallHistoryScreen(
    viewModel: DatingViewModel,
    onBack: () -> Unit,
    onRecall: (String) -> Unit = {}
) {
    BackHandler(onBack = onBack)

    LaunchedEffect(Unit) { viewModel.loadTransactionHistory() }

    val allTransactions by viewModel.transactionHistory.collectAsState()

    // Map CALL_CHARGE (outgoing) and CALL_EARN (incoming) transactions to display entries
    val calls = remember(allTransactions) {
        allTransactions
            .filter { it.type == TransactionType.CALL_CHARGE.name || it.type == TransactionType.CALL_EARN.name }
            .map { tx ->
                val callType = if (tx.type == TransactionType.CALL_EARN.name) CallType.INCOMING else CallType.OUTGOING
                val duration = tx.note.ifBlank { "—" }
                val timeStr = if (tx.timestamp > 0) callDateFmt.format(Date(tx.timestamp)) else "—"
                CallHistoryEntry(
                    id        = tx.id.ifBlank { tx.timestamp.toString() },
                    name      = tx.counterpartName ?: "Unknown",
                    photoUrl  = "",
                    type      = callType,
                    duration  = duration,
                    timestamp = timeStr,
                    userId    = tx.counterpartId ?: "",
                )
            }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Call History", fontWeight = FontWeight.Bold, fontSize = 20.sp) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background)
            )
        }
    ) { pad ->
        if (calls.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(pad), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Default.CallEnd, null, tint = TextSecondary.copy(.35f), modifier = Modifier.size(56.dp))
                    Spacer(Modifier.height(12.dp))
                    Text("No calls yet", color = TextSecondary, fontSize = 15.sp)
                }
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(pad),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                items(calls, key = { it.id }) { call ->
                    CallHistoryRow(call = call, onRecall = { onRecall(call.userId) })
                }
            }
        }
    }
}

@Composable
private fun CallHistoryRow(call: CallHistoryEntry, onRecall: () -> Unit) {
    val (typeColor, typeIcon, typeLabel) = when (call.type) {
        CallType.INCOMING -> Triple(Color(0xFF4CAF50), Icons.Default.CallReceived,  "Incoming")
        CallType.OUTGOING -> Triple(BrandPurple,       Icons.Default.CallMade,      "Outgoing")
        CallType.MISSED   -> Triple(Color(0xFFF44336), Icons.Default.PhoneMissed,   "Missed")
        CallType.DECLINED -> Triple(Color(0xFFFF9800), Icons.Default.CallEnd,       "Declined")
    }

    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(.4f),
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(.1f)),
        shadowElevation = 1.dp
    ) {
        Row(
            modifier = Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Avatar
            Box(modifier = Modifier.size(52.dp)) {
                if (call.photoUrl.isNotBlank()) {
                    SubcomposeAsyncImage(
                        model = call.photoUrl,
                        contentDescription = null,
                        modifier = Modifier.fillMaxSize().clip(CircleShape),
                        contentScale = ContentScale.Crop
                    )
                } else {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .clip(CircleShape)
                            .background(Brush.linearGradient(listOf(BrandPurple, BrandPink))),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(call.name.take(1).uppercase(), color = Color.White, fontWeight = FontWeight.Bold, fontSize = 20.sp)
                    }
                }
                // Call type badge
                Box(
                    modifier = Modifier
                        .size(16.dp)
                        .align(Alignment.BottomEnd)
                        .border(1.dp, MaterialTheme.colorScheme.surface, CircleShape)
                        .clip(CircleShape)
                        .background(typeColor)
                )
            }

            Spacer(Modifier.width(14.dp))

            Column(modifier = Modifier.weight(1f)) {
                Text(call.name, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(3.dp))
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Icon(typeIcon, null, tint = typeColor, modifier = Modifier.size(13.dp))
                    Text(typeLabel, color = typeColor, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                    Text("·", color = TextSecondary, fontSize = 12.sp)
                    Text(call.duration, color = TextSecondary, fontSize = 12.sp)
                }
                Text(call.timestamp, color = TextSecondary.copy(.6f), fontSize = 11.sp)
            }

            // Recall button
            IconButton(
                onClick = onRecall,
                modifier = Modifier
                    .size(42.dp)
                    .background(BrandPink.copy(.1f), CircleShape)
            ) {
                Icon(Icons.Default.VideoCall, null, tint = BrandPink, modifier = Modifier.size(20.dp))
            }
        }
    }
}

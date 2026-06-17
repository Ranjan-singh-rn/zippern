package com.zipper.datingapp.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.zipper.datingapp.ui.DatingUiState
import com.zipper.datingapp.ui.theme.AppResponsiveContentMaxWidth
import com.zipper.datingapp.ui.theme.LocalWindowWidthClass
import com.zipper.datingapp.ui.theme.defaultHorizontalContentPadding
import java.util.*

@Composable
fun EarningsScreen(uiState: DatingUiState) {
    val widthClass = LocalWindowWidthClass.current
    val hPad = widthClass.defaultHorizontalContentPadding()
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.TopCenter,
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = AppResponsiveContentMaxWidth)
                .fillMaxHeight()
                .verticalScroll(rememberScrollState())
                .padding(hPad)
        ) {
        Text(
            text = "My Earnings",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold
        )
        
        Spacer(modifier = Modifier.height(24.dp))
        
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)
        ) {
            Column(
                modifier = Modifier.padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text(text = "Total Balance", style = MaterialTheme.typography.labelLarge)
                Text(
                    text = "₹${String.format(Locale.getDefault(), "%.2f", uiState.totalEarnings)}",
                    style = MaterialTheme.typography.displayMedium,
                    fontWeight = FontWeight.ExtraBold,
                    color = MaterialTheme.colorScheme.onPrimaryContainer
                )
                Spacer(modifier = Modifier.height(16.dp))
                // Withdrawal is handled through Bean Center (beans → INR payout)
                OutlinedButton(
                    onClick = { /* TODO: navigate to BeanCenterScreen */ },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = false,
                ) {
                    Icon(Icons.Default.AccountBalanceWallet, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text("Withdraw via Bean Center")
                }
            }
        }
        
        Spacer(modifier = Modifier.height(32.dp))

        Text(
            text = "Platform Policy",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
        )
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            text = "Gifts: You receive 50% of every gift's value as beans.\n" +
                "Calls: You earn 30–50% of call charges as beans (varies by caller and callee gender).\n" +
                "Payouts: 1,00,000 beans = ₹1,000 paid to your account.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        }
    }
}


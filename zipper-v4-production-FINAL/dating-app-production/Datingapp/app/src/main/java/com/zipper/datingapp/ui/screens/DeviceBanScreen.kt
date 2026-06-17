package com.zipper.datingapp.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Block
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zipper.datingapp.security.DeviceBanInfo
import com.zipper.datingapp.ui.theme.AppBackground
import com.zipper.datingapp.ui.theme.BrandPink
import com.zipper.datingapp.ui.theme.TextPrimary
import com.zipper.datingapp.ui.theme.TextSecondary
import java.text.SimpleDateFormat
import java.util.*

/**
 * Full-screen shown when device is banned. No way out — user must contact support.
 */
@Composable
fun DeviceBanScreen(banInfo: DeviceBanInfo) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(AppBackground),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Icon(
                Icons.Default.Block,
                contentDescription = null,
                tint = Color(0xFFE53935),
                modifier = Modifier.size(72.dp),
            )

            Text(
                "Device Banned",
                color = Color(0xFFE53935),
                fontSize = 26.sp,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
            )

            Text(
                "This device has been banned from Zipper.",
                color = TextPrimary,
                fontSize = 16.sp,
                textAlign = TextAlign.Center,
            )

            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(12.dp),
                colors = CardDefaults.cardColors(containerColor = Color.White.copy(0.05f)),
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    BanDetailRow("Reason", banInfo.reason)
                    BanDetailRow(
                        "Banned On",
                        SimpleDateFormat("dd MMM yyyy, hh:mm a", Locale.getDefault())
                            .format(Date(banInfo.bannedAt)),
                    )
                    BanDetailRow("Action By", banInfo.bannedBy)
                }
            }

            Spacer(Modifier.height(8.dp))

            Text(
                "If you believe this is a mistake, contact support at support@zipper.app",
                color = TextSecondary,
                fontSize = 13.sp,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun BanDetailRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth()) {
        Text(label, color = TextSecondary, fontSize = 13.sp, modifier = Modifier.weight(0.4f))
        Text(value, color = TextPrimary, fontSize = 13.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(0.6f))
    }
}

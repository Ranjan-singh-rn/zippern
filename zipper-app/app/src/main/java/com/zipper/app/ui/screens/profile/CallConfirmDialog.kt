package com.zipper.app.ui.screens.profile

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.dp
import com.zipper.app.ui.components.Currency
import com.zipper.app.ui.components.CurrencyDisc
import com.zipper.app.ui.components.indianGrouping
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import com.zipper.app.util.CallBilling

/**
 * Spec §11 (APK 20) — the pre-call confirmation, shared by the profile and (O5b, 5 Nov 2026) the chat: what a minute
 * costs, that the FIRST minute is charged the moment the call connects, and the caller's balance — before the server
 * is asked to ring anybody. The server still prices and refuses (`startCall`); this only says it first.
 *
 * Short of a minute's diamonds, the confirm button is "Recharge" instead: the call would be refused anyway.
 */
@Composable
fun CallConfirmDialog(
    name: String,
    perMinuteDiamonds: Long,
    balanceDiamonds: Long,
    onCall: () -> Unit,
    onRecharge: () -> Unit,
    onDismiss: () -> Unit,
) {
    val c = ZipperTheme.colors
    val short = CallBilling.isShort(balanceDiamonds, perMinuteDiamonds)
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.bgElevated,
        title = { Text("Call $name?", style = ZipperTheme.type.headingS, color = c.textPrimary) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
                    CurrencyDisc(Currency.Diamond, 14.dp)
                    Text("${indianGrouping(perMinuteDiamonds)} per minute", style = ZipperTheme.type.labelM, color = c.textPrimary)
                }
                Text(CallBilling.confirmText(perMinuteDiamonds), style = ZipperTheme.type.bodyM, color = c.textSecondary)
                Text(
                    "Your balance: ${indianGrouping(balanceDiamonds)} diamonds",
                    style = ZipperTheme.type.caption, color = if (short) c.statusDanger else c.textMuted,
                )
                if (short) {
                    Text(
                        "You need at least ${indianGrouping(perMinuteDiamonds)} diamonds for the first minute.",
                        style = ZipperTheme.type.caption, color = c.statusDanger,
                    )
                }
            }
        },
        confirmButton = {
            if (short) {
                TextButton(onRecharge) { Text("Recharge", color = c.textBrand) }
            } else {
                TextButton(onCall) { Text("Call — first minute charged on connect", color = c.textBrand) }
            }
        },
        dismissButton = { TextButton(onDismiss) { Text("Cancel", color = c.textSecondary) } },
    )
}

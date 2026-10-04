package com.zipper.app.ui.screens.diamond

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Diamond
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.zipper.app.data.model.DiamondTransaction
import com.zipper.app.ui.components.*
import com.zipper.app.ui.screens.messages.timeAgo
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme

/** Maps a raw reason code to a display label when reasonLabel is blank (e.g. older records). */
private fun DiamondTransaction.displayLabel(): String = reasonLabel.ifBlank {
    when (reason) {
        "seller_recharge" -> "Seller Recharge"
        "gift_sent"       -> if (relatedUserName.isNotBlank()) "Gift Sent to $relatedUserName" else "Gift Sent"
        "call_payment"    -> if (relatedUserName.isNotBlank()) "Call — $relatedUserName" else "Call Payment"
        "daily_reward"    -> "Daily Reward"
        "bean_conversion" -> "Beans → Diamond"
        "game_win"        -> "Game Win Reward"
        "lucky_spin"      -> "Lucky Spin Win"
        "company_credit"  -> "Added by Zipper"
        else              -> reason.replace('_', ' ').replaceFirstChar { it.uppercase() }
    }
}

/*
 * Diamond wallet — aqua balance hero with a "Recharge" CTA, then one row per
 * transaction: credits "+" in aqua, debits in danger, reason label + timeAgo.
 */
@Composable
fun DiamondHistoryScreen(
    currentDiamonds: Long = 0L,
    transactions: List<DiamondTransaction> = emptyList(),
    onBack: () -> Unit = {},
    onRecharge: () -> Unit = {},
) {
    val c = ZipperTheme.colors
    ZipperScreen(topBar = { TopBar("Diamond wallet", onBack = onBack) }) { _ ->
        LazyColumn(contentPadding = PaddingValues(horizontal = Space.lg, vertical = Space.md), verticalArrangement = Arrangement.spacedBy(Space.md)) {
            item {
                Column(
                    Modifier.fillMaxWidth()
                        .background(Brush.linearGradient(listOf(c.currencyDiamond.copy(alpha = 0.22f), c.brandSecondary.copy(alpha = 0.18f))), RoundedCornerShape(Radius.xl))
                        .border(1.dp, c.tintDiamondSubtle, RoundedCornerShape(Radius.xl)).padding(Space.xl),
                    verticalArrangement = Arrangement.spacedBy(Space.sm),
                ) {
                    Text("Your balance", style = ZipperTheme.type.caption, color = c.textSecondary)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                        CurrencyDisc(Currency.Diamond, 24.dp)
                        Text(indianGrouping(currentDiamonds), style = ZipperTheme.type.numericL, color = c.currencyDiamond)
                        Text("diamonds", style = ZipperTheme.type.bodyM, color = c.textSecondary)
                    }
                    ZipperButton("Recharge diamonds", onRecharge, size = ButtonSize.Medium, gradient = true, fullWidth = true)
                }
            }

            if (transactions.isEmpty()) {
                item { EmptyState(Icons.Outlined.Diamond, "No transactions yet", "Recharge from a verified reseller and your diamond history will appear here.", actionLabel = "Get diamonds", onAction = onRecharge) }
            } else {
                item { SectionHeader("Transaction history", Modifier.padding(top = Space.xs)) }
                items(transactions, key = { it.id }) { tx ->
                    val credit = tx.type == "credit"
                    Row(Modifier.fillMaxWidth().padding(vertical = Space.sm), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
                        Box(Modifier.size(36.dp).background(if (credit) c.tintDiamondSubtle else c.tintDangerSubtle, CircleShape), contentAlignment = Alignment.Center) {
                            CurrencyDisc(Currency.Diamond, 14.dp)
                        }
                        Column(Modifier.weight(1f)) {
                            Text(tx.displayLabel(), style = ZipperTheme.type.bodyM, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (tx.relatedUserName.isNotBlank()) Text(tx.relatedUserName, style = ZipperTheme.type.caption, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(timeAgo(tx.timestamp), style = ZipperTheme.type.caption, color = c.textMuted)
                        }
                        Text((if (credit) "+" else "−") + indianGrouping(tx.amount), style = ZipperTheme.type.numericS, color = if (credit) c.currencyDiamond else c.statusDanger)
                    }
                    HairlineDivider()
                }
            }
            item { Spacer(Modifier.navigationBarsPadding()) }
        }
    }
}

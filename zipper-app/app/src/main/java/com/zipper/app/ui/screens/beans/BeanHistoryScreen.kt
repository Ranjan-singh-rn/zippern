package com.zipper.app.ui.screens.beans

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Receipt
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.zipper.app.data.model.BeanTransaction
import com.zipper.app.ui.components.*
import com.zipper.app.ui.screens.messages.timeAgo
import com.zipper.app.ui.screens.profile.GlassCard
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme

/*
 * Beans Center — balance hero (mint), convert-to-diamonds card with a live
 * preview, then the transaction list: money in mint with a "+", money out in
 * danger with a "−", and a weekly release labelled as such. Which of those a row
 * is comes from BeanTransaction.isMoneyIn, not from a test written here — this
 * screen used to call `type == "credit"` money in, which made every weekly
 * payout look like a deduction.
 */

/** Maps a raw reason code to a display label when reasonLabel is blank (e.g. older records). */
private fun BeanTransaction.displayLabel(): String = reasonLabel.ifBlank {
    when (reason) {
        "gift_earning"      -> if (relatedUserName.isNotBlank()) "Gift — from $relatedUserName" else "Gift Earning"
        "call_earning"      -> if (relatedUserName.isNotBlank()) "Call — $relatedUserName" else "Call Earning"
        "diamond_conversion"-> "Converted to Diamonds"
        "weekly_salary"     -> "Weekly Salary"
        "weekly_reset"      -> "Weekly Beans Processed for Cashflow"
        else                -> reason.replace('_', ' ').replaceFirstChar { it.uppercase() }
    }
}

/** Weekly reset and salary entries get a descriptive italic subtitle. */
private fun BeanTransaction.subtitle(): String? = when (reason) {
    "weekly_reset"   -> "Beans reset every Sunday — processed to your cashflow account"
    "weekly_salary"  -> "Beans reset weekly as salary"
    else             -> null
}

@Composable
fun BeanHistoryScreen(
    currentBeans: Long = 0L,
    transactions: List<BeanTransaction> = emptyList(),
    /**
     * Live from the CRM. Was a `private const val 20L` in this file, so if the
     * rate were ever changed the screen would promise one number of diamonds
     * and the server would grant another — or refuse the amount outright for
     * not being a multiple.
     */
    beansPerDiamond: Long = 20L,
    onBack: () -> Unit = {},
    onConvert: (Long) -> Unit = {},
) {
    val c = ZipperTheme.colors

    ZipperScreen(topBar = { TopBar("Beans", onBack = onBack) }) { _ ->
        LazyColumn(contentPadding = PaddingValues(horizontal = Space.lg, vertical = Space.md), verticalArrangement = Arrangement.spacedBy(Space.md)) {
            item {
                // Balance hero
                Column(
                    Modifier.fillMaxWidth()
                        .background(Brush.linearGradient(listOf(c.currencyBean.copy(0.22f), c.brandSecondary.copy(0.18f))), RoundedCornerShape(Radius.xl))
                        .border(1.dp, c.tintSuccessSubtle, RoundedCornerShape(Radius.xl)).padding(Space.xl),
                    verticalArrangement = Arrangement.spacedBy(Space.sm),
                ) {
                    Text("Bean balance", style = ZipperTheme.type.caption, color = c.textSecondary)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                        CurrencyDisc(Currency.Bean, 24.dp)
                        Text(indianGrouping(currentBeans), style = ZipperTheme.type.numericL, color = c.currencyBean)
                        Text("beans", style = ZipperTheme.type.bodyM, color = c.textSecondary)
                    }
                    Text("$beansPerDiamond beans = 1 diamond", style = ZipperTheme.type.caption, color = c.textMuted)
                }
            }
            item { BeanConversionCard(currentBeans = currentBeans, beansPerDiamond = beansPerDiamond, onConvert = onConvert) }
            item { SectionHeader("Transaction history", Modifier.padding(top = Space.sm)) }
            if (transactions.isEmpty()) {
                item { EmptyState(Icons.Outlined.Receipt, "No transactions yet", "Take calls and receive gifts to earn beans — every credit and conversion shows up here.") }
            } else {
                items(transactions, key = { it.id }) { tx -> BeanTransactionRow(tx); HairlineDivider() }
            }
            item { Spacer(Modifier.navigationBarsPadding()) }
        }
    }
}

@Composable
private fun BeanConversionCard(currentBeans: Long, beansPerDiamond: Long, onConvert: (Long) -> Unit) {
    val c = ZipperTheme.colors
    var inputText by remember { mutableStateOf("") }

    /*
     * The server's rule is a MODULUS, not a floor.
     *
     * `convertBeans` refuses any amount where `beansAmount % rate != 0` with
     * "Convert in multiples of N beans." This card used to gate on
     * `enteredAmount >= beansPerDiamond` alone and label the field "min N", so
     * at a rate of 20 an entry of 30 cleared the gate, the preview promised a
     * whole diamond, and the button lit up — and every tap came back refused.
     * The user was told the rule was a floor, met it, and still could not
     * convert: an enabled button that can only fail is worse than a disabled
     * one, because nothing on screen says what would make it work.
     *
     * Both ends truncate the CRM's rate to a whole number of beans (see the
     * note on ProfileViewModel's `beansPerDiamond`), so the multiple enforced
     * here is the multiple the server checks. The floor of 1 is load-bearing
     * rather than defensive habit: a missing or zero rate would make `% step`
     * and `/ step` below divide by zero and take the screen down.
     */
    val step = beansPerDiamond.coerceAtLeast(1L)
    val enteredAmount = inputText.toLongOrNull() ?: 0L
    val isMultiple = enteredAmount > 0L && enteredAmount % step == 0L
    val notEnough = enteredAmount > currentBeans
    val canConvert = isMultiple && !notEnough
    val diamondsToReceive = if (canConvert) enteredAmount / step else 0L
    val beansRemaining = (currentBeans - enteredAmount).coerceAtLeast(0L)

    /*
     * The largest convertible amount is rarely the balance, and rounding the
     * balance DOWN to a multiple is what keeps the top of the range reachable
     * at all: at 35 beans and a rate of 20 the only amount that satisfies both
     * "≤ balance" and "multiple of 20" is 20, and the screen used to say
     * nothing about it — the user had to divide their own balance to discover
     * that the number in the hero above was not a number they could type.
     * "Convert all" fills it in, and the beans left behind are stated rather
     * than found out afterwards when the balance fails to reach zero.
     */
    val maxConvertible = (currentBeans / step) * step

    // The two multiples either side of what they typed, minus any that is zero
    // or past their balance — a suggestion is only useful if it is an amount
    // they could actually send.
    val nearestBelow = (enteredAmount / step) * step
    val suggestions = listOf(nearestBelow, nearestBelow + step).filter { it in 1L..maxConvertible }

    GlassCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Convert to diamonds", style = ZipperTheme.type.headingS, color = c.textPrimary, modifier = Modifier.weight(1f))
            Chip("$step : 1", tint = c.tintSuccessSubtle, contentColor = c.currencyBean)
        }
        Row(
            Modifier.fillMaxWidth().height(52.dp).background(c.bgElevated, RoundedCornerShape(Radius.lg)).border(1.dp, c.borderDefault, RoundedCornerShape(Radius.lg)).padding(horizontal = Space.lg),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            CurrencyDisc(Currency.Bean, 16.dp)
            BasicTextField(
                value = inputText,
                // Digits, and only as many as a Long holds. A longer run used to
                // be accepted, parse to null, and read back as 0 — so the button
                // sat dead with the user's own number visible in the field.
                onValueChange = { value ->
                    if (value.all { it.isDigit() } && (value.isEmpty() || value.toLongOrNull() != null)) inputText = value
                },
                modifier = Modifier.weight(1f),
                textStyle = ZipperTheme.type.bodyL.copy(color = c.textPrimary),
                cursorBrush = SolidColor(c.brandPrimary),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                singleLine = true,
                decorationBox = { inner ->
                    Box(contentAlignment = Alignment.CenterStart) {
                        if (inputText.isEmpty()) Text("Beans to convert (multiples of ${indianGrouping(step)})", style = ZipperTheme.type.bodyL, color = c.textMuted)
                        inner()
                    }
                },
            )
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (maxConvertible > 0L) "In multiples of ${indianGrouping(step)} beans"
                else "Not enough to convert yet — ${indianGrouping(step)} beans make 1 diamond",
                style = ZipperTheme.type.caption, color = c.textMuted,
                // Weighted so a long rate never pushes "Convert all" off the card.
                modifier = Modifier.weight(1f, fill = false).padding(end = Space.sm),
            )
            if (maxConvertible > 0L && enteredAmount != maxConvertible) {
                Text(
                    "Convert all ${indianGrouping(maxConvertible)}",
                    style = ZipperTheme.type.labelS, color = c.textBrand,
                    modifier = Modifier.clickableNoRipple { inputText = maxConvertible.toString() },
                )
            }
        }
        when {
            notEnough -> Text(
                // Phrased like the server's own refusal, which names the balance.
                "Insufficient beans — you have ${indianGrouping(currentBeans)}.",
                style = ZipperTheme.type.caption, color = c.statusDanger,
            )
            enteredAmount > 0L && !isMultiple -> Text(
                if (suggestions.isEmpty()) "Convert in multiples of ${indianGrouping(step)} beans."
                else "Convert in multiples of ${indianGrouping(step)} beans — try ${suggestions.joinToString(" or ") { indianGrouping(it) }}.",
                style = ZipperTheme.type.caption, color = c.statusDanger,
            )
            // Only a convertible amount gets a preview. Promising diamonds for an
            // amount the server will refuse is how the old card lied.
            canConvert -> {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
                    Text("You'll receive", style = ZipperTheme.type.bodyS, color = c.textSecondary)
                    CurrencyDisc(Currency.Diamond, 12.dp)
                    Text(indianGrouping(diamondsToReceive), style = ZipperTheme.type.numericM, color = c.currencyDiamond)
                    Text(if (diamondsToReceive == 1L) "diamond" else "diamonds", style = ZipperTheme.type.bodyS, color = c.textSecondary)
                }
                if (beansRemaining > 0L) {
                    Text("${indianGrouping(beansRemaining)} beans stay in your balance", style = ZipperTheme.type.caption, color = c.textMuted)
                }
            }
        }
        ZipperButton(
            "Convert",
            onClick = { if (canConvert) { onConvert(enteredAmount); inputText = "" } },
            enabled = canConvert, gradient = true, fullWidth = true, size = ButtonSize.Medium,
        )
    }
}

@Composable
private fun BeanTransactionRow(tx: BeanTransaction) {
    val c = ZipperTheme.colors
    val moneyIn = tx.isMoneyIn
    val sub = tx.subtitle()

    Row(Modifier.fillMaxWidth().padding(vertical = Space.sm), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
        Box(Modifier.size(36.dp).background(if (moneyIn) c.tintSuccessSubtle else c.tintDangerSubtle, CircleShape), contentAlignment = Alignment.Center) {
            CurrencyDisc(Currency.Bean, 14.dp)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(tx.displayLabel(), style = ZipperTheme.type.bodyM, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (tx.relatedUserName.isNotBlank()) Text(tx.relatedUserName, style = ZipperTheme.type.caption, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (sub != null) Text(sub, style = ZipperTheme.type.caption.copy(fontStyle = FontStyle.Italic), color = c.textMuted)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                Text(timeAgo(tx.timestamp), style = ZipperTheme.type.caption, color = c.textMuted)
                // Named, because "+4,200 beans" on its own reads as a fresh
                // earning when it is last week's earnings being unlocked for
                // withdrawal — the same beans, counted once, not twice.
                if (tx.isRelease) Chip("Released", tint = c.statusSuccess.copy(0.14f), contentColor = c.statusSuccess)
            }
        }
        Text(tx.signPrefix + indianGrouping(tx.amount), style = ZipperTheme.type.numericS, color = if (moneyIn) c.currencyBean else c.statusDanger)
    }
}

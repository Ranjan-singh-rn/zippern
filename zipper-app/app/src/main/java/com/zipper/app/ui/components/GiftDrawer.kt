package com.zipper.app.ui.components

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.zipper.app.data.repository.GiftItem
import com.zipper.app.data.repository.GiftResult
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme

/*
 * Gift drawer — Figma "12 Modals & Sheets / 01 Gift drawer" (153:3) and
 * "02 Gift drawer — insufficient balance" (154:100).
 *
 * One drawer for every place a gift can be sent: the live room, the party
 * room, a video call, a DM. Sheet on bg/elevated, 36×4 grabber, "Sending to"
 * row, category tabs (Semi Bold 12, 3dp brand underline), 4-column grid of
 * 78×94 tiles (r16, glass/low, hairline border; selected = brand tint + brand
 * border), price in diamond aqua Semi Bold 13, quantity chips, then the
 * balance + Send row.
 *
 * The catalogue comes from Firestore `gifts` (CRM-managed) — never hardcoded.
 * Money only moves through `settleGift`; this composable just reports the
 * chosen gift and quantity.
 *
 * ── Lucky gifts (spec §11, APK 20) ───────────────────────────────────────────
 *
 * A lucky gift is sent as a COMBO, never singly: when the selected gift is
 * lucky the quantity chips become the combo picker (`appConfig/luckyGifts
 * .combos`, default 10 / 17 / 25 / 77), the total is `unit × combo`, and the
 * number handed to `onSend` is the combo. The SERVER rolls the reward (5× to
 * 100× one unit) and the screen celebrates what came back; nothing here
 * computes, predicts or simulates it.
 *
 * Lucky gifts are OFF until the Owner turns them on (`appConfig/luckyGifts
 * .enabled`, after legal clearance under the Online Gaming Act 2025). While
 * off — the default, and what an absent or unreadable document means — a
 * lucky gift is shown dimmed and, when picked, says "Lucky gifts are not
 * available right now." with the Send button disabled. The sheet re-reads the
 * switch each time it opens. Normal gifts are untouched.
 */

private val QUANTITIES = listOf(1, 10, 77, 177, 520, 1314)

/** A selectable recipient — during a PK battle the viewer can gift either host. */
data class GiftRecipient(val id: String, val name: String, val photoUrl: String?)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GiftDrawer(
    gifts: List<GiftItem>,
    balanceDiamonds: Long,
    recipientName: String,
    onSend: (gift: GiftItem, quantity: Int) -> Unit,
    onRecharge: () -> Unit,
    onDismiss: () -> Unit,
    recipientPhotoUrl: String? = null,
    sending: Boolean = false,
    /**
     * The catalogue is still being fetched. An empty [gifts] while this is true
     * is "not here yet", not "there are none" — the drawer says so rather than
     * telling somebody the shelves are bare a quarter of a second before they
     * fill up.
     */
    loading: Boolean = false,
    /**
     * Non-null when the fetch failed. This is the state that had nowhere to go
     * before: a failed catalogue looked exactly like an empty one, so the drawer
     * could only shrug, and the caller's only option was to substitute gifts
     * that did not exist. With the reason in hand the drawer can say it and
     * offer [onRetry].
     */
    loadError: String? = null,
    onRetry: () -> Unit = {},
    /** More than one entry turns the "Sending to" row into a picker. */
    recipients: List<GiftRecipient> = emptyList(),
    selectedRecipientId: String = "",
    onSelectRecipient: (GiftRecipient) -> Unit = {},
    /**
     * Several recipients at once, which is what a party room wants.
     *
     * ── WHY THIS IS A MODE AND NOT A REPLACEMENT ─────────────────────────────
     *
     * Single-select is still right almost everywhere this drawer opens: a live
     * room has one host, a DM has one person, and a PK battle has two you choose
     * BETWEEN rather than both. A party has ten or fifteen people on seats and
     * "everyone" is the normal intent, so the party turns this on and nothing
     * else has to change — [selectedRecipientId] and [onSelectRecipient] keep
     * working untouched for every existing caller.
     *
     * The selection is the CALLER's, not the drawer's. The caller is the one that
     * has to survive somebody standing up mid-choice, and it is the one that
     * holds the per-tap idempotency nonce the send is keyed on — so a selection
     * the drawer owned privately would be a second copy that could disagree with
     * the one being charged for.
     */
    multiSelect: Boolean = false,
    selectedRecipientIds: Set<String> = emptySet(),
    onToggleRecipient: (GiftRecipient) -> Unit = {},
    onSelectEveryone: () -> Unit = {},
    /**
     * The combos a lucky gift may be sent as. Null — the normal case — reads
     * `appConfig/luckyGifts` through [LuckyGiftConfigViewModel]; a caller
     * that already has the list may pass it.
     */
    luckyCombos: List<Int>? = null,
    /** The receiver's share of a lucky send, for the explainer line. Null reads the config. */
    luckyReceiverPct: Int? = null,
) {
    val c = ZipperTheme.colors
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    // One shared read of the lucky configuration (see LuckyGiftConfigViewModel),
    // refreshed each time the sheet opens so the Owner's switch is current.
    val luckyConfigVm: LuckyGiftConfigViewModel = androidx.hilt.navigation.compose.hiltViewModel()
    val luckyConfig by luckyConfigVm.config.collectAsState()
    LaunchedEffect(luckyConfigVm) { luckyConfigVm.refresh() }
    val receiverPct = luckyReceiverPct ?: luckyConfig.receiverPct

    var selected by remember { mutableStateOf<GiftItem?>(null) }
    var quantity by remember { mutableIntStateOf(1) }
    val luckySelected = selected?.isLucky == true
    // The Owner's switch. Off — the default — leaves a lucky gift visible but
    // not sendable; the server refuses it anyway (LUCKY_GIFTS_DISABLED).
    val luckyEnabled = luckyConfig.enabled
    val luckyUnavailable = selected?.let { !com.zipper.app.util.LuckyCombos.sendable(it.isLucky, luckyEnabled) } ?: false
    val combos = remember(luckyCombos, luckyConfig) {
        val list = luckyCombos ?: luckyConfig.combos
        if (list.isEmpty()) com.zipper.app.util.LuckyCombos.DEFAULT else list
    }
    /*
     * Pick a gift: a lucky one starts on the smallest combo (the cheapest tap),
     * a normal one keeps the chip that was chosen — unless it was a combo that
     * is not a quantity chip, in which case it falls back to one.
     */
    val pick: (GiftItem) -> Unit = { g ->
        selected = g
        quantity = when {
            g.isLucky -> if (quantity in combos) quantity else com.zipper.app.util.LuckyCombos.defaultChoice(combos)
            quantity in QUANTITIES -> quantity
            else -> 1
        }
    }
    // The configured list can arrive after a lucky gift was picked on the
    // defaults; a combo the server would refuse must not stay selected.
    LaunchedEffect(combos, luckySelected) {
        if (luckySelected && quantity !in combos) quantity = com.zipper.app.util.LuckyCombos.defaultChoice(combos)
    }

    // Tabs are derived from the catalogue so a new CRM category shows up
    // without an app release. "Hot" is everything.
    val categories = remember(gifts) {
        listOf("hot") + gifts.map { it.category }.distinct().filter { it != "normal" }
    }
    var tab by remember { mutableStateOf("hot") }
    val visible = remember(gifts, tab) {
        if (tab == "hot") gifts else gifts.filter { it.category == tab }
    }

    /*
     * How many people are being paid for.
     *
     * Load-bearing for the number in the footer. A gift to four people costs four
     * times the gift, because `sendGift` settles one transaction per recipient —
     * so a total that ignored the recipient count would quote a quarter of what
     * the wallet is about to lose, and the "insufficient balance" strip would say
     * the balance was fine right up until three of the four sends failed.
     */
    val payees = if (multiSelect) selectedRecipientIds.size.coerceAtLeast(1) else 1
    // Nothing is quoted for a gift that cannot be sent.
    val total = if (luckyUnavailable) 0L else (selected?.costDiamonds ?: 0L) * quantity * payees
    val insufficient = selected != null && !luckyUnavailable && total > balanceDiamonds
    val nothingPicked = multiSelect && selectedRecipientIds.isEmpty()

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheet,
        containerColor = c.bgElevated,
        dragHandle = null,
        shape = RoundedCornerShape(topStart = Radius.xl, topEnd = Radius.xl),
    ) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
            // Grabber
            Box(
                Modifier.padding(top = 6.dp).size(36.dp, 4.dp)
                    .background(c.borderDefault, CircleShape)
                    .align(Alignment.CenterHorizontally)
            )

            // Recipient row
            if (multiSelect && recipients.isNotEmpty()) {
                val everyone = selectedRecipientIds.size == recipients.size
                Row(
                    Modifier.fillMaxWidth().padding(start = Space.md, end = Space.md, top = Space.md),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        when {
                            everyone -> "Sending to everyone on a seat"
                            selectedRecipientIds.isEmpty() -> "Pick who this is for"
                            selectedRecipientIds.size == 1 -> "Sending to 1 person"
                            else -> "Sending to ${selectedRecipientIds.size} people"
                        },
                        style = ZipperTheme.type.labelS,
                        color = if (selectedRecipientIds.isEmpty()) c.statusWarning else c.textPrimary,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    if (!everyone) {
                        Text(
                            "Everyone", style = ZipperTheme.type.labelS, color = c.textBrand,
                            modifier = Modifier.clickableNoRipple(onSelectEveryone).padding(end = Space.sm),
                        )
                    }
                    CurrencyPill(Currency.Diamond, balanceDiamonds, onClick = onRecharge)
                }
                // A scrolling row of chips rather than a dropdown: with ten or
                // fifteen seat holders a menu is a list nobody reads, and the whole
                // point of the default is that it is already right — the chips are
                // there to take somebody OUT of it.
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())
                        .padding(horizontal = Space.md, vertical = Space.sm),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    recipients.forEach { r ->
                        RecipientChip(r, r.id in selectedRecipientIds) { onToggleRecipient(r) }
                    }
                }
            } else {
                // Scoped to this branch, because only this branch has a dropdown to
                // open: multi-select lays every recipient out as a chip and never
                // shows a menu. Declared above the `if`, it was a piece of state that
                // one of the two modes could not reach and could not clear — which
                // reads as an oversight in that mode rather than as a deliberate
                // single-select control.
                var pickerOpen by remember { mutableStateOf(false) }
                val current = recipients.firstOrNull { it.id == selectedRecipientId }
                val shownName = current?.name ?: recipientName
                val shownPhoto = current?.photoUrl ?: recipientPhotoUrl
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = Space.md, vertical = Space.md),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Row(
                        Modifier.weight(1f).then(if (recipients.size > 1) Modifier.clickableNoRipple { pickerOpen = true } else Modifier),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Avatar(shownPhoto, size = AvatarSize.XS, initial = shownName)
                        Spacer(Modifier.width(6.dp))
                        Text(
                            "Sending to $shownName",
                            style = ZipperTheme.type.labelS, color = c.textPrimary,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                        if (recipients.size > 1) {
                            Spacer(Modifier.width(4.dp))
                            Icon(
                                Icons.Default.KeyboardArrowDown, null,
                                tint = c.textSecondary, modifier = Modifier.size(14.dp),
                            )
                            androidx.compose.material3.DropdownMenu(
                                expanded = pickerOpen, onDismissRequest = { pickerOpen = false },
                                containerColor = c.bgElevated,
                            ) {
                                recipients.forEach { r ->
                                    androidx.compose.material3.DropdownMenuItem(
                                        text = { Text(r.name, style = ZipperTheme.type.bodyM, color = c.textPrimary) },
                                        leadingIcon = { Avatar(r.photoUrl, size = AvatarSize.XS, initial = r.name) },
                                        onClick = { pickerOpen = false; onSelectRecipient(r) },
                                    )
                                }
                            }
                        }
                    }
                    CurrencyPill(Currency.Diamond, balanceDiamonds, onClick = onRecharge)
                }
            }

            // Tabs
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(start = Space.md),
                horizontalArrangement = Arrangement.spacedBy(Space.xl),
            ) {
                categories.forEach { cat ->
                    val active = cat == tab
                    Column(
                        Modifier.clickableNoRipple { tab = cat }.padding(top = 6.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text(
                            cat.replaceFirstChar { it.uppercase() },
                            style = ZipperTheme.type.labelS,
                            color = if (active) c.textPrimary else c.textSecondary,
                        )
                        Spacer(Modifier.height(6.dp))
                        Box(
                            Modifier.height(3.dp).fillMaxWidth(0.8f)
                                .background(if (active) c.brandPrimary else Color.Transparent, CircleShape)
                        )
                    }
                }
            }
            HairlineDivider()

            // Grid
            //
            // Three ways to have nothing to show, three different things to say.
            // "No gifts available right now" used to answer all of them,
            // including the failed fetch — the one case where the person looking
            // at it could actually fix the problem by trying again.
            //
            // Gifts in hand always win: a catalogue that arrived is worth more
            // than either a spinner or a stale complaint about the fetch.
            if (gifts.isEmpty()) {
                Column(
                    Modifier.fillMaxWidth().height(200.dp).padding(horizontal = Space.xl),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    when {
                        loading -> CircularProgressIndicator(
                            modifier = Modifier.size(28.dp),
                            color = c.brandPrimary, strokeWidth = 3.dp,
                        )
                        loadError != null -> {
                            Text(loadError, style = ZipperTheme.type.bodyM, color = c.textSecondary, textAlign = TextAlign.Center)
                            Spacer(Modifier.height(Space.md))
                            ZipperButton("Try again", onRetry, style = ButtonStyle.Secondary, size = ButtonSize.Small)
                        }
                        else -> Text("No gifts available right now", style = ZipperTheme.type.bodyM, color = c.textSecondary)
                    }
                }
            } else {
                LazyVerticalGrid(
                    columns = GridCells.Fixed(4),
                    modifier = Modifier.fillMaxWidth().heightIn(max = 300.dp),
                    contentPadding = PaddingValues(horizontal = Space.md, vertical = Space.sm),
                    horizontalArrangement = Arrangement.spacedBy(Space.sm),
                    verticalArrangement = Arrangement.spacedBy(Space.sm),
                ) {
                    items(visible, key = { it.id }) { gift ->
                        GiftTile(
                            gift, selected?.id == gift.id,
                            unavailable = !com.zipper.app.util.LuckyCombos.sendable(gift.isLucky, luckyEnabled),
                        ) { pick(gift) }
                    }
                }
            }

            // Quantity row — or, for a lucky gift, the COMBO picker. While the
            // Owner's switch is off a lucky gift gets neither: one line saying
            // it is not available, and the Send button below stays disabled.
            if (luckyUnavailable) {
                Text(
                    com.zipper.app.util.LuckyCombos.UNAVAILABLE_MESSAGE,
                    style = ZipperTheme.type.bodyS, color = c.statusWarning,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = Space.md, vertical = Space.md),
                )
            } else {
                if (luckySelected) {
                    Row(
                        Modifier.fillMaxWidth().padding(start = Space.md, end = Space.md, top = Space.sm),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("Combo", style = ZipperTheme.type.labelS, color = c.brandVip)
                        Spacer(Modifier.width(Space.sm))
                        Text(
                            "Lucky gifts are sent as a combo",
                            style = ZipperTheme.type.caption, color = c.textSecondary,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())
                        .padding(horizontal = Space.md, vertical = Space.sm),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    (if (luckySelected) combos else QUANTITIES).forEach { q ->
                        val active = q == quantity
                        Box(
                            Modifier
                                .height(34.dp)
                                .background(
                                    if (active) (if (luckySelected) c.tintGoldSubtle else c.tintBrandMedium) else c.glassMid,
                                    CircleShape,
                                )
                                .border(1.dp, if (active) (if (luckySelected) c.brandVip else c.brandPrimary) else c.borderSubtle, CircleShape)
                                .clickableNoRipple { quantity = q }
                                .padding(horizontal = 14.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                if (luckySelected) "×$q" else q.toString(), style = ZipperTheme.type.labelS,
                                color = if (active) c.textPrimary else c.textSecondary,
                            )
                        }
                    }
                }
                if (luckySelected) {
                    val unit = selected?.costDiamonds ?: 0L
                    Text(
                        com.zipper.app.util.LuckyCombos.explainer(unit, quantity, receiverPct),
                        style = ZipperTheme.type.caption, color = c.textMuted,
                        modifier = Modifier.padding(horizontal = Space.md),
                    )
                    Spacer(Modifier.height(Space.xs))
                }
            }

            // Insufficient-balance strip (Figma 154:100)
            if (insufficient) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = Space.md)
                        .background(c.tintDangerSubtle, RoundedCornerShape(Radius.md))
                        .padding(horizontal = Space.md, vertical = Space.sm),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "You need ${indianGrouping(total - balanceDiamonds)} more diamonds",
                        style = ZipperTheme.type.bodyS, color = c.textPrimary,
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        "Recharge", style = ZipperTheme.type.labelM, color = c.textBrand,
                        modifier = Modifier.clickableNoRipple(onRecharge),
                    )
                }
                Spacer(Modifier.height(Space.sm))
            }

            // Footer: total + send
            Row(
                Modifier.fillMaxWidth().padding(horizontal = Space.md, vertical = Space.md),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        // Says out loud that the total is multiplied by the number
                        // of people, so the figure cannot look like a mistake.
                        if (multiSelect && payees > 1) "Total · $payees people" else "Total",
                        style = ZipperTheme.type.caption, color = c.textSecondary,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        CurrencyDisc(Currency.Diamond, 14.dp)
                        Text(indianGrouping(total), style = ZipperTheme.type.numericM, color = c.textPrimary)
                    }
                }
                ZipperButton(
                    text = when {
                        luckyUnavailable -> "Unavailable"
                        insufficient -> "Recharge"
                        luckySelected -> "Send combo ×$quantity"
                        multiSelect && payees > 1 -> "Send ×$payees"
                        else -> "Send"
                    },
                    onClick = {
                        val g = selected ?: return@ZipperButton
                        // The button is disabled for it too: a lucky gift is never sent while the switch is off.
                        if (!com.zipper.app.util.LuckyCombos.sendable(g.isLucky, luckyEnabled)) return@ZipperButton
                        if (insufficient) onRecharge() else onSend(g, quantity)
                    },
                    size = ButtonSize.Medium,
                    gradient = true,
                    enabled = selected != null && !nothingPicked && !luckyUnavailable,
                    loading = sending,
                )
            }
        }
    }
}

/**
 * One recipient, in or out.
 *
 * Selected is the resting state in a party room, because the default is everyone
 * on a seat — so the OUT state is the one that has to be unmistakable, and it
 * loses the tick, the brand border and the tinted fill all at once.
 */
@Composable
private fun RecipientChip(recipient: GiftRecipient, selected: Boolean, onClick: () -> Unit) {
    val c = ZipperTheme.colors
    Row(
        Modifier
            .height(34.dp)
            .background(if (selected) c.tintBrandMedium else c.glassLow, CircleShape)
            .border(1.dp, if (selected) c.brandPrimary else c.borderSubtle, CircleShape)
            .clickableNoRipple(onClick)
            .padding(start = 3.dp, end = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Avatar(recipient.photoUrl, size = AvatarSize.XS, initial = recipient.name)
        Text(
            recipient.name.ifBlank { "Guest" },
            style = ZipperTheme.type.labelS,
            color = if (selected) c.textPrimary else c.textSecondary,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.widthIn(max = 84.dp),
        )
        if (selected) {
            Icon(Icons.Default.Check, null, tint = c.brandPrimary, modifier = Modifier.size(12.dp))
        }
    }
}

/** [unavailable]: a lucky gift while the Owner's switch is off — shown dimmed; picking it explains why it cannot be sent. */
@Composable
private fun GiftTile(gift: GiftItem, selected: Boolean, unavailable: Boolean = false, onClick: () -> Unit) {
    val c = ZipperTheme.colors
    Column(
        Modifier
            .height(94.dp)
            .alpha(if (unavailable) 0.45f else 1f)
            .clip(RoundedCornerShape(Radius.lg))
            .background(if (selected) c.tintBrandMedium else c.glassLow)
            .border(1.dp, if (selected) c.brandPrimary else c.borderSubtle, RoundedCornerShape(Radius.lg))
            .clickableNoRipple(onClick)
            .padding(top = 10.dp, bottom = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Box(Modifier.size(34.dp), contentAlignment = Alignment.Center) {
            if (gift.imageUrl.isNotBlank()) {
                AsyncImage(gift.imageUrl, null, contentScale = ContentScale.Fit, modifier = Modifier.size(34.dp))
            } else {
                Text(gift.emoji, fontSize = 26.sp)
            }
            if (gift.isLucky) {
                Box(
                    Modifier.align(Alignment.TopEnd).offset(x = 10.dp, y = (-8).dp)
                        .background(c.brandVip, CircleShape).padding(horizontal = 5.dp, vertical = 1.dp)
                ) {
                    Text("LUCKY", style = ZipperTheme.type.overline.copy(fontSize = 8.sp), color = c.bgBase)
                }
            }
        }
        Text(gift.name, style = ZipperTheme.type.caption, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
            CurrencyDisc(Currency.Diamond, 12.dp)
            Text(
                indianGrouping(gift.costDiamonds),
                style = ZipperTheme.type.numericS,
                color = if (selected) c.textPrimary else c.currencyDiamond,
            )
        }
    }
}

/**
 * The "Arjun sent Dragon ×3" pill that floats over video when a gift lands
 * (Figma "Gift event" — 40h, scrim/strong, gold hairline, gold quantity chip).
 */
@Composable
fun GiftEventPill(senderName: String, giftName: String, quantity: Int, photoUrl: String?, modifier: Modifier = Modifier) {
    val c = ZipperTheme.colors
    Row(
        modifier
            .height(40.dp)
            .background(c.scrimStrong, CircleShape)
            .border(1.dp, c.tintGoldSubtle, CircleShape)
            .padding(start = 2.dp, end = 12.dp, top = 2.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Avatar(photoUrl, size = AvatarSize.SM, ring = AvatarRing.Vip, initial = senderName)
        Column {
            Text(senderName, style = ZipperTheme.type.labelS, color = c.textPrimary, maxLines = 1)
            Text("sent $giftName", style = ZipperTheme.type.caption, color = c.textSecondary, maxLines = 1)
        }
        if (quantity > 1) {
            Box(
                Modifier
                    .background(Brush.horizontalGradient(listOf(Color(0xFFFFE08A), Color(0xFFFFB627), Color(0xFFE89806))), CircleShape)
                    .padding(horizontal = 8.dp, vertical = 2.dp)
            ) {
                Text("x$quantity", style = ZipperTheme.type.overline, color = Color(0xFF0E0F21))
            }
        }
    }
}

/**
 * The lucky reward, as the SERVER rolled it (spec §11): "×25 — you won 2,500
 * diamonds back". A small celebration that floats over the screen for a few
 * seconds; the caller clears it. Nothing here decides the number — it draws
 * `GiftResult.LuckyWin`, which is the settlement's own answer.
 */
@Composable
fun LuckyWinBanner(win: GiftResult.LuckyWin, modifier: Modifier = Modifier) {
    val big = win.multiplier >= 25
    val pulse = rememberInfiniteTransition(label = "lucky")
    val scale by pulse.animateFloat(
        initialValue = 1f, targetValue = if (big) 1.08f else 1.03f,
        animationSpec = infiniteRepeatable(tween(600), RepeatMode.Reverse),
        label = "scale",
    )
    Column(
        modifier
            .scale(scale)
            .background(
                Brush.linearGradient(listOf(Color(0xFFFFE08A), Color(0xFFFFB627), Color(0xFFE89806))),
                RoundedCornerShape(Radius.xl),
            )
            .border(1.dp, Color.White.copy(alpha = 0.6f), RoundedCornerShape(Radius.xl))
            .padding(horizontal = Space.xl, vertical = Space.lg),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(if (big) "BIG LUCKY WIN" else "LUCKY WIN", style = ZipperTheme.type.overline, color = Color(0xFF0E0F21))
        Text("×${win.multiplier}", style = ZipperTheme.type.displayM, color = Color(0xFF0E0F21))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            CurrencyDisc(Currency.Diamond, 16.dp)
            Text("+${indianGrouping(win.diamondsBack)} diamonds back", style = ZipperTheme.type.labelM, color = Color(0xFF0E0F21))
        }
        if (win.combo > 0 && win.unit > 0L) {
            Text(
                "Combo ×${win.combo} · ${indianGrouping(win.unit)} each · paid ${indianGrouping(win.charged)}",
                style = ZipperTheme.type.caption, color = Color(0xFF0E0F21).copy(alpha = 0.75f),
            )
        }
    }
}

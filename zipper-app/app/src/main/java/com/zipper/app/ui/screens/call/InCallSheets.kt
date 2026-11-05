package com.zipper.app.ui.screens.call

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.VolumeOff
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.Flag
import androidx.compose.material.icons.filled.FlipCameraAndroid
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.PictureInPicture
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.VideocamOff
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.zipper.app.ui.components.Avatar
import com.zipper.app.ui.components.AvatarRing
import com.zipper.app.ui.components.AvatarSize
import com.zipper.app.ui.components.ButtonSize
import com.zipper.app.ui.components.ButtonStyle
import com.zipper.app.ui.components.Currency
import com.zipper.app.ui.components.CurrencyPill
import com.zipper.app.ui.components.HairlineDivider
import com.zipper.app.ui.components.LoadingState
import com.zipper.app.ui.components.ZipperButton
import com.zipper.app.ui.components.clickableNoRipple
import com.zipper.app.ui.components.indianGrouping
import com.zipper.app.ui.screens.diamond.DiamondShopViewModel
import com.zipper.app.ui.screens.diamond.RechargePackage
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import com.zipper.app.util.CallControls

/*
 * WP2 (Owner, 5 Nov 2026) — the call screen's two sheets.
 *
 *   * The menu, the same on both sides: flip the camera, the microphone, the speaker, the camera, minimise, report,
 *     block. Each row does one thing and closes the sheet.
 *   * Buy diamonds, for the paying side, without leaving the call: Zipper's packs (`rechargePackages`, the CRM's) and
 *     the verified resellers, exactly as the Diamond Shop offers them. Payment is off the platform, so choosing a
 *     reseller sends them the request as a chat message from here; the reseller adds the diamonds and the call screen's
 *     balance — live — shows them. "Open chat" is there for reading the reseller's payment details; the call keeps
 *     running underneath and the screen picks it up again on the way back.
 */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun InCallMenuSheet(
    otherName: String,
    isMicOn: Boolean,
    isSpeakerOn: Boolean,
    isCameraOn: Boolean,
    onFlip: () -> Unit,
    onMic: () -> Unit,
    onSpeaker: () -> Unit,
    onCamera: () -> Unit,
    onMinimise: () -> Unit,
    onReport: () -> Unit,
    onBlock: () -> Unit,
    onDismiss: () -> Unit,
) {
    val c = ZipperTheme.colors
    val who = otherName.ifBlank { "them" }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = c.bgElevated,
        shape = RoundedCornerShape(topStart = Radius.xl, topEnd = Radius.xl),
    ) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = Space.lg)) {
            CallControls.MENU.forEach { item ->
                when (item) {
                    CallControls.MenuItem.FLIP_CAMERA ->
                        MenuRow(Icons.Default.FlipCameraAndroid, "Flip camera") { onDismiss(); onFlip() }
                    CallControls.MenuItem.MICROPHONE ->
                        MenuRow(
                            if (isMicOn) Icons.Default.MicOff else Icons.Default.Mic,
                            if (isMicOn) "Mute my microphone" else "Unmute my microphone",
                        ) { onDismiss(); onMic() }
                    CallControls.MenuItem.SPEAKER ->
                        MenuRow(
                            if (isSpeakerOn) Icons.AutoMirrored.Filled.VolumeOff else Icons.AutoMirrored.Filled.VolumeUp,
                            if (isSpeakerOn) "Speaker off (earpiece)" else "Speaker on",
                        ) { onDismiss(); onSpeaker() }
                    CallControls.MenuItem.CAMERA ->
                        MenuRow(
                            if (isCameraOn) Icons.Default.VideocamOff else Icons.Default.Videocam,
                            if (isCameraOn) "Turn my camera off" else "Turn my camera on",
                        ) { onDismiss(); onCamera() }
                    CallControls.MenuItem.MINIMISE ->
                        MenuRow(Icons.Default.PictureInPicture, "Minimise") { onDismiss(); onMinimise() }
                    CallControls.MenuItem.REPORT ->
                        MenuRow(Icons.Default.Flag, "Report $who", c.statusDanger) { onDismiss(); onReport() }
                    CallControls.MenuItem.BLOCK ->
                        MenuRow(Icons.Default.Block, "Block $who and hang up", c.statusDanger) { onDismiss(); onBlock() }
                }
            }
        }
    }
}

@Composable
private fun MenuRow(icon: ImageVector, label: String, tint: Color = ZipperTheme.colors.textPrimary, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickableNoRipple(onClick).padding(horizontal = Space.xl, vertical = Space.md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(22.dp))
        Text(label, style = ZipperTheme.type.bodyM, color = tint)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun InCallDiamondSheet(
    balance: Long,
    sending: Boolean,
    notice: String?,
    noticeSellerUid: String?,
    onRequest: (sellerUid: String, sellerName: String, sellerPhotoUrl: String, message: String) -> Unit,
    onOpenChat: (sellerUid: String) -> Unit,
    onDismiss: () -> Unit,
    shop: DiamondShopViewModel = hiltViewModel(),
) {
    val c = ZipperTheme.colors
    val ctx = LocalContext.current
    val state by shop.state.collectAsStateWithLifecycle()
    var pack by remember { mutableStateOf<RechargePackage?>(null) }
    LaunchedEffect(Unit) { shop.load(ctx) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = c.bgElevated,
        shape = RoundedCornerShape(topStart = Radius.xl, topEnd = Radius.xl),
    ) {
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = Space.lg).padding(bottom = Space.lg),
            verticalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Buy diamonds", style = ZipperTheme.type.headingS, color = c.textPrimary)
                    Text("Your call keeps running while you buy.", style = ZipperTheme.type.caption, color = c.textSecondary)
                }
                CurrencyPill(Currency.Diamond, balance)
            }
            HairlineDivider()
            when {
                notice != null -> {
                    Text(notice, style = ZipperTheme.type.bodyM, color = c.textPrimary)
                    Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                        if (noticeSellerUid != null) {
                            ZipperButton(
                                "Open chat", { onOpenChat(noticeSellerUid) },
                                size = ButtonSize.Medium, style = ButtonStyle.Secondary,
                            )
                        }
                        ZipperButton("Back to the call", onDismiss, size = ButtonSize.Medium)
                    }
                }
                state.isLoadingPackages -> Box(Modifier.fillMaxWidth().height(160.dp)) { LoadingState() }
                pack == null -> {
                    if (state.packages.isEmpty()) {
                        Text(
                            "Packs are being set up. You can still message a verified reseller from the Diamond Shop after the call.",
                            style = ZipperTheme.type.bodyS, color = c.textSecondary,
                        )
                    } else {
                        LazyColumn(Modifier.heightIn(max = 360.dp), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                            items(state.packages, key = { it.id }) { p ->
                                PackRow(p, state.localPrices[p.id]) { pack = p; shop.loadSellers() }
                            }
                        }
                    }
                }
                else -> {
                    val chosen = pack ?: return@Column
                    val price = state.localPrices[chosen.id] ?: "₹${indianGrouping(chosen.priceInr.toLong())}"
                    Text(
                        "${indianGrouping(chosen.totalDiamonds)} diamonds for $price — choose a reseller. They confirm your " +
                            "payment and add the diamonds. Never share OTPs or passwords.",
                        style = ZipperTheme.type.bodyS, color = c.textSecondary,
                    )
                    when {
                        state.isLoadingSellers -> Box(Modifier.fillMaxWidth().height(120.dp)) { LoadingState() }
                        state.sellers.isEmpty() -> Text(
                            "No resellers are online right now. Try again shortly.",
                            style = ZipperTheme.type.bodyM, color = c.textSecondary,
                        )
                        else -> LazyColumn(Modifier.heightIn(max = 320.dp)) {
                            items(state.sellers, key = { it.uid }) { s ->
                                Row(
                                    Modifier.fillMaxWidth()
                                        .clickableNoRipple {
                                            if (!sending) {
                                                val msg = "Hi! I want to recharge ${indianGrouping(chosen.totalDiamonds)} diamonds " +
                                                    "($price pack). Please confirm."
                                                onRequest(s.uid, s.name, s.photoUrl, msg)
                                            }
                                        }
                                        .padding(vertical = Space.sm),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(Space.md),
                                ) {
                                    Avatar(s.photoUrl, size = AvatarSize.MD, initial = s.name, ring = if (s.isOnline) AvatarRing.Online else AvatarRing.None)
                                    Column(Modifier.weight(1f)) {
                                        Text(s.name, style = ZipperTheme.type.labelM, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                        Text(
                                            if (s.isOnline) "Online now" else "Away — may reply later",
                                            style = ZipperTheme.type.caption,
                                            color = if (s.isOnline) c.statusOnline else c.textMuted,
                                        )
                                    }
                                    Box(
                                        Modifier.size(40.dp).background(c.glassMid, CircleShape).border(1.dp, c.borderDefault, CircleShape),
                                        contentAlignment = Alignment.Center,
                                    ) { Icon(Icons.Outlined.ChatBubbleOutline, "Send the request", tint = c.textPrimary, modifier = Modifier.size(18.dp)) }
                                }
                            }
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                        ZipperButton("Other packs", { pack = null }, size = ButtonSize.Small, style = ButtonStyle.Ghost, enabled = !sending)
                        if (sending) Text("Sending…", style = ZipperTheme.type.caption, color = c.textSecondary)
                    }
                }
            }
            Spacer(Modifier.height(Space.xs))
        }
    }
}

@Composable
private fun PackRow(p: RechargePackage, localPrice: String?, onClick: () -> Unit) {
    val c = ZipperTheme.colors
    Row(
        Modifier.fillMaxWidth()
            .background(c.glassLow, RoundedCornerShape(Radius.lg))
            .border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.lg))
            .clickableNoRipple(onClick)
            .padding(horizontal = Space.md, vertical = Space.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Column(Modifier.weight(1f)) {
            Text("${indianGrouping(p.totalDiamonds)} diamonds", style = ZipperTheme.type.labelL, color = c.currencyDiamond)
            if (p.bonusDiamonds > 0) {
                Text(
                    "${indianGrouping(p.baseDiamonds)} + ${indianGrouping(p.bonusDiamonds)} bonus",
                    style = ZipperTheme.type.caption, color = c.textSecondary,
                )
            }
        }
        Text(
            localPrice ?: "₹${indianGrouping(p.priceInr.toLong())}",
            style = ZipperTheme.type.labelM, color = c.textPrimary,
        )
    }
}

package com.zipper.app.ui.screens.diamond

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Storefront
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.app.data.repository.DiscoverRepository
import com.zipper.app.ui.components.*
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import com.zipper.app.util.CurrencyConverter
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import javax.inject.Inject

/*
 * Diamond shop — Figma "05 Economy / 01 Diamond shop" (77:21).
 *
 *   App bar: back, "Diamond Shop", balance pill.
 *   "Pack prices load from Zipper server" line.
 *   2-column pack grid: 158×144 glass cards — badge slot, amount (aqua Semi
 *   Bold 16), "base + bonus", gradient ₹ CTA (44h), "≈ $" line.
 *   "How pricing works" footer.
 *
 * Packs come from `rechargePackages` (CRM). The old screen carried a
 * hardcoded list "to be replaced by Firestore" that never was, so a price
 * change in the CRM did not reach the app. Payment is off-platform: the
 * buyer messages a verified reseller, who confirms and the CRM credits.
 */

data class RechargePackage(
    val id: String,
    val label: String,
    val priceInr: Int,
    val priceUsd: Int,
    val baseDiamonds: Long,
    val bonusDiamonds: Long,
    val badge: String,
) { val totalDiamonds get() = baseDiamonds + bonusDiamonds }

internal data class SellerUser(val uid: String, val name: String, val photoUrl: String, val isOnline: Boolean)

internal data class DiamondShopUiState(
    val packages: List<RechargePackage> = emptyList(),
    val isLoadingPackages:  Boolean = true,
    val sellers: List<SellerUser> = emptyList(),
    val isLoadingSellers: Boolean = false,
    val localPrices: Map<String, String?> = emptyMap(),
)

@HiltViewModel
class DiamondShopViewModel @Inject constructor(
    private val firestore: FirebaseFirestore,
    private val discover: DiscoverRepository,
) : ViewModel() {
    private val _state = MutableStateFlow(DiamondShopUiState())
    internal val state: StateFlow<DiamondShopUiState> = _state.asStateFlow()

    fun load(ctx: android.content.Context) {
        viewModelScope.launch {
            val packs = try {
                firestore.collection("rechargePackages").get().await().documents.mapNotNull { d ->
                    if (d.getBoolean("isActive") == false) return@mapNotNull null
                    RechargePackage(
                        id = d.id,
                        label = d.getString("label") ?: "",
                        priceInr = (d.getLong("priceInr") ?: return@mapNotNull null).toInt(),
                        priceUsd = (d.getLong("priceUsd") ?: 0L).toInt(),
                        baseDiamonds = d.getLong("baseDiamonds") ?: 0L,
                        bonusDiamonds = d.getLong("bonusDiamonds") ?: 0L,
                        badge = d.getString("badge") ?: "",
                    ) to (d.getLong("sortOrder") ?: 0L)
                }.sortedBy { it.second }.map { it.first }
            } catch (_: Exception) { emptyList() }
            _state.update { it.copy(packages = packs, isLoadingPackages = false) }

            CurrencyConverter.prefetch(ctx)
            val prices = packs.associate { p -> p.id to CurrencyConverter.localEquivalent(ctx, p.priceUsd) }
            _state.update { it.copy(localPrices = prices) }
        }
    }

    fun loadSellers() {
        if (_state.value.sellers.isNotEmpty()) return
        _state.update { it.copy(isLoadingSellers = true) }
        viewModelScope.launch {
            try {
                val sellers = discover.sellers().map { SellerUser(it.uid, it.name, it.photoUrl, it.isOnline) }
                _state.update { it.copy(sellers = sellers, isLoadingSellers = false) }
            } catch (_: Exception) { _state.update { it.copy(isLoadingSellers = false) } }
        }
    }
}

// ── Screen ───────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DiamondShopScreen(
    currentDiamonds: Long = 0L,
    onBack: () -> Unit,
    onNavigateToChat: (sellerUid: String, prefilledMsg: String) -> Unit,
    onViewResellers: () -> Unit = {},
    viewModel: DiamondShopViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    val ctx = androidx.compose.ui.platform.LocalContext.current
    var selected by remember { mutableStateOf<RechargePackage?>(null) }

    LaunchedEffect(Unit) { viewModel.load(ctx) }

    ZipperScreen(
        topBar = {
            TopBar("Diamond Shop", onBack = onBack, centered = false) {
                CurrencyPill(Currency.Diamond, currentDiamonds)
            }
        },
    ) { _ ->
        when {
            state.isLoadingPackages -> LoadingState()
            // O5b: no packs published is not "you cannot recharge" — a verified reseller can still take payment and
            // add diamonds. The way to them is offered rather than a dead end.
            state.packages.isEmpty() -> EmptyState(
                Icons.Outlined.Storefront, "Packs are being set up",
                "You can still recharge: message a verified reseller, pay them directly, and they add the diamonds to your account.",
                actionLabel = "Buy from a reseller", onAction = onViewResellers,
            )
            else -> LazyColumn(contentPadding = PaddingValues(horizontal = Space.lg, vertical = Space.sm), verticalArrangement = Arrangement.spacedBy(Space.md)) {
                item {
                    Text("Pack prices load from Zipper server", style = ZipperTheme.type.caption, color = c.textMuted)
                }
                items(state.packages.chunked(2)) { row ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.md)) {
                        row.forEach { p ->
                            PackCard(p, state.localPrices[p.id], Modifier.weight(1f)) { selected = p; viewModel.loadSellers() }
                        }
                        if (row.size == 1) Spacer(Modifier.weight(1f))
                    }
                }
                item {
                    Row(
                        Modifier.fillMaxWidth().padding(top = Space.sm).background(Brush.verticalGradient(listOf(Color(0x12FFFFFF), Color(0x05FFFFFF))), RoundedCornerShape(Radius.lg))
                            .border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.lg)).padding(Space.md),
                        horizontalArrangement = Arrangement.spacedBy(Space.sm),
                    ) {
                        Icon(Icons.Outlined.Info, null, tint = c.currencyDiamond, modifier = Modifier.size(18.dp))
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text("Zipper sets the pack price", style = ZipperTheme.type.labelM, color = c.textPrimary)
                            Text(
                                "You pay a verified reseller directly and they may add their own margin. Diamonds arrive once they confirm your payment.",
                                style = ZipperTheme.type.bodyS, color = c.textSecondary,
                            )
                            Text("See all resellers", style = ZipperTheme.type.labelS, color = c.textBrand, modifier = Modifier.padding(top = 4.dp).clickableNoRipple(onViewResellers))
                        }
                    }
                }
                item { Spacer(Modifier.navigationBarsPadding()) }
            }
        }
    }

    selected?.let { pkg ->
        ModalBottomSheet(
            onDismissRequest = { selected = null },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = c.bgElevated, dragHandle = null,
            shape = RoundedCornerShape(topStart = Radius.xl, topEnd = Radius.xl),
        ) {
            Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = Space.lg)) {
                Box(Modifier.padding(top = 6.dp).size(36.dp, 4.dp).background(c.borderDefault, CircleShape).align(Alignment.CenterHorizontally))
                Column(Modifier.padding(Space.lg), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Choose a reseller", style = ZipperTheme.type.headingS, color = c.textPrimary)
                    Text(
                        "${indianGrouping(pkg.totalDiamonds)} diamonds for ₹${indianGrouping(pkg.priceInr.toLong())} — message a reseller to pay. Never share OTPs or passwords.",
                        style = ZipperTheme.type.bodyS, color = c.textSecondary,
                    )
                }
                HairlineDivider()
                when {
                    state.isLoadingSellers -> Box(Modifier.fillMaxWidth().height(120.dp)) { LoadingState() }
                    state.sellers.isEmpty() -> Text("No resellers are online right now. Try again shortly.", style = ZipperTheme.type.bodyM, color = c.textSecondary, modifier = Modifier.padding(Space.lg))
                    else -> LazyColumn(Modifier.heightIn(max = 380.dp)) {
                        items(state.sellers, key = { it.uid }) { s ->
                            Row(
                                Modifier.fillMaxWidth().clickableNoRipple {
                                    val price = state.localPrices[pkg.id] ?: "₹${indianGrouping(pkg.priceInr.toLong())}"
                                    val msg = "Hi! I want to recharge ${indianGrouping(pkg.totalDiamonds)} diamonds ($price pack). Please confirm."
                                    selected = null
                                    onNavigateToChat(s.uid, msg)
                                }.padding(horizontal = Space.lg, vertical = Space.sm),
                                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md),
                            ) {
                                Avatar(s.photoUrl, size = AvatarSize.MD, initial = s.name, ring = if (s.isOnline) AvatarRing.Online else AvatarRing.None)
                                Column(Modifier.weight(1f)) {
                                    Text(s.name, style = ZipperTheme.type.labelM, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Text(if (s.isOnline) "Online now" else "Away — may reply later", style = ZipperTheme.type.caption, color = if (s.isOnline) c.statusOnline else c.textMuted)
                                }
                                Box(Modifier.size(40.dp).background(c.glassMid, CircleShape).border(1.dp, c.borderDefault, CircleShape), contentAlignment = Alignment.Center) {
                                    Icon(Icons.Outlined.ChatBubbleOutline, null, tint = c.textPrimary, modifier = Modifier.size(18.dp))
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PackCard(p: RechargePackage, localPrice: String?, modifier: Modifier, onClick: () -> Unit) {
    val c = ZipperTheme.colors
    Column(
        modifier.height(144.dp)
            .background(Brush.verticalGradient(listOf(Color(0x12FFFFFF), Color(0x05FFFFFF))), RoundedCornerShape(Radius.lg))
            .border(1.dp, if (p.badge.isNotBlank()) c.brandVip else c.borderSubtle, RoundedCornerShape(Radius.lg))
            .clickableNoRipple(onClick)
            .padding(horizontal = Space.md, vertical = Space.sm),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Box(Modifier.height(20.dp)) {
            if (p.badge.isNotBlank()) {
                Box(Modifier.background(c.tintGoldSubtle, CircleShape).border(1.dp, c.brandVip, CircleShape).padding(horizontal = 8.dp, vertical = 2.dp)) {
                    Text(p.badge.uppercase(), style = ZipperTheme.type.overline, color = c.brandVip)
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            CurrencyDisc(Currency.Diamond, 20.dp)   // O5b: the same cut gem as every balance and price
            Text(indianGrouping(p.totalDiamonds), style = ZipperTheme.type.numericM, color = c.currencyDiamond)
        }
        Text(
            if (p.bonusDiamonds > 0) "${indianGrouping(p.baseDiamonds)} + ${indianGrouping(p.bonusDiamonds)} bonus" else p.label,
            style = ZipperTheme.type.caption, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        Box(
            Modifier.fillMaxWidth().height(44.dp).background(Brush.horizontalGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), CircleShape),
            contentAlignment = Alignment.Center,
        ) { Text("₹${indianGrouping(p.priceInr.toLong())}", style = ZipperTheme.type.labelL, color = Color.White) }
        Text(localPrice ?: "≈ $${p.priceUsd}", style = ZipperTheme.type.caption, color = c.textMuted)
    }
}

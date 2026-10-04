package com.zipper.app.ui.screens.seller

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.outlined.AddPhotoAlternate
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.ClipboardManager
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import com.google.firebase.Timestamp
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.ktx.firestore
import com.google.firebase.ktx.Firebase
import com.google.firebase.storage.ktx.storage
import com.zipper.app.ui.components.*
import com.zipper.app.ui.screens.profile.GlassCard
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

/*
 * Buy coin (seller wholesale) — Figma "04 Buy coin".
 *
 *   Top bar: back, "Buy diamonds (wholesale)", coin balance pill.
 *   Region segmented control (India ₹ / Foreign $), margin notice.
 *   Pack cards: glass, amount in aqua, "wholesale rate" caption, gradient ₹ CTA.
 *   Payment step: bank / Binance details on a glass card with copy buttons,
 *   UTR field, screenshot upload, gradient submit with loading.
 */

// ─── Payment config ───────────────────────────────────────────────────────────
// Loaded from Firestore: appConfig/paymentCredentials
// Managed via CRM → App Config → Payment Credentials
//
// There are deliberately no built-in values. The account details used to be
// compiled in as defaults, which put them into every shipped APK and — worse —
// meant a failed or missing read silently showed whatever the build was made
// with. A stale account number is money sent to the wrong place. If the
// document cannot be read the screen says so and refuses the purchase.

private data class PaymentConfig(
    val binanceUid:  String = "",
    val bankName:    String = "",
    val bankIfsc:    String = "",
    val bankAccount: String = "",
    val bankHolder:  String = "",
    val bankBranch:  String = "",
) {
    /**
     * Everything a seller needs to make the bank transfer. Partial is not
     * usable — half an account number is worse than none, because it looks
     * like something to pay into.
     */
    val hasBankDetails: Boolean
        get() = bankName.isNotBlank() && bankIfsc.isNotBlank() && bankAccount.isNotBlank() && bankHolder.isNotBlank()

    val hasBinanceDetails: Boolean
        get() = binanceUid.isNotBlank()
}

private data class CoinPackage(
    val coins: Long,
    val label: String,
    val priceInr: Int,
    val priceUsd: Int,
)

/**
 * Packages derived from the CRM's wholesale price, not hardcoded.
 *
 * Every tier is a whole number of lakhs, so one per-lakh price defines all of
 * them. The previous fixed list (2290 / 4580 / 11450) was the RETAIL price,
 * which handed the seller a zero margin regardless of what the CRM said.
 */
private fun coinPackages(perLakhInr: Int, perLakhUsd: Int) = listOf(
    CoinPackage(100_000L, "1 Lakh", perLakhInr,     perLakhUsd),
    CoinPackage(200_000L, "2 Lakh", perLakhInr * 2, perLakhUsd * 2),
    CoinPackage(500_000L, "5 Lakh", perLakhInr * 5, perLakhUsd * 5),
)

// ─── Screen ───────────────────────────────────────────────────────────────────

@Composable
fun BuyCoinScreen(
    onBack: () -> Unit = {},
    viewModel: BuyCoinViewModel = hiltViewModel(),
) {
    val economy by viewModel.state.collectAsStateWithLifecycle()
    val packages = remember(economy.wholesalePerLakhInr, economy.wholesalePerLakhUsd) {
        coinPackages(economy.wholesalePerLakhInr, economy.wholesalePerLakhUsd)
    }
    val c            = ZipperTheme.colors
    val auth         = FirebaseAuth.getInstance()
    val currentUser  = auth.currentUser
    val currentUid   = currentUser?.uid ?: ""
    val scope        = rememberCoroutineScope()
    val clipboard    = LocalClipboardManager.current

    // Form state
    var selectedIndex      by remember { mutableIntStateOf(0) }
    val selectedPackage    = packages.getOrElse(selectedIndex) { packages.first() }
    var isIndia            by remember { mutableStateOf(true) }   // India = bank, else Binance
    var transactionRef     by remember { mutableStateOf("") }
    var proofUri           by remember { mutableStateOf<Uri?>(null) }

    // Seller info (needed for the Firestore doc)
    var sellerName  by remember { mutableStateOf("") }
    var sellerEmail by remember { mutableStateOf("") }
    var coinBalance by remember { mutableStateOf(0L) }

    // Payment credentials — loaded from Firestore. There is no fallback.
    var payConfig        by remember { mutableStateOf(PaymentConfig()) }
    var payConfigLoading by remember { mutableStateOf(true) }

    // Status
    var isUploading    by remember { mutableStateOf(false) }
    var uploadProgress by remember { mutableFloatStateOf(0f) }
    var isSubmitting   by remember { mutableStateOf(false) }
    var isSuccess      by remember { mutableStateOf(false) }
    var errorMsg       by remember { mutableStateOf<String?>(null) }

    // Image picker
    val imageLauncher = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri -> proofUri = uri }

    // Load seller info + payment credentials from Firestore
    LaunchedEffect(currentUid) {
        if (currentUid.isBlank()) {
            // Nobody is signed in, so the credentials document is not readable
            // either. Stop waiting and let the screen say the details are
            // unavailable rather than spinning forever.
            payConfigLoading = false
            return@LaunchedEffect
        }
        try {
            val snap = Firebase.firestore.collection("sellers").document(currentUid).get().await()
            sellerName  = snap.getString("displayName") ?: currentUser?.displayName ?: ""
            sellerEmail = snap.getString("email") ?: currentUser?.email ?: ""
            coinBalance = snap.getLong("coinBalance") ?: 0L
        } catch (_: Exception) { }

        // Load payment credentials (CRM → App Config → Payment Credentials).
        // A missing document or a failed read leaves the config blank, which
        // the screen reports honestly. It never falls back to a built-in
        // account.
        payConfig = try {
            val credSnap = Firebase.firestore.collection("appConfig").document("paymentCredentials").get().await()
            if (credSnap.exists()) {
                PaymentConfig(
                    binanceUid  = credSnap.getString("binanceUid").orEmpty(),
                    bankName    = credSnap.getString("bankName").orEmpty(),
                    bankIfsc    = credSnap.getString("bankIfsc").orEmpty(),
                    bankAccount = credSnap.getString("bankAccount").orEmpty(),
                    bankHolder  = credSnap.getString("bankHolder").orEmpty(),
                    bankBranch  = credSnap.getString("bankBranch").orEmpty(),
                )
            } else PaymentConfig()
        } catch (_: Exception) { PaymentConfig() }
        payConfigLoading = false
    }

    fun submit() {
        if (proofUri == null) { errorMsg = "Please upload a payment screenshot."; return }
        if (transactionRef.isBlank()) { errorMsg = "Please enter your UTR / Transaction ID."; return }
        errorMsg = null
        scope.launch {
            try {
                isUploading = true
                // Upload screenshot to Firebase Storage
                val fileName = "proof_${System.currentTimeMillis()}.jpg"
                val storageRef = Firebase.storage.reference.child("coinPurchaseProofs/$currentUid/$fileName")
                val uploadTask = storageRef.putFile(proofUri!!)
                uploadTask.addOnProgressListener { snap ->
                    uploadProgress = snap.bytesTransferred.toFloat() / snap.totalByteCount.toFloat()
                }
                uploadTask.await()
                val downloadUrl = storageRef.downloadUrl.await().toString()
                isUploading = false

                // Write Firestore doc
                isSubmitting = true
                val method   = if (isIndia) "bank" else "binance"
                val currency = if (isIndia) "INR" else "USD"
                val amount   = if (isIndia) selectedPackage.priceInr.toDouble() else selectedPackage.priceUsd.toDouble()
                Firebase.firestore.collection("coinPurchaseRequests").add(
                    mapOf(
                        "sellerUid"       to currentUid,
                        "sellerName"      to sellerName,
                        "sellerEmail"     to sellerEmail,
                        "coinsRequested"  to selectedPackage.coins,
                        "paymentMethod"   to method,
                        "amountPaid"      to amount,
                        "currency"        to currency,
                        "paymentProofUrl" to downloadUrl,
                        "transactionRef"  to transactionRef.trim(),
                        "status"          to "pending",
                        "createdAt"       to Timestamp.now(),
                    )
                ).await()
                isSubmitting = false
                isSuccess = true
            } catch (e: Exception) {
                isUploading  = false
                isSubmitting = false
                errorMsg = e.message ?: "Submission failed. Please try again."
            }
        }
    }

    val priceLabel = if (isIndia) "₹${indianGrouping(selectedPackage.priceInr.toLong())}" else "$${selectedPackage.priceUsd}"

    // ─── Success screen ────────────────────────────────────────────────────────
    if (isSuccess) {
        ZipperScreen(topBar = { TopBar("Request sent", onBack = onBack) }) { _ ->
            Column(Modifier.fillMaxSize().padding(Space.lg), verticalArrangement = Arrangement.Center) {
                EmptyState(
                    Icons.Outlined.CheckCircle, "Request submitted",
                    "Your purchase request has gone to Zippern. Coins are credited once the finance team verifies your payment — usually within a few hours.",
                )
                ZipperButton("Back to dashboard", onBack, fullWidth = true, gradient = true)
                Spacer(Modifier.navigationBarsPadding())
            }
        }
        return
    }

    // ─── Main screen ──────────────────────────────────────────────────────────
    ZipperScreen(topBar = { TopBar("Buy diamonds (wholesale)", onBack = onBack) { CurrencyPill(Currency.Coin, coinBalance) } }) { _ ->
        LazyColumn(contentPadding = PaddingValues(horizontal = Space.lg, vertical = Space.md), verticalArrangement = Arrangement.spacedBy(Space.md)) {
            // ── Region ────────────────────────────────────────────────────────
            item {
                Row(Modifier.fillMaxWidth().height(38.dp).background(c.bgRaised, CircleShape).padding(2.dp)) {
                    Segment("India (₹)", isIndia, Modifier.weight(1f)) { isIndia = true }
                    Segment("Foreign ($)", !isIndia, Modifier.weight(1f)) { isIndia = false }
                }
            }

            // ── What the seller actually makes ─────────────────────────────────
            // A seller's whole business is the spread. Showing it here means the
            // number they resell at is on screen at the moment they buy, rather
            // than being something they work out themselves and get wrong.
            item {
                when {
                    economy.isFallback -> Notice(
                        "Live prices unavailable",
                        "Showing the last known prices. Do not transfer money against these — check with support first.",
                        c.statusDanger,
                    )
                    economy.marginPerLakhInr > 0 -> Notice(
                        "Your margin: ₹${indianGrouping(economy.marginPerLakhInr.toLong())} per lakh",
                        "You pay ₹${indianGrouping(economy.wholesalePerLakhInr.toLong())} per lakh. Buyers pay ₹${indianGrouping(economy.retailPerLakhInr.toLong())}. You collect the difference from them directly.",
                        c.currencyCoin,
                    )
                    !economy.isLoading -> Notice(
                        "No margin set",
                        "You are being charged the same price your buyers pay, so this purchase earns you nothing. Contact support before transferring.",
                        c.statusDanger,
                    )
                }
            }

            // ── Package selection ──────────────────────────────────────────────
            item { SectionHeader("Choose a pack") }
            item {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    packages.forEachIndexed { index, pkg ->
                        PackCard(pkg, isIndia, index == selectedIndex, Modifier.weight(1f)) { selectedIndex = index }
                    }
                }
            }

            // ── Payment details ────────────────────────────────────────────────
            item { SectionHeader(if (isIndia) "Pay to bank account" else "Pay via Binance Pay") }
            val detailsReady = if (isIndia) payConfig.hasBankDetails else payConfig.hasBinanceDetails
            item {
                when {
                    payConfigLoading -> GlassCard {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
                            CircularProgressIndicator(Modifier.size(18.dp), color = c.brandPrimary, strokeWidth = 2.dp)
                            Text("Loading payment details…", style = ZipperTheme.type.bodyS, color = c.textSecondary)
                        }
                    }
                    // Deliberately loud, and deliberately not a blank card: a seller
                    // who sees an empty row assumes the app is still loading and may
                    // pay into whatever account they remember.
                    !detailsReady -> Notice(
                        "Payment details unavailable",
                        (if (isIndia)
                            "Our bank details could not be loaded, so there is nothing safe to show you. Do not transfer to any account you may have used before — please contact Zippern support and we will confirm where to pay."
                        else
                            "Our Binance UID could not be loaded, so there is nothing safe to show you. Please contact Zippern support and we will confirm where to pay.")
                            + "\n\nYou cannot submit a purchase request until this is fixed.",
                        c.statusDanger,
                    )
                    isIndia -> GlassCard {
                        CopyableRow("Bank",    payConfig.bankName,    clipboard)
                        CopyableRow("IFSC",    payConfig.bankIfsc,    clipboard)
                        CopyableRow("Account", payConfig.bankAccount, clipboard)
                        CopyableRow("Name",    payConfig.bankHolder,  clipboard)
                        if (payConfig.bankBranch.isNotBlank()) CopyableRow("Branch", payConfig.bankBranch, clipboard)
                        Text(
                            "Transfer exactly $priceLabel and use your registered mobile number as the payment reference.",
                            style = ZipperTheme.type.caption, color = c.statusWarning,
                        )
                    }
                    else -> GlassCard {
                        CopyableRow("Binance UID", payConfig.binanceUid, clipboard)
                        Text(
                            "Send exactly $priceLabel via Binance Pay to the UID above. Price includes ~2% Binance network fee.",
                            style = ZipperTheme.type.caption, color = c.statusWarning,
                        )
                    }
                }
            }

            // ── Transaction reference ──────────────────────────────────────────
            item {
                Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                    Text(if (isIndia) "UTR / reference number" else "Binance transaction ID", style = ZipperTheme.type.labelM, color = c.textPrimary)
                    Row(
                        Modifier.fillMaxWidth().height(52.dp).background(c.bgElevated, RoundedCornerShape(Radius.lg))
                            .border(1.dp, c.borderDefault, RoundedCornerShape(Radius.lg)).padding(horizontal = Space.lg),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        BasicTextField(
                            value = transactionRef, onValueChange = { transactionRef = it }, singleLine = true,
                            textStyle = ZipperTheme.type.bodyL.copy(color = c.textPrimary),
                            cursorBrush = SolidColor(c.brandPrimary),
                            modifier = Modifier.weight(1f),
                            decorationBox = { inner ->
                                if (transactionRef.isEmpty()) Text(if (isIndia) "e.g. 423456789012" else "e.g. 123456789", style = ZipperTheme.type.bodyL, color = c.textMuted)
                                inner()
                            },
                        )
                    }
                }
            }

            // ── Upload screenshot ──────────────────────────────────────────────
            item {
                Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                    Text("Payment screenshot", style = ZipperTheme.type.labelM, color = c.textPrimary)
                    if (proofUri == null) {
                        Column(
                            Modifier.fillMaxWidth().height(120.dp)
                                .background(Brush.verticalGradient(listOf(Color(0x12FFFFFF), Color(0x05FFFFFF))), RoundedCornerShape(Radius.lg))
                                .border(1.dp, c.borderDefault, RoundedCornerShape(Radius.lg))
                                .clickableNoRipple { imageLauncher.launch("image/*") },
                            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
                        ) {
                            Icon(Icons.Outlined.AddPhotoAlternate, null, tint = c.textBrand, modifier = Modifier.size(32.dp))
                            Spacer(Modifier.height(Space.sm))
                            Text("Tap to upload screenshot", style = ZipperTheme.type.bodyM, color = c.textSecondary)
                        }
                    } else {
                        Box(Modifier.fillMaxWidth().height(200.dp).clip(RoundedCornerShape(Radius.lg)).clickableNoRipple { imageLauncher.launch("image/*") }) {
                            AsyncImage(model = proofUri, contentDescription = "Payment proof", contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                            Box(Modifier.fillMaxSize().background(c.scrimSoft))
                            Text("Tap to change", style = ZipperTheme.type.labelS, color = Color.White, modifier = Modifier.align(Alignment.BottomCenter).padding(Space.sm))
                        }
                    }
                }
            }

            // ── Upload progress ────────────────────────────────────────────────
            if (isUploading) item {
                Column(verticalArrangement = Arrangement.spacedBy(Space.xs)) {
                    LinearProgressIndicator(progress = { uploadProgress }, modifier = Modifier.fillMaxWidth().clip(CircleShape), color = c.brandPrimary, trackColor = c.bgElevated)
                    Text("Uploading ${(uploadProgress * 100).toInt()}%…", style = ZipperTheme.type.caption, color = c.textSecondary)
                }
            }

            // ── Error message ──────────────────────────────────────────────────
            errorMsg?.let { msg -> item { Text(msg, style = ZipperTheme.type.bodyS, color = c.statusDanger) } }

            // ── Submit ─────────────────────────────────────────────────────────
            // Without payment details we never told the seller where to pay, so
            // a request claiming they did cannot be honest. The button stays
            // disabled until the details are on screen.
            item {
                val canSubmit = detailsReady && transactionRef.isNotBlank() && proofUri != null && !isUploading && !isSubmitting
                ZipperButton(
                    if (isSubmitting) "Submitting…" else "Submit request — $priceLabel", { submit() },
                    modifier = Modifier.padding(top = Space.xs), enabled = canSubmit, loading = isSubmitting || isUploading, gradient = true, fullWidth = true,
                )
            }
            // TODO(design): status list of previous coinPurchaseRequests (pending / approved / rejected Chips) — this screen has no query for them yet; add one to BuyCoinViewModel before rendering.
            item { Spacer(Modifier.navigationBarsPadding()) }
        }
    }
}

// ─── Private pieces ───────────────────────────────────────────────────────────

@Composable
private fun Segment(text: String, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val c = ZipperTheme.colors
    Box(
        modifier.fillMaxHeight()
            .then(if (selected) Modifier.background(Brush.horizontalGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), CircleShape) else Modifier)
            .clickableNoRipple(onClick),
        contentAlignment = Alignment.Center,
    ) { Text(text, style = ZipperTheme.type.labelM, color = if (selected) Color.White else c.textMuted, maxLines = 1) }
}

@Composable
private fun Notice(title: String, body: String, tint: Color) {
    val c = ZipperTheme.colors
    Column(
        Modifier.fillMaxWidth().background(tint.copy(0.12f), RoundedCornerShape(Radius.md)).border(1.dp, tint.copy(0.5f), RoundedCornerShape(Radius.md)).padding(Space.md),
        verticalArrangement = Arrangement.spacedBy(Space.xs),
    ) {
        Text(title, style = ZipperTheme.type.labelM, color = tint)
        Text(body, style = ZipperTheme.type.bodyS, color = c.textSecondary)
    }
}

@Composable
private fun PackCard(pkg: CoinPackage, isIndia: Boolean, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val c = ZipperTheme.colors
    Column(
        modifier
            .background(Brush.verticalGradient(listOf(Color(0x12FFFFFF), Color(0x05FFFFFF))), RoundedCornerShape(Radius.lg))
            .border(1.dp, if (selected) c.brandPrimary else c.borderSubtle, RoundedCornerShape(Radius.lg))
            .clickableNoRipple(onClick)
            .padding(horizontal = Space.md, vertical = Space.sm),
        verticalArrangement = Arrangement.spacedBy(Space.xs),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
            CurrencyDisc(Currency.Diamond, 16.dp)
            Text(pkg.label, style = ZipperTheme.type.numericM, color = c.currencyDiamond, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Text(indianGrouping(pkg.coins), style = ZipperTheme.type.caption, color = c.textSecondary, maxLines = 1)
        Text("wholesale rate", style = ZipperTheme.type.caption, color = c.textMuted, maxLines = 1)
        Box(
            Modifier.fillMaxWidth().height(40.dp)
                .background(if (selected) Brush.horizontalGradient(listOf(c.brandGradientFrom, c.brandGradientTo)) else Brush.horizontalGradient(listOf(c.bgElevated, c.bgElevated)), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                if (isIndia) "₹${indianGrouping(pkg.priceInr.toLong())}" else "$${pkg.priceUsd}",
                style = ZipperTheme.type.labelM, color = if (selected) Color.White else c.textPrimary, maxLines = 1,
            )
        }
    }
}

@Composable
private fun CopyableRow(label: String, value: String, clipboard: ClipboardManager) {
    val c = ZipperTheme.colors
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
        Text(label, style = ZipperTheme.type.caption, color = c.textSecondary, modifier = Modifier.width(80.dp))
        Text(value, style = ZipperTheme.type.numericM.copy(fontFamily = FontFamily.Monospace), color = c.textPrimary, modifier = Modifier.weight(1f))
        IconButtonCircle(Icons.Default.ContentCopy, "Copy $label", { clipboard.setText(AnnotatedString(value)) }, size = 32.dp, background = Color.Transparent, tint = c.textSecondary)
    }
}

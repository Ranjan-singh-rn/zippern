package com.zipper.app.ui.screens.seller

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import coil.compose.AsyncImage
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.ktx.firestore
import com.google.firebase.ktx.Firebase
import com.zipper.app.ui.components.*
import com.zipper.app.ui.screens.profile.GlassCard
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

/*
 * Seller panel.
 *
 *   Top bar: back, "Seller panel", coin balance pill.
 *   Hero: coin balance (numeric L, gold), online toggle, "Buy diamonds" CTA.
 *   Stats row: total sold · pending · online.
 *   Pending / History segmented tabs; pending rows carry Approve / Reject.
 *
 * Approving a row is the seller spending their own coin stock against cash a
 * buyer has already handed over, so every pending row has to show three things
 * before the button is worth tapping: how big the order is, what the seller
 * holds, and the proof of payment at a size a human can actually read.
 */

// ─── Data classes ────────────────────────────────────────────────────────────

private data class SellerDoc(
    val displayName: String = "",
    val coinBalance: Long = 0L,
    val totalCoinsSold: Long = 0L,
    val isOnline: Boolean = false,
)

private data class RechargeRequest(
    val id: String = "",
    val buyerName: String = "",
    /**
     * The diamond count, which is also the number of coins this approval takes
     * out of the seller's stock — `onRechargeApproved` deducts `diamondPackage`
     * from `sellers/{uid}.coinBalance` and credits the same figure to the buyer.
     *
     * A NUMBER, not a string: zipper-crm/lib/sellers.ts types it `number`,
     * functions/src/index.ts does arithmetic on it, and the Python weekly report
     * reads it as an int. This screen used to declare it `String` and read it
     * with `getString`, so it was always empty and the row printed the
     * placeholder word "Recharge" where the size of the sale belongs — the
     * seller was approving a debit against their own stock without ever being
     * shown how large it was.
     *
     * Nullable because "nobody recorded it" is a real state on old documents and
     * is not the same as zero: a 0 here would read as a free order and would
     * sail past the balance check on the row.
     */
    val diamondPackage: Long? = null,
    /** Rupees the buyer says they paid, `null` when the document never recorded it. */
    val amountPaid: Double? = null,
    val paymentScreenshotUrl: String = "",
    val status: String = "",
    val sellerUid: String = "",
    /**
     * Why an approval bounced back to `pending`, in the seller's terms, written
     * by `onRechargeApproved` when the coin transfer failed (see the catch block
     * in functions/src/index.ts). Without rendering it, a request the seller
     * approved minutes ago simply reappears in Pending looking untouched.
     */
    val transferErrorReason: String = "",
    val transferAttempts: Long = 0L,
)

// ─── Firestore readers ────────────────────────────────────────────────────────

private fun DocumentSnapshot.toSellerDoc() = SellerDoc(
    displayName = getString("displayName") ?: "",
    coinBalance = getLong("coinBalance") ?: 0L,
    totalCoinsSold = getLong("totalCoinsSold") ?: 0L,
    isOnline = getBoolean("isOnline") ?: false,
)

/**
 * A figure that one writer may have stored as a number and an older one as text.
 *
 * Read through `get` and coerced here, never through `getLong` / `getDouble` /
 * `getString`, because those cannot coerce: handed a value of another type they
 * at best return null and at worst throw a RuntimeException naming the field and
 * the class it is not. That throw would happen inside the loader below, where a
 * single legacy row takes the entire dashboard down to an error screen.
 *
 * `null` means nobody recorded the figure, and the row says so out loud instead
 * of printing 0. A seller must not be shown "0 diamonds" or "₹0" for an order
 * they have already been paid for in cash — zipper-crm's own `legacyAmount`
 * takes the same line with these same two fields.
 */
private fun DocumentSnapshot.numberOrNull(field: String): Double? = when (val raw = get(field)) {
    is Number -> raw.toDouble()
    is String -> raw.trim().toDoubleOrNull()
    else -> null
}

/**
 * One request. Both tabs go through here — the `getString("diamondPackage")` bug
 * existed twice, once per tab, because the mapping was written out twice.
 */
private fun DocumentSnapshot.toRechargeRequest() = RechargeRequest(
    id = id,
    buyerName = getString("buyerName") ?: "",
    diamondPackage = numberOrNull("diamondPackage")?.toLong(),
    amountPaid = numberOrNull("amountPaid"),
    paymentScreenshotUrl = getString("paymentScreenshotUrl") ?: "",
    status = getString("status") ?: "",
    sellerUid = getString("sellerUid") ?: "",
    transferErrorReason = getString("transferErrorReason") ?: "",
    transferAttempts = getLong("transferAttempts") ?: 0L,
)

/**
 * What to tell a seller when a write to one of their own requests is refused.
 *
 * The likely cause is not the network. firestore.rules only allows a seller to
 * update a `rechargeRequests` document whose `buyerUid` is not their own uid —
 * the self-dealing guard, because approving a sale to yourself mints diamonds
 * for free — and a rule refusal arrives as a bare PERMISSION_DENIED. Handed to
 * the seller raw that reads as a bug in the app, so they tap again, and again.
 * Naming the situation at least stops the retrying and gives them something to
 * quote to support.
 */
private fun writeFailureMessage(e: Exception): String =
    when ((e as? FirebaseFirestoreException)?.code) {
        FirebaseFirestoreException.Code.PERMISSION_DENIED ->
            "The server refused this, and nothing was changed. The usual cause is that the buyer on this request is your own account — a seller can't approve their own purchase. If the buyer is someone else, send support this request's ID."
        FirebaseFirestoreException.Code.UNAVAILABLE ->
            "Couldn't reach the server. Nothing was changed — try again once you're back online."
        // Anything else is genuinely unexpected, so the seller gets a plain
        // sentence first and the raw detail second — they need to know the sale
        // is untouched, and support needs something to go on.
        else ->
            "That didn't go through and nothing was changed. Try again — if it keeps failing, send support this: " +
                (e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName)
    }

// ─── Screen ───────────────────────────────────────────────────────────────────

@Composable
fun SellerDashboardScreen(
    onBack: () -> Unit = {},
    onBuyCoins: () -> Unit = {},
) {
    val c = ZipperTheme.colors
    val currentUid = FirebaseAuth.getInstance().currentUser?.uid ?: ""
    val scope = rememberCoroutineScope()

    var sellerDoc by remember { mutableStateOf<SellerDoc?>(null) }
    var isOnlineToggle by remember { mutableStateOf(false) }
    var pendingRequests by remember { mutableStateOf<List<RechargeRequest>>(emptyList()) }
    var historyRequests by remember { mutableStateOf<List<RechargeRequest>>(emptyList()) }
    var isLoading by remember { mutableStateOf(true) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var selectedTab by remember { mutableIntStateOf(0) }   // 0=Pending, 1=History

    // Reject dialog state
    var rejectDialogRequest by remember { mutableStateOf<RechargeRequest?>(null) }
    var rejectReason by remember { mutableStateOf("") }
    var rejectLoading by remember { mutableStateOf(false) }
    var rejectError by remember { mutableStateOf<String?>(null) }

    // The payment proof, full screen. Null = closed.
    var proofUrl by remember { mutableStateOf<String?>(null) }

    /*
     * Approve/reject feedback, in two shapes on purpose.
     *
     * A failure belongs to its row: the row is still sitting in Pending and the
     * seller has to decide what to do about it, so the message stays there until
     * they act. A success has no row left to live on — it has moved to History —
     * so it is confirmed once, transiently, the way the rest of the app confirms
     * things.
     */
    var approveFailure by remember { mutableStateOf<Pair<String, String>?>(null) }
    var approvingId by remember { mutableStateOf<String?>(null) }
    var actionNotice by remember { mutableStateOf<String?>(null) }
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(actionNotice) { actionNotice?.let { snackbar.showSnackbar(it); actionNotice = null } }

    LaunchedEffect(currentUid) {
        if (currentUid.isBlank()) {
            isLoading = false
            return@LaunchedEffect
        }
        try {
            // Fetch seller doc
            val sellerSnap = Firebase.firestore.collection("sellers").document(currentUid).get().await()
            val doc = sellerSnap.toSellerDoc()
            sellerDoc = doc
            isOnlineToggle = doc.isOnline

            // Fetch pending recharge requests
            val pendingSnap = Firebase.firestore.collection("rechargeRequests")
                .whereEqualTo("sellerUid", currentUid)
                .whereEqualTo("status", "pending")
                .orderBy("createdAt", Query.Direction.DESCENDING)
                .get().await()
            pendingRequests = pendingSnap.documents.map { it.toRechargeRequest() }

            // Fetch history (last 20 non-pending)
            val historySnap = Firebase.firestore.collection("rechargeRequests")
                .whereEqualTo("sellerUid", currentUid)
                .whereIn("status", listOf("approved", "rejected"))
                .orderBy("createdAt", Query.Direction.DESCENDING)
                .limit(20)
                .get().await()
            historyRequests = historySnap.documents.map { it.toRechargeRequest() }
        } catch (e: Exception) {
            errorMessage = e.message ?: "Failed to load seller data"
        } finally {
            isLoading = false
        }
    }

    /*
     * The coin balance is watched, not fetched once.
     *
     * Every pending row is measured against this number, and approving a row
     * spends it: the deduction happens server-side in `onRechargeApproved`,
     * after the write this screen makes. A figure read once at load is therefore
     * stale from the first approval onwards, and the second row of a session
     * would be checked against coins the seller no longer has. The listener also
     * corrects itself the other way — when a transfer bounces, no deduction ever
     * happened and the balance has not moved.
     *
     * A listener error is deliberately not surfaced: the last known balance on
     * screen is more use than blanking a dashboard that has already loaded.
     */
    DisposableEffect(currentUid) {
        val registration = if (currentUid.isBlank()) null else
            Firebase.firestore.collection("sellers").document(currentUid)
                .addSnapshotListener { snap, err ->
                    if (err == null && snap != null && snap.exists()) sellerDoc = snap.toSellerDoc()
                }
        onDispose { registration?.remove() }
    }

    proofUrl?.let { url -> ProofViewer(url = url, onClose = { proofUrl = null }) }

    // Reject dialog
    rejectDialogRequest?.let { request ->
        val dismiss = { if (!rejectLoading) { rejectDialogRequest = null; rejectReason = ""; rejectError = null } }
        AlertDialog(
            onDismissRequest = dismiss,
            containerColor = c.bgElevated,
            title = { Text("Reject request", style = ZipperTheme.type.headingS, color = c.textPrimary) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                    Text("Enter a reason for rejecting this request:", style = ZipperTheme.type.bodyM, color = c.textSecondary)
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 48.dp).background(c.bgRaised, RoundedCornerShape(Radius.lg))
                            .border(1.dp, c.borderDefault, RoundedCornerShape(Radius.lg)).padding(horizontal = Space.md, vertical = Space.sm),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        BasicTextField(
                            value = rejectReason, onValueChange = { rejectReason = it }, maxLines = 3,
                            textStyle = ZipperTheme.type.bodyL.copy(color = c.textPrimary),
                            cursorBrush = SolidColor(c.brandPrimary),
                            modifier = Modifier.weight(1f),
                            decorationBox = { inner ->
                                if (rejectReason.isEmpty()) Text("Reason (e.g. wrong amount)", style = ZipperTheme.type.bodyL, color = c.textMuted)
                                inner()
                            },
                        )
                    }
                    // The refusal, kept in front of the seller with their typed
                    // reason still in the field, so the rejection is not lost.
                    rejectError?.let { RowNotice(it, c.statusDanger) }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        rejectLoading = true
                        rejectError = null
                        scope.launch {
                            try {
                                Firebase.firestore.collection("rechargeRequests").document(request.id)
                                    .update(mapOf("status" to "rejected", "rejectedReason" to rejectReason.trim()))
                                    .await()
                                /*
                                 * Dismissing is the success path's job, and only
                                 * the success path's.
                                 *
                                 * This used to sit in a `finally` that cleared
                                 * the spinner and closed the dialog whether the
                                 * update committed or threw, so a
                                 * PERMISSION_DENIED looked exactly like a
                                 * rejection: the row left Pending on this screen
                                 * while the document was still `pending` on the
                                 * server, and it reappeared on the next load
                                 * with nothing to explain itself.
                                 */
                                pendingRequests = pendingRequests.filterNot { it.id == request.id }
                                historyRequests = listOf(request.copy(status = "rejected")) + historyRequests
                                rejectLoading = false
                                rejectDialogRequest = null
                                rejectReason = ""
                                actionNotice = "Rejected. The reason is saved on the request."
                            } catch (e: Exception) {
                                rejectError = writeFailureMessage(e)
                                rejectLoading = false
                            }
                        }
                    },
                    enabled = rejectReason.isNotBlank() && !rejectLoading,
                ) { Text(if (rejectLoading) "Rejecting…" else "Reject", style = ZipperTheme.type.labelM, color = c.statusDanger) }
            },
            dismissButton = { TextButton(onClick = dismiss) { Text("Cancel", style = ZipperTheme.type.labelM, color = c.textSecondary) } },
        )
    }

    ZipperScreen(topBar = { TopBar("Seller panel", onBack = onBack) { CurrencyPill(Currency.Coin, sellerDoc?.coinBalance ?: 0L) } }) { _ ->
        Box(Modifier.fillMaxSize()) {
            when {
                isLoading -> LoadingState()
                errorMessage != null -> EmptyState(Icons.Outlined.Inbox, "Couldn't load your seller data", errorMessage ?: "Unknown error. Go back and try again.")
                else -> LazyColumn(contentPadding = PaddingValues(horizontal = Space.lg, vertical = Space.md), verticalArrangement = Arrangement.spacedBy(Space.md)) {
                    // ── Balance hero ──────────────────────────────────────────
                    item {
                        Column(
                            Modifier.fillMaxWidth().background(Brush.linearGradient(listOf(c.tintGoldSubtle, c.tintVioletSubtle)), RoundedCornerShape(Radius.xl))
                                .border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.xl)).padding(Space.xl),
                            verticalArrangement = Arrangement.spacedBy(Space.md),
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text(sellerDoc?.displayName?.ifBlank { "Seller" } ?: "Seller", style = ZipperTheme.type.labelM, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Text("Coin balance", style = ZipperTheme.type.caption, color = c.textMuted)
                                }
                                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                    Text(if (isOnlineToggle) "Online" else "Offline", style = ZipperTheme.type.caption, color = if (isOnlineToggle) c.statusOnline else c.textMuted)
                                    Switch(
                                        checked = isOnlineToggle,
                                        onCheckedChange = { newValue ->
                                            isOnlineToggle = newValue
                                            scope.launch {
                                                try {
                                                    Firebase.firestore.collection("sellers").document(currentUid).update("isOnline", newValue).await()
                                                } catch (_: Exception) {
                                                    isOnlineToggle = !newValue // revert on failure
                                                }
                                            }
                                        },
                                        colors = SwitchDefaults.colors(
                                            checkedThumbColor = Color.White, checkedTrackColor = c.statusOnline,
                                            uncheckedThumbColor = c.textMuted, uncheckedTrackColor = c.bgElevated, uncheckedBorderColor = c.borderDefault,
                                        ),
                                    )
                                }
                            }
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                                CurrencyDisc(Currency.Coin, 24.dp)
                                Text(indianGrouping(sellerDoc?.coinBalance ?: 0L), style = ZipperTheme.type.numericL, color = c.currencyCoin)
                                Text("coins", style = ZipperTheme.type.bodyM, color = c.textSecondary)
                            }
                            ZipperButton("Buy diamonds", onBuyCoins, gradient = true, fullWidth = true, size = ButtonSize.Medium)
                        }
                    }

                    // ── Stats ─────────────────────────────────────────────────
                    // TODO(design): "sold today" / "this week" / "margin" — the seller doc only carries totalCoinsSold; add daily/weekly figures before showing them.
                    item {
                        GlassCard(padding = PaddingValues(Space.md)) {
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Stat("Total sold", indianGrouping(sellerDoc?.totalCoinsSold ?: 0L))
                                Stat("Pending", indianGrouping(pendingRequests.size.toLong()))
                                Stat("Completed", indianGrouping(historyRequests.count { it.status == "approved" }.toLong()))
                            }
                        }
                    }

                    // ── Tabs ──────────────────────────────────────────────────
                    item {
                        Row(Modifier.fillMaxWidth().height(38.dp).background(c.bgRaised, CircleShape).padding(2.dp)) {
                            TabSegment("Pending (${pendingRequests.size})", selectedTab == 0, Modifier.weight(1f)) { selectedTab = 0 }
                            TabSegment("History", selectedTab == 1, Modifier.weight(1f)) { selectedTab = 1 }
                        }
                    }

                    // ── Content based on selected tab ─────────────────────────
                    if (selectedTab == 0) {
                        if (pendingRequests.isEmpty()) {
                            item { EmptyState(Icons.Outlined.Inbox, "No pending requests", "New recharge requests from buyers will show up here — stay online so buyers can find you.") }
                        } else {
                            items(pendingRequests, key = { it.id }) { req ->
                                RequestRow(
                                    request = req,
                                    showBalance = true,
                                    coinBalance = sellerDoc?.coinBalance,
                                    onViewProof = { proofUrl = it },
                                    failure = approveFailure?.takeIf { it.first == req.id }?.second,
                                ) {
                                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                                        ZipperButton(
                                            "Reject", { rejectDialogRequest = req; rejectReason = ""; rejectError = null },
                                            modifier = Modifier.weight(1f), style = ButtonStyle.Danger, size = ButtonSize.Small,
                                        )
                                        ZipperButton(
                                            "Approve", {
                                                approvingId = req.id
                                                approveFailure = null
                                                scope.launch {
                                                    try {
                                                        Firebase.firestore.collection("rechargeRequests").document(req.id).update("status", "approved").await()
                                                        pendingRequests = pendingRequests.filterNot { it.id == req.id }
                                                        historyRequests = listOf(req.copy(status = "approved")) + historyRequests
                                                        /*
                                                         * "Running", not "done".
                                                         * The coins move in
                                                         * `onRechargeApproved`,
                                                         * after this write, and
                                                         * that transfer can send
                                                         * the request back to
                                                         * Pending — promising the
                                                         * buyer their diamonds
                                                         * here would be a promise
                                                         * this screen cannot keep.
                                                         */
                                                        actionNotice = req.diamondPackage
                                                            ?.let { "Approved — ${indianGrouping(it)} diamonds. The transfer is running; your coin balance updates when it lands." }
                                                            ?: "Approved. The transfer is running; your coin balance updates when it lands."
                                                    } catch (e: Exception) {
                                                        /*
                                                         * This was
                                                         * `catch (_: Exception) {}`,
                                                         * which made a refused
                                                         * approval indistinguishable
                                                         * from a successful one:
                                                         * the row stayed put, the
                                                         * seller tapped again, and
                                                         * nothing anywhere said
                                                         * why. The row keeps its
                                                         * place in Pending — which
                                                         * is the truth — and now
                                                         * carries the reason.
                                                         */
                                                        approveFailure = req.id to writeFailureMessage(e)
                                                    } finally {
                                                        approvingId = null
                                                    }
                                                }
                                            },
                                            modifier = Modifier.weight(1f), size = ButtonSize.Small, gradient = true,
                                            // One approval at a time: a second tap
                                            // while the first is in flight fires
                                            // against a row this screen has already
                                            // moved to History.
                                            enabled = approvingId == null,
                                            loading = approvingId == req.id,
                                        )
                                    }
                                }
                            }
                        }
                    } else {
                        if (historyRequests.isEmpty()) {
                            item { EmptyState(Icons.Outlined.Inbox, "No history yet", "Approved and rejected requests will be listed here.") }
                        } else {
                            items(historyRequests, key = { it.id }) { req ->
                                val (tint, label) = when (req.status) {
                                    "approved" -> c.statusSuccess to "Approved"
                                    "rejected" -> c.statusDanger to "Rejected"
                                    else -> c.textMuted to req.status.replaceFirstChar { it.uppercase() }
                                }
                                RequestRow(
                                    request = req,
                                    onViewProof = { proofUrl = it },
                                    trailing = { Chip(label, tint = tint.copy(0.14f), contentColor = tint) },
                                )
                            }
                        }
                    }

                    item { Spacer(Modifier.navigationBarsPadding()) }
                }
            }

            SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(Space.lg)) { data ->
                Snackbar(snackbarData = data, containerColor = c.bgElevated, contentColor = c.textPrimary)
            }
        }
    }
}

// ─── Private pieces ───────────────────────────────────────────────────────────

@Composable
private fun Stat(label: String, value: String) {
    val c = ZipperTheme.colors
    Column { Text(label, style = ZipperTheme.type.caption, color = c.textSecondary); Text(value, style = ZipperTheme.type.numericS, color = c.textPrimary) }
}

@Composable
private fun TabSegment(text: String, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val c = ZipperTheme.colors
    Box(
        modifier.fillMaxHeight()
            .then(if (selected) Modifier.background(Brush.horizontalGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), CircleShape) else Modifier)
            .clickableNoRipple(onClick),
        contentAlignment = Alignment.Center,
    ) { Text(text, style = ZipperTheme.type.labelM, color = if (selected) Color.White else c.textMuted, maxLines = 1) }
}

/** A tinted, bordered line inside a card: something the seller has to read, not skim. */
@Composable
private fun RowNotice(text: String, tint: Color) {
    Row(Modifier.fillMaxWidth().background(tint.copy(0.12f), RoundedCornerShape(Radius.md)).border(1.dp, tint.copy(0.5f), RoundedCornerShape(Radius.md)).padding(Space.md)) {
        Text(text, style = ZipperTheme.type.bodyS, color = tint)
    }
}

/**
 * One recharge request: buyer, the diamond count, what they paid, the proof
 * thumbnail, then `trailing` / `actions`.
 *
 * @param showBalance  Pending rows only. The seller's own stock, next to the
 *   order, because the decision is "can I fill this" and the answer used to be
 *   somewhere else on the screen entirely.
 * @param coinBalance  `null` means the balance could not be read — said plainly
 *   rather than compared against, since a wrong comparison here is worse than no
 *   comparison.
 * @param failure      Why the last approve on this row was refused.
 */
@Composable
private fun RequestRow(
    request: RechargeRequest,
    showBalance: Boolean = false,
    coinBalance: Long? = null,
    onViewProof: ((String) -> Unit)? = null,
    failure: String? = null,
    trailing: (@Composable () -> Unit)? = null,
    actions: (@Composable () -> Unit)? = null,
) {
    val c = ZipperTheme.colors
    val diamonds = request.diamondPackage
    val paid = request.amountPaid
    GlassCard(padding = PaddingValues(Space.md)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
            Avatar(null, size = AvatarSize.MD, initial = request.buyerName)
            Column(Modifier.weight(1f)) {
                Text(request.buyerName.ifBlank { "Unknown buyer" }, style = ZipperTheme.type.labelM, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (diamonds != null) Price(Currency.Diamond, diamonds, color = c.currencyDiamond)
                else Text("Diamond count not recorded", style = ZipperTheme.type.caption, color = c.statusWarning)
                if (paid != null) Text("₹${indianGrouping(paid.toLong())}", style = ZipperTheme.type.numericS, color = c.textPrimary)
                else Text("Amount paid not recorded", style = ZipperTheme.type.caption, color = c.statusWarning)
            }
            if (request.paymentScreenshotUrl.isNotBlank()) {
                /*
                 * Tappable, because a UPI reference number is not legible in
                 * 56dp of cropped thumbnail and that thumbnail is the seller's
                 * only evidence that the cash arrived. The badge is there because
                 * a picture that happens to be a button looks exactly like a
                 * picture that is not.
                 */
                Box(
                    Modifier.size(56.dp)
                        .then(onViewProof?.let { open -> Modifier.clickableNoRipple { open(request.paymentScreenshotUrl) } } ?: Modifier)
                ) {
                    AsyncImage(
                        model = request.paymentScreenshotUrl,
                        contentDescription = if (onViewProof != null) "Payment screenshot — tap to view full screen" else "Payment screenshot",
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.matchParentSize().clip(RoundedCornerShape(Radius.sm)).border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.sm)),
                    )
                    if (onViewProof != null) {
                        Box(
                            Modifier.align(Alignment.BottomEnd).padding(2.dp).background(c.scrimMedium, CircleShape).padding(2.dp),
                            contentAlignment = Alignment.Center,
                        ) { Icon(Icons.Outlined.Visibility, null, tint = Color.White, modifier = Modifier.size(12.dp)) }
                    }
                }
            }
            trailing?.invoke()
        }

        /*
         * Why a request the seller already approved is sitting in Pending again.
         *
         * Only while it IS pending: `transferErrorReason` is not cleared when a
         * later attempt succeeds, so showing it on an approved row in History
         * would report a failure that has since been fixed.
         */
        if (request.status == "pending" && request.transferErrorReason.isNotBlank()) {
            RowNotice(
                if (request.transferAttempts > 1) "${request.transferErrorReason} (${request.transferAttempts} attempts so far)"
                else request.transferErrorReason,
                c.statusWarning,
            )
        }

        if (showBalance) {
            when {
                coinBalance == null ->
                    Text("Your coin balance couldn't be read — only approve this if you know you hold the stock.", style = ZipperTheme.type.caption, color = c.textMuted)
                diamonds == null ->
                    Text("You hold ${indianGrouping(coinBalance)} coins.", style = ZipperTheme.type.caption, color = c.textSecondary)
                /*
                 * Short stock is a warning and not a disabled button.
                 *
                 * Approving an order larger than the balance does not fail
                 * loudly: the server sends the request straight back to Pending,
                 * and the buyer has already paid in cash outside the app. So the
                 * seller is told, in figures, before they tap. The button stays
                 * live because this balance can itself be stale or unread, and a
                 * seller locked out of a sale they can actually fill is a worse
                 * failure than one who was warned.
                 */
                diamonds > coinBalance ->
                    RowNotice(
                        "This order needs ${indianGrouping(diamonds)} coins and you hold ${indianGrouping(coinBalance)} — ${indianGrouping(diamonds - coinBalance)} short. " +
                            "Approving it now sends it back to Pending without delivering anything, and the buyer has already paid you. Top up first.",
                        c.statusDanger,
                    )
                else ->
                    Text("You hold ${indianGrouping(coinBalance)} coins — ${indianGrouping(coinBalance - diamonds)} left after this.", style = ZipperTheme.type.caption, color = c.textSecondary)
            }
        }

        failure?.let { RowNotice(it, c.statusDanger) }

        actions?.invoke()
    }
}

/**
 * The payment proof, full screen, pinch to zoom.
 *
 * Built here rather than reusing `profile/GalleryViewerScreen`: that one is a
 * navigation destination for a pager of profile media and it has no zoom at all,
 * which is the entire point of this viewer — the seller is reading a UPI
 * reference number off somebody's screenshot to check it against their own bank
 * app, and "bigger" is not the same as "readable".
 */
@Composable
private fun ProofViewer(url: String, onClose: () -> Unit) {
    val c = ZipperTheme.colors
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }

    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(
            Modifier.fillMaxSize().background(Color.Black)
                // Double tap is the shortcut, pinch is the real control. The tap
                // detector is the OUTER of the two so that a drag — which the
                // transform detector consumes once it passes the touch slop —
                // cancels it instead of being mistaken for a tap.
                .pointerInput(Unit) {
                    detectTapGestures(
                        onDoubleTap = {
                            if (scale > 1f) {
                                scale = 1f
                                offset = Offset.Zero
                            } else {
                                scale = 2.5f
                            }
                        },
                    )
                }
                .pointerInput(Unit) {
                    detectTransformGestures { _, pan, zoom, _ ->
                        scale = (scale * zoom).coerceIn(1f, 6f)
                        // Nothing to pan to at 1x, and letting the image drift
                        // off-centre there makes the viewer feel broken.
                        offset = if (scale <= 1f) Offset.Zero else offset + pan
                    }
                },
            contentAlignment = Alignment.Center,
        ) {
            AsyncImage(
                model = url,
                contentDescription = "Payment screenshot",
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxSize().graphicsLayer {
                    scaleX = scale
                    scaleY = scale
                    translationX = offset.x
                    translationY = offset.y
                },
            )
            Row(
                Modifier.fillMaxWidth().align(Alignment.TopStart).statusBarsPadding().padding(Space.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButtonCircle(Icons.Default.Close, "Close", onClose, background = c.scrimMedium, tint = Color.White)
                Spacer(Modifier.weight(1f))
                Box(Modifier.background(c.scrimMedium, CircleShape).padding(horizontal = Space.md, vertical = Space.xs)) {
                    Text("Pinch or double-tap to zoom", style = ZipperTheme.type.caption, color = Color.White)
                }
            }
        }
    }
}

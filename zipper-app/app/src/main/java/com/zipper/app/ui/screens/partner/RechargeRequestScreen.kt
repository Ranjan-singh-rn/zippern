package com.zipper.app.ui.screens.partner

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AddPhotoAlternate
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import coil.compose.AsyncImage
import com.zipper.app.data.repository.PartnerFunctions
import com.zipper.app.data.repository.PartnerRepository
import com.zipper.app.ui.components.TopBar
import com.zipper.app.ui.components.ZipperButton
import com.zipper.app.ui.components.clickableNoRipple
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * "I have paid this seller" — the buyer files the reference and a screenshot.
 *
 * ── WHAT HAPPENS AFTER SEND, AND WHAT DOES NOT ──────────────────────────────
 *
 * Nothing is credited here. The request goes to Zipper staff `pending`; they
 * check the payment against the seller's account and approve, and only then
 * does the API move the seller's coins to the buyer's diamonds — once, through
 * the ledger. The seller's own tap used to do this; it no longer can.
 *
 * The buyer is told at each step in Messages → Official: received, verified
 * and credited, or not approved with the reason.
 */
data class RechargeRequestUiState(
    val sellerId: String,
    val sellerName: String,
    val diamonds: String = "",
    val amount: String = "",
    val currency: String = "INR",
    val method: String = "upi",
    val reference: String = "",
    val proof: Uri? = null,
    val proofUrl: String = "",
    val uploading: Boolean = false,
    val sending: Boolean = false,
    val error: String? = null,
    val filedId: String = "",
    /**
     * RF-30: ONE id for this form, sent with every Send. The API answers a
     * repeat with the request it already filed, so a Send whose answer was
     * lost can be pressed again without filing the payment twice.
     */
    val requestId: String = "",
)

@HiltViewModel
class RechargeRequestViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val repo: PartnerRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(
        RechargeRequestUiState(
            sellerId = checkNotNull(savedStateHandle["sellerId"]),
            // B2: already decoded by Navigation; "-" is the blank-name placeholder.
            sellerName = com.zipper.app.util.RouteArgs.sellerName(savedStateHandle.get<String>("sellerName")),
            // Kept in the saved state, so a retry after the process was killed
            // is still the same request.
            requestId = savedStateHandle.get<String>(REQUEST_ID_KEY)
                ?: java.util.UUID.randomUUID().toString().also { savedStateHandle[REQUEST_ID_KEY] = it },
        ),
    )
    val state: StateFlow<RechargeRequestUiState> = _state.asStateFlow()

    fun onDiamonds(v: String) = _state.update { it.copy(diamonds = v.filter(Char::isDigit).take(7), error = null) }
    fun onAmount(v: String) = _state.update { it.copy(amount = v.filter { ch -> ch.isDigit() || ch == '.' }.take(10), error = null) }
    fun onMethod(v: String) = _state.update { it.copy(method = v, currency = if (v == "binance") "USDT" else "INR") }
    fun onReference(v: String) = _state.update { it.copy(reference = v.take(64), error = null) }

    fun onProof(uri: Uri) {
        _state.update { it.copy(proof = uri, uploading = true, error = null) }
        viewModelScope.launch {
            when (val up = repo.uploadRechargeProof(uri)) {
                is PartnerRepository.Upload.Ok -> _state.update { it.copy(proofUrl = up.url, uploading = false) }
                is PartnerRepository.Upload.Failed -> _state.update {
                    it.copy(proof = null, uploading = false, error = "The screenshot could not be uploaded: ${up.message}")
                }
            }
        }
    }

    fun send() {
        val s = _state.value
        if (s.sending || s.uploading) return
        val diamonds = s.diamonds.toIntOrNull() ?: 0
        val amountMinor = ((s.amount.toDoubleOrNull() ?: 0.0) * 100).toLong()
        val problem = when {
            diamonds <= 0 -> "Say how many diamonds you are buying."
            amountMinor <= 0 -> "Say how much you paid."
            s.reference.isBlank() && s.proofUrl.isBlank() -> "Add the payment reference (UTR / transaction id) or a screenshot."
            else -> null
        }
        if (problem != null) { _state.update { it.copy(error = problem) }; return }
        _state.update { it.copy(sending = true, error = null) }
        viewModelScope.launch {
            val res = repo.submitRechargeRequest(
                s.sellerId, diamonds, amountMinor, s.currency, s.method, s.reference.trim(), s.proofUrl,
                requestId = s.requestId,
            )
            _state.update {
                when (res) {
                    is PartnerFunctions.Result.Ok -> it.copy(sending = false, filedId = res.value.id)
                    // RF-30: it may have been filed — and Send again cannot file it twice.
                    is PartnerFunctions.Result.Failed -> it.copy(
                        sending = false,
                        error = if (res.outcomeUnknown) FilingConfirmation.RECHARGE_NOT_CONFIRMED else res.userMessage,
                    )
                }
            }
        }
    }

    private companion object {
        const val REQUEST_ID_KEY = "rechargeRequestId"
    }
}

private val METHODS = listOf("upi" to "UPI", "bank" to "Bank transfer", "binance" to "Binance", "cash" to "Cash", "other" to "Other")

@Composable
fun RechargeRequestScreen(
    onBack: () -> Unit,
    onDone: () -> Unit,
    viewModel: RechargeRequestViewModel = hiltViewModel(),
) {
    val c = ZipperTheme.colors
    val state by viewModel.state.collectAsStateWithLifecycle()
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
        uri?.let(viewModel::onProof)
    }

    Column(Modifier.fillMaxSize().background(c.bgBase).statusBarsPadding()) {
        TopBar("I have paid", onBack = onBack)

        if (state.filedId.isNotBlank()) {
            Column(
                Modifier.fillMaxSize().padding(Space.xl),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(Space.md),
            ) {
                Spacer(Modifier.height(Space.x5l))
                Icon(Icons.Outlined.CheckCircle, null, tint = c.statusSuccess, modifier = Modifier.size(48.dp))
                Text("Request sent", style = ZipperTheme.type.headingM, color = c.textPrimary)
                Text(
                    "Zipper is verifying your payment with ${state.sellerName.ifBlank { "the seller" }}. " +
                    "Diamonds are credited as soon as it is confirmed — you will be told in Messages → Official.",
                    style = ZipperTheme.type.bodyM, color = c.textSecondary, textAlign = TextAlign.Center,
                )
                Text("Reference: ${state.filedId}", style = ZipperTheme.type.caption, color = c.textMuted)
                Spacer(Modifier.height(Space.lg))
                ZipperButton("Done", onClick = onDone, fullWidth = true)
            }
            return@Column
        }

        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).imePadding()
                .padding(horizontal = Space.lg, vertical = Space.md),
            verticalArrangement = Arrangement.spacedBy(Space.lg),
        ) {
            Text(
                "Paid ${state.sellerName.ifBlank { "the seller" }}? Tell us how much and how, and attach the " +
                "reference or a screenshot. Zipper verifies the payment before diamonds are credited.",
                style = ZipperTheme.type.bodyS, color = c.textSecondary,
            )

            Line("Diamonds you are buying", state.diamonds, viewModel::onDiamonds, "e.g. 500", KeyboardType.Number)
            Line("Amount paid (${state.currency})", state.amount, viewModel::onAmount, "e.g. 499", KeyboardType.Decimal)

            Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                Text("How you paid", style = ZipperTheme.type.labelM, color = c.textSecondary)
                Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    METHODS.take(3).forEach { (k, l) -> Pill(l, state.method == k) { viewModel.onMethod(k) } }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    METHODS.drop(3).forEach { (k, l) -> Pill(l, state.method == k) { viewModel.onMethod(k) } }
                }
            }

            Line("Payment reference (UTR / transaction id)", state.reference, viewModel::onReference, "From your bank or UPI app")

            Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                Text("Screenshot of the payment", style = ZipperTheme.type.labelM, color = c.textSecondary)
                Row(
                    Modifier.fillMaxWidth()
                        .background(c.bgElevated, RoundedCornerShape(Radius.lg))
                        .border(1.dp, if (state.proofUrl.isNotBlank()) c.statusSuccess else c.borderSubtle, RoundedCornerShape(Radius.lg))
                        .clickableNoRipple { if (!state.uploading) picker.launch("image/*") }
                        .padding(Space.md),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Space.md),
                ) {
                    if (state.proof != null) {
                        AsyncImage(model = state.proof, contentDescription = "Payment proof",
                            modifier = Modifier.size(56.dp).background(c.bgBase, RoundedCornerShape(Radius.md)))
                    } else {
                        Box(Modifier.size(56.dp).background(c.bgBase, RoundedCornerShape(Radius.md)), contentAlignment = Alignment.Center) {
                            Icon(Icons.Outlined.AddPhotoAlternate, null, tint = c.textMuted, modifier = Modifier.size(22.dp))
                        }
                    }
                    Text(
                        when { state.uploading -> "Uploading…"; state.proofUrl.isNotBlank() -> "Attached"; else -> "Tap to attach" },
                        style = ZipperTheme.type.labelM,
                        color = if (state.proofUrl.isNotBlank()) c.statusSuccess else c.textPrimary,
                        modifier = Modifier.weight(1f),
                    )
                    if (state.uploading) CircularProgressIndicator(color = c.brandPrimary, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                }
                Text("A reference or a screenshot — at least one. Both is best.", style = ZipperTheme.type.caption, color = c.textMuted)
            }

            state.error?.let { Text(it, style = ZipperTheme.type.bodyS, color = c.statusDanger) }

            ZipperButton(
                "Send for verification",
                onClick = viewModel::send,
                gradient = true, fullWidth = true,
                enabled = !state.sending && !state.uploading,
                loading = state.sending,
            )
            Spacer(Modifier.height(Space.x5l))
        }
    }
}

@Composable
private fun Line(label: String, value: String, onValueChange: (String) -> Unit, placeholder: String, keyboardType: KeyboardType = KeyboardType.Text) {
    val c = ZipperTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        Text(label, style = ZipperTheme.type.labelM, color = c.textSecondary)
        Row(
            Modifier.fillMaxWidth().heightIn(min = 56.dp)
                .background(c.bgElevated, RoundedCornerShape(Radius.lg))
                .border(1.dp, c.borderDefault, RoundedCornerShape(Radius.lg))
                .padding(horizontal = Space.lg, vertical = Space.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BasicTextField(
                value = value, onValueChange = onValueChange, singleLine = true,
                textStyle = ZipperTheme.type.bodyL.copy(color = c.textPrimary),
                cursorBrush = SolidColor(c.brandPrimary),
                keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
                modifier = Modifier.fillMaxWidth(),
                decorationBox = { inner ->
                    if (value.isEmpty()) Text(placeholder, style = ZipperTheme.type.bodyL, color = c.textMuted)
                    inner()
                },
            )
        }
    }
}

@Composable
private fun Pill(text: String, on: Boolean, onClick: () -> Unit) {
    val c = ZipperTheme.colors
    Box(
        Modifier.background(if (on) c.brandPrimary else c.bgElevated, CircleShape)
            .border(1.dp, if (on) c.brandPrimary else c.borderSubtle, CircleShape)
            .clickableNoRipple(onClick)
            .padding(horizontal = Space.md, vertical = Space.sm),
    ) {
        Text(text, style = ZipperTheme.type.labelS, color = if (on) Color.White else c.textSecondary)
    }
}

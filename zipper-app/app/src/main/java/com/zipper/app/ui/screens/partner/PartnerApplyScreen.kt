package com.zipper.app.ui.screens.partner

import android.net.Uri
import androidx.activity.compose.BackHandler
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
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import com.zipper.app.ui.components.ButtonStyle
import com.zipper.app.ui.components.TopBar
import com.zipper.app.ui.components.ZipperButton
import com.zipper.app.ui.components.clickableNoRipple
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme

/**
 * The application form. One screen, four roles — see [PartnerApplyViewModel]
 * for the steps each role walks and why the fields are what they are.
 */
@Composable
fun PartnerApplyScreen(
    onBack: () -> Unit,
    onDone: () -> Unit,
    /** Approved contact rule: open phone verification; it returns to this form when done. */
    onVerifyPhone: () -> Unit = {},
    /** Approved contact rule: open email verification; it returns to this form when done. */
    onVerifyEmail: () -> Unit = {},
    viewModel: PartnerApplyViewModel = hiltViewModel(),
) {
    val c = ZipperTheme.colors
    val state by viewModel.state.collectAsStateWithLifecycle()

    // Back from phone / email verification: re-read the identity and let the
    // same form be submitted again (approved contact rule).
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) viewModel.onResumed()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    // Back steps backwards through the form before it leaves the screen.
    BackHandler(enabled = state.step != ApplyStep.DONE) { if (!viewModel.back()) onBack() }

    val title = when (state.kind) {
        "agency" -> "Apply as Agency"
        "sub_agency" -> "Apply as Sub-agency"
        "seller" -> "Apply as Coin Seller"
        else -> "Apply as Host"
    }

    Column(Modifier.fillMaxSize().background(c.bgBase).statusBarsPadding()) {
        TopBar(title, onBack = { if (state.step == ApplyStep.DONE || !viewModel.back()) onBack() })

        StepIndicator(state)

        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).imePadding()
                .padding(horizontal = Space.lg, vertical = Space.md),
            verticalArrangement = Arrangement.spacedBy(Space.lg),
        ) {
            when (state.step) {
                ApplyStep.BASIC -> BasicStep(state, viewModel)
                ApplyStep.PROFILE -> ProfileStep(state, viewModel)
                ApplyStep.DOCS -> DocsStep(state, viewModel)
                ApplyStep.PAYMENT -> PaymentStep(state, viewModel)
                ApplyStep.DONE -> DoneStep(state, onDone)
            }

            if (state.step != ApplyStep.DONE) {
                val contact = state.contactRequired
                if (contact != null) {
                    // Approved contact rule: say what is missing and open verification.
                    ContactRequiredCard(contact, onVerifyPhone = onVerifyPhone, onVerifyEmail = onVerifyEmail)
                } else {
                    state.error?.let { Text(it, style = ZipperTheme.type.bodyS, color = c.statusDanger) }
                }
                val last = state.steps.indexOf(state.step) == state.steps.size - 2
                ZipperButton(
                    if (last) "Submit application" else "Continue",
                    onClick = viewModel::next,
                    gradient = true, fullWidth = true,
                    enabled = !state.submitting && state.uploading.isEmpty(),
                    loading = state.submitting,
                )
                Spacer(Modifier.height(Space.x5l))
            }
        }
    }
}

// ── Steps ───────────────────────────────────────────────────────────────────

@Composable
private fun StepIndicator(state: PartnerApplyUiState) {
    val c = ZipperTheme.colors
    val visible = state.steps.filter { it != ApplyStep.DONE }
    val current = state.steps.indexOf(state.step)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Space.lg, vertical = Space.sm),
        horizontalArrangement = Arrangement.spacedBy(Space.xs),
    ) {
        visible.forEachIndexed { i, _ ->
            Box(
                Modifier.weight(1f).height(4.dp)
                    .background(if (i <= current) c.brandPrimary else c.bgElevated, CircleShape),
            )
        }
    }
    val names = visible.map { stepName(state.kind, it) }
    Text(
        "Step ${minOf(current + 1, names.size)} of ${names.size} · ${names.getOrNull(current) ?: "Done"}",
        style = ZipperTheme.type.caption, color = c.textMuted,
        modifier = Modifier.padding(horizontal = Space.lg),
    )
}

private fun stepName(kind: String, step: ApplyStep) = when (step) {
    ApplyStep.BASIC -> if (kind == "host") "Agency & identity" else "Basic information"
    ApplyStep.PROFILE -> "Profile"
    ApplyStep.DOCS -> if (kind == "seller") "ID proof" else "KYC documents"
    ApplyStep.PAYMENT -> when (kind) { "seller" -> "Payment details"; "host" -> "Rate & payout"; else -> "Banking information" }
    ApplyStep.DONE -> "Done"
}

@Composable
private fun BasicStep(state: PartnerApplyUiState, vm: PartnerApplyViewModel) {
    val c = ZipperTheme.colors
    // What the account already knows — shown, not asked.
    IdentityCard(state)

    // Host picks its agency first (it decides everything after). A Sub-agency
    // picks its MAIN agency last, after banking — the order the product spec
    // gives: Basic → KYC → Banking → Select MAIN Agency → Done.
    if (state.kind == "host") ParentPicker(state, vm)

    when (state.kind) {
        "seller" -> {
            Field("Shop / display name", state.f("displayName"), { vm.set("displayName", it) }, "How buyers will see you")
            Field("City", state.f("city"), { vm.set("city", it) }, "Where you operate")
            Field("About you (optional)", state.f("description"), { vm.set("description", it) }, "A line buyers will read", singleLine = false)
        }
        "host" -> {
            Field("Your name", state.f("hostName"), { vm.set("hostName", it) }, "As on your ID")
        }
        else -> {
            Field(if (state.kind == "sub_agency") "Sub-agency name" else "Agency name", state.f("agencyName"), { vm.set("agencyName", it) }, "The business name")
            Field("Owner's name", state.f("ownerName"), { vm.set("ownerName", it) }, "As on your ID")
            Field("Address", state.f("address"), { vm.set("address", it) }, "Registered address", singleLine = false)
        }
    }
    Text(
        when (state.kind) {
            "sub_agency" -> "A sub-agency sits under one main agency. Your hosts and your earnings are routed through it."
            "host" -> "You will be a Host under the agency you pick. After approval you complete facial verification to become a verified Host."
            "seller" -> "Coin Sellers receive payments from buyers directly and are settled by Zipper. Staff verify every recharge before diamonds are credited."
            else -> "An agency recruits hosts and sub-agencies and earns commission on their work."
        },
        style = ZipperTheme.type.caption, color = c.textMuted,
    )
}

@Composable
private fun ProfileStep(state: PartnerApplyUiState, vm: PartnerApplyViewModel) {
    Field("Age", state.f("age"), { vm.set("age", it.filter(Char::isDigit).take(3)) }, "18 or over", KeyboardType.Number)
    Field("Date of birth (optional)", state.f("dob"), { vm.set("dob", it) }, "DD/MM/YYYY")
    Field("Country", state.f("country"), { vm.set("country", it) }, "e.g. India")
    DocPicker("Reference photo", "A clear, recent photo of your face. Used for facial verification.", "photo", state, vm, imageOnly = true)
}

@Composable
private fun DocsStep(state: PartnerApplyUiState, vm: PartnerApplyViewModel) {
    val india = state.isIndia
    if (state.kind == "seller") {
        DocPicker("Government photo ID", "Aadhaar, PAN, Voter ID or passport.", "proof", state, vm)
    } else {
        DocPicker(if (india) "Aadhaar card" else "Passport", "Front side, readable.", "doc1", state, vm)
        DocPicker(if (india) "PAN card" else "Government / national ID", "", "doc2", state, vm)
        DocPicker(if (india) "Bank passbook" else "Proof of address", "", "doc3", state, vm)
    }
}

@Composable
private fun PaymentStep(state: PartnerApplyUiState, vm: PartnerApplyViewModel) {
    val c = ZipperTheme.colors
    if (state.kind == "seller") {
        Text(
            "How buyers pay you. Add every method you accept; UPI, QR and Binance are shown to buyers. " +
            "Bank details are seen only by Zipper staff.",
            style = ZipperTheme.type.bodyS, color = c.textSecondary,
        )
        Field("UPI id", state.f("upiId"), { vm.set("upiId", it) }, "name@bank")
        DocPicker("UPI QR code", "A screenshot of your UPI QR.", "upiQr", state, vm, imageOnly = true)
        Field("Binance UID (optional)", state.f("binanceUid"), { vm.set("binanceUid", it) }, "For USDT")
        Field("Bank account number (optional)", state.f("accountNumber"), { vm.set("accountNumber", it) }, "", KeyboardType.Number)
        Field("IFSC", state.f("ifscCode"), { vm.set("ifscCode", it.uppercase()) }, "")
        Field("Bank name", state.f("bankName"), { vm.set("bankName", it) }, "")
        Field("Account holder name", state.f("accountHolderName"), { vm.set("accountHolderName", it) }, "")
        Field("International method (optional)", state.f("internationalMethod"), { vm.set("internationalMethod", it) }, "e.g. Wise, PayPal")
        Field("International details", state.f("internationalDetails"), { vm.set("internationalDetails", it) }, "Address or handle")
        return
    }

    if (state.kind == "host") {
        Field("Call rate (beans per minute, optional)", state.f("callRate"), { vm.set("callRate", it.filter(Char::isDigit)) }, "Your agency may set this", KeyboardType.Number)
    }
    Text("Where you are paid", style = ZipperTheme.type.labelM, color = c.textPrimary)
    Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
        Toggle("India (bank)", state.isIndia) { vm.set("paymentType", "india") }
        Toggle("International (Binance)", !state.isIndia) { vm.set("paymentType", "foreign") }
    }
    if (state.isIndia) {
        Field("Account holder name", state.f("accountHolderName"), { vm.set("accountHolderName", it) }, "")
        Field("Account number", state.f("accountNumber"), { vm.set("accountNumber", it) }, "", KeyboardType.Number)
        Field("Confirm account number", state.f("confirmAccountNumber"), { vm.set("confirmAccountNumber", it) }, "", KeyboardType.Number)
        Field("IFSC", state.f("ifscCode"), { vm.set("ifscCode", it.uppercase()) }, "")
        Field("Bank name", state.f("bankName"), { vm.set("bankName", it) }, "")
        Field("Branch", state.f("branch"), { vm.set("branch", it) }, "")
        Field("UPI id (optional)", state.f("upiId"), { vm.set("upiId", it) }, "")
    } else {
        Field("Country", state.f("country"), { vm.set("country", it) }, "")
        Field("Binance UID", state.f("binanceUid"), { vm.set("binanceUid", it) }, "")
    }

    // Sub-agency: the one relationship field, last before submit. The list is
    // the server's (approved, active MAIN agencies only); the server validates
    // the choice again when the application arrives.
    if (state.kind == "sub_agency") ParentPicker(state, vm)
}

@Composable
private fun DoneStep(state: PartnerApplyUiState, onDone: () -> Unit) {
    val c = ZipperTheme.colors
    Column(
        Modifier.fillMaxWidth().padding(top = Space.x5l),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Icon(Icons.Outlined.CheckCircle, null, tint = c.statusSuccess, modifier = Modifier.size(48.dp))
        Text("Application sent", style = ZipperTheme.type.headingM, color = c.textPrimary)
        Text(
            "A reviewer at Zipper will check it. You will be told the outcome in Messages → Official." +
            if (state.kind == "host") " If approved, complete facial verification from your profile to become a verified Host." else "",
            style = ZipperTheme.type.bodyM, color = c.textSecondary, textAlign = TextAlign.Center,
        )
        if (state.filedId.isNotBlank()) {
            Text("Reference: ${state.filedId}", style = ZipperTheme.type.caption, color = c.textMuted)
        }
        Spacer(Modifier.height(Space.lg))
        ZipperButton("Done", onClick = onDone, fullWidth = true)
    }
}

// ── Pieces ──────────────────────────────────────────────────────────────────

@Composable
private fun IdentityCard(state: PartnerApplyUiState) {
    val c = ZipperTheme.colors
    Column(
        Modifier.fillMaxWidth().background(c.bgElevated, RoundedCornerShape(Radius.lg))
            .border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.lg)).padding(Space.md),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text("Applying as", style = ZipperTheme.type.caption, color = c.textMuted)
        if (state.identityPhone.isNotBlank()) Text(state.identityPhone, style = ZipperTheme.type.labelM, color = c.textPrimary)
        if (state.identityEmail.isNotBlank()) Text(state.identityEmail, style = ZipperTheme.type.labelM, color = c.textPrimary)
        if (state.identityPhone.isBlank() && state.identityEmail.isBlank()) {
            Text("Your signed-in account", style = ZipperTheme.type.labelM, color = c.textPrimary)
        }
        Text("Taken from your account — nothing to type again.", style = ZipperTheme.type.caption, color = c.textMuted)
    }
}

@Composable
private fun ParentPicker(state: PartnerApplyUiState, vm: PartnerApplyViewModel) {
    val c = ZipperTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        Text(
            if (state.kind == "host") "Select agency or sub-agency" else "Select agency",
            style = ZipperTheme.type.labelM, color = c.textPrimary,
        )
        when {
            state.parentsLoading -> CircularProgressIndicator(color = c.brandPrimary, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
            state.parents.isEmpty() -> Text(
                "No agencies are accepting applications right now.",
                style = ZipperTheme.type.bodyS, color = c.textMuted,
            )
            else -> state.parents.forEach { p ->
                val on = state.parent?.id == p.id
                Row(
                    Modifier.fillMaxWidth()
                        .background(if (on) c.tintDiamondSubtle else c.bgElevated, RoundedCornerShape(Radius.md))
                        .border(1.dp, if (on) c.currencyDiamond else c.borderSubtle, RoundedCornerShape(Radius.md))
                        .clickableNoRipple { vm.choose(p) }
                        .padding(Space.md),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(p.name, style = ZipperTheme.type.labelM, color = c.textPrimary)
                        Text(
                            if (p.kind == "sub_agency") "Sub-agency" + (if (p.parentName.isNotBlank()) " of ${p.parentName}" else "") else "Main agency",
                            style = ZipperTheme.type.caption, color = c.textSecondary,
                        )
                    }
                    if (on) Icon(Icons.Outlined.Check, null, tint = c.currencyDiamond, modifier = Modifier.size(18.dp))
                }
            }
        }
    }
}

@Composable
private fun Field(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    keyboardType: KeyboardType = KeyboardType.Text,
    singleLine: Boolean = true,
) {
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
                value = value, onValueChange = onValueChange, singleLine = singleLine,
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
private fun Toggle(text: String, on: Boolean, onClick: () -> Unit) {
    val c = ZipperTheme.colors
    Box(
        Modifier.background(if (on) c.brandPrimary else c.bgElevated, CircleShape)
            .border(1.dp, if (on) c.brandPrimary else c.borderSubtle, CircleShape)
            .clickableNoRipple(onClick)
            .padding(horizontal = Space.md, vertical = Space.sm),
    ) {
        Text(text, style = ZipperTheme.type.labelS, color = if (on) androidx.compose.ui.graphics.Color.White else c.textSecondary)
    }
}

@Composable
private fun DocPicker(
    label: String,
    hint: String,
    slot: String,
    state: PartnerApplyUiState,
    vm: PartnerApplyViewModel,
    imageOnly: Boolean = false,
) {
    val c = ZipperTheme.colors
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
        uri?.let { vm.pick(slot, it) }
    }
    val uploading = slot in state.uploading
    val done = slot in state.uploaded
    Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        Text(label, style = ZipperTheme.type.labelM, color = c.textSecondary)
        Row(
            Modifier.fillMaxWidth()
                .background(c.bgElevated, RoundedCornerShape(Radius.lg))
                .border(1.dp, if (done) c.statusSuccess else c.borderSubtle, RoundedCornerShape(Radius.lg))
                .clickableNoRipple { if (!uploading) picker.launch(if (imageOnly) "image/*" else "image/*") }
                .padding(Space.md),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            val local = state.picked[slot]
            if (local != null) {
                AsyncImage(model = local, contentDescription = label,
                    modifier = Modifier.size(56.dp).background(c.bgBase, RoundedCornerShape(Radius.md)))
            } else {
                Box(Modifier.size(56.dp).background(c.bgBase, RoundedCornerShape(Radius.md)), contentAlignment = Alignment.Center) {
                    Icon(Icons.Outlined.AddPhotoAlternate, null, tint = c.textMuted, modifier = Modifier.size(22.dp))
                }
            }
            Column(Modifier.weight(1f)) {
                Text(
                    when { uploading -> "Uploading…"; done -> "Uploaded"; else -> "Tap to choose a photo" },
                    style = ZipperTheme.type.labelM, color = if (done) c.statusSuccess else c.textPrimary,
                )
                if (hint.isNotBlank()) Text(hint, style = ZipperTheme.type.caption, color = c.textMuted)
            }
            if (uploading) CircularProgressIndicator(color = c.brandPrimary, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
        }
    }
}

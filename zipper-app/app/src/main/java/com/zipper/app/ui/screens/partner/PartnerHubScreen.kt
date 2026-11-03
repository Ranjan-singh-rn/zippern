package com.zipper.app.ui.screens.partner

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.Star
import androidx.compose.material.icons.outlined.Storefront
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.zipper.app.data.repository.PartnerFunctions
import com.zipper.app.data.repository.RoleAppealStatement
import com.zipper.app.ui.components.ButtonStyle
import com.zipper.app.ui.components.Chip
import com.zipper.app.ui.components.LoadingState
import com.zipper.app.ui.components.TopBar
import com.zipper.app.ui.components.ZipperButton
import com.zipper.app.ui.components.clickableNoRipple
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme

/**
 * "Become a partner" — the four roles, offered or greyed out according to the
 * server, plus the applications this person already has.
 *
 *   Normal user                → Join as Host / Agency / Sub-agency / Coin Seller
 *   Host under a main agency   → Sub-agency, Coin Seller
 *   Host under a sub-agency    → Coin Seller
 *   Agency / Sub-agency        → Coin Seller
 *   Coin Seller                → Host, Agency, Sub-agency
 *
 * A blocked choice stays visible with the server's sentence beside it, so a
 * person is told WHY rather than left wondering where the button went.
 *
 * There is no "enter an agency code" route here: a Host joins by applying and
 * choosing an agency or sub-agency. ZIPPER staff accounts are offered nothing —
 * the server returns no options for them and this screen says so, so an old
 * link or deep link into the hub cannot reach an application form.
 *
 * A REVOKED role (C1/C2, B04) is shown as revoked, with its reason and either
 * the open reinstatement request or "Request reinstatement" — never as a role
 * to apply for again. See [PartnerHubRows].
 */
@Composable
fun PartnerHubScreen(
    onBack: () -> Unit,
    onApply: (kind: String) -> Unit,
    /** Approved contact rule: open phone verification; it returns here when done. */
    onVerifyPhone: () -> Unit = {},
    /** Approved contact rule: open email verification; it returns here when done. */
    onVerifyEmail: () -> Unit = {},
    viewModel: PartnerHubViewModel = hiltViewModel(),
) {
    val c = ZipperTheme.colors
    val state by viewModel.state.collectAsStateWithLifecycle()

    /*
     * Re-read whenever the hub comes back to the front — above all after an
     * application form pops back here, which reuses this view model and used
     * to leave the hub showing the state from before the person applied.
     */
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) viewModel.onResumed()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val appealKind = state.appealKind
    if (appealKind != null) {
        ReinstatementDialog(
            kind = appealKind,
            statement = state.appealStatement,
            sending = state.appealSending,
            error = state.appealError,
            onStatement = viewModel::onAppealStatement,
            onSend = viewModel::submitAppeal,
            onDismiss = viewModel::closeAppeal,
        )
    }

    Column(Modifier.fillMaxSize().background(c.bgBase).statusBarsPadding()) {
        TopBar("Become a partner", onBack = onBack)

        when {
            state.loading -> LoadingState()
            state.eligibility == null -> Column(
                Modifier.fillMaxSize().padding(Space.xl),
                verticalArrangement = Arrangement.spacedBy(Space.md),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    state.error ?: "Could not load your options.",
                    style = ZipperTheme.type.bodyM, color = c.statusDanger,
                )
                ZipperButton("Try again", onClick = viewModel::refresh, fullWidth = true)
            }
            else -> Content(
                state, onApply,
                onRequestReinstatement = viewModel::openAppeal,
                onVerifyPhone = onVerifyPhone,
                onVerifyEmail = onVerifyEmail,
            )
        }
    }
}

private data class RoleOption(
    val kind: String,
    val title: String,
    val blurb: String,
    val icon: ImageVector,
)

private val ROLES = listOf(
    RoleOption("host", "Join as Host", "Go live and earn beans under an agency or sub-agency.", Icons.Outlined.Star),
    RoleOption("agency", "Join as Agency", "Recruit hosts and sub-agencies; earn commission on their work.", Icons.Outlined.Groups),
    RoleOption("sub_agency", "Join as Sub-agency", "Recruit hosts under a main agency you choose.", Icons.Outlined.Groups),
    RoleOption("seller", "Join as Coin Seller", "Sell diamonds to users and settle with Zipper.", Icons.Outlined.Storefront),
)

// One spelling of the role names, shared with the pure mapping and its test.
private fun label(kind: String) = PartnerHubRows.label(kind)

@Composable
private fun Content(
    state: PartnerHubUiState,
    onApply: (String) -> Unit,
    onRequestReinstatement: (String) -> Unit,
    onVerifyPhone: () -> Unit,
    onVerifyEmail: () -> Unit,
) {
    val c = ZipperTheme.colors
    val elig = state.eligibility ?: return

    // Staff are never partners. Nothing to choose, nothing to tap.
    if (elig.isInternal) {
        Column(
            Modifier.fillMaxSize().padding(Space.xl),
            verticalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            Text("Not available for staff accounts", style = ZipperTheme.type.labelM, color = c.textPrimary)
            Text(
                "ZIPPER staff accounts cannot hold Host, Agency, Sub-agency or Coin Seller roles.",
                style = ZipperTheme.type.bodyS, color = c.textSecondary,
            )
        }
        return
    }

    // Held, revoked and the four choices, decided in one pure place (C1/C2).
    val model = remember(elig, state.roleAppeals) { PartnerHubRows.build(elig, state.roleAppeals) }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = Space.lg),
        verticalArrangement = Arrangement.spacedBy(Space.lg),
    ) {
        // ── What they already hold ───────────────────────────────────────
        // Live roles only: a revoked one is listed below as revoked, never as
        // a chip that reads like it still works.
        val held = model.held
        if (held.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                Text("Your roles", style = ZipperTheme.type.labelM, color = c.textSecondary)
                Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    held.forEach { Chip(it, tint = c.tintDiamondSubtle, contentColor = c.currencyDiamond) }
                }
            }
        }

        // ── Decision 15 (RC): approved, waiting for BOTH verified contacts ─
        if (model.awaiting.isNotEmpty()) {
            AwaitingRolesCard(
                rows = model.awaiting,
                requirement = state.activation ?: elig.activation,
                onVerifyPhone = onVerifyPhone,
                onVerifyEmail = onVerifyEmail,
            )
        }

        // ── Revoked roles (C1/C2) ────────────────────────────────────────
        if (model.revoked.isNotEmpty()) {
            RevokedRoles(model.revoked, onRequestReinstatement)
        }
        state.notice?.let { notice ->
            Text(notice, style = ZipperTheme.type.bodyS, color = c.statusSuccess)
        }

        // ── Approved contact rule ────────────────────────────────────────
        // No verified phone or email: say what is missing and open the
        // verification flow, which returns here (the hub re-reads on resume).
        elig.contact?.takeIf { it.required }?.let { contact ->
            ContactRequiredCard(contact, onVerifyPhone = onVerifyPhone, onVerifyEmail = onVerifyEmail)
        }

        Text(
            "Choose a role to apply for. A reviewer at Zipper checks every application; you " +
            "will be told the outcome in Messages → Official.",
            style = ZipperTheme.type.bodyS, color = c.textSecondary,
        )
        // Decision 15 (RC): said BEFORE the form — an approved role starts only
        // once both contacts are verified, so nobody is surprised by a role
        // that was approved and has not started.
        elig.activation?.beforeApplying?.takeIf { it.isNotBlank() && model.awaiting.isEmpty() }?.let { note ->
            Text(note, style = ZipperTheme.type.caption, color = c.textSecondary)
        }

        // ── The four choices ─────────────────────────────────────────────
        // A revoked kind is never offered as a first application, whatever the
        // options list says; its row stays, greyed, with the server's sentence.
        ROLES.forEach { role ->
            val choice = model.choice(role.kind)
            val allowed = choice?.canApply == true
            val why = choice?.blockedReason
            Row(
                Modifier.fillMaxWidth()
                    .background(c.bgElevated, RoundedCornerShape(Radius.lg))
                    .border(1.dp, if (allowed) c.borderSubtle else c.borderSubtle.copy(alpha = 0.5f), RoundedCornerShape(Radius.lg))
                    .then(if (allowed) Modifier.clickableNoRipple { onApply(role.kind) } else Modifier)
                    .padding(Space.md),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Space.md),
            ) {
                Box(
                    Modifier.size(40.dp).background(c.bgBase, RoundedCornerShape(Radius.sm)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(role.icon, null, tint = if (allowed) c.brandVip else c.textMuted, modifier = Modifier.size(20.dp))
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(role.title, style = ZipperTheme.type.labelM, color = if (allowed) c.textPrimary else c.textMuted)
                    Text(
                        if (allowed) role.blurb else (why ?: "Not available with the roles you hold."),
                        style = ZipperTheme.type.caption,
                        color = if (allowed) c.textSecondary else c.textMuted,
                    )
                }
                if (allowed) Icon(Icons.Default.ChevronRight, null, tint = c.textMuted, modifier = Modifier.size(18.dp))
            }
        }

        // ── Applications in flight / decided ─────────────────────────────
        if (state.applications.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                Text("Your applications", style = ZipperTheme.type.labelM, color = c.textSecondary)
                state.applications.forEach { a ->
                    val tint = when (a.status) {
                        "approved" -> c.statusSuccess
                        "pending", PartnerHubRows.AWAITING -> c.statusWarning
                        "rejected", "revoked" -> c.statusDanger
                        else -> c.textMuted
                    }
                    Column(
                        Modifier.fillMaxWidth()
                            .background(c.bgElevated, RoundedCornerShape(Radius.md))
                            .border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.md))
                            .padding(Space.md),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(label(a.kind) + (if (a.name.isNotBlank()) " · ${a.name}" else ""), style = ZipperTheme.type.labelM, color = c.textPrimary, modifier = Modifier.weight(1f))
                            Chip(
                                if (a.status == PartnerHubRows.AWAITING) "Approved · waiting"
                                else a.status.replaceFirstChar { it.uppercase() },
                                tint = tint.copy(alpha = 0.14f), contentColor = tint,
                            )
                        }
                        val reason = a.rejectionReason.ifBlank { a.revocationReason }
                        if (reason.isNotBlank()) {
                            Text("Reason: $reason", style = ZipperTheme.type.caption, color = c.textSecondary)
                        }
                        if (a.status == "pending") {
                            Text("With a reviewer. You will be told here and in Messages.", style = ZipperTheme.type.caption, color = c.textSecondary)
                        }
                        if (a.status == PartnerHubRows.AWAITING) {
                            // QA #34: say what is actually still missing — the
                            // same line as the banner above, not always "both".
                            Text(
                                (state.activation ?: elig.activation)?.waitingLine
                                    ?: "Approved. It starts once both your phone number and your email address are verified.",
                                style = ZipperTheme.type.caption, color = c.textSecondary,
                            )
                        }
                    }
                }
            }
        }

        Spacer(Modifier.height(Space.x5l))
    }
}

/**
 * "Agency · Revoked", why, and the one thing that can be done about it.
 *
 * Each row shows EITHER where an open reinstatement request stands OR the
 * button to make one — never both, so a second request cannot be filed over
 * one that is already with a reviewer.
 */
@Composable
private fun RevokedRoles(
    rows: List<PartnerHubRows.RevokedRow>,
    onRequest: (String) -> Unit,
) {
    val c = ZipperTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        Text("Revoked roles", style = ZipperTheme.type.labelM, color = c.textSecondary)
        rows.forEach { row ->
            Column(
                Modifier.fillMaxWidth()
                    .background(c.bgElevated, RoundedCornerShape(Radius.md))
                    .border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.md))
                    .padding(Space.md),
                verticalArrangement = Arrangement.spacedBy(Space.sm),
            ) {
                Text(row.title, style = ZipperTheme.type.labelM, color = c.statusDanger)
                if (row.reason.isNotBlank()) {
                    Text("Reason: ${row.reason}", style = ZipperTheme.type.caption, color = c.textSecondary)
                }
                when (val r = row.reinstatement) {
                    is PartnerHubRows.Reinstatement.CanRequest -> {
                        if (r.lastDeclined) {
                            Text(
                                "Your last request to restore it was not accepted." +
                                    if (r.note.isNotBlank()) " ${r.note}" else "",
                                style = ZipperTheme.type.caption, color = c.textSecondary,
                            )
                        }
                        ZipperButton(
                            "Request reinstatement",
                            onClick = { onRequest(row.kind) },
                            style = ButtonStyle.Secondary,
                            fullWidth = true,
                        )
                    }
                    is PartnerHubRows.Reinstatement.Open ->
                        Text(r.label, style = ZipperTheme.type.caption, color = c.statusWarning)
                    PartnerHubRows.Reinstatement.Restored ->
                        Text(
                            "Restored. It will show under Your roles shortly.",
                            style = ZipperTheme.type.caption, color = c.statusSuccess,
                        )
                }
            }
        }
    }
}

/**
 * The reinstatement statement — what the reviewer reads (C2).
 *
 * The same shape as the appeal form on the restriction screens: a field, a
 * live count against the bounds, and a Send that is live only when the server
 * would accept what is in the box (20–2,000 characters, [RoleAppealStatement]).
 */
@Composable
private fun ReinstatementDialog(
    kind: String,
    statement: String,
    sending: Boolean,
    error: String?,
    onStatement: (String) -> Unit,
    onSend: () -> Unit,
    onDismiss: () -> Unit,
) {
    val c = ZipperTheme.colors
    val typed = RoleAppealStatement.length(statement)
    val sendable = RoleAppealStatement.isSendable(statement)
    AlertDialog(
        onDismissRequest = { if (!sending) onDismiss() },
        containerColor = c.bgElevated,
        title = {
            Text("Restore your ${label(kind)} role?", style = ZipperTheme.type.headingS, color = c.textPrimary)
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                Text(
                    "Tell us why it should be given back. A reviewer reads every request and " +
                        "the Owner makes the decision. Nothing changes until then.",
                    style = ZipperTheme.type.bodyS, color = c.textSecondary,
                )
                Box(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 120.dp)
                        .background(c.bgBase, RoundedCornerShape(Radius.lg))
                        .border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.lg))
                        .padding(Space.md),
                ) {
                    BasicTextField(
                        value = statement,
                        onValueChange = onStatement,
                        textStyle = ZipperTheme.type.bodyM.copy(color = c.textPrimary),
                        cursorBrush = SolidColor(c.brandPrimary),
                        modifier = Modifier.fillMaxWidth(),
                        decorationBox = { inner ->
                            if (statement.isEmpty()) {
                                Text(
                                    "Why should this role be restored?",
                                    style = ZipperTheme.type.bodyM, color = c.textMuted,
                                )
                            }
                            inner()
                        },
                    )
                }
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        if (typed < RoleAppealStatement.MIN) "At least ${RoleAppealStatement.MIN} characters"
                        else "Ready to send",
                        style = ZipperTheme.type.bodyS,
                        color = if (!sendable && typed > 0) c.statusDanger else c.textSecondary,
                    )
                    Text(
                        "$typed / ${RoleAppealStatement.MAX}",
                        style = ZipperTheme.type.bodyS,
                        color = c.textSecondary,
                    )
                }
                error?.let { Text(it, style = ZipperTheme.type.bodyS, color = c.statusDanger) }
            }
        },
        confirmButton = {
            TextButton(onClick = onSend, enabled = sendable && !sending) {
                Text(if (sending) "Sending…" else "Send request", color = c.textBrand)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !sending) {
                Text("Cancel", color = c.textSecondary)
            }
        },
    )
}

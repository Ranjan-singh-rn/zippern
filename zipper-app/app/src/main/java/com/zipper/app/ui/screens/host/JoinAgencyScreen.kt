package com.zipper.app.ui.screens.host

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.zipper.app.ui.components.TopBar
import com.zipper.app.ui.components.ZipperButton
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme

/**
 * Redeem an agency referral code on an account that already exists.
 *
 * ── WHAT THIS SCREEN IS CAREFUL ABOUT ────────────────────────────────────────
 *
 * Three different things can be wrong when a code is refused, and before this
 * existed they were indistinguishable — the person saw a red line and assumed
 * they had mistyped:
 *
 *   * the CODE is wrong, expired or already used;
 *   * the code is fine but the invitation was addressed to a different phone or
 *     email than this account carries;
 *   * nothing about the code is wrong at all — the account is restricted, or
 *     already belongs to another agency, and no code will change that.
 *
 * The server distinguishes all three (`checkReferralCode`), and the panel at the
 * bottom of this screen says which one happened and what to do about it. The
 * second is the common one and it has a concrete remedy: ask the agency to
 * re-send the invitation to the details on the account.
 *
 * Nothing is decided here. "Check" looks and "Join" commits, both through the
 * same server functions the first-run setup form uses.
 */
@Composable
fun JoinAgencyScreen(
    onBack: () -> Unit,
    onActivated: () -> Unit,
    viewModel: JoinAgencyViewModel = hiltViewModel(),
) {
    val c = ZipperTheme.colors
    val state by viewModel.uiState.collectAsStateWithLifecycle()

    // Activation is one-way, so the screen leaves rather than offering a button
    // that would re-submit a code the server has already consumed.
    LaunchedEffect(state.done) { if (state.done) onActivated() }

    Column(
        Modifier
            .fillMaxSize()
            .background(c.bgBase)
            .statusBarsPadding(),
    ) {
        TopBar("Join an agency", onBack = onBack)

        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Space.lg),
            verticalArrangement = Arrangement.spacedBy(Space.lg),
        ) {
            Text(
                "Hosts are invited by an agency. If one has invited you, they " +
                "will have given you a code — enter it here to become a host.",
                style = ZipperTheme.type.bodyM,
                color = c.textSecondary,
            )

            // ── The code ─────────────────────────────────────────────────────
            Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                Text("Agency code", style = ZipperTheme.type.labelM, color = c.textPrimary)
                Box(
                    Modifier
                        .fillMaxWidth()
                        .background(c.bgElevated, RoundedCornerShape(Radius.lg))
                        .border(
                            1.dp,
                            if (state.verified) c.statusSuccess else c.borderSubtle,
                            RoundedCornerShape(Radius.lg),
                        )
                        .padding(horizontal = Space.md, vertical = 18.dp),
                ) {
                    BasicTextField(
                        value = state.code,
                        onValueChange = viewModel::onCodeChange,
                        singleLine = true,
                        enabled = !state.activating,
                        textStyle = ZipperTheme.type.bodyL.copy(color = c.textPrimary),
                        cursorBrush = SolidColor(c.brandPrimary),
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.Characters,
                        ),
                        modifier = Modifier.fillMaxWidth(),
                        decorationBox = { inner ->
                            if (state.code.isEmpty()) {
                                Text(
                                    "e.g. ZIPP4K2M",
                                    style = ZipperTheme.type.bodyL,
                                    color = c.textMuted,
                                )
                            }
                            inner()
                        },
                    )
                }
            }

            // ── What the server said ─────────────────────────────────────────
            state.error?.let { message ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .background(c.bgElevated, RoundedCornerShape(Radius.lg))
                        .border(1.dp, c.statusDanger, RoundedCornerShape(Radius.lg))
                        .padding(Space.md),
                    horizontalArrangement = Arrangement.spacedBy(Space.sm),
                ) {
                    Icon(
                        Icons.Outlined.ErrorOutline, null,
                        tint = c.statusDanger, modifier = Modifier.size(20.dp),
                    )
                    Text(message, style = ZipperTheme.type.caption, color = c.textPrimary)
                }
            }

            if (state.verified && state.error == null) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .background(c.bgElevated, RoundedCornerShape(Radius.lg))
                        .border(1.dp, c.statusSuccess, RoundedCornerShape(Radius.lg))
                        .padding(Space.md),
                    horizontalArrangement = Arrangement.spacedBy(Space.sm),
                ) {
                    Icon(
                        Icons.Outlined.CheckCircle, null,
                        tint = c.statusSuccess, modifier = Modifier.size(20.dp),
                    )
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(
                            "Invitation found — ${state.agencyName}",
                            style = ZipperTheme.type.labelM, color = c.textPrimary,
                        )
                        Text(
                            "Joining makes you a host of this agency at the rate they " +
                            "agreed. You will then need to verify your face before you " +
                            "can go live or be paid.",
                            style = ZipperTheme.type.caption, color = c.textSecondary,
                        )
                    }
                }
            }

            // ── Act ──────────────────────────────────────────────────────────
            if (state.verified) {
                ZipperButton(
                    "Join ${state.agencyName}",
                    onClick = viewModel::activate,
                    gradient = true,
                    fullWidth = true,
                    enabled = !state.activating,
                    loading = state.activating,
                )
            } else {
                ZipperButton(
                    "Check code",
                    onClick = viewModel::check,
                    gradient = true,
                    fullWidth = true,
                    enabled = state.canCheck,
                    loading = state.checking,
                )
            }

            if (state.checking) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator(
                        color = c.brandPrimary, strokeWidth = 2.dp,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }

            /*
             * The honest footer. Not every refusal has a self-service remedy —
             * an account that already belongs to another agency needs a staff
             * release, and there is no point implying otherwise.
             */
            Text(
                "No code? Agencies invite hosts directly — you cannot apply from " +
                "here. If you were invited but the code will not work, ask your " +
                "agency to check the phone number and email on the invitation, or " +
                "contact support.",
                style = ZipperTheme.type.caption,
                color = c.textMuted,
            )

            Spacer(Modifier.navigationBarsPadding())
            Spacer(Modifier.height(Space.lg))
        }
    }
}

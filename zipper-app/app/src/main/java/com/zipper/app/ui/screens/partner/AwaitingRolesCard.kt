package com.zipper.app.ui.screens.partner

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.zipper.app.ui.components.ButtonStyle
import com.zipper.app.ui.components.ZipperButton
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import com.zipper.app.util.ActivationRequirement
import com.zipper.app.util.VerifyAction

/**
 * Decision 15 (RC) — approved roles that have NOT started.
 *
 * The Owner approved them while this account did not yet hold BOTH a verified
 * phone number and a verified email address. They grant nothing until both are
 * verified; then they start by themselves (the hub asks the server to check
 * every time it comes back to the front). "Verify phone number" opens
 * SecureAccount and "Verify email" opens SecureEmail — the same flows the
 * contact rule uses — and both return here.
 */
@Composable
fun AwaitingRolesCard(
    rows: List<PartnerHubRows.AwaitingRow>,
    requirement: ActivationRequirement?,
    onVerifyPhone: () -> Unit,
    onVerifyEmail: () -> Unit,
) {
    val c = ZipperTheme.colors
    Column(
        Modifier.fillMaxWidth()
            .background(c.bgElevated, RoundedCornerShape(Radius.lg))
            .border(1.dp, c.statusWarning.copy(alpha = 0.5f), RoundedCornerShape(Radius.lg))
            .padding(Space.md),
        verticalArrangement = Arrangement.spacedBy(Space.sm),
    ) {
        Text("Approved — verify to start", style = ZipperTheme.type.labelM, color = c.textPrimary)
        rows.forEach { row ->
            Text(row.title, style = ZipperTheme.type.bodyS, color = c.textSecondary)
        }
        val line = requirement?.waitingLine
            ?: "It starts once both your phone number and your email address are verified."
        Text(line, style = ZipperTheme.type.caption, color = c.textSecondary)
        val actions = requirement?.actions ?: listOf(VerifyAction.PHONE, VerifyAction.EMAIL)
        actions.forEachIndexed { i, action ->
            ZipperButton(
                when (action) {
                    VerifyAction.PHONE -> "Verify phone number"
                    VerifyAction.EMAIL -> "Verify email"
                },
                onClick = {
                    when (action) {
                        VerifyAction.PHONE -> onVerifyPhone()
                        VerifyAction.EMAIL -> onVerifyEmail()
                    }
                },
                style = if (i == 0) ButtonStyle.Primary else ButtonStyle.Secondary,
                fullWidth = true,
            )
        }
    }
}

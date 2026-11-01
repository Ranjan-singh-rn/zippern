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
import com.zipper.app.util.ContactRequirement
import com.zipper.app.util.VerifyAction

/**
 * Approved contact rule — what the hub and the application form show when the
 * server says a verified contact is required: what is missing, and the way to
 * fix it. "Verify phone number" opens SecureAccount and "Verify email" opens
 * SecureEmail; both return here when they finish (ZipperNavGraph), and the
 * screen re-reads the server's answer on resume.
 */
@Composable
fun ContactRequiredCard(
    contact: ContactRequirement,
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
        Text("Verify a contact to apply", style = ZipperTheme.type.labelM, color = c.textPrimary)
        Text(contact.explanation, style = ZipperTheme.type.bodyS, color = c.textSecondary)
        contact.actions.forEachIndexed { i, action ->
            ZipperButton(
                when (action) {
                    VerifyAction.PHONE -> "Verify phone number"
                    VerifyAction.EMAIL -> if (contact.emailUnverified) "Verify your email" else "Verify email"
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

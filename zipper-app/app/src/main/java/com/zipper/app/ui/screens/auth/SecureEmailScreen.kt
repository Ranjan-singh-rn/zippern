package com.zipper.app.ui.screens.auth

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewResponder
import androidx.compose.foundation.relocation.bringIntoViewResponder
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.MailOutline
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.zipper.app.ui.components.ButtonStyle
import com.zipper.app.ui.components.IconButtonCircle
import com.zipper.app.ui.components.ZipperButton
import com.zipper.app.ui.components.clickableNoRipple
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import kotlinx.coroutines.delay

/**
 * "Secure your account", by email — an address is attached to THIS account by a
 * six-digit code (UGP-C).
 *
 * enter address → "Send code" → the code arrives by email → type it here → the
 * server binds the address to the same uid → Done → Settings.
 *
 * It is deliberately the phone flow's twin: same frame, same steps (`StepColumn`,
 * `StepError`, the same `OtpCodeBoxes`), same refusal. It used to be a Firebase
 * email LINK: the app sent a link, the person left for a mail client, and an App
 * Link reopened the app on this destination — which always starts on the
 * address form, so people landed on "Add your email" again after tapping it.
 * There is no link, no deep link and no second visit any more.
 *
 * ── THE ADDRESS MAY NOT BE THEIRS TO TAKE ────────────────────────────────────
 *
 * The code proves this person reads that mailbox today; it proves nothing about
 * an account the address is already attached to. When the server refuses, this
 * screen refuses with it: a different address, or nothing. No merge, no
 * overwrite, no "use that account instead" — and this account is left exactly as
 * it was.
 */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun SecureEmailScreen(
    /** The address is on the account. The caller takes them to Settings. */
    onDone: () -> Unit,
    /** They changed their mind, or the address was not available. Nothing happened. */
    onCancel: () -> Unit,
    viewModel: SecureEmailViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    val focusManager = LocalFocusManager.current

    // The typed address survives a process death with the ViewModel's saved
    // state (UGP review). The code is deliberately NOT saved: it lives in the
    // mailbox, and re-typing six digits is cheaper than persisting a secret.
    var email by rememberSaveable { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var resendIn by remember { mutableIntStateOf(0) }

    // Restarted on every send: the countdown is the server's cooldown, not ours.
    LaunchedEffect(state.sendCount) {
        resendIn = state.resendInSec
        code = ""
    }
    LaunchedEffect(resendIn) { if (resendIn > 0) { delay(1000); resendIn-- } }

    /*
     * The same no-op responder the login and phone screens carry. People still
     * leave for their mail app to read the code, and an activity coming back to
     * the front while a field inside a vertical scroll holds focus is the crash
     * it prevents ("BringIntoViewRequester used before parents are placed").
     */
    val noOpResponder = remember {
        object : BringIntoViewResponder {
            override fun calculateRectForParent(localRect: Rect): Rect = localRect
            override suspend fun bringChildIntoView(localRect: () -> Rect?) {}
        }
    }

    Box(Modifier.fillMaxSize().background(c.bgBase).bringIntoViewResponder(noOpResponder)) {
        AmbientGlows()

        AnimatedContent(
            targetState = state.stage,
            transitionSpec = {
                if (targetState.ordinal >= initialState.ordinal) {
                    (slideInHorizontally { it } + fadeIn()) togetherWith (slideOutHorizontally { -it } + fadeOut())
                } else {
                    (slideInHorizontally { -it } + fadeIn()) togetherWith (slideOutHorizontally { it } + fadeOut())
                }
            },
            label = "secure-email",
        ) { stage ->
            when (stage) {
                SecureEmailStage.Email -> AddressStep(
                    email = email,
                    // Trimmed on the way in: a pasted leading space is invisible
                    // and would otherwise leave the button dead for no visible reason.
                    onEmail = { email = it.trim() },
                    busy = state.busy,
                    error = state.error,
                    onSend = {
                        focusManager.clearFocus(force = true)
                        viewModel.sendCode(email)
                    },
                    onCancel = onCancel,
                )

                SecureEmailStage.Code -> EmailCodeStep(
                    emailLabel = state.maskedEmail,
                    expiresInSec = state.expiresInSec,
                    code = code,
                    onCode = { code = it.filter { ch -> ch.isDigit() }.take(6); viewModel.clearError() },
                    busy = state.busy,
                    error = state.error,
                    resendIn = resendIn,
                    onVerify = { viewModel.verify(code) },
                    onChangeEmail = viewModel::useDifferentEmail,
                    onResend = viewModel::resend,
                )

                SecureEmailStage.Taken -> TakenEmailStep(
                    emailLabel = state.email,
                    serverMessage = state.takenMessage,
                    // The address is not available to them at all; leaving it in
                    // the box would invite a second code for the same refusal.
                    onUseDifferentEmail = { email = ""; viewModel.useDifferentEmail() },
                    onCancel = onCancel,
                )

                SecureEmailStage.Done -> DoneEmailStep(
                    emailLabel = state.email,
                    onDone = onDone,
                )
            }
        }
    }
}

// ── Steps ────────────────────────────────────────────────────────────────────

@Composable
private fun AddressStep(
    email: String, onEmail: (String) -> Unit,
    busy: Boolean, error: String?,
    onSend: () -> Unit, onCancel: () -> Unit,
) {
    val c = ZipperTheme.colors
    val canSubmit = looksLikeAnEmail(email) && !busy

    StepColumn {
        IconButtonCircle(Icons.Default.Close, "Close", onCancel, background = c.bgRaised, enabled = !busy)

        Box(
            Modifier.size(72.dp).background(c.tintBrandSubtle, CircleShape),
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Outlined.MailOutline, null, tint = c.textBrand, modifier = Modifier.size(32.dp)) }

        Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            Text("Add your email", style = ZipperTheme.type.headingL, color = c.textPrimary)
            Text(
                "We will email you a 6-digit code. Enter it here and the address is " +
                    "added to this account — the same account, with your diamonds and " +
                    "your history.",
                style = ZipperTheme.type.bodyM, color = c.textSecondary,
            )
        }

        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Space.md)) {
            Text("Your email address", style = ZipperTheme.type.labelM, color = c.textSecondary)
            EmailField(email = email, onEmail = onEmail, onDone = { if (canSubmit) onSend() })
            ZipperButton(
                "Send code", onSend,
                gradient = true, fullWidth = true, enabled = canSubmit, loading = busy,
            )
            Text(
                "There is no password to set, and nothing about your profile changes.",
                style = ZipperTheme.type.caption, color = c.textMuted,
            )
        }

        StepError(error)

        ZipperButton("Not now", onCancel, style = ButtonStyle.Ghost, fullWidth = true, enabled = !busy)
    }
}

@Composable
private fun EmailCodeStep(
    emailLabel: String, expiresInSec: Int, code: String, onCode: (String) -> Unit,
    busy: Boolean, error: String?, resendIn: Int,
    onVerify: () -> Unit, onChangeEmail: () -> Unit, onResend: () -> Unit,
) {
    val c = ZipperTheme.colors
    // The server's own lifetime for the code; 10 minutes is its policy today.
    val minutes = if (expiresInSec > 0) ((expiresInSec + 59) / 60) else 10

    StepColumn {
        IconButtonCircle(
            Icons.AutoMirrored.Filled.ArrowBack, "Back", onChangeEmail,
            background = c.bgRaised,
            // Not while a request is in flight — see `useDifferentEmail`.
            enabled = !busy,
        )
        Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            Text("Enter the code", style = ZipperTheme.type.headingL, color = c.textPrimary)
            Text(
                "Sent to $emailLabel. It expires in $minutes ${if (minutes == 1) "minute" else "minutes"}. " +
                    "Check your spam folder if it has not arrived.",
                style = ZipperTheme.type.bodyM, color = c.textSecondary,
            )
        }

        OtpCodeBoxes(code = code, onCode = onCode, onDone = { if (code.length == 6 && !busy) onVerify() })

        StepError(error)

        Column(
            Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(Space.xl),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            ZipperButton(
                "Add this email", onVerify,
                gradient = true, fullWidth = true, enabled = code.length == 6 && !busy, loading = busy,
            )
            ZipperButton(
                "Use a different address", onChangeEmail,
                style = ButtonStyle.Ghost, fullWidth = true, enabled = !busy,
            )
            if (resendIn > 0) {
                Text(
                    "Resend code in ${resendIn}s",
                    style = ZipperTheme.type.bodyS, color = c.textMuted, textAlign = TextAlign.Center,
                )
            } else {
                Text(
                    "Resend code",
                    style = ZipperTheme.type.labelM, color = c.textBrand,
                    modifier = Modifier.clickableNoRipple { if (!busy) onResend() },
                )
            }
        }
    }
}

/**
 * The refusal. Two answers, and both leave every account exactly as it was —
 * see the note at the top of the file for what is deliberately not offered.
 */
@Composable
private fun TakenEmailStep(
    emailLabel: String,
    /**
     * The server's own explanation. It is not always "another account": an
     * address on an account inside its deletion grace window is refused too,
     * with recovery guidance instead (UGP review).
     */
    serverMessage: String,
    onUseDifferentEmail: () -> Unit,
    onCancel: () -> Unit,
) {
    val c = ZipperTheme.colors

    StepColumn {
        Box(
            Modifier.size(72.dp).background(c.tintDangerSubtle, CircleShape),
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Outlined.ErrorOutline, null, tint = c.statusWarning, modifier = Modifier.size(32.dp)) }

        Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            Text("That email cannot be added", style = ZipperTheme.type.headingL, color = c.textPrimary)
            Text(
                serverMessage.ifBlank {
                    "$emailLabel belongs to another Zipper account, so it cannot be added to this one."
                } + " This account has not been changed — nothing has been added to it and " +
                    "nothing taken away.",
                style = ZipperTheme.type.bodyM, color = c.textSecondary,
            )
        }

        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Space.md)) {
            ZipperButton("Use a different address", onUseDifferentEmail, gradient = true, fullWidth = true)
            ZipperButton("Cancel", onCancel, style = ButtonStyle.Secondary, fullWidth = true)
        }

        Text(
            "If that account is yours, log out and sign in to it with its phone number " +
                "or Google instead (or contact support). Do that only " +
                "if you are happy to leave this account behind.",
            style = ZipperTheme.type.caption, color = c.textMuted,
        )
    }
}

@Composable
private fun DoneEmailStep(emailLabel: String, onDone: () -> Unit) {
    val c = ZipperTheme.colors

    StepColumn {
        Box(
            Modifier.size(72.dp).background(c.tintSuccessSubtle, CircleShape),
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Outlined.CheckCircle, null, tint = c.statusSuccess, modifier = Modifier.size(32.dp)) }

        Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            Text("Your email is added", style = ZipperTheme.type.headingL, color = c.textPrimary)
            /*
             * Careful about what this promises. The address is verified and bound,
             * but the sign-in screen has no email entry (phone, Google, guest and
             * quick login only), so it is a recovery anchor rather than a second
             * front door — see FLOW-MAP decision D1.
             */
            Text(
                "$emailLabel is on this account now — the same account, with everything " +
                    "already on it. If you ever lose this phone, that address is how " +
                    "support can find the account and get you back into it.",
                style = ZipperTheme.type.bodyM, color = c.textSecondary,
            )
        }

        ZipperButton("Done", onDone, gradient = true, fullWidth = true)
    }
}

// ── Pieces ───────────────────────────────────────────────────────────────────

/** The 56dp address row — the same box as the phone field, minus the dial code. */
@Composable
private fun EmailField(email: String, onEmail: (String) -> Unit, onDone: () -> Unit) {
    val c = ZipperTheme.colors
    Row(
        Modifier.fillMaxWidth().height(56.dp)
            .background(c.bgElevated, RoundedCornerShape(Radius.lg))
            .border(1.dp, c.borderDefault, RoundedCornerShape(Radius.lg))
            .padding(horizontal = Space.lg),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        BasicTextField(
            value = email, onValueChange = onEmail, singleLine = true,
            textStyle = ZipperTheme.type.bodyL.copy(color = c.textPrimary),
            cursorBrush = SolidColor(c.brandPrimary),
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Email,
                imeAction = ImeAction.Done,
            ),
            keyboardActions = KeyboardActions(onDone = { onDone() }),
            modifier = Modifier.weight(1f),
            decorationBox = { inner ->
                if (email.isEmpty()) {
                    Text("you@example.com", style = ZipperTheme.type.bodyL, color = c.textMuted)
                }
                inner()
            },
        )
    }
}

/**
 * Enough of a check to keep the button off until there is something worth
 * sending — the platform pattern, never stricter than whether the mail arrives.
 * The server validates again.
 */
private fun looksLikeAnEmail(value: String): Boolean {
    val address = value.trim()
    return address.isNotEmpty() &&
        android.util.Patterns.EMAIL_ADDRESS.matcher(address).matches()
}

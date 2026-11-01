package com.zipper.app.ui.screens.auth

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.zipper.app.ui.components.ButtonSize
import com.zipper.app.ui.components.ButtonStyle
import com.zipper.app.ui.components.LoadingState
import com.zipper.app.ui.components.TopBar
import com.zipper.app.ui.components.ZipperButton
import com.zipper.app.ui.components.ZipperScreen
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import kotlinx.coroutines.delay

/**
 * The Owner's second step on the way into the app (spec §8), one screen per
 * [MfaStep]. Shown by [OwnerMfaGateHost] in place of Main until the step
 * passes; `onPassed` lets Main render, `onSignOut` ends the app session with
 * the reason shown on the login screen.
 *
 * ── Set-up without a QR library ─────────────────────────────────────────────
 * The project has no QR dependency (`gradle/libs.versions.toml`: none), so
 * the setup key is shown as text with "Copy key" (marked sensitive on
 * Android 13+, so the clipboard does not preview it) and "Open in
 * authenticator app", which hands the `otpauth://` URI to whichever
 * authenticator is installed on THIS phone — the common case, since the
 * authenticator and the app share the handset and a QR on the same screen
 * could not be scanned anyway. The key is shown once, never stored, never
 * logged.
 */
@Composable
fun OwnerMfaScreen(
    onPassed: () -> Unit,
    onSignOut: (reason: String?) -> Unit,
    viewModel: OwnerMfaViewModel = hiltViewModel(),
) {
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { viewModel.begin() }
    LaunchedEffect(ui.step) { if (MfaMachine.passes(ui.step)) onPassed() }

    val c = ZipperTheme.colors
    val step = ui.step
    ZipperScreen(topBar = { TopBar(titleOf(step), centered = true) }) { _ ->
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = Space.lg, vertical = Space.md),
            verticalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            when (step) {
                is MfaStep.Checking -> Box(Modifier.fillMaxWidth().height(200.dp)) { LoadingState() }
                is MfaStep.Enrol -> EnrolStep(step, ui.busy, viewModel) { onSignOut(null) }
                is MfaStep.Verify -> VerifyStep(step, ui.busy, viewModel) { onSignOut(null) }
                is MfaStep.RecoveryCodes -> RecoveryCodesStep(step, ui.busy, viewModel)
                // Audit C-3: the server has no two-step routes — the CRM's notice, then in.
                is MfaStep.Unavailable -> {
                    Text(step.notice, style = ZipperTheme.type.bodyM, color = c.textPrimary)
                    ZipperButton("Continue", viewModel::acknowledge, fullWidth = true)
                }
                // Verified, but Owner screens that read Firestore are still locked: say so once (CRM "unbound").
                is MfaStep.Done -> if (MfaMachine.passes(step)) {
                    Box(Modifier.fillMaxWidth().height(120.dp)) { LoadingState() }
                } else {
                    Text("Two-step sign-in passed.", style = ZipperTheme.type.bodyM, color = c.textPrimary)
                    BindingNote(step.binding, ui.busy, viewModel)
                    ZipperButton("Continue", viewModel::acknowledge, style = ButtonStyle.Secondary, fullWidth = true)
                }
                is MfaStep.Blocked -> {
                    Text(step.message, style = ZipperTheme.type.bodyM, color = c.textPrimary)
                    ZipperButton("Sign out", { onSignOut(step.message) }, style = ButtonStyle.Secondary, fullWidth = true)
                }
                is MfaStep.Trouble -> {
                    Text(step.message, style = ZipperTheme.type.bodyM, color = c.textPrimary)
                    ZipperButton("Try again", viewModel::retry, fullWidth = true, loading = ui.busy)
                    ZipperButton("Sign out", { onSignOut(null) }, style = ButtonStyle.Ghost, fullWidth = true)
                }
                // Passing: `onPassed` fires from the effect above; a frame may render in between.
                MfaStep.NotRequired -> Box(Modifier.fillMaxWidth().height(120.dp)) { LoadingState() }
            }
            Spacer(Modifier.navigationBarsPadding().height(Space.lg))
        }
    }
}

private fun titleOf(step: MfaStep): String = when (step) {
    is MfaStep.Enrol -> "Set up two-step sign-in"
    is MfaStep.Verify -> "Two-step sign-in"
    is MfaStep.RecoveryCodes -> "Save your recovery codes"
    is MfaStep.Unavailable -> "Signed in — without a second step"
    is MfaStep.Done -> if (MfaMachine.passes(step)) "Signing in" else "Signed in — some screens are locked"
    is MfaStep.Blocked -> "Cannot finish signing in"
    is MfaStep.Trouble -> "Cannot finish signing in"
    else -> "Signing in"
}

@Composable
private fun EnrolStep(step: MfaStep.Enrol, busy: Boolean, vm: OwnerMfaViewModel, onSignOut: () -> Unit) {
    val c = ZipperTheme.colors
    val context = LocalContext.current
    var code by remember { mutableStateOf("") }
    val lock = lockSentence(step.lockedUntil)
    Text(
        "Your account is an Owner account. Add it to an authenticator app (Google Authenticator, Authy, 1Password…) " +
            "and enter the first 6-digit code it shows. This key is shown once.",
        style = ZipperTheme.type.bodyM, color = c.textSecondary,
    )
    Column(
        Modifier.fillMaxWidth().background(c.bgRaised, RoundedCornerShape(Radius.lg))
            .border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.lg)).padding(Space.md),
        verticalArrangement = Arrangement.spacedBy(Space.sm),
    ) {
        Text("Setup key", style = ZipperTheme.type.caption, color = c.textSecondary)
        Text(MfaMachine.groupedSecret(step.secret), style = ZipperTheme.type.headingS.copy(fontFamily = FontFamily.Monospace), color = c.textPrimary)
        Text("Time-based · 6 digits · 30 seconds", style = ZipperTheme.type.caption, color = c.textMuted)
        if (step.otpauthUri.startsWith("otpauth://")) {
            ZipperButton("Open in authenticator app", { openAuthenticator(context, step.otpauthUri) },
                style = ButtonStyle.Primary, size = ButtonSize.Medium, fullWidth = true)
        }
        ZipperButton("Copy key", { copySensitive(context, "Zipper setup key", step.secret) },
            style = ButtonStyle.Secondary, size = ButtonSize.Medium, fullWidth = true)
        step.expiresAt?.let {
            Text("This set-up expires at ${com.zipper.app.data.work.WorkDisplay.date(it)} if not confirmed.", style = ZipperTheme.type.caption, color = c.textMuted)
        }
    }
    CodeField("First code from the app", code, KeyboardType.Number) { code = MfaMachine.normaliseCode(it).take(8) }
    (step.error ?: lock.takeIf { it.isNotBlank() })?.let { Text(it, style = ZipperTheme.type.bodyS, color = c.statusDanger) }
    ZipperButton("Turn on & continue", { vm.submit(code) }, fullWidth = true, loading = busy,
        enabled = !busy && lock.isBlank() && MfaMachine.codeLooksValid(code))
    Text(
        "Lost your phone later? Recovery codes are shown once after this step; the Observer can reset two-step sign-in for you.",
        style = ZipperTheme.type.caption, color = c.textMuted,
    )
    // No way past without the code — but always a way out.
    ZipperButton("Sign out", onSignOut, style = ButtonStyle.Ghost, size = ButtonSize.Medium, fullWidth = true, enabled = !busy)
}

@Composable
private fun VerifyStep(step: MfaStep.Verify, busy: Boolean, vm: OwnerMfaViewModel, onSignOut: () -> Unit) {
    val c = ZipperTheme.colors
    var code by remember(step.useRecovery) { mutableStateOf("") }
    val lock = lockSentence(step.lockedUntil)
    Text(
        if (step.useRecovery) "Enter one of the recovery codes you saved when you set up two-step sign-in. Each works once."
        else "Enter the 6-digit code from your authenticator app to open the Owner account on this phone.",
        style = ZipperTheme.type.bodyM, color = c.textSecondary,
    )
    if (step.useRecovery) {
        CodeField("Recovery code", code, KeyboardType.Ascii) { code = it.take(24) }
    } else {
        CodeField("6-digit code", code, KeyboardType.Number) { code = MfaMachine.normaliseCode(it).take(8) }
    }
    (step.error ?: lock.takeIf { it.isNotBlank() })?.let { Text(it, style = ZipperTheme.type.bodyS, color = c.statusDanger) }
    ZipperButton("Verify", { vm.submit(code) }, fullWidth = true, loading = busy,
        enabled = !busy && lock.isBlank() && (if (step.useRecovery) MfaMachine.recoveryLooksValid(code) else MfaMachine.codeLooksValid(code)))
    ZipperButton(
        if (step.useRecovery) "Use the authenticator code instead" else "Use a recovery code",
        vm::toggleRecovery, style = ButtonStyle.Ghost, size = ButtonSize.Medium, fullWidth = true,
    )
    if (step.recoveryCodesLeft in 1..3) {
        Text("${step.recoveryCodesLeft} recovery code${if (step.recoveryCodesLeft == 1) "" else "s"} left. New ones can be issued from the CRM.",
            style = ZipperTheme.type.caption, color = c.statusWarning)
    }
    Text("Five wrong codes pause sign-in for 15 minutes. Lost both the phone and the codes? The Observer resets two-step sign-in.",
        style = ZipperTheme.type.caption, color = c.textMuted)
    ZipperButton("Sign out", onSignOut, style = ButtonStyle.Ghost, size = ButtonSize.Medium, fullWidth = true, enabled = !busy)
}

@Composable
private fun RecoveryCodesStep(step: MfaStep.RecoveryCodes, busy: Boolean, vm: OwnerMfaViewModel) {
    val c = ZipperTheme.colors
    val context = LocalContext.current
    Text(
        "Two-step sign-in is on. These recovery codes are shown ONCE: write them down or copy them somewhere safe now. " +
            "Each one signs you in once if you lose your authenticator.",
        style = ZipperTheme.type.bodyM, color = c.textSecondary,
    )
    Column(
        Modifier.fillMaxWidth().background(c.bgRaised, RoundedCornerShape(Radius.lg))
            .border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.lg)).padding(Space.md),
        verticalArrangement = Arrangement.spacedBy(Space.xs),
    ) {
        step.codes.forEach { Text(it, style = ZipperTheme.type.bodyM.copy(fontFamily = FontFamily.Monospace), color = c.textPrimary) }
    }
    ZipperButton("Copy all codes", { copySensitive(context, "Zipper recovery codes", step.codes.joinToString("\n")) },
        style = ButtonStyle.Secondary, size = ButtonSize.Medium, fullWidth = true)
    BindingNote(step.binding, busy, vm)
    ZipperButton("I have saved them — continue", vm::recoveryCodesSaved, fullWidth = true, enabled = !busy)
}

/** P1-A3b: whether Owner screens that read Firestore were unlocked too; retry from here or later from Work → Two-step sign-in. */
@Composable
private fun BindingNote(binding: MfaBinding, busy: Boolean, vm: OwnerMfaViewModel) {
    val c = ZipperTheme.colors
    if (binding.bound) return
    Text(
        "Signed in, but Owner screens that read Firestore stay locked on this phone" +
            (binding.reason?.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ".") +
            " You can retry now, or later from Work → Two-step sign-in → Retry unlock.",
        style = ZipperTheme.type.caption, color = c.statusWarning,
    )
    ZipperButton("Retry unlock", vm::retryBind, style = ButtonStyle.Secondary, size = ButtonSize.Medium, fullWidth = true, loading = busy)
}

/** Re-evaluated every few seconds so the lock sentence counts down without a refresh. */
@Composable
private fun lockSentence(lockedUntil: String?): String {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(lockedUntil) {
        while (lockedUntil != null && MfaMachine.lockRemainingMs(lockedUntil, System.currentTimeMillis()) > 0L) {
            delay(5_000)
            now = System.currentTimeMillis()
        }
        now = System.currentTimeMillis()
    }
    return MfaMachine.lockSentence(lockedUntil, now)
}

@Composable
private fun CodeField(label: String, value: String, keyboard: KeyboardType, onChange: (String) -> Unit) {
    val c = ZipperTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(Space.xs)) {
        Text(label, style = ZipperTheme.type.labelM, color = c.textSecondary)
        Box(
            Modifier.fillMaxWidth().heightIn(min = 52.dp)
                .background(c.bgElevated, RoundedCornerShape(Radius.lg)).border(1.dp, c.borderDefault, RoundedCornerShape(Radius.lg))
                .padding(horizontal = Space.md, vertical = Space.sm),
        ) {
            BasicTextField(
                value = value, onValueChange = onChange, singleLine = true,
                textStyle = ZipperTheme.type.headingS.copy(color = c.textPrimary, fontFamily = FontFamily.Monospace),
                cursorBrush = SolidColor(c.brandPrimary),
                keyboardOptions = KeyboardOptions(keyboardType = keyboard),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/** Clipboard, flagged sensitive (Android 13+ keeps it out of the clipboard preview). Never logged. */
private fun copySensitive(context: Context, label: String, text: String) {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
    val clip = ClipData.newPlainText(label, text)
    if (Build.VERSION.SDK_INT >= 33) {
        clip.description.extras = android.os.PersistableBundle().apply { putBoolean("android.content.extra.IS_SENSITIVE", true) }
    }
    runCatching { cm.setPrimaryClip(clip) }
}

/** Hand the `otpauth://` URI to an installed authenticator; silently a no-op when none handles it. */
private fun openAuthenticator(context: Context, otpauthUri: String) {
    runCatching {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(otpauthUri)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}

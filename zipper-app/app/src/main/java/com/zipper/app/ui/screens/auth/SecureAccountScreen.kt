package com.zipper.app.ui.screens.auth

import android.app.Activity
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewResponder
import androidx.compose.foundation.relocation.bringIntoViewResponder
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Phone
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.zipper.app.ui.components.Avatar
import com.zipper.app.ui.components.AvatarSize
import com.zipper.app.ui.components.ButtonStyle
import com.zipper.app.ui.components.IconButtonCircle
import com.zipper.app.ui.components.ZipperButton
import com.zipper.app.ui.components.clickableNoRipple
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import com.zipper.app.util.ALL_COUNTRIES
import com.zipper.app.util.CountryCode
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * "Secure your account" — a guest attaches a phone number and stops being
 * temporary.
 *
 * ── THE STATE THIS RESCUES PEOPLE FROM ───────────────────────────────────────
 *
 * A guest account is an anonymous Firebase credential held on one handset. There
 * is no SMS and no Google account that can produce it again, so the app could
 * only ever offer these people a quick-sign-in button on the login screen and
 * hope the phone survived. `AuthRepository.linkPhone` existed to fix that and
 * had no callers at all: no screen, no button, nowhere in the app to reach it.
 * A guest was a guest for ever.
 *
 * ── LINK, NOT SIGN IN ────────────────────────────────────────────────────────
 *
 * The code is verified with `linkPhone`, never `verifyOtp`. Signing in with the
 * credential would resolve to whatever account that number belongs to and give
 * this person a different uid — leaving their diamonds, level and history on an
 * anonymous account nobody can ever open again. Linking keeps the uid, so the
 * account they are already using simply gains a way back into it.
 *
 * ── THE NUMBER MAY NOT BE THEIRS TO TAKE ─────────────────────────────────────
 *
 * Receiving the SMS proves control of the SIM today. It does not prove anything
 * about the account already attached to that number — carriers recycle numbers
 * and handsets get sold — so when the server refuses, this screen refuses with
 * it. Two ways out and no third: a different number, or nothing. There is
 * deliberately no merge, no overwrite, no "use that account instead", and the
 * guest's own account is left in the state it was in, which is what
 * `undoPhoneLink` in the repository exists to guarantee.
 *
 * The number field and the code boxes are `PhoneNumberField` and `OtpCodeBoxes`
 * from LoginScreen, so this is the same control the login screen uses rather
 * than a second one that looks nearly like it.
 */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun SecureAccountScreen(
    /** The number is on the account. Back to wherever they came from. */
    onDone: () -> Unit,
    /** They changed their mind, or the number was not available. Nothing happened. */
    onCancel: () -> Unit,
    viewModel: SecureAccountViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val focusManager = LocalFocusManager.current

    var phone by remember { mutableStateOf("") }
    var selectedCountry by remember { mutableStateOf(ALL_COUNTRIES.first { it.dialCode == "+91" }) }
    var showCountryPicker by remember { mutableStateOf(false) }
    var resendIn by remember { mutableIntStateOf(0) }

    // Same no-op responder as the login screen: without it, Firebase's reCAPTCHA
    // activity returning while a field inside a vertical scroll holds focus
    // crashes with "BringIntoViewRequester used before parents are placed".
    val noOpResponder = remember {
        object : BringIntoViewResponder {
            override fun calculateRectForParent(localRect: Rect): Rect = localRect
            override suspend fun bringChildIntoView(localRect: () -> Rect?) {}
        }
    }

    fun send() {
        focusManager.clearFocus(force = true)
        scope.launch {
            delay(500) // let the keyboard hide before Firebase launches reCAPTCHA
            viewModel.sendCode("${selectedCountry.dialCode}$phone", context as Activity)
        }
    }

    // Restarted whenever the code step is entered, including after "use a
    // different number" — a countdown left over from the previous number would
    // sit there refusing a resend for a code that was never sent.
    LaunchedEffect(state.stage) {
        if (state.stage == SecureAccountStage.Code) resendIn = 45
    }
    LaunchedEffect(resendIn) { if (resendIn > 0) { delay(1000); resendIn-- } }

    Box(Modifier.fillMaxSize().background(c.bgBase).bringIntoViewResponder(noOpResponder)) {
        AmbientGlows()

        AnimatedContent(
            targetState = state.stage,
            transitionSpec = {
                // Forward through the flow slides left, back slides right — the
                // ordering the enum is declared in is the order of the steps.
                if (targetState.ordinal >= initialState.ordinal) {
                    (slideInHorizontally { it } + fadeIn()) togetherWith (slideOutHorizontally { -it } + fadeOut())
                } else {
                    (slideInHorizontally { -it } + fadeIn()) togetherWith (slideOutHorizontally { it } + fadeOut())
                }
            },
            label = "secure-account",
        ) { stage ->
            when (stage) {
                SecureAccountStage.Phone -> NumberStep(
                    phone = phone,
                    onPhone = { v -> phone = v.filter { it.isDigit() }.take(selectedCountry.maxDigits) },
                    country = selectedCountry,
                    onPickCountry = { showCountryPicker = true },
                    busy = state.busy,
                    error = state.error,
                    onSend = ::send,
                    onCancel = onCancel,
                )

                SecureAccountStage.Code -> CodeStep(
                    phoneLabel = state.phoneE164,
                    code = state.code,
                    onCode = viewModel::onCode,
                    busy = state.busy,
                    error = state.error,
                    resendIn = resendIn,
                    onVerify = {
                        focusManager.clearFocus(force = true)
                        viewModel.submitCode()
                    },
                    onChangeNumber = viewModel::useDifferentNumber,
                    onResend = { resendIn = 45; send() },
                )

                SecureAccountStage.Taken -> TakenStep(
                    phoneLabel = state.phoneE164,
                    heldByName = state.heldByName,
                    heldByPhotoUrl = state.heldByPhotoUrl,
                    /*
                     * The typed digits are wiped here and deliberately NOT on the
                     * code step's "use a different number", which is usually
                     * somebody fixing one wrong digit and would be furious to
                     * find the field emptied. This number is not available to
                     * them at all, so leaving it in the box is an invitation to
                     * send a second SMS to a number that will be refused again.
                     */
                    onUseDifferentNumber = { phone = ""; viewModel.useDifferentNumber() },
                    onCancel = onCancel,
                )

                SecureAccountStage.Done -> DoneStep(
                    phoneLabel = state.phoneE164,
                    onDone = onDone,
                )
            }
        }
    }

    if (showCountryPicker) {
        CountryPickerSheet(
            selectedCountry,
            onSelect = { selectedCountry = it; showCountryPicker = false },
        ) { showCountryPicker = false }
    }
}

// ── Steps ────────────────────────────────────────────────────────────────────

@Composable
private fun NumberStep(
    phone: String, onPhone: (String) -> Unit,
    country: CountryCode, onPickCountry: () -> Unit,
    busy: Boolean, error: String?,
    onSend: () -> Unit, onCancel: () -> Unit,
) {
    val c = ZipperTheme.colors
    val canSubmit = phone.length >= 5 && !busy

    StepColumn {
        IconButtonCircle(Icons.Default.Close, "Close", onCancel, background = c.bgRaised)

        Box(
            Modifier.size(72.dp).background(c.tintBrandSubtle, CircleShape),
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Outlined.Phone, null, tint = c.textBrand, modifier = Modifier.size(32.dp)) }

        Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            Text("Keep this account", style = ZipperTheme.type.headingL, color = c.textPrimary)
            /*
             * Says what is at stake in one sentence, in the words of the thing
             * they would lose rather than the mechanism that loses it. "Your
             * anonymous credential is device-local" is true and means nothing to
             * anybody; "if you lose this phone you lose the account" is the same
             * fact and is the reason they are here.
             */
            Text(
                "You are signed in as a guest, so this account only exists on this " +
                    "phone — lose the phone and it is gone. Add your number and you " +
                    "can sign back into it, with your diamonds and your history, from " +
                    "anywhere.",
                style = ZipperTheme.type.bodyM, color = c.textSecondary,
            )
        }

        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Space.md)) {
            Text("Your mobile number", style = ZipperTheme.type.labelM, color = c.textSecondary)
            PhoneNumberField(
                phone = phone, onPhone = onPhone,
                country = country, onPickCountry = onPickCountry,
                onDone = { if (canSubmit) onSend() },
            )
            ZipperButton(
                "Send code", onSend,
                gradient = true, fullWidth = true, enabled = canSubmit, loading = busy,
            )
            Text(
                "We will text you a six-digit code. Nothing about your profile changes.",
                style = ZipperTheme.type.caption, color = c.textMuted,
            )
        }

        StepError(error)

        ZipperButton("Not now", onCancel, style = ButtonStyle.Ghost, fullWidth = true, enabled = !busy)
    }
}

@Composable
private fun CodeStep(
    phoneLabel: String, code: String, onCode: (String) -> Unit,
    busy: Boolean, error: String?, resendIn: Int,
    onVerify: () -> Unit, onChangeNumber: () -> Unit, onResend: () -> Unit,
) {
    val c = ZipperTheme.colors

    StepColumn {
        IconButtonCircle(
            Icons.AutoMirrored.Filled.ArrowBack, "Back", onChangeNumber,
            background = c.bgRaised,
        )
        Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            Text("Enter the code", style = ZipperTheme.type.headingL, color = c.textPrimary)
            Text("Sent to $phoneLabel", style = ZipperTheme.type.bodyM, color = c.textSecondary)
        }

        OtpCodeBoxes(code = code, onCode = onCode, onDone = onVerify)

        StepError(error)

        Column(
            Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(Space.xl),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            ZipperButton(
                "Add this number", onVerify,
                gradient = true, fullWidth = true, enabled = code.length == 6 && !busy, loading = busy,
            )
            ZipperButton(
                "Use a different number", onChangeNumber,
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
                    modifier = Modifier.clickableNoRipple(onResend),
                )
            }
        }
    }
}

/**
 * The refusal.
 *
 * ── WHAT IS NOT ON THIS SCREEN, AND WHY ──────────────────────────────────────
 *
 * No "merge the two accounts", no "use that account instead", no way to take the
 * number off whoever has it. Passing the OTP proved this person is holding that
 * SIM right now; it proved nothing about the account attached to it, and a
 * number that has been recycled by a carrier or a handset that has been sold
 * makes those two completely different claims. Any button here that touched the
 * other account would be an account-takeover route with a friendly label on it,
 * which is exactly the dialog `bindVerifiedIdentity` was rewritten to delete.
 *
 * So there are two answers, and both of them leave every account involved
 * exactly as it was.
 */
@Composable
private fun TakenStep(
    phoneLabel: String,
    heldByName: String,
    heldByPhotoUrl: String,
    onUseDifferentNumber: () -> Unit,
    onCancel: () -> Unit,
) {
    val c = ZipperTheme.colors
    val name = heldByName.trim()

    StepColumn {
        Box(
            Modifier.size(72.dp).background(c.tintDangerSubtle, CircleShape),
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Outlined.ErrorOutline, null, tint = c.statusWarning, modifier = Modifier.size(32.dp)) }

        Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            Text(
                "That number is already taken",
                style = ZipperTheme.type.headingL, color = c.textPrimary,
            )
            Text(
                "$phoneLabel belongs to another Zipper account, so it cannot be added " +
                    "to this one. Your guest account has not been changed — nothing " +
                    "has been added to it and nothing taken away.",
                style = ZipperTheme.type.bodyM, color = c.textSecondary,
            )
        }

        /*
         * Who it is, when the lookup found them.
         *
         * The likeliest holder by far is the person's own older account — they
         * are typing their own number — and the name is what makes them realise
         * that, where a nameless refusal reads as the app being wrong about a
         * number they know perfectly well is theirs. Shown as a fact about the
         * number they have just proved they hold, with no control on it.
         */
        if (name.isNotEmpty()) {
            Row(
                Modifier.fillMaxWidth()
                    .background(c.bgRaised, CircleShape)
                    .padding(horizontal = Space.md, vertical = Space.sm),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Space.md),
            ) {
                Avatar(photoUrl = heldByPhotoUrl, size = AvatarSize.MD, initial = name)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(name, style = ZipperTheme.type.labelL, color = c.textPrimary, maxLines = 1)
                    Text(
                        "Already uses this number",
                        style = ZipperTheme.type.caption, color = c.textMuted, maxLines = 1,
                    )
                }
            }
        }

        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Space.md)) {
            ZipperButton(
                "Use a different number", onUseDifferentNumber,
                gradient = true, fullWidth = true,
            )
            ZipperButton("Cancel", onCancel, style = ButtonStyle.Secondary, fullWidth = true)
        }

        /*
         * The route to the other account is described, not offered.
         *
         * A button that signed them into it would sign them OUT of the guest
         * account in the same breath, and for a guest that is not a switch — the
         * anonymous credential is destroyed by `signOut` and the balance goes
         * with it. If that is genuinely what they want, it belongs on the login
         * screen where they can see what they are leaving.
         */
        Text(
            "If that account is yours, log out and sign in with this number instead. " +
                "Do that only if you are happy to leave this guest account behind.",
            style = ZipperTheme.type.caption, color = c.textMuted,
        )
    }
}

@Composable
private fun DoneStep(phoneLabel: String, onDone: () -> Unit) {
    val c = ZipperTheme.colors

    StepColumn {
        Box(
            Modifier.size(72.dp).background(c.tintSuccessSubtle, CircleShape),
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Outlined.CheckCircle, null, tint = c.statusSuccess, modifier = Modifier.size(32.dp)) }

        Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            Text("Your account is yours", style = ZipperTheme.type.headingL, color = c.textPrimary)
            /*
             * Names the uid-keeping outcome in the only terms that matter to the
             * person: it is the SAME account. The whole risk of a flow like this
             * is somebody assuming they have just made a second one.
             */
            Text(
                "$phoneLabel is on this account now — the same account, with everything " +
                    "already on it. Sign in with that number on any phone and it is here.",
                style = ZipperTheme.type.bodyM, color = c.textSecondary,
            )
        }

        ZipperButton("Done", onDone, gradient = true, fullWidth = true)
    }
}

// ── Pieces ───────────────────────────────────────────────────────────────────

/**
 * The frame all four steps sit in.
 *
 * Scrollable and `imePadding`-ed rather than centred and fixed: the refusal step
 * runs to a heading, three paragraphs and two buttons, and on a short handset
 * with the keyboard up a fixed layout would push the two answers off the bottom
 * with no way to reach them. A choice you cannot scroll to is not a choice.
 *
 * `internal` rather than `private` so `SecureEmailScreen` uses this frame rather
 * than a second one that looks nearly like it — the same reason that screen's
 * number field and code boxes come from LoginScreen. Two flows that are meant to
 * be indistinguishable in feel have to share the layout, or they drift apart the
 * first time either is touched.
 */
@Composable
internal fun StepColumn(content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding()
            .verticalScroll(rememberScrollState())
            .padding(top = Space.xl, start = Space.xxl, end = Space.xxl, bottom = Space.x5l),
        verticalArrangement = Arrangement.spacedBy(Space.xxl),
        content = content,
    )
}

/**
 * A retryable failure, inline.
 *
 * Inline rather than a snackbar because every step here ends in a button the
 * message is about — a four-second toast over a form somebody is still filling
 * in is gone by the time they look up from the keyboard. The refusal does not
 * come through here at all; it has a step of its own.
 *
 * `internal` for the same reason as [StepColumn].
 */
@Composable
internal fun StepError(error: String?) {
    if (error == null) return
    Text(
        error,
        style = ZipperTheme.type.bodyS,
        color = ZipperTheme.colors.statusDanger,
    )
}

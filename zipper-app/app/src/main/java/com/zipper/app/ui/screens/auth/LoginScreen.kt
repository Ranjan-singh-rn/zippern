package com.zipper.app.ui.screens.auth

import android.app.Activity
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.relocation.BringIntoViewResponder
import androidx.compose.foundation.relocation.bringIntoViewResponder
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialException
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.zipper.app.R
import com.zipper.app.util.installedVersionLabel
import com.zipper.app.ui.components.*
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import com.zipper.app.util.ALL_COUNTRIES
import com.zipper.app.util.CountryCode
import com.zipper.app.util.QuickLoginStore
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/*
 * Login — Figma "02 Login" (19:22) and "03 OTP Verify" (21:5).
 *
 * Both states live in this one screen because the phone-auth
 * `verificationId` is held by the AuthViewModel instance created here; a
 * separate destination would get a fresh ViewModel and lose it.
 *
 *   Ambient glows (brand + violet, blurred), 96 brand mark, "Zipper" 28 Bold,
 *   "LIVE. CONNECT. SHINE." gold overline. Phone field 56h r16 with "+91 ▾"
 *   and hairline separator; gradient "Get OTP"; OR divider; Google / Guest
 *   secondary buttons; T&C row with gradient checkbox; "18+" line.
 *   OTP: back disc, "Verify OTP" 24 Bold, "Sent to +91 …", six 45×48 boxes
 *   (active = brand stroke + caret), gradient Verify, "Change number",
 *   "Resend OTP in 42s".
 */

@OptIn(ExperimentalMaterial3Api::class, androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun LoginScreen(
    /*
     * `onNavigateToOtp` is gone along with the destination it pointed at.
     *
     * It was declared here and never called: the `verificationId` lives in the
     * AuthViewModel this screen creates, and a separate nav destination would
     * get a fresh one — so the OTP step is an AnimatedContent stage inside this
     * screen instead. The dead screen it led to called `verifyOtp` with no
     * device id, which would have skipped the banned-device check on the one
     * path a banned user is most likely to try, so it was removed rather than
     * left to be revived.
     */
    onNavigateToProfileSetup: () -> Unit,
    onNavigateToMain: () -> Unit,
    /**
     * A refusal, with WHICH refusal it is.
     *
     * It used to be a bare reason string, so the graph could not tell a barred
     * device from a banned account from a suspension and defaulted all three to
     * the ban wording — a seven-day suspension read as permanent until the next
     * cold start, when Splash classified it properly.
     */
    onNavigateToBanned: (
        reason: String,
        kind: com.zipper.app.data.repository.RestrictionKind,
        untilMillis: Long,
    ) -> Unit = { _, _, _ -> },
    /**
     * The account signed in fine but is inside its 30-day deletion window, so
     * the person has to choose between restoring it and starting over.
     *
     * The same destination SplashScreen sends a pending deletion to. Both routes
     * had to reach it: Splash catches the case where the credential was still on
     * the device, and this catches the case where they signed in from scratch —
     * which is the more likely one, since deleting an account tends to be
     * followed by uninstalling the app.
     */
    onNavigateToRecoverAccount: () -> Unit = {},
    onNavigateToTerms: () -> Unit,
    viewModel: AuthViewModel = hiltViewModel(),
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val focusManager = LocalFocusManager.current
    val snackbar = remember { SnackbarHostState() }

    var phone by remember { mutableStateOf("") }
    var otp by remember { mutableStateOf("") }
    var termsAccepted by remember { mutableStateOf(false) }
    var otpStage by remember { mutableStateOf(false) }
    var resendIn by remember { mutableIntStateOf(0) }
    var selectedCountry by remember { mutableStateOf(ALL_COUNTRIES.first { it.dialCode == "+91" }) }
    var showCountryPicker by remember { mutableStateOf(false) }

    val deviceId = remember {
        android.provider.Settings.Secure.getString(context.contentResolver, android.provider.Settings.Secure.ANDROID_ID) ?: ""
    }

    /*
     * ── THE QUICK-SIGN-IN BUTTON, AND WHY ITS STATE IS RE-READ ───────────────
     *
     * `savedQuickLogin()` is a suspend call into Block Store, so it cannot be
     * read during composition — it is loaded into state instead, and the load is
     * keyed on a counter rather than on `Unit`.
     *
     * The counter is what stops the button becoming a trap. When the server
     * refuses the saved token — expired, revoked, or the account is gone —
     * `signInWithQuickLogin` calls `quickLogin.clear()` and returns an error, so
     * the secret is already gone from the device by the time the error reaches
     * this screen. Keyed on `Unit`, the effect would never re-run: the button
     * would stay on screen, showing a name and a photo for an account that no
     * longer exists, and fail with the same snackbar every single time it was
     * pressed, with no way for the person to make it go away short of
     * reinstalling. Bumping the counter after every failure re-reads the store,
     * finds nothing, and the button disappears on its own.
     *
     * Null while loading, which is the right default: showing a placeholder card
     * that might evaporate a frame later is worse than showing the ordinary
     * login form and adding the button once there is something real to put in it.
     */
    var quickLoginProbe by remember { mutableIntStateOf(0) }
    var quickLogin by remember { mutableStateOf<QuickLoginStore.Saved?>(null) }
    LaunchedEffect(quickLoginProbe) { quickLogin = viewModel.savedQuickLogin() }

    /*
     * Why they are looking at a login screen they did not ask for.
     *
     * Consumed once, on the first composition — see ForcedSignOut. A person
     * displaced on Tuesday should not be told about it again on Friday, so the
     * value is taken out of the holder as it is read, and dismissing it here
     * clears it from the screen for good.
     */
    var forcedSignOutReason by remember { mutableStateOf(ForcedSignOut.consume()) }

    // No-op BringIntoViewResponder: stops the "BringIntoViewRequester used
    // before parents are placed" crash when Firebase's reCAPTCHA activity
    // returns while a text field is focused inside a vertical scroll.
    val noOpResponder = remember {
        object : BringIntoViewResponder {
            override fun calculateRectForParent(localRect: Rect): Rect = localRect
            override suspend fun bringChildIntoView(localRect: () -> Rect?) {}
        }
    }

    val credentialManager = remember { CredentialManager.create(context) }
    fun launchGoogleSignIn() {
        scope.launch {
            try {
                val option = GetGoogleIdOption.Builder()
                    .setFilterByAuthorizedAccounts(false)
                    .setServerClientId(context.getString(R.string.default_web_client_id))
                    .setAutoSelectEnabled(false)
                    .build()
                val result = credentialManager.getCredential(context as Activity, GetCredentialRequest.Builder().addCredentialOption(option).build())
                val cred = result.credential
                if (cred is CustomCredential && cred.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                    viewModel.signInWithGoogle(GoogleIdTokenCredential.createFrom(cred.data).idToken, deviceId)
                }
            } catch (_: GetCredentialException) { /* cancelled */ }
        }
    }
    fun sendOtp() {
        focusManager.clearFocus(force = true)
        scope.launch {
            delay(500) // let the keyboard hide before Firebase launches reCAPTCHA
            viewModel.sendOtp("${selectedCountry.dialCode}$phone", context as Activity, deviceId)
        }
    }

    LaunchedEffect(uiState.navigateToOtp) {
        if (uiState.navigateToOtp) { viewModel.onNavigatedToOtp(); otpStage = true; otp = ""; resendIn = 45 }
    }
    LaunchedEffect(resendIn) { if (resendIn > 0) { delay(1000); resendIn-- } }
    /*
     * `deviceId`, on the auto-filled path too.
     *
     * Every sign-in entry point takes one now, and it is not decoration: the
     * repository checks it against `bannedDevices` before it will complete the
     * sign-in, and hands it to `startMobileSession` so the record of who holds
     * the session names a real handset. Omitting it here — which this line did —
     * meant that the ONE path a user never chooses deliberately, the SMS being
     * auto-read by Play Services, was also the one path on which a banned device
     * sailed through and the session record was claimed with an empty deviceId.
     */
    LaunchedEffect(uiState.otpAutoFilled) { uiState.otpAutoFilled?.let { otp = it; viewModel.verifyOtp(it, deviceId) } }
    LaunchedEffect(uiState.navigateToProfileSetup) { if (uiState.navigateToProfileSetup) { viewModel.onNavigatedToProfileSetup(); onNavigateToProfileSetup() } }
    LaunchedEffect(uiState.navigateToMain) { if (uiState.navigateToMain) { viewModel.onNavigatedToMain(); onNavigateToMain() } }
    LaunchedEffect(uiState.navigateToBanned) { if (uiState.navigateToBanned) { viewModel.onNavigatedToBanned(); onNavigateToBanned(uiState.bannedReason, uiState.bannedKind, uiState.suspendedUntilMs) } }
    /*
     * A deleted account that can still be brought back.
     *
     * `AuthResult.DeletedRecoverable` sets this from any of the four sign-in
     * paths, and before this line nothing on the login screen watched it — the
     * spinner simply stopped and the person sat on the form they had just
     * successfully used, with no error and no explanation, because the sign-in
     * had in fact WORKED and the state was waiting for somebody to read it.
     *
     * The flag is deliberately not consumed. There is no
     * `onNavigatedToRecoverAccount()` on the ViewModel, and the graph sends this
     * to RecoverAccount with `popUpTo(0) { inclusive = true }` — the back stack
     * entry that owns this AuthViewModel is destroyed on the way, so the state
     * goes with it and there is nothing left to leave stale.
     */
    LaunchedEffect(uiState.navigateToRecoverAccount) { if (uiState.navigateToRecoverAccount) onNavigateToRecoverAccount() }
    LaunchedEffect(uiState.error) {
        uiState.error?.let {
            // Before the snackbar, not after: `showSnackbar` suspends until the
            // message is dismissed, and a refused quick-login token has already
            // been erased from the device by the repository. Re-reading now is
            // what makes the stale button disappear in the same frame as the
            // failure rather than at the next cold start.
            quickLoginProbe++
            /*
             * A long message needs longer than four seconds.
             *
             * `SnackbarDuration.Short` is 4s, which is fine for "Wrong code"
             * and useless for the provider-conflict message, which is three
             * sentences of remediation — sign in by phone, or connect Google in
             * the CRM once. Somebody reading that at normal speed loses it
             * halfway through and has no way to get it back.
             *
             * The threshold is length rather than a flag on the result, so any
             * future message that grows past a glance gets the same treatment
             * without a second place to remember to update.
             */
            snackbar.showSnackbar(
                message = it,
                withDismissAction = it.length > 90,
                duration = if (it.length > 90) SnackbarDuration.Indefinite
                           else SnackbarDuration.Short,
            )
            viewModel.clearError()
        }
    }

    Box(Modifier.fillMaxSize().background(c.bgBase).bringIntoViewResponder(noOpResponder)) {
        AmbientGlows()

        AnimatedContent(
            targetState = otpStage,
            transitionSpec = {
                if (targetState) (slideInHorizontally { it } + fadeIn()) togetherWith (slideOutHorizontally { -it } + fadeOut())
                else (slideInHorizontally { -it } + fadeIn()) togetherWith (slideOutHorizontally { it } + fadeOut())
            },
            label = "login",
        ) { stage ->
            if (!stage) {
                PhoneStage(
                    phone = phone, onPhone = { v -> phone = v.filter { it.isDigit() }.take(selectedCountry.maxDigits) },
                    country = selectedCountry, onPickCountry = { showCountryPicker = true },
                    termsAccepted = termsAccepted, onTerms = { termsAccepted = it }, onOpenTerms = onNavigateToTerms,
                    loading = uiState.isLoading,
                    onGetOtp = ::sendOtp,
                    onGoogle = ::launchGoogleSignIn,
                    onGuest = { viewModel.signInAsGuest(deviceId) },
                    quickLogin = quickLogin,
                    onQuickLogin = { viewModel.quickLogin(deviceId) },
                    forcedSignOutReason = forcedSignOutReason,
                    onDismissForcedSignOut = { forcedSignOutReason = null },
                )
            } else {
                OtpStage(
                    phoneLabel = "${selectedCountry.dialCode} $phone",
                    otp = otp, onOtp = { otp = it.filter { ch -> ch.isDigit() }.take(6) },
                    loading = uiState.isLoading, resendIn = resendIn,
                    onVerify = { focusManager.clearFocus(force = true); viewModel.verifyOtp(otp, deviceId) },
                    onChangeNumber = { otpStage = false },
                    onResend = { resendIn = 45; sendOtp() },
                )
            }
        }

        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(Space.lg)) { data ->
            Snackbar(snackbarData = data, containerColor = c.bgElevated, contentColor = c.textPrimary)
        }
    }

    if (showCountryPicker) {
        CountryPickerSheet(selectedCountry, onSelect = { selectedCountry = it; showCountryPicker = false }) { showCountryPicker = false }
    }
}

// ── Stages ───────────────────────────────────────────────────────────────────

@Composable
private fun PhoneStage(
    phone: String, onPhone: (String) -> Unit,
    country: CountryCode, onPickCountry: () -> Unit,
    termsAccepted: Boolean, onTerms: (Boolean) -> Unit, onOpenTerms: () -> Unit,
    loading: Boolean, onGetOtp: () -> Unit, onGoogle: () -> Unit, onGuest: () -> Unit,
    /** What this device remembers, or null when it remembers nothing. */
    quickLogin: QuickLoginStore.Saved?,
    onQuickLogin: () -> Unit,
    /** Why they were signed out, when they did not ask to be. */
    forcedSignOutReason: String?,
    onDismissForcedSignOut: () -> Unit,
) {
    val c = ZipperTheme.colors
    val canSubmit = phone.length >= 5 && termsAccepted && !loading

    Column(
        Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding().verticalScroll(rememberScrollState())
            .padding(top = 64.dp, start = Space.xxl, end = Space.xxl, bottom = Space.xxl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.x3l),
    ) {
        // Brand
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.md)) {
            // The three stops were the literals 0xFFFF3D8B / 0xFFE81E6E /
            // 0xFF8B5CF6, which are exactly Rose.r500, Rose.r600 and Violet.v500.
            // Read through the tokens instead so the brand mark cannot drift away
            // from the brand — it is the same gradient the CTA button uses.
            Box(
                Modifier.size(96.dp).background(Brush.linearGradient(listOf(c.brandGradientFrom, c.brandPrimaryPressed, c.brandGradientTo)), RoundedCornerShape(21.dp)),
                contentAlignment = Alignment.Center,
            ) { Image(painterResource(R.drawable.ic_splash_logo), null, Modifier.size(56.dp)) }
            Text("Zipper", style = ZipperTheme.type.displayM, color = c.textPrimary)
            // Green rather than the usual gold, as a deliberate marker for this
            // release: a version number proves the manifest changed, and a
            // colour proves the COMPILED UI changed with it. After the stale
            // `BuildConfig` constants — where the login screen reported 1.0.4
            // while Android reported 1.0.7 for the same install — a number on
            // its own is no longer enough to tell a delivered build from a
            // partially rebuilt one.
            //
            // Reverted now that an update has been seen to land. The marker is no
            // longer needed because the number beside it is trustworthy again:
            // the version is read from `PackageManager` at runtime rather than
            // from the inlined `BuildConfig` constants that went stale.
            Text("LIVE. CONNECT. SHINE.", style = ZipperTheme.type.overline, color = c.brandVip)
            /*
             * The build, on the one screen everybody sees before signing in.
             *
             * Settings already shows it, but Settings is behind a sign-in — so
             * the question "which build is on this handset" could not be
             * answered for a phone that would not get past Login, which is
             * exactly the phone somebody is asking about. It is also how an
             * OTA update is confirmed to have actually landed: the dialog
             * appearing proves the check ran, and only the number changing
             * proves the new binary is the one now running.
             *
             * Deliberately quiet — muted, caption-sized, under the tagline. It
             * is for whoever is looking for it and invisible to everyone else.
             */
            Text(
                "v" + LocalContext.current.installedVersionLabel(),
                style = ZipperTheme.type.caption,
                color = c.textMuted,
            )
        }

        /*
         * The explanation goes above the thing they are most likely to tap.
         *
         * Somebody who was displaced by their own second handset will press
         * "Continue as …" without reading anything, and that is fine — it is
         * their account. Somebody who was displaced by a handset they do not
         * recognise needs to see the sentence BEFORE they sign straight back in
         * and carry on as though nothing happened.
         */
        if (forcedSignOutReason != null) {
            ForcedSignOutNotice(forcedSignOutReason, onDismissForcedSignOut)
        }

        /*
         * ── THE RETURNING ACCOUNT, FIRST AND LOUDEST ─────────────────────────
         *
         * Everything below this is a way of PROVING who you are — an SMS round
         * trip, a Google account picker, or a brand-new guest account. This is
         * the only control on the screen for somebody the device already knows,
         * and for a GUEST it is the only one that will ever return their
         * account: an anonymous credential cannot be re-obtained from an SMS or
         * a Google picker, so a guest who signs out and is then shown only the
         * ordinary form has, in practice, lost their balance. It goes above all
         * three.
         *
         * It sits UNDER the brand mark rather than above it because a logo is
         * not something anyone taps; this is the first thing on the screen that
         * does anything.
         *
         * NOT GATED ON THE TERMS BOX, unlike every control below it. That gate
         * exists to collect consent before an account is created, and this
         * account already exists — its owner ticked the box to make it. Gating
         * it would mean a returning user finds the one control meant for them
         * greyed out at 40% alpha, which is precisely the dead-control problem
         * the comment below describes, reintroduced at the top of the screen.
         */
        if (quickLogin != null) {
            QuickLoginBlock(saved = quickLogin, loading = loading, onClick = onQuickLogin)
        }

        /*
         * CONSENT FIRST — above every control it gates.
         *
         * This block used to sit at the BOTTOM, under the Google and Guest
         * buttons. All three sign-in methods are gated on `termsAccepted`
         * (see `canSubmit`), and a disabled ZipperButton renders at 40% alpha
         * — so a new user arrived at a screen with three faint, dead controls
         * and the one thing that would wake them up was below the fold of
         * their attention. On a light-mode device, where the Secondary fill
         * and the label were both white, they could not see them at all.
         *
         * Moving it up costs nothing and makes the disabled state
         * self-explanatory: the tick box is the first thing above the buttons
         * it unlocks.
         */
        // Terms
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Space.lg), horizontalAlignment = Alignment.CenterHorizontally) {
            Row(
                Modifier.fillMaxWidth().height(48.dp).background(c.bgRaised, RoundedCornerShape(Radius.md)).padding(horizontal = Space.md),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md),
            ) {
                // The tick is `c.textOnBrand`, not `Color.White`: it sits on the
                // brand gradient, so its role is "foreground on a brand fill".
                // Same value today, but it now moves with the palette instead of
                // staying white while the fill underneath it changes.
                Box(
                    Modifier.size(20.dp)
                        .then(if (termsAccepted) Modifier.background(Brush.linearGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), RoundedCornerShape(4.dp))
                              else Modifier.border(1.5.dp, c.borderStrong, RoundedCornerShape(4.dp)))
                        .clickableNoRipple { onTerms(!termsAccepted) },
                    contentAlignment = Alignment.Center,
                ) { if (termsAccepted) Icon(Icons.Default.Check, null, tint = c.textOnBrand, modifier = Modifier.size(14.dp)) }
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("I agree to the", style = ZipperTheme.type.bodyS, color = c.textSecondary, modifier = Modifier.clickableNoRipple { onTerms(!termsAccepted) })
                    Text("Terms & Conditions", style = ZipperTheme.type.bodyS, color = c.textBrand, modifier = Modifier.clickableNoRipple(onOpenTerms))
                }
            }
            Text("By continuing you confirm you're 18+", style = ZipperTheme.type.caption, color = c.textMuted)
        }

        // Form
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Space.md)) {
            Text("Enter your mobile number", style = ZipperTheme.type.labelM, color = c.textSecondary)
            PhoneNumberField(
                phone = phone, onPhone = onPhone,
                country = country, onPickCountry = onPickCountry,
                onDone = { if (canSubmit) onGetOtp() },
            )
            ZipperButton("Get OTP", onGetOtp, gradient = true, fullWidth = true, enabled = canSubmit, loading = loading)
        }

        // OR
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
            HairlineDivider(Modifier.weight(1f))
            Text("OR", style = ZipperTheme.type.labelS, color = c.textMuted)
            HairlineDivider(Modifier.weight(1f))
        }

        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Space.md)) {
            ZipperButton("Continue with Google", onGoogle, style = ButtonStyle.Secondary, fullWidth = true, enabled = termsAccepted && !loading)
            ZipperButton("Continue as Guest", onGuest, style = ButtonStyle.Secondary, fullWidth = true, enabled = termsAccepted && !loading)
        }

    }
}

@Composable
private fun OtpStage(
    phoneLabel: String, otp: String, onOtp: (String) -> Unit,
    loading: Boolean, resendIn: Int,
    onVerify: () -> Unit, onChangeNumber: () -> Unit, onResend: () -> Unit,
) {
    val c = ZipperTheme.colors

    Column(
        Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding().verticalScroll(rememberScrollState())
            .padding(top = Space.xxl, start = Space.xxl, end = Space.xxl, bottom = Space.x5l),
        verticalArrangement = Arrangement.spacedBy(Space.x6l),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(Space.x3l)) {
            IconButtonCircle(Icons.AutoMirrored.Filled.ArrowBack, "Back", onChangeNumber, background = c.bgRaised)
            Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                Text("Verify OTP", style = ZipperTheme.type.headingL, color = c.textPrimary)
                Text("Sent to $phoneLabel", style = ZipperTheme.type.bodyM, color = c.textSecondary)
            }
            OtpCodeBoxes(code = otp, onCode = onOtp, onDone = onVerify)
        }
        Column(verticalArrangement = Arrangement.spacedBy(Space.xl), horizontalAlignment = Alignment.CenterHorizontally) {
            ZipperButton("Verify", onVerify, gradient = true, fullWidth = true, enabled = otp.length == 6 && !loading, loading = loading)
            ZipperButton("Change number", onChangeNumber, style = ButtonStyle.Ghost, fullWidth = true)
            if (resendIn > 0) Text("Resend OTP in ${resendIn}s", style = ZipperTheme.type.bodyS, color = c.textMuted, textAlign = TextAlign.Center)
            else Text("Resend OTP", style = ZipperTheme.type.labelM, color = c.textBrand, modifier = Modifier.clickableNoRipple(onResend))
        }
    }
}

// ── Pieces ───────────────────────────────────────────────────────────────────

/*
 * ── THE NUMBER AND THE CODE ARE SHARED, NOT COPIED ───────────────────────────
 *
 * `PhoneNumberField`, `OtpCodeBoxes` and `CountryPickerSheet` are public for the
 * same reason `AmbientGlows` further down is: a second screen now asks for a
 * phone number and a six-digit code — SecureAccountScreen, where a guest turns
 * their account into a permanent one — and hand-building a second 56dp row with
 * its own dial-code chip and its own picker sheet would be two implementations
 * of one Figma component, free to drift apart the first time either is touched.
 *
 * They live here rather than in ui/components because this file already owns the
 * onboarding look and six screens already reach into it for `AmbientGlows`.
 */

/** The 56dp number row — dial code, hairline, field. Figma "02 Login" (19:22). */
@Composable
fun PhoneNumberField(
    phone: String,
    onPhone: (String) -> Unit,
    country: CountryCode,
    onPickCountry: () -> Unit,
    /** The keyboard's Done key. Callers gate it on their own submit rules. */
    onDone: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = ZipperTheme.colors
    Row(
        modifier.fillMaxWidth().height(56.dp).background(c.bgElevated, RoundedCornerShape(Radius.lg)).border(1.dp, c.borderDefault, RoundedCornerShape(Radius.lg)).padding(horizontal = Space.lg),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Row(Modifier.clickableNoRipple(onPickCountry), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(country.dialCode, style = ZipperTheme.type.labelL, color = c.textBrand)
            Icon(Icons.Default.KeyboardArrowDown, null, tint = c.textBrand, modifier = Modifier.size(16.dp))
        }
        Box(Modifier.width(1.dp).height(24.dp).background(c.borderStrong))
        BasicTextField(
            value = phone, onValueChange = onPhone, singleLine = true,
            textStyle = ZipperTheme.type.bodyL.copy(color = c.textPrimary), cursorBrush = SolidColor(c.brandPrimary),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { onDone() }),
            modifier = Modifier.weight(1f),
            decorationBox = { inner -> if (phone.isEmpty()) Text("Phone number", style = ZipperTheme.type.bodyL, color = c.textMuted); inner() },
        )
    }
}

/**
 * Six boxes over one invisible field — Figma "03 OTP Verify" (21:5).
 *
 * The field is the whole control and the boxes are decoration over it, so paste,
 * autofill and the SMS suggestion chip all work exactly as they do on any single
 * text field. Six separately focusable boxes look identical and break all three.
 *
 * Focus is requested on first composition. There is nothing else to do on a step
 * that exists to receive six digits, and the alternative is a keyboard the person
 * has to summon with a tap on boxes that do not look tappable.
 */
@Composable
fun OtpCodeBoxes(
    code: String,
    onCode: (String) -> Unit,
    onDone: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = ZipperTheme.colors
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }

    Box(modifier) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
            repeat(6) { i ->
                val ch = code.getOrNull(i)
                val active = code.length == i
                Box(
                    Modifier.weight(1f).height(48.dp).background(c.bgElevated, RoundedCornerShape(Radius.md))
                        .border(1.dp, when { active -> c.brandPrimary; ch != null -> c.borderStrong; else -> c.borderDefault }, RoundedCornerShape(Radius.md)),
                    contentAlignment = Alignment.Center,
                ) {
                    if (ch != null) Text(ch.toString(), style = ZipperTheme.type.headingL, color = c.textPrimary)
                    else if (active) Box(Modifier.size(2.dp, 24.dp).background(c.brandPrimary, CircleShape))
                }
            }
        }
        BasicTextField(
            value = code, onValueChange = onCode, singleLine = true,
            textStyle = ZipperTheme.type.bodyL.copy(color = Color.Transparent), cursorBrush = SolidColor(Color.Transparent),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { if (code.length == 6) onDone() }),
            modifier = Modifier.matchParentSize().focusRequester(focus),
        )
    }
}

/**
 * "Continue as Rahul" — the one control on this screen for somebody the device
 * already knows.
 *
 * ── THE PHOTO AND THE NAME ARE LOCAL ─────────────────────────────────────────
 *
 * Both come out of Block Store alongside the secret (see QuickLoginStore), not
 * out of Firestore, because at this point in the flow there is no session to
 * read Firestore with. That is what lets the card render instantly on a cold
 * start with no network at all.
 *
 * `photoUrl` is passed through untouched. It may be an `avatar:fox` string
 * rather than a URL — one of the built-in default avatars — and it is
 * deliberately NOT special-cased here: `DefaultAvatarMapper` is registered on
 * the application-wide Coil loader (see ZipperApp.onCreate), so every
 * `AsyncImage` in the app resolves it for free. A branch here would be a second
 * place to keep in step with a convention that already has one.
 */
@Composable
private fun QuickLoginBlock(
    saved: QuickLoginStore.Saved,
    loading: Boolean,
    onClick: () -> Unit,
) {
    val c = ZipperTheme.colors

    /*
     * A BLANK NAME IS A GUEST, NOT A MISSING STRING.
     *
     * `displayName` is empty for an account that never reached the end of
     * profile setup, which for guests is the normal state rather than an edge
     * case — a guest is never asked for a name at all. Interpolating it
     * produced "Continue as " with a trailing space, on the hero control of the
     * login screen, for the exact group of users who most need this button:
     * a guest's anonymous credential cannot be recovered from an SMS or a
     * Google picker, so this is the only route back to their balance.
     *
     * Trimmed before the test because a name of pure whitespace reads as blank
     * to a person and as non-empty to `isEmpty()`.
     */
    val name = saved.displayName.trim()
    val label = if (name.isEmpty()) "Continue as guest" else "Continue as $name"

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Space.lg)) {
        Row(
            Modifier.fillMaxWidth()
                .background(
                    Brush.horizontalGradient(listOf(c.brandGradientFrom, c.brandGradientTo)),
                    RoundedCornerShape(Radius.xl),
                )
                // No `enabled` on clickableNoRipple, so the tap is removed
                // outright while a sign-in is in flight. `quickLogin()` also
                // returns early when it is already loading, so a double tap
                // cannot start two redemptions of a one-use token.
                .then(if (loading) Modifier else Modifier.clickableNoRipple(onClick))
                .padding(horizontal = Space.lg, vertical = Space.md),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            Avatar(photoUrl = saved.photoUrl, size = AvatarSize.LG, initial = name)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(label, style = ZipperTheme.type.labelL, color = c.textOnBrand, maxLines = 1)
                Text(
                    "Signed in on this device before",
                    style = ZipperTheme.type.caption,
                    color = c.textOnBrand.copy(0.80f),
                    maxLines = 1,
                )
            }
            if (loading) {
                CircularProgressIndicator(
                    modifier = Modifier.size(20.dp),
                    color = c.textOnBrand,
                    strokeWidth = 2.dp,
                )
            } else {
                Icon(Icons.Default.ChevronRight, null, tint = c.textOnBrand, modifier = Modifier.size(24.dp))
            }
        }

        /*
         * Everything below is now demoted to "some other account".
         *
         * The phone form, Google and Guest all stay exactly where they were and
         * all still work — this is a label, not a collapsed section. Hiding them
         * behind a tap would strand anybody whose saved secret has quietly gone
         * stale, and stranding them is the failure this whole feature exists to
         * prevent.
         */
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            HairlineDivider(Modifier.weight(1f))
            Text("Use a different account", style = ZipperTheme.type.labelS, color = c.textMuted)
            HairlineDivider(Modifier.weight(1f))
        }
    }
}

/**
 * "You were signed out because your account was opened on a Motorola."
 *
 * ── WHY A BANNER AND NOT THE SNACKBAR ────────────────────────────────────────
 *
 * The errors on this screen use the snackbar, which is right for them: they are
 * about the action the person just took, and they time out because the person
 * is still looking at the screen when they arrive. This is the opposite. It is
 * about something that happened to them while they were doing something else,
 * it is waiting for them before they have touched anything, and — if the device
 * named is one they do not recognise — it is the most important thing on the
 * screen. A four-second toast on a screen somebody may not look at for another
 * minute would lose it entirely.
 *
 * Dismissible, because the other case is a person who just changed phones on
 * purpose and already knows.
 */
@Composable
private fun ForcedSignOutNotice(reason: String, onDismiss: () -> Unit) {
    val c = ZipperTheme.colors
    Row(
        Modifier.fillMaxWidth()
            .background(c.tintDangerSubtle, RoundedCornerShape(Radius.md))
            .border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.md))
            .padding(horizontal = Space.md, vertical = Space.md),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Icon(Icons.Outlined.ErrorOutline, null, tint = c.statusWarning, modifier = Modifier.size(18.dp))
        Text(reason, style = ZipperTheme.type.bodyS, color = c.textPrimary, modifier = Modifier.weight(1f))
        Icon(
            Icons.Default.Close, "Dismiss", tint = c.textMuted,
            modifier = Modifier.size(18.dp).clickableNoRipple(onDismiss),
        )
    }
}

/**
 * The blurred brand/violet orbs behind every onboarding screen — Splash, Login,
 * ProfileSetup, FaceVerification, RecoverAccount, Banned and LiveSummary all
 * call this, so it is the single most widely drawn thing in the app after the
 * background itself.
 *
 * The three fills were the literals 0xFFFF3D8B and 0xFF8B5CF6, which are exactly
 * Rose.r500 and Violet.v500 — the two ends of the brand gradient. They now read
 * from the tokens, so retuning the brand retunes all seven screens from one
 * place instead of leaving them on last season's pink.
 */
@Composable
fun AmbientGlows() {
    val c = ZipperTheme.colors
    Box(Modifier.fillMaxSize()) {
        Box(Modifier.size(320.dp).offset((-80).dp, (-60).dp).blur(120.dp).background(c.brandGradientFrom.copy(0.28f), CircleShape))
        Box(Modifier.size(280.dp).align(Alignment.TopEnd).offset(80.dp, 40.dp).blur(100.dp).background(c.brandGradientTo.copy(0.24f), CircleShape))
        Box(Modifier.size(300.dp).align(Alignment.BottomStart).offset((-60).dp, 80.dp).blur(120.dp).background(c.brandGradientFrom.copy(0.18f), CircleShape))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CountryPickerSheet(selected: CountryCode, onSelect: (CountryCode) -> Unit, onDismiss: () -> Unit) {
    val c = ZipperTheme.colors
    var query by remember { mutableStateOf("") }
    val list = remember(query) {
        if (query.isBlank()) ALL_COUNTRIES else ALL_COUNTRIES.filter { it.name.contains(query, true) || it.dialCode.contains(query) }
    }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = c.bgElevated, dragHandle = null, shape = RoundedCornerShape(topStart = Radius.xl, topEnd = Radius.xl)) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.85f).navigationBarsPadding()) {
            Box(Modifier.padding(top = 6.dp).size(36.dp, 4.dp).background(c.borderDefault, CircleShape).align(Alignment.CenterHorizontally))
            Text("Country code", style = ZipperTheme.type.headingS, color = c.textPrimary, modifier = Modifier.padding(horizontal = Space.lg, vertical = Space.md))
            Row(
                Modifier.padding(horizontal = Space.lg).fillMaxWidth().height(44.dp).background(c.bgRaised, CircleShape).border(1.dp, c.borderSubtle, CircleShape).padding(horizontal = Space.md),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm),
            ) {
                Icon(Icons.Default.Search, null, tint = c.textMuted, modifier = Modifier.size(18.dp))
                BasicTextField(query, { query = it }, singleLine = true, textStyle = ZipperTheme.type.bodyM.copy(color = c.textPrimary), cursorBrush = SolidColor(c.brandPrimary), modifier = Modifier.weight(1f),
                    decorationBox = { inner -> if (query.isEmpty()) Text("Search country", style = ZipperTheme.type.bodyM, color = c.textMuted); inner() })
            }
            Spacer(Modifier.height(Space.sm))
            LazyColumn {
                items(list, key = { it.dialCode + it.name }) { cc ->
                    Row(
                        Modifier.fillMaxWidth().clickableNoRipple { onSelect(cc) }.padding(horizontal = Space.lg, vertical = Space.md),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md),
                    ) {
                        Text(cc.flag, style = ZipperTheme.type.bodyL)
                        Text(cc.name, style = ZipperTheme.type.bodyM, color = c.textPrimary, modifier = Modifier.weight(1f))
                        Text(cc.dialCode, style = ZipperTheme.type.labelM, color = if (cc == selected) c.textBrand else c.textSecondary)
                    }
                }
            }
        }
    }
}

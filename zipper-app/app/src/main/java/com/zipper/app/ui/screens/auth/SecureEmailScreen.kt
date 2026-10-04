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
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.MailOutline
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
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
import com.zipper.app.ui.components.Avatar
import com.zipper.app.ui.components.AvatarSize
import com.zipper.app.ui.components.ButtonStyle
import com.zipper.app.ui.components.IconButtonCircle
import com.zipper.app.ui.components.ZipperButton
import com.zipper.app.ui.components.clickableNoRipple
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import kotlinx.coroutines.delay

/**
 * "Secure your account", by email — a guest attaches an address and stops being
 * temporary.
 *
 * ── WHY THIS IS A SIBLING SCREEN AND NOT A MODE ON SecureAccountScreen ───────
 *
 * The two flows answer the same question and are deliberately identical to look
 * at — same frame, same four steps, same refusal, and the shared `StepColumn`
 * and `StepError` are what keep them that way. What is not shared is the middle,
 * and it is not a detail:
 *
 *   * The phone flow never leaves the app. Firebase texts six digits, the person
 *     types them into a box that is on screen the whole time, and the verify is
 *     a button they press.
 *   * The email flow ends by LEAVING. There is nothing to type; the app sends a
 *     link, goes quiet, and is reopened minutes later by an Android intent from
 *     a mail client, possibly in a new process. The completion is not a button
 *     at all — see [EmailLinkReturn].
 *
 * Folding that into one screen means a mode flag threaded through every step,
 * every `when`, the resend countdown, the ViewModel and the credential type,
 * with the only shared code being the parts already factored out. And the
 * Settings entry offers two rows — two destinations — so one screen would need
 * an argument saying which row was tapped, or a chooser step in front of both,
 * which is a step the phone flow does not have today and would be a regression
 * for the people who take it.
 *
 * ── NO PASSWORD FIELD, EVER ──────────────────────────────────────────────────
 *
 * This is a verification link, not a login. The app has no email+password
 * sign-in and must not gain one: a password is a second secret for the person
 * to lose and a second recovery flow to build, and it proves nothing the link
 * does not already prove. See `AuthRepository.linkEmail`.
 *
 * ── THE ADDRESS MAY NOT BE THEIRS TO TAKE ────────────────────────────────────
 *
 * Opening the link proves this person reads that mailbox today. It does not
 * prove anything about the account already attached to the address — addresses
 * get reused inside families and companies — so when the server refuses, this
 * screen refuses with it. Two ways out and no third: a different address, or
 * nothing. There is deliberately no merge, no overwrite, no "use that account
 * instead", and the guest's own account is left exactly as it was, which is what
 * `undoEmailLink` in the repository exists to guarantee.
 */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun SecureEmailScreen(
    /** The address is on the account. Back to wherever they came from. */
    onDone: () -> Unit,
    /** They changed their mind, or the address was not available. Nothing happened. */
    onCancel: () -> Unit,
    viewModel: SecureEmailViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    val focusManager = LocalFocusManager.current

    var email by remember { mutableStateOf("") }
    var resendIn by remember { mutableIntStateOf(0) }

    /*
     * The same no-op responder the login and phone screens carry.
     *
     * There is no reCAPTCHA here, but the crash it prevents is about an
     * activity coming back to the front while a field inside a vertical scroll
     * still holds focus ("BringIntoViewRequester used before parents are
     * placed") — and this is the one flow in the app that is DESIGNED to be
     * left and returned to, from a mail client.
     */
    val noOpResponder = remember {
        object : BringIntoViewResponder {
            override fun calculateRectForParent(localRect: Rect): Rect = localRect
            override suspend fun bringChildIntoView(localRect: () -> Rect?) {}
        }
    }

    fun send() {
        focusManager.clearFocus(force = true)
        viewModel.sendLink(email)
    }

    // Restarted whenever the sent step is entered, including after "use a
    // different address" — a countdown left over from the previous address
    // would sit there refusing a resend for a link that was never sent.
    LaunchedEffect(state.stage) {
        if (state.stage == SecureEmailStage.Sent) resendIn = 45
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
            label = "secure-email",
        ) { stage ->
            when (stage) {
                SecureEmailStage.Email -> AddressStep(
                    email = email,
                    // Trimmed on the way in rather than on submit: a leading
                    // space pasted from a contact card is invisible in the
                    // field and would otherwise fail validation with nothing on
                    // screen to explain why the button is dead.
                    onEmail = { email = it.trim() },
                    busy = state.busy,
                    error = state.error,
                    onSend = ::send,
                    onCancel = onCancel,
                )

                SecureEmailStage.Sent -> SentStep(
                    emailLabel = state.email,
                    busy = state.busy,
                    error = state.error,
                    resendIn = resendIn,
                    onChangeEmail = viewModel::useDifferentEmail,
                    onResend = { resendIn = 45; viewModel.resend() },
                )

                SecureEmailStage.Taken -> TakenEmailStep(
                    emailLabel = state.email,
                    heldByName = state.heldByName,
                    heldByPhotoUrl = state.heldByPhotoUrl,
                    /*
                     * The typed address is wiped here and deliberately NOT on
                     * the sent step's "use a different address", which is
                     * usually somebody fixing one wrong character and would be
                     * furious to find the field emptied. This address is not
                     * available to them at all, so leaving it in the box is an
                     * invitation to mail a second link to an address that will
                     * be refused again.
                     */
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
        IconButtonCircle(Icons.Default.Close, "Close", onCancel, background = c.bgRaised)

        Box(
            Modifier.size(72.dp).background(c.tintBrandSubtle, CircleShape),
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Outlined.MailOutline, null, tint = c.textBrand, modifier = Modifier.size(32.dp)) }

        Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            Text("Keep this account", style = ZipperTheme.type.headingL, color = c.textPrimary)
            /*
             * The same sentence as the phone step, for the same reason: it says
             * what is at stake in the words of the thing they would lose rather
             * than the mechanism that loses it.
             */
            Text(
                "You are signed in as a guest, so this account only exists on this " +
                    "phone — lose the phone and it is gone. Add your email and you " +
                    "can sign back into it, with your diamonds and your history, from " +
                    "anywhere.",
                style = ZipperTheme.type.bodyM, color = c.textSecondary,
            )
        }

        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Space.md)) {
            Text("Your email address", style = ZipperTheme.type.labelM, color = c.textSecondary)
            EmailField(email = email, onEmail = onEmail, onDone = { if (canSubmit) onSend() })
            ZipperButton(
                "Send me a link", onSend,
                gradient = true, fullWidth = true, enabled = canSubmit, loading = busy,
            )
            /*
             * Says there is no password before they go looking for one. People
             * who have used a hundred other apps expect an email field to be
             * followed by a password field, and an email flow with no password
             * anywhere reads as a form that has not finished loading.
             */
            Text(
                "We will email you a link to tap. There is no password to set, and " +
                    "nothing about your profile changes.",
                style = ZipperTheme.type.caption, color = c.textMuted,
            )
        }

        StepError(error)

        ZipperButton("Not now", onCancel, style = ButtonStyle.Ghost, fullWidth = true, enabled = !busy)
    }
}

/**
 * Sent, and waiting.
 *
 * The one step in either flow with nothing to press towards, so it says where
 * the next action is and on WHICH DEVICE it has to happen. A link opened on a
 * laptop signs a browser in and leaves this account exactly as it was, and the
 * person would have no way of knowing why nothing happened.
 */
@Composable
private fun SentStep(
    emailLabel: String,
    busy: Boolean, error: String?, resendIn: Int,
    onChangeEmail: () -> Unit, onResend: () -> Unit,
) {
    val c = ZipperTheme.colors

    StepColumn {
        IconButtonCircle(
            Icons.AutoMirrored.Filled.ArrowBack, "Back", onChangeEmail,
            background = c.bgRaised,
        )

        Box(
            Modifier.size(72.dp).background(c.tintBrandSubtle, CircleShape),
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Outlined.Inbox, null, tint = c.textBrand, modifier = Modifier.size(32.dp)) }

        Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            Text("Check your email", style = ZipperTheme.type.headingL, color = c.textPrimary)
            Text(
                "We sent a link to $emailLabel. Open it on this phone and your " +
                    "account is kept — there is nothing to type back here.",
                style = ZipperTheme.type.bodyM, color = c.textSecondary,
            )
            Text(
                "It has to be opened on this phone. A link opened on a computer " +
                    "will not reach this account.",
                style = ZipperTheme.type.caption, color = c.textMuted,
            )
        }

        /*
         * `busy` on this step means the link has come back and is being
         * exchanged — see SecureEmailStage.Sent. Shown rather than swapped for
         * a fifth step, so the screen does not flicker through a state that
         * lasts under a second on a good connection.
         */
        if (busy) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Space.md),
            ) {
                CircularProgressIndicator(
                    modifier = Modifier.size(18.dp),
                    color = c.brandPrimary,
                    strokeWidth = 2.dp,
                )
                Text("Adding it to your account…", style = ZipperTheme.type.bodyS, color = c.textSecondary)
            }
        }

        StepError(error)

        Column(
            Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(Space.xl),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            ZipperButton(
                "Use a different address", onChangeEmail,
                style = ButtonStyle.Ghost, fullWidth = true, enabled = !busy,
            )
            if (resendIn > 0) {
                Text(
                    "Resend link in ${resendIn}s",
                    style = ZipperTheme.type.bodyS, color = c.textMuted, textAlign = TextAlign.Center,
                )
            } else {
                Text(
                    "Resend link",
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
 * address off whoever has it. Opening the link proved this person reads that
 * mailbox right now; it proved nothing about the account attached to it, and a
 * shared family address or an old work address makes those two completely
 * different claims. Any button here that touched the other account would be an
 * account-takeover route with a friendly label on it, which is exactly the
 * dialog `bindVerifiedIdentity` was rewritten to delete.
 *
 * So there are two answers, and both of them leave every account involved
 * exactly as it was.
 */
@Composable
private fun TakenEmailStep(
    emailLabel: String,
    heldByName: String,
    heldByPhotoUrl: String,
    onUseDifferentEmail: () -> Unit,
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
                "That email is already taken",
                style = ZipperTheme.type.headingL, color = c.textPrimary,
            )
            Text(
                "$emailLabel belongs to another Zipper account, so it cannot be added " +
                    "to this one. Your guest account has not been changed — nothing " +
                    "has been added to it and nothing taken away.",
                style = ZipperTheme.type.bodyM, color = c.textSecondary,
            )
        }

        /*
         * Who it is, when the lookup found them.
         *
         * The likeliest holder by far is the person's own older account — they
         * are typing their own address — and the name is what makes them
         * realise that, where a nameless refusal reads as the app being wrong
         * about an address they know perfectly well is theirs. Shown as a fact
         * about the address they have just proved they read, with no control on
         * it.
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
                        "Already uses this email",
                        style = ZipperTheme.type.caption, color = c.textMuted, maxLines = 1,
                    )
                }
            }
        }

        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Space.md)) {
            ZipperButton(
                "Use a different address", onUseDifferentEmail,
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
            "If that account is yours, log out and sign in with it instead. " +
                "Do that only if you are happy to leave this guest account behind.",
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
            Text("Your account is yours", style = ZipperTheme.type.headingL, color = c.textPrimary)
            /*
             * Names the uid-keeping outcome in the only terms that matter to the
             * person: it is the SAME account. The whole risk of a flow like this
             * is somebody assuming they have just made a second one.
             */
            /*
             * Careful about what this promises.
             *
             * It used to end "Sign in with that address on any phone and it is
             * here", and the app cannot do that: the sign-in screen offers
             * Google, phone and guest, and there is no email door — deliberately,
             * because the mobile app is never getting an email-and-password
             * login. Google with the same address does not reach the account
             * either; the binding verifies the address, so Firebase raises a
             * collision and `signInWithGoogle` turns it into IdentityTaken.
             *
             * So the address is a recovery ANCHOR, not a second front door, and
             * saying otherwise would leave somebody who lost their phone
             * hunting for a screen that does not exist.
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

/**
 * The 56dp address row.
 *
 * Deliberately the same box as `PhoneNumberField` minus the dial-code chip, so
 * the two entry steps are the same control to look at. It is not lifted into
 * LoginScreen beside that one because nothing else in the app takes an email
 * on this styling — profile setup has its own `SetupField` — and a shared
 * component with one caller is a component that will be changed for that caller
 * anyway.
 */
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
 * sending, and no more than that.
 *
 * `android.util.Patterns.EMAIL_ADDRESS` rather than a regex written here: the
 * platform one is already on every device, already wrong in the same ways for
 * everybody, and cannot drift from the one profile setup would use. The real
 * authority is whether the mail arrives, and no client-side pattern is allowed
 * to be stricter than that — a person whose perfectly valid address is refused
 * by a home-made regex has no way round it at all.
 */
private fun looksLikeAnEmail(value: String): Boolean {
    val address = value.trim()
    return address.isNotEmpty() &&
        android.util.Patterns.EMAIL_ADDRESS.matcher(address).matches()
}

package com.zipper.app.ui.screens.auth

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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AddPhotoAlternate
import androidx.compose.material.icons.outlined.Block
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import com.google.firebase.auth.FirebaseAuth
import com.zipper.app.data.repository.AppealStatement
import com.zipper.app.data.repository.AppealStatus
import com.zipper.app.ui.components.ButtonStyle
import com.zipper.app.ui.components.ZipperButton
import com.zipper.app.util.AppealRoute
import com.zipper.app.util.PublicAppeal
import com.zipper.app.ui.components.clickableNoRipple
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme

/**
 * WHAT is blocked — the account, or the handset it is being used on.
 *
 * ── WHY THE SCREEN HAS TO BE TOLD ────────────────────────────────────────────
 *
 * This one destination is reached from two completely different findings, and
 * the reason string that arrives with it cannot be told apart:
 *
 *   [Account]  `users/{uid}.isBanned` is true and the account is not merely
 *              suspended. The reason is `banReason`.
 *   [Device]   `bannedDevices/{androidId}` exists. The reason is that
 *              document's, and it applies to EVERY account on this phone —
 *              including one that has done nothing wrong, and including the
 *              new one somebody is about to make to get around it.
 *
 * Told "your account has been banned" over a device ban, a person signs out and
 * registers again, which is precisely the move a device ban exists to stop, and
 * they burn a phone number finding that out. So the caller passes what it
 * actually found, and the copy follows from it.
 *
 * A SUSPENSION is not in this enum on purpose: it is not a variant of this
 * screen, it is SuspendedScreen, because the behaviour differs (the device
 * stays clean, so they may sign in with another account) and not only the
 * wording.
 */
enum class BanKind(val arg: String) {
    Account("account"),
    Device("device");

    companion object {
        /**
         * Anything unrecognised — a missing argument, a value from a future
         * build — reads as an ACCOUNT ban.
         *
         * That is the safe end to fail towards: it is the commoner case, and it
         * neither tells somebody their phone is barred when it is not nor hides
         * a wall behind a wording that invites them to try again.
         */
        fun fromArg(value: String?): BanKind = entries.firstOrNull { it.arg == value } ?: Account
    }
}

/*
 * Banned — a wall, but no longer a dead end.
 *
 * ── WHAT THIS SCREEN USED TO BE ──────────────────────────────────────────────
 *
 * A danger disc, the reason, and the sentence "if you believe this is a
 * mistake, contact support@zipperlive.app". That is the whole product's answer
 * to a wrongful ban: leave, open an email client, and hope somebody reads it.
 * There was a TODO in the file saying the callbacks for a Contact support
 * button did not exist.
 *
 * The people this matters most to are the ones who were banned by mistake —
 * a host reported by a viewer who lost an argument, an account caught by a
 * device ban meant for somebody else. They are also the ones least likely to
 * chase an email address, and the ones whose earnings are stopped while they
 * do not.
 *
 * So the appeal is filed from here, in the product, by an account that is
 * still signed in — `isBanned` gates the product, not the session, which is
 * what makes this possible at all.
 *
 * ── AND WHAT IT USED TO SAY ──────────────────────────────────────────────────
 *
 * "Account suspended", hardcoded, for all of it. Three findings reached this
 * screen — a suspension, a ban, a barred device — and every one of them was
 * announced with the one word that was wrong for two of them. A banned host
 * read "suspended" and waited for it to end; a suspended one read a screen with
 * no end date and assumed it never would; somebody on a barred handset read
 * "your account" and made another. A suspension has its own screen now (see
 * SuspendedScreen) and the two that are left are told apart by [BanKind].
 *
 * Three states, and the appeal panel must not conflate them either:
 *
 *   nothing filed    the form, with a statement and up to three photographs.
 *   one waiting      no form. "It is with a reviewer" — a second appeal from
 *                    the same person delays every other appeal in the queue.
 *   one decided      what the reviewer said, verbatim. Somebody refused should
 *                    read the reason rather than file the same words again.
 */
@Composable
fun BannedScreen(
    reason: String,
    kind: BanKind = BanKind.Account,
    viewModel: BannedViewModel = hiltViewModel(),
) {
    // No back navigation — this is still a wall.
    BackHandler(enabled = true) { /* swallow back press */ }
    val c = ZipperTheme.colors

    Box(Modifier.fillMaxSize().background(c.bgBase)) {
        AmbientGlows()
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Space.xxl, vertical = Space.x4l),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box(
                Modifier.size(96.dp).background(c.tintDangerSubtle, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                // The same "no entry" disc for both. What differs between a
                // banned account and a barred handset is what the person can do
                // next, and that is carried by the words below rather than by a
                // second icon nobody would read as the distinction.
                Icon(Icons.Outlined.Block, null, tint = c.statusDanger, modifier = Modifier.size(44.dp))
            }
            Spacer(Modifier.height(Space.xxl))
            Text(
                when (kind) {
                    BanKind.Account -> "Account banned"
                    // "This device", not "your account". The account in their
                    // hand may be perfectly fine; it is the hardware that is
                    // refused, and saying so is the only way the sentence below
                    // about a new account makes any sense.
                    BanKind.Device -> "This device is blocked"
                },
                style = ZipperTheme.type.headingL,
                color = c.textPrimary,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(Space.md))
            Text(
                reason.ifBlank {
                    when (kind) {
                        BanKind.Account -> "Your account has been banned."
                        BanKind.Device -> "This device has been blocked from Zipper."
                    }
                },
                style = ZipperTheme.type.bodyM,
                color = c.textSecondary,
                textAlign = TextAlign.Center,
            )

            if (kind == BanKind.Device) {
                /*
                 * The one sentence that saves a wasted phone number.
                 *
                 * Without it the obvious next move is to sign out and register
                 * again — which fails in exactly the same way, at the cost of
                 * an OTP and a second number, and reads to the person as the
                 * app being broken rather than as a decision about the handset.
                 */
                Spacer(Modifier.height(Space.md))
                Text(
                    "Every account is blocked on this phone, whoever signs in, so " +
                        "making a new one here will not get past it. Another device " +
                        "will work if the account itself is in good standing.",
                    style = ZipperTheme.type.bodyS,
                    color = c.textMuted,
                    textAlign = TextAlign.Center,
                )
            }

            Spacer(Modifier.height(Space.xxl))

            AppealPanel(viewModel)

            Spacer(Modifier.navigationBarsPadding())
        }
    }
}

/**
 * "Think this is wrong?" — the appeal, and whatever came of the last one.
 *
 * ── WHY THIS IS NOT PRIVATE TO BannedScreen ──────────────────────────────────
 *
 * A suspension is appealed through the same queue, by the same server call, on
 * the same rules (`AppealRepository` says so in its own heading: "Appealing a
 * ban or a suspension"). SuspendedScreen therefore needs every line of this,
 * and the alternative — a second copy of the form, the evidence picker, the
 * three states and the wording — would drift the first time one of them was
 * changed, most likely leaving the SUSPENDED person with the older, worse one.
 *
 * It is the whole panel rather than a handful of helpers so that the three
 * states stay mutually exclusive by construction: there is one `when` over
 * them, in one place, and neither screen can show a form to somebody who
 * already has an appeal waiting.
 */
@Composable
internal fun AppealPanel(viewModel: BannedViewModel = hiltViewModel()) {
    val c = ZipperTheme.colors
    val state by viewModel.state.collectAsStateWithLifecycle()

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        uri?.let(viewModel::addEvidence)
    }

    /*
     * AN APPEAL IS A WRITE ABOUT THE ACCOUNT — SO SOMETHING HAS TO PROVE WHOSE.
     *
     * Every other way into this panel keeps the session deliberately (see
     * SplashScreen), but a DEVICE ban does not: it is found before anybody has
     * signed in, on the cold-start check and on the login screen's first tap,
     * and the person sitting in front of it may hold no credential at all.
     *
     * `firestore.rules` requires `subjectUid == request.auth.uid`, so for them
     * the ordinary form would accept a statement, accept photographs, and fail
     * on submit with "You are not signed in" — after the typing, which is the
     * worst possible moment to say it.
     *
     * ── C9 (B26): THE DEVICE KEY IS PROOF TOO ───────────────────────────────
     *
     * This used to ask only "is anybody signed in", and answer the web address
     * otherwise. But a ban or a suspension found by QUICK LOGIN never issues a
     * session, and those are exactly the people `submitAccountAppeal` was built
     * for: the saved credential plus a Keystore signature proves the handset,
     * and the appeal is filed with no session at all. So the form is shown
     * whenever `state.route` (AppealRoute) says it can be SENT — signed in, or
     * holding both the credential and the key — and the web appeal only when
     * neither is there. The device-key form carries the statement alone and
     * grants nothing but the appeal.
     *
     * Decided once, by the view model, when the screen opens: a fact about how
     * the screen was entered, which must not flicker into a form halfway
     * through somebody reading it.
     */
    val route = state.route

    Column(
        Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        when {
            state.checking -> {
                CircularProgressIndicator(color = c.brandPrimary, strokeWidth = 2.dp, modifier = Modifier.size(22.dp))
            }

            !AppealRoute.showsForm(route) -> {
                // UGP-F: nothing on this phone can send the in-app form — but the
                // public web appeal can, with the account ID below. Support is
                // still named as the other way.
                WebAppealCard(accountId = PublicAppeal.accountIdToShow(null))
                Spacer(Modifier.height(Space.md))
                Text(
                    "You can also write to support@zipperlive.app from the email address or " +
                        "phone number on the account. A person reads it.",
                    style = ZipperTheme.type.caption, color = c.textMuted,
                    textAlign = TextAlign.Center,
                )
            }

            // Already with a reviewer. Say so, and do not offer the form.
            state.hasPending -> {
                NoticeCard {
                    Icon(Icons.Outlined.CheckCircle, null, tint = c.statusSuccess, modifier = Modifier.size(26.dp))
                    Spacer(Modifier.height(Space.md))
                    Text(
                        if (state.sent) "Your appeal has been sent" else "Your appeal is with a reviewer",
                        style = ZipperTheme.type.labelL, color = c.textPrimary, textAlign = TextAlign.Center,
                    )
                    Spacer(Modifier.height(Space.sm))
                    Text(
                        "A person reads every appeal. You will be able to sign in " +
                        "normally if it is accepted — there is nothing else you need " +
                        "to do, and sending another one will not make it faster.",
                        style = ZipperTheme.type.bodyS, color = c.textSecondary, textAlign = TextAlign.Center,
                    )
                    // Said out loud, and only when it happened. The appeal is
                    // filed either way — but a reviewer seeing no screenshot
                    // when the person believes they sent one is how a good
                    // appeal gets refused.
                    if (state.evidenceDropped > 0) {
                        Spacer(Modifier.height(Space.sm))
                        Text(
                            if (state.evidenceDropped == 1)
                                "One screenshot could not be attached, so the reviewer " +
                                "will not see it. Your appeal was still sent."
                            else
                                "${state.evidenceDropped} screenshots could not be attached, " +
                                "so the reviewer will not see them. Your appeal was still sent.",
                            style = ZipperTheme.type.bodyS,
                            color = c.statusWarning,
                            textAlign = TextAlign.Center,
                        )
                    }
                }
            }

            else -> {
                /*
                 * A previous appeal, concluded. Shown before the form, because
                 * somebody who was refused needs the reason more than they need
                 * another empty box.
                 *
                 * ── WHY THIS IS A `when` AND NOT AN `if/else` ────────────────
                 *
                 * It was `if (verdict == "overturned") accepted else refused` —
                 * an `else` over a string the SERVER owns, which silently
                 * promised that `upheld` and `overturned` are the only outcomes
                 * that will ever exist. The backend's `AppealStatus` is an enum
                 * that is expected to grow, and the first new member would have
                 * made this screen tell people their appeal "was not accepted"
                 * when nobody had refused it.
                 *
                 * `AppealStatus.outcomeOf` is total, so UNRECOGNISED is a real
                 * branch rather than a default. The reviewer's words are shown
                 * for every outcome — on an unknown status they are the only
                 * trustworthy thing on screen, so they carry it alone.
                 */
                val headline: String? = when (state.lastOutcome) {
                    AppealStatus.Outcome.NONE -> null
                    AppealStatus.Outcome.ACCEPTED -> "Your last appeal was accepted"
                    AppealStatus.Outcome.REFUSED -> "Your last appeal was not accepted"
                    // Deliberately neutral. Claims neither acceptance nor
                    // refusal, because this build cannot tell which it was.
                    AppealStatus.Outcome.UNRECOGNISED -> "About your last appeal"
                }

                if (headline != null) {
                    NoticeCard {
                        Text(
                            headline,
                            style = ZipperTheme.type.labelL,
                            color = if (state.lastOutcome == AppealStatus.Outcome.ACCEPTED)
                                c.statusSuccess else c.textPrimary,
                            textAlign = TextAlign.Center,
                        )
                        if (state.lastReason.isNotBlank()) {
                            Spacer(Modifier.height(Space.sm))
                            Text(
                                state.lastReason,
                                style = ZipperTheme.type.bodyS,
                                color = c.textSecondary,
                                textAlign = TextAlign.Center,
                            )
                        }
                    }
                    Spacer(Modifier.height(Space.lg))
                }

                Text(
                    "Think this is wrong?",
                    style = ZipperTheme.type.labelL, color = c.textPrimary,
                )
                Spacer(Modifier.height(Space.xs))
                Text(
                    "Tell us what happened. A person will read it.",
                    style = ZipperTheme.type.bodyS, color = c.textSecondary, textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(Space.md))

                Box(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 120.dp)
                        .background(c.bgElevated, RoundedCornerShape(Radius.lg))
                        .border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.lg))
                        .padding(Space.md),
                ) {
                    BasicTextField(
                        value = state.statement,
                        onValueChange = viewModel::onStatement,
                        textStyle = ZipperTheme.type.bodyM.copy(color = c.textPrimary),
                        cursorBrush = SolidColor(c.brandPrimary),
                        modifier = Modifier.fillMaxWidth(),
                        decorationBox = { inner ->
                            if (state.statement.isEmpty()) {
                                Text(
                                    "What happened, in your own words…",
                                    style = ZipperTheme.type.bodyM, color = c.textMuted,
                                )
                            }
                            inner()
                        },
                    )
                }

                // ── THE MINIMUM, ON SCREEN ────────────────────────────────
                //
                // `AppealStatement.MIN` is 20 and the Send button is gated on
                // it, but the only place that number was ever written down
                // was an error string the user could not reach: the button
                // that would have triggered it was the thing disabled. People
                // typed a short sentence, watched a grey button, and had no
                // way to find out why — which, on the screen whose entire
                // purpose is letting somebody say they were banned by
                // mistake, means the appeal never arrives.
                //
                // A live count rather than a static hint, so the remedy is
                // visible while they type. It turns red only once they have
                // started, because an untouched field is not an error.
                //
                // Both values come from `AppealStatement`, the same object the
                // button and the repository use, so the counter cannot read
                // "20 / 20" beside a button that will not press.
                Spacer(Modifier.height(Space.xs))
                val typed = AppealStatement.length(state.statement)
                val short = !AppealStatement.isSendable(state.statement)
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        if (short) "At least ${AppealStatement.MIN} characters"
                        else "Ready to send",
                        style = ZipperTheme.type.bodyS,
                        color = if (short && typed > 0) c.statusDanger else c.textSecondary,
                    )
                    Text(
                        "$typed / ${AppealStatement.MIN}",
                        style = ZipperTheme.type.bodyS,
                        color = if (short && typed > 0) c.statusDanger else c.textSecondary,
                    )
                }

                Spacer(Modifier.height(Space.md))

                // C9: sent by the device key, with no session — so there is no
                // upload, and no picker that would collect screenshots only to
                // drop them. Said once, plainly, instead.
                if (!AppealRoute.carriesEvidence(route)) {
                    Text(
                        "Sent from this phone without signing in, so screenshots can't be " +
                            "attached here. Your words are what the reviewer reads.",
                        style = ZipperTheme.type.caption, color = c.textMuted,
                        textAlign = TextAlign.Center,
                    )
                } else {
                    // Evidence. Optional, and capped at three — a reviewer who
                    // has to open twenty screenshots reads none of them.
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(Space.sm),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        state.evidence.forEach { uri ->
                            Box {
                                AsyncImage(
                                    model = uri,
                                    contentDescription = "Evidence",
                                    modifier = Modifier
                                        .size(64.dp)
                                        .background(c.bgElevated, RoundedCornerShape(Radius.md)),
                                )
                                Box(
                                    Modifier
                                        .align(Alignment.TopEnd)
                                        .size(20.dp)
                                        .background(c.bgBase, CircleShape)
                                        .clickableNoRipple { viewModel.removeEvidence(uri) },
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Icon(Icons.Outlined.Close, "Remove", tint = c.textSecondary, modifier = Modifier.size(13.dp))
                                }
                            }
                        }
                        if (state.evidence.size < 3) {
                            Box(
                                Modifier
                                    .size(64.dp)
                                    .background(c.bgElevated, RoundedCornerShape(Radius.md))
                                    .border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.md))
                                    .clickableNoRipple { picker.launch("image/*") },
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(
                                    Icons.Outlined.AddPhotoAlternate, "Add a photo",
                                    tint = c.textMuted, modifier = Modifier.size(22.dp),
                                )
                            }
                        }
                        Spacer(Modifier.weight(1f))
                    }
                    Spacer(Modifier.height(Space.xs))
                    Text(
                        "Screenshots help, up to three. Optional.",
                        style = ZipperTheme.type.caption, color = c.textMuted,
                    )
                }

                state.error?.let { err ->
                    Spacer(Modifier.height(Space.md))
                    Text(err, style = ZipperTheme.type.bodyS, color = c.statusDanger, textAlign = TextAlign.Center)
                }

                Spacer(Modifier.height(Space.lg))
                ZipperButton(
                    "Send appeal",
                    onClick = viewModel::submit,
                    gradient = true,
                    fullWidth = true,
                    // The same rule the repository enforces, through the same
                    // function — a second copy of the comparison here is how
                    // the UI and the validator drift apart.
                    enabled = AppealStatement.isSendable(state.statement) && !state.sending,
                    loading = state.sending,
                )
            }
        }

        // "Also" — a second way, on top of the form above. Not shown to somebody
        // who has no form, because for them the address is the only route and
        // the card above has already given it; the word would be a lie about
        // what else they could have done.
        if (!state.checking && AppealRoute.showsForm(route)) {
            Spacer(Modifier.height(Space.xxl))
            // UGP-F: the same appeal can be filed on the web, signed out, from
            // any device — useful once this screen signs them out.
            WebAppealCard(accountId = PublicAppeal.accountIdToShow(FirebaseAuth.getInstance().currentUser?.uid))
            Spacer(Modifier.height(Space.md))
            Text(
                "You can also write to support@zipperlive.app",
                style = ZipperTheme.type.caption, color = c.textMuted, textAlign = TextAlign.Center,
            )
        }
    }
}

/**
 * UGP-F — the public web appeal: the address and THIS account's ID, copyable.
 *
 * The page needs no sign-in, so it works after this screen signs the person
 * out, after a reinstall, or from a computer. It writes the same appeals queue
 * as the form above and changes nothing on the account by itself.
 */
@Composable
internal fun WebAppealCard(accountId: String) {
    val c = ZipperTheme.colors
    val clipboard = LocalClipboardManager.current
    val uri = LocalUriHandler.current
    NoticeCard {
        Text(
            "Appeal on the web",
            style = ZipperTheme.type.labelL, color = c.textPrimary, textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(Space.sm))
        Text(
            "Go to ${PublicAppeal.DISPLAY} on any phone or computer — no sign-in needed — " +
                "enter your account ID and say what happened. A person reviews it.",
            style = ZipperTheme.type.bodyS, color = c.textSecondary, textAlign = TextAlign.Center,
        )
        if (accountId.isNotBlank()) {
            Spacer(Modifier.height(Space.md))
            Text("Your account ID", style = ZipperTheme.type.caption, color = c.textMuted)
            Text(
                accountId,
                style = ZipperTheme.type.labelM, color = c.textPrimary, textAlign = TextAlign.Center,
                modifier = Modifier.clickableNoRipple { clipboard.setText(AnnotatedString(accountId)) },
            )
            Text("Tap to copy", style = ZipperTheme.type.caption, color = c.textMuted)
        } else {
            Spacer(Modifier.height(Space.sm))
            Text(
                "If you cannot see your account ID, use your display name together with the " +
                    "8-character ID from your profile.",
                style = ZipperTheme.type.caption, color = c.textMuted, textAlign = TextAlign.Center,
            )
        }
        Spacer(Modifier.height(Space.md))
        ZipperButton(
            "Open the appeal page",
            onClick = { runCatching { uri.openUri(PublicAppeal.URL) } },
            style = ButtonStyle.Secondary,
            fullWidth = true,
        )
    }
}

/**
 * The panel used for "with a reviewer", "here is what they said", and — on
 * SuspendedScreen — "here is when it ends".
 *
 * Not private, because SuspendedScreen shows the same kind of quiet statement
 * of fact and a second hand-rolled copy would drift from this one.
 */
@Composable
internal fun NoticeCard(content: @Composable ColumnScope.() -> Unit) {
    val c = ZipperTheme.colors
    // Was the literal 0x0DFFFFFF — white at 5%, hand-rolled. `glassLow` is the
    // token for exactly that idea (a translucent panel over the background) and
    // is defined per palette: white at low alpha in dark, ink at low alpha in
    // light. The literal would have stayed white-on-white in a light palette,
    // making this card's fill vanish and leaving only its hairline border.
    Column(
        Modifier
            .fillMaxWidth()
            .background(c.glassLow, RoundedCornerShape(Radius.lg))
            .border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.lg))
            .padding(Space.lg),
        horizontalAlignment = Alignment.CenterHorizontally,
        content = content,
    )
}

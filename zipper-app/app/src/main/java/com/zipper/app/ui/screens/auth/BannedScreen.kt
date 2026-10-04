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
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import com.google.firebase.auth.FirebaseAuth
import com.zipper.app.ui.components.ZipperButton
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
     * AN APPEAL IS A WRITE ABOUT THE SIGNED-IN ACCOUNT — SO THERE HAS TO BE ONE.
     *
     * Every other way into this panel keeps the session deliberately (see
     * SplashScreen), but a DEVICE ban does not: it is found before anybody has
     * signed in, on the cold-start check and on the login screen's first tap,
     * and the person sitting in front of it may hold no credential at all.
     *
     * `firestore.rules` requires `subjectUid == request.auth.uid`, so for them
     * the form would accept a statement, accept photographs, and fail on submit
     * with "You are not signed in" — after the typing, which is the worst
     * possible moment to say it. They get the address instead.
     *
     * Remembered rather than read on each recomposition: this is a fact about
     * how the screen was entered, and it must not flicker into a form halfway
     * through somebody reading it.
     */
    val signedIn = remember { FirebaseAuth.getInstance().currentUser != null }

    Column(
        Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        when {
            !signedIn -> {
                NoticeCard {
                    Text(
                        "Think this is wrong?",
                        style = ZipperTheme.type.labelL, color = c.textPrimary,
                        textAlign = TextAlign.Center,
                    )
                    Spacer(Modifier.height(Space.sm))
                    Text(
                        "Write to support@zipperlive.app from the email address or " +
                            "phone number on the account, and say what happened. A " +
                            "person reads it.",
                        style = ZipperTheme.type.bodyS, color = c.textSecondary,
                        textAlign = TextAlign.Center,
                    )
                }
            }

            state.checking -> {
                CircularProgressIndicator(color = c.brandPrimary, strokeWidth = 2.dp, modifier = Modifier.size(22.dp))
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
                }
            }

            else -> {
                // A previous appeal, decided. Shown before the form, because
                // somebody who was refused needs the reason more than they
                // need another empty box.
                if (state.lastVerdict.isNotBlank()) {
                    NoticeCard {
                        Text(
                            if (state.lastVerdict == "overturned")
                                "Your last appeal was accepted"
                            else "Your last appeal was not accepted",
                            style = ZipperTheme.type.labelL,
                            color = if (state.lastVerdict == "overturned") c.statusSuccess else c.textPrimary,
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

                Spacer(Modifier.height(Space.md))

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
                    enabled = state.statement.trim().length >= 20 && !state.sending,
                    loading = state.sending,
                )
            }
        }

        // "Also" — a second way, on top of the form above. Not shown to somebody
        // who has no form, because for them the address is the only route and
        // the card above has already given it; the word would be a lie about
        // what else they could have done.
        if (signedIn) {
            Spacer(Modifier.height(Space.xxl))
            Text(
                "You can also write to support@zipperlive.app",
                style = ZipperTheme.type.caption, color = c.textMuted, textAlign = TextAlign.Center,
            )
        }
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

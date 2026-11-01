package com.zipper.app.ui.screens.auth

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.SwitchAccount
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.zipper.app.ui.components.ButtonStyle
import com.zipper.app.ui.components.ZipperButton
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** One day in millis, for the "how much longer" arithmetic below. */
private const val DAY_MS = 86_400_000L

/**
 * Suspended — which is not banned, and the difference is the whole screen.
 *
 * ── WHY THIS IS NOT A PARAMETER ON BannedScreen ──────────────────────────────
 *
 * A repo-wide search for `isSuspended` used to return nothing. The app had one
 * gate, `isBanned`, the server sets it for a suspension as well as for a ban,
 * and so a seven-day suspension arrived on BannedScreen — a screen with no end
 * date, no way off it, and the hardcoded title "Account suspended" shown to
 * banned people too. Three findings, one screen, one word, and it was the wrong
 * word for two of them.
 *
 * What separates the two is not the tone of the copy. It is this:
 *
 *   SUSPENDED   the account is shut out, temporarily. THE DEVICE IS NOT BARRED.
 *               The person may go back to the login screen and sign in with a
 *               different, eligible account on the same phone — which matters
 *               most on a shared handset, where one person's suspension used to
 *               take the phone away from everybody else who signs in on it.
 *   BANNED      the account and every device it has been seen on. There is
 *               nothing to go back to the login screen for, which is why
 *               BannedScreen does not offer it.
 *
 * So the button on this screen is not decoration: it is the behavioural
 * difference between the two states, made available. See `resolveSignIn` in
 * functions/src/identity.ts, which bars the device on a ban and deliberately
 * does not on a suspension.
 *
 * ── WHAT IT MUST SAY, AND WHAT IT MUST NOT INVENT ────────────────────────────
 *
 * When it ends, in words a person can plan around: the date, and how far away
 * that is. And when `suspendedUntil` is ABSENT — an indefinite suspension, one
 * that runs until a reviewer lifts it — it says exactly that. Formatting a
 * missing timestamp would put 1 January 1970 on screen as the day somebody gets
 * their account back, and a wrong date here is worse than no date: they stop
 * appealing and wait for a day that means nothing.
 *
 * The session is KEPT, exactly as it is on a ban, because the appeal is a write
 * about the signed-in account. See SplashScreen for the whole reasoning.
 */
@Composable
fun SuspendedScreen(
    reason: String,
    /** When it ends, in millis. 0 = indefinite, NOT "already over". */
    untilMillis: Long,
    /**
     * Sign out and go back to Login, so another account can be used on this
     * phone. The graph hands in the app's one sign-out path rather than this
     * screen rolling its own — see `signOutAndGoToLogin` in ZipperNavGraph,
     * which is the same call "Switch account" in Settings makes.
     */
    onBackToLogin: () -> Unit,
    viewModel: BannedViewModel = hiltViewModel(),
) {
    /*
     * Back does nothing, as on every other wall in this flow.
     *
     * The way off this screen is the button, which signs out first. A back
     * press that popped an empty stack would close the app instead, and a
     * person who has just been suspended reads that as the app crashing on
     * them.
     */
    BackHandler(enabled = true) { /* swallow back press */ }
    val c = ZipperTheme.colors

    val endsOn = remember(untilMillis) {
        if (untilMillis <= 0L) null
        else SimpleDateFormat("d MMMM yyyy", Locale.getDefault()).format(Date(untilMillis))
    }
    /*
     * ROUNDED UP, NOT DOWN.
     *
     * Floor division is what the deletion screen uses, and it is the right call
     * there — a deadline twenty hours away really is "today", and the screen
     * says so in words. Here the same arithmetic would print "0 days" to
     * somebody who is still locked out for most of a day, which reads as "it is
     * over" while the product is still refusing them: the exact confusion this
     * screen exists to end. Rounding up can only ever overstate the wait by
     * less than a day, and the copy below says "less than a day" rather than
     * "1 day" when that is what it comes to.
     *
     * Three values, three different sentences, and they must not be collapsed:
     *
     *   null  no end date on the document — an INDEFINITE suspension.
     *   0     the end date has already passed and the account is still shut
     *         out, because the sweep that lifts expired suspensions runs on a
     *         schedule and has not come round yet.
     *   n     n days of it left to run.
     */
    val daysLeft = remember(untilMillis) {
        if (untilMillis <= 0L) null
        else {
            val remaining = untilMillis - System.currentTimeMillis()
            if (remaining <= 0L) 0 else ((remaining + DAY_MS - 1L) / DAY_MS).toInt()
        }
    }

    Box(Modifier.fillMaxSize().background(c.bgBase)) {
        AmbientGlows()
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Space.xxl, vertical = Space.x4l),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            /*
             * Amber and a clock, not red and a "no entry" sign.
             *
             * BannedScreen's disc is `tintDangerSubtle` + `statusDanger`
             * because a ban is the end of the account. This one is the same
             * pairing RecoverAccountScreen uses for a thing that is waiting on
             * a clock — the point being made before a word is read is that this
             * one is temporary.
             */
            Box(
                Modifier.size(96.dp).background(c.tintGoldSubtle, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Outlined.History, null, tint = c.statusWarning, modifier = Modifier.size(44.dp))
            }
            Spacer(Modifier.height(Space.xxl))
            Text(
                "Account suspended",
                style = ZipperTheme.type.headingL,
                color = c.textPrimary,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(Space.xs))
            // Said out loud, because the screen this replaced was the banned
            // one and a person who has seen it before will assume the worst.
            Text(
                "This is a suspension, not a ban.",
                style = ZipperTheme.type.bodyS,
                color = c.textMuted,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(Space.md))
            Text(
                reason.ifBlank { "Your account has been suspended." },
                style = ZipperTheme.type.bodyM,
                color = c.textSecondary,
                textAlign = TextAlign.Center,
            )

            Spacer(Modifier.height(Space.xxl))

            // ── When it ends ──────────────────────────────────────────────
            NoticeCard {
                when {
                    /*
                     * No `suspendedUntil` on the document at all. The CRM omits
                     * the field for a suspension with no fixed term, so there
                     * is genuinely no date to show — and saying so plainly is
                     * the only honest option. The alternative, quietly showing
                     * nothing, leaves a suspension that looks identical to a
                     * seven-day one and a person checking every morning for an
                     * ending that was never scheduled.
                     */
                    daysLeft == null -> {
                        Text(
                            "No end date",
                            style = ZipperTheme.type.labelL, color = c.textPrimary,
                            textAlign = TextAlign.Center,
                        )
                        Spacer(Modifier.height(Space.sm))
                        Text(
                            "This suspension does not run out on its own — it stays " +
                                "until a reviewer lifts it. We would rather tell you " +
                                "that than put a date on screen that was never set.",
                            style = ZipperTheme.type.bodyS, color = c.textSecondary,
                            textAlign = TextAlign.Center,
                        )
                    }

                    /*
                     * The date has passed and the account is still shut out.
                     *
                     * Real, and not an error: suspensions are lifted by a sweep
                     * that runs on a schedule (`lift_expired_suspensions` on the
                     * server), so there is a window between the end of the term
                     * and the account actually opening. Somebody who was told
                     * "Tuesday", and is reading this on Tuesday, needs to know
                     * the delay is a job that has not run yet rather than a
                     * second decision made about them overnight.
                     */
                    daysLeft == 0 -> {
                        Text(
                            "Your suspension has run out",
                            style = ZipperTheme.type.labelL, color = c.statusSuccess,
                            textAlign = TextAlign.Center,
                        )
                        Spacer(Modifier.height(Space.sm))
                        Text(
                            "It ended on $endsOn. Accounts are let back in by a check " +
                                "that runs on a schedule, so if you are still seeing " +
                                "this it has not caught up yet. Try again in a few hours.",
                            style = ZipperTheme.type.bodyS, color = c.textSecondary,
                            textAlign = TextAlign.Center,
                        )
                    }

                    else -> {
                        Text(
                            "Ends on $endsOn",
                            style = ZipperTheme.type.labelL, color = c.textPrimary,
                            textAlign = TextAlign.Center,
                        )
                        Spacer(Modifier.height(Space.sm))
                        Text(
                            if (daysLeft == 1) {
                                "That is less than a day from now. Your account opens " +
                                    "again by itself — there is nothing you have to do."
                            } else {
                                "That is $daysLeft days from now. Your account opens " +
                                    "again by itself — there is nothing you have to do."
                            },
                            style = ZipperTheme.type.bodyS, color = c.textSecondary,
                            textAlign = TextAlign.Center,
                        )
                    }
                }
            }

            Spacer(Modifier.height(Space.xxl))

            // ── The phone still works ─────────────────────────────────────
            //
            // The one thing a suspended person can do that a banned one cannot,
            // and the app had no way to say it or to offer it. Above the appeal
            // on purpose: most people who land here want to get on with their
            // day on another account, and the ones who want to argue will
            // scroll.
            Text(
                "This phone is not blocked",
                style = ZipperTheme.type.labelL, color = c.textPrimary,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(Space.xs))
            Text(
                "Only this account is suspended. The device itself is untouched, so " +
                    "you can go back to the login screen and sign in with another " +
                    "account you are allowed to use. This one will be here when the " +
                    "suspension is over.",
                style = ZipperTheme.type.bodyS, color = c.textSecondary,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(Space.md))
            ZipperButton(
                "Back to login",
                onClick = onBackToLogin,
                style = ButtonStyle.Secondary,
                icon = Icons.Outlined.SwitchAccount,
                fullWidth = true,
            )
            Spacer(Modifier.height(Space.sm))
            /*
             * The cost of the button, before it is pressed.
             *
             * An appeal is a write about the SIGNED-IN account — `firestore.rules`
             * requires `subjectUid == request.auth.uid` — so the form below stops
             * working the moment this signs them out. They can sign back in to
             * this account whenever they like and finish it, but finding that
             * out after typing four paragraphs is how an appeal gets abandoned.
             */
            Text(
                "This signs you out of the suspended account. The appeal form below " +
                    "works while you are signed in here; after that you can still appeal " +
                    "on the web with your account ID — see below.",
                style = ZipperTheme.type.caption, color = c.textMuted,
                textAlign = TextAlign.Center,
            )

            Spacer(Modifier.height(Space.xxl))

            // The same appeal, the same queue, the same rules as a ban — see
            // AppealRepository, whose own heading is "Appealing a ban or a
            // suspension". Shared rather than copied so the two screens cannot
            // drift into offering different wording for one process.
            AppealPanel(viewModel)

            Spacer(Modifier.navigationBarsPadding())
        }
    }
}

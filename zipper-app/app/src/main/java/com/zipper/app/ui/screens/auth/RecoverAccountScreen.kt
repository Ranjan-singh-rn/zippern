package com.zipper.app.ui.screens.auth

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.History
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.zipper.app.ui.components.ButtonStyle
import com.zipper.app.ui.components.ZipperButton
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * "You asked us to delete this account. Do you still want that?"
 *
 * ── WHY THIS SCREEN EXISTS ───────────────────────────────────────────────────
 *
 * Deleting an account was a one-way door with nothing behind it: the flag was
 * written, the app said goodbye, nothing was ever purged, and signing back in
 * let the person straight into an account that was now permanently invisible in
 * discovery with no way to clear the flag. They would not know why nobody could
 * find them.
 *
 * Deletion is a thirty-day pause now, and this is the door back. It is shown
 * once, on the next sign-in after the request, and it makes the person choose —
 * because the one thing worse than deleting an account by accident is silently
 * resurrecting one somebody meant to delete.
 *
 * ── THE THREE ANSWERS, AND WHY ALL THREE ARE HERE ────────────────────────────
 *
 * Most people who reach this screen are here by accident: they deleted in
 * frustration, or handed the phone to someone. Recover is the prominent one.
 *
 * The screen used to stop there and offer one other thing — "Delete it now
 * instead" — which collapsed two completely different people into one button:
 *
 *   Somebody who wants to be RID of the account. They came back to confirm, and
 *   should not have to wait a month for a decision they have already made.
 *
 *   Somebody who wants to STAY but as a new person. They are not finishing a
 *   deletion, they are starting over — and the old button asked them to press
 *   something that reads like a goodbye in order to say hello. Worse, it never
 *   told them what starting over costs, which is the one thing they needed to
 *   know: the coins, the level, the gifts and the messages stay behind.
 *
 * So there are three answers now, each labelled as the outcome the person
 * wants rather than as the mechanism that delivers it.
 *
 * ── THE TWO ENDINGS SHARE ONE SERVER CALL, ON PURPOSE ────────────────────────
 *
 * "Create a new account instead" and "Delete it for good" both run
 * `deleteNow()` → `purgeMyAccountNow`. That is not a shortcut: the thing the
 * server does is the same in both cases, and what differs is only what the
 * person does on the NEXT screen. Splitting the button rather than the call is
 * what lets each one state its own honest cost, and stops somebody who simply
 * wants out from having to click "Create a new account".
 *
 * ── WHAT A PURGE ACTUALLY DOES, AND WHY THE OLD COPY WAS WRONG ───────────────
 *
 * The old confirmation promised "your profile, photos and messages are removed
 * now". Two of those three are false. `purgeAccount` in functions/src/accounts.ts
 * does NOT delete the user document — it blanks the identity on it (name, photo,
 * bio, phone, email, session, device), marks it `permanently_deactivated`, drops
 * `fcmTokens`/`followers`/`following`/`ownedItems`, removes the profile media and
 * deletes the Firebase login last. Everything in `RETAINED_SUBCOLLECTIONS` —
 * the coin and bean transactions, the earnings, the warnings, the gift showcase —
 * survives for the life of the CRM, deliberately, because a chargeback six
 * months later has to have something to answer from. Messages are not touched
 * at all.
 *
 * Copy that promises an erasure the system does not perform is the kind of lie
 * that only surfaces when somebody asks for their data back, so every line here
 * describes what the purge really is: the identity is released, the record
 * stays.
 */
@Composable
fun RecoverAccountScreen(
    onRecovered: () -> Unit,
    onDeletedForGood: () -> Unit,
    viewModel: RecoverAccountViewModel = hiltViewModel(),
) {
    // No way back past this. The choice has to be made.
    BackHandler(enabled = true) { }
    val c = ZipperTheme.colors
    val state by viewModel.state.collectAsStateWithLifecycle()

    /*
     * Which ending is waiting to be confirmed, or null while the three options
     * are on screen.
     *
     * Both endings are irreversible and both are one tap from a list, so
     * neither fires straight from its button. Holding the choice here rather
     * than in the ViewModel keeps it where it belongs: it is a step in a
     * conversation with this screen, not a fact about the account, and it must
     * not survive a rotation into a state where a purge looks half-started.
     */
    var confirming by remember { mutableStateOf<Ending?>(null) }

    LaunchedEffect(state.recovered) { if (state.recovered) onRecovered() }
    // Both endings land here: the account is gone and the session with it, so
    // there is nowhere to go but Login — where "create a new account" finishes
    // by signing up again, and "delete for good" finishes by walking away.
    LaunchedEffect(state.purged) { if (state.purged) onDeletedForGood() }

    val dueText = remember(state.dueAtMillis) {
        if (state.dueAtMillis <= 0L) null
        else SimpleDateFormat("d MMMM yyyy", Locale.getDefault()).format(Date(state.dueAtMillis))
    }
    val daysLeft = remember(state.dueAtMillis) {
        if (state.dueAtMillis <= 0L) null
        else ((state.dueAtMillis - System.currentTimeMillis()) / 86_400_000L)
            .coerceAtLeast(0L).toInt()
    }

    Box(Modifier.fillMaxSize().background(c.bgBase)) {
        AmbientGlows()
        /*
         * Scrollable rather than centred-and-fixed.
         *
         * Three options with a line of explanation each, or a confirmation
         * paragraph that has to spell out what is kept and what is released, is
         * more content than the old two-button version — and on a short handset
         * the fixed layout would have clipped the last button off the bottom
         * with no way to reach it. A choice you cannot scroll to is a choice you
         * do not have.
         */
        Column(
            Modifier.fillMaxSize().statusBarsPadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Space.x3l, vertical = Space.xxl),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(Space.x4l))

            Box(
                Modifier.size(88.dp).background(c.tintGoldSubtle, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Outlined.History, null,
                    tint = c.statusWarning, modifier = Modifier.size(40.dp),
                )
            }

            Spacer(Modifier.height(Space.xxl))
            Text(
                "Welcome back",
                style = ZipperTheme.type.headingL, color = c.textPrimary,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(Space.md))
            Text(
                buildString {
                    append("You asked us to delete this account. ")
                    if (daysLeft != null && dueText != null) {
                        append(
                            if (daysLeft > 0) {
                                "It will be deleted on $dueText — $daysLeft day" +
                                    (if (daysLeft == 1) "" else "s") + " from now. "
                            } else {
                                "It is due to be deleted today. "
                            },
                        )
                    }
                    append("Nothing has been removed yet.")
                },
                style = ZipperTheme.type.bodyM, color = c.textSecondary,
                textAlign = TextAlign.Center,
            )

            Spacer(Modifier.height(Space.x3l))

            // Read once into a local so the branch below smart-casts it to a
            // non-null `Ending` without a `!!`.
            val pending = confirming
            if (pending == null) {
                /*
                 * No choice pending: all three outcomes, each with the one line
                 * that says what it costs. The captions are not decoration —
                 * "Create a new account instead" is indistinguishable from
                 * "Keep my account" to somebody who assumes their coins follow
                 * them, and that assumption is exactly the one that has to be
                 * broken BEFORE the tap rather than after it.
                 */
                ZipperButton(
                    "Keep my account",
                    onClick = viewModel::recover,
                    gradient = true,
                    fullWidth = true,
                    enabled = !state.busy,
                    loading = state.busy,
                )
                Spacer(Modifier.height(Space.sm))
                Text(
                    "Your profile, coins, level, gifts and messages come back " +
                        "exactly as they were.",
                    style = ZipperTheme.type.caption, color = c.textMuted,
                    textAlign = TextAlign.Center,
                )

                Spacer(Modifier.height(Space.xl))

                ZipperButton(
                    "Create a new account instead",
                    onClick = { confirming = Ending.StartFresh },
                    style = ButtonStyle.Secondary,
                    fullWidth = true,
                    enabled = !state.busy,
                )
                Spacer(Modifier.height(Space.sm))
                Text(
                    "Start again from zero. Your coins, level, gifts and messages " +
                        "stay with the old account and do not come across.",
                    style = ZipperTheme.type.caption, color = c.textMuted,
                    textAlign = TextAlign.Center,
                )

                Spacer(Modifier.height(Space.xl))

                ZipperButton(
                    "Delete it for good",
                    onClick = { confirming = Ending.DeleteForGood },
                    style = ButtonStyle.Ghost,
                    fullWidth = true,
                    enabled = !state.busy,
                )
                Spacer(Modifier.height(Space.sm))
                Text(
                    if (dueText != null) {
                        "Finish it today instead of waiting until $dueText."
                    } else {
                        "Finish it today instead of waiting out the thirty days."
                    },
                    style = ZipperTheme.type.caption, color = c.textMuted,
                    textAlign = TextAlign.Center,
                )
            } else {
                /*
                 * The confirmation replaces the options rather than sitting
                 * under them. Leaving all three on screen behind a confirm step
                 * gave two live destructive buttons at once — one of them a tap
                 * away from firing while the other was asking "are you sure?".
                 */
                Text(
                    when (pending) {
                        Ending.StartFresh -> "Start over with a new account?"
                        Ending.DeleteForGood -> "Delete this account for good?"
                    },
                    style = ZipperTheme.type.headingS, color = c.textPrimary,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(Space.md))
                Text(
                    when (pending) {
                        /*
                         * Says "stays deleted and keeps its history" because
                         * that is literally what happens — the document
                         * survives as the historical record. Promising a clean
                         * slate for the OLD account here would be the same lie
                         * in the other direction.
                         */
                        Ending.StartFresh ->
                            "This account stays deleted and keeps its history for ever. " +
                                "Its coins, level, gifts and messages stay with it and do " +
                                "not come across to the new one.\n\n" +
                                "Your number and email are released straight away, so you " +
                                "can sign up again on the next screen and start from zero. " +
                                "This cannot be undone."
                        /*
                         * No "your data is erased" here either. What the purge
                         * takes is the identity and the ability to sign in;
                         * what it keeps — on purpose — is the record that money
                         * moved.
                         */
                        Ending.DeleteForGood ->
                            "Your profile, photo and login are removed today and nobody " +
                                "can sign in as this account again.\n\n" +
                                "Your purchase and earnings history is kept as our record " +
                                "of payments that were made. This cannot be undone — there " +
                                "is no getting the account back afterwards."
                    },
                    style = ZipperTheme.type.bodyS, color = c.textSecondary,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(Space.lg))
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(Space.sm),
                ) {
                    ZipperButton(
                        "Cancel",
                        onClick = { confirming = null },
                        style = ButtonStyle.Secondary,
                        modifier = Modifier.weight(1f),
                        enabled = !state.busy,
                    )
                    ZipperButton(
                        when (pending) {
                            Ending.StartFresh -> "Start fresh"
                            Ending.DeleteForGood -> "Delete for good"
                        },
                        onClick = viewModel::deleteNow,
                        style = ButtonStyle.Danger,
                        modifier = Modifier.weight(1f),
                        enabled = !state.busy,
                        loading = state.busy,
                    )
                }
            }

            state.error?.let { err ->
                Spacer(Modifier.height(Space.lg))
                Text(
                    err,
                    style = ZipperTheme.type.bodyS, color = c.statusDanger,
                    textAlign = TextAlign.Center,
                )
            }

            Spacer(Modifier.height(Space.xxl))
            Spacer(Modifier.navigationBarsPadding())
        }
    }
}

/**
 * The two ways this account can end, once recovery has been declined.
 *
 * They run the same server call and differ only in what the person intends to
 * do next, which is precisely why they need separate copy: the cost of starting
 * fresh is the history left behind, and the cost of deleting for good is that
 * there is no way back. One button could not state both.
 */
private enum class Ending { StartFresh, DeleteForGood }

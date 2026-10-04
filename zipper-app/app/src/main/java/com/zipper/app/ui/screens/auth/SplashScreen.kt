package com.zipper.app.ui.screens.auth

import androidx.compose.animation.core.*
import androidx.compose.foundation.layout.*
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import coil.compose.AsyncImage
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.app.R
import com.zipper.app.ui.theme.*
import com.zipper.app.ui.components.*
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.Brush
import androidx.compose.material3.Text
import com.zipper.app.data.model.AccountRestriction
import com.zipper.app.data.model.restrictionOf
import com.zipper.app.util.SessionManager
import com.zipper.app.util.millis
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.tasks.await
import android.provider.Settings

@Composable
fun SplashScreen(
    onNavigateToLogin: () -> Unit,
    onNavigateToProfileSetup: () -> Unit,
    onNavigateToMain: () -> Unit,
    /** The ACCOUNT is banned. Every device it has used is barred with it. */
    onNavigateToBanned: (reason: String) -> Unit = {},
    /**
     * This HANDSET is barred, whoever is holding it.
     *
     * A separate callback rather than a flag on [onNavigateToBanned] because
     * the two are found in different places — one in `bannedDevices`, before
     * anybody has signed in, the other on the user document afterwards — and
     * the screen cannot tell them apart from the reason string alone. Told the
     * wrong one, somebody on a barred phone signs out and registers again,
     * which is precisely what a device ban exists to prevent.
     */
    onNavigateToDeviceBanned: (reason: String) -> Unit = {},
    /**
     * The account is SUSPENDED: shut out temporarily, with the device left
     * alone, so another eligible account may be used on this phone.
     *
     * [untilMillis] is 0 for an indefinite suspension — the field is absent on
     * the document — and the screen says so rather than formatting the epoch.
     */
    onNavigateToSuspended: (reason: String, untilMillis: Long) -> Unit = { _, _ -> },
    /** An account with a deletion pending, which must be answered before entry. */
    onNavigateToRecoverAccount: () -> Unit = {},
    sessionManager: SessionManager = hiltViewModel<SplashViewModel>().sessionManager,
    /**
     * Injected for [SessionViewModel.tearDownSession] alone.
     *
     * Both forced sign-outs below used to be hand-rolled, and neither matched
     * the other or the one in MainActivity — see `tearDownSession` for what each
     * copy forgot. There is now one implementation and all three call it.
     */
    sessionViewModel: SessionViewModel = hiltViewModel(),
) {
    val context = LocalContext.current
    val scale = remember { Animatable(0.6f) }

    LaunchedEffect(Unit) {
        scale.animateTo(1f, animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy))
        delay(800)

        // Device-level ban check — blocks reinstalled accounts too
        val deviceId = Settings.Secure.getString(
            context.contentResolver, Settings.Secure.ANDROID_ID
        ) ?: ""
        if (deviceId.isNotBlank()) {
            try {
                val deviceBanSnap = FirebaseFirestore.getInstance()
                    .collection("bannedDevices").document(deviceId).get().await()
                if (deviceBanSnap.exists()) {
                    // `ifBlank`, not just `?:` — a `reason` field that exists
                    // and is empty is not null, and an empty last segment does
                    // not match the route pattern, so the navigation would be
                    // refused and the person would sit on the splash for ever.
                    val reason = deviceBanSnap.getString("reason")
                        .orEmpty().ifBlank { "This device has been blocked from Zipper." }
                    onNavigateToDeviceBanned(reason)
                    return@LaunchedEffect
                }
            } catch (_: Exception) {
                // PERMISSION_DENIED (rules not deployed yet) or network error —
                // treat as "not banned" and continue. The proper fix is deploying
                // Firestore security rules for the bannedDevices collection.
            }
        }

        /*
         * NOBODY IS SIGNED IN — GO TO LOGIN, EVEN WHEN A QUICK-LOGIN SECRET IS SAVED.
         *
         * ── WHY THIS IS NOT AN AUTO-SIGN-IN ──────────────────────────────────
         *
         * The secret in Block Store is enough to sign in with, on its own, with
         * no SMS and no Google picker — that is the entire point of it (see
         * QuickLoginStore). Which means the obvious thing to do here, redeeming
         * it and walking straight into the app, is also the wrong thing.
         *
         * Quick sign-in restores ANY account the device last held, including one
         * holding a diamond balance and a payout history. This screen runs on
         * every cold start, and it has no idea who is holding the phone: a phone
         * left on a desk, handed to a child, sold, or picked up by somebody else
         * would open straight into a stranger's account and their money. There is
         * no gesture to undo it, because there was no gesture in the first place.
         *
         * So the secret buys a BUTTON, not an entry. LoginScreen reads
         * `savedQuickLogin()` and offers "Continue as <name>", and the one tap
         * that follows is the whole consent step — cheap for the owner, and the
         * difference between a convenience and a hole for everyone else.
         *
         * Nothing is read here on purpose. Asking Block Store for a secret we
         * have already decided not to act on would cost a Play Services round
         * trip on every launch and change the outcome not at all.
         */
        val user = FirebaseAuth.getInstance().currentUser
        if (user == null) {
            onNavigateToLogin()
            return@LaunchedEffect
        }

        try {
            user.reload().await()
        } catch (e: Exception) {
            /*
             * The credential will not load — expired, revoked, or the account
             * was disabled underneath us.
             *
             * This branch used to call `FirebaseAuth.signOut()` and nothing
             * else. The push token stayed registered against the uid, so the
             * account carried on ringing a phone that could no longer answer it,
             * and SessionManager kept a session id for a session that was gone.
             * `tearDownSession` is the same complete sequence MainActivity's
             * kick handler runs, and it is awaited rather than raced because the
             * next line navigates away.
             */
            ForcedSignOut.raise(ForcedSignOut.SESSION_EXPIRED)
            sessionViewModel.tearDownSession()
            onNavigateToLogin()
            return@LaunchedEffect
        }

        try {
            val snap = FirebaseFirestore.getInstance()
                .collection("users").document(user.uid).get().await()
            if (!snap.exists()) {
                onNavigateToProfileSetup()
                return@LaunchedEffect
            }

            /*
             * Banned — but NOT signed out.
             *
             * This used to call `signOut()` first, and that one line made the
             * whole appeal path unreachable: the banned screen writes an
             * `appeals` document about the signed-in account, `firestore.rules`
             * requires `subjectUid == request.auth.uid`, and Storage requires
             * `isOwner(uid)` for the evidence. With no session the form renders,
             * accepts a statement, and fails on submit with "You are not signed
             * in" — the one person with the strongest reason to write here was
             * the one person who could not.
             *
             * Signing out was never a security control either. A banned person
             * holds their own credentials and can re-authenticate whenever they
             * like; all it cost was the honest user's ability to say the ban was
             * wrong. What actually has to stop a banned account from acting is
             * the rules, on the server, for every write it can reach.
             *
             * ── AND WHICH OF THE TWO IT IS ───────────────────────────────────
             *
             * This used to be `if (isBanned) → BannedScreen` and nothing else,
             * which is how a seven-day suspension came to be announced on a
             * screen with no end date and no way off it. `isBanned` is true for
             * BOTH — it is the gate, and its meaning is not being changed here —
             * so the question of WHICH is asked separately, by `restrictionOf`,
             * which reads `accountState` and falls back to the `isSuspended`
             * boolean for documents written before that field existed. The same
             * order the server uses (`restriction_of`, backend/app/services/
             * users.py), because the two answering differently is how a person
             * gets told one thing by the app and another by support.
             *
             * The session is kept for a suspension as well, for the same reason
             * it is kept for a ban: the appeal is a write about the signed-in
             * account. Everything below this point is unchanged and runs in the
             * same order it always did.
             */
            when (restrictionOf(snap)) {
                AccountRestriction.Suspended -> {
                    val reason = snap.getString("banReason")
                        .orEmpty().ifBlank { "Your account has been suspended." }
                    // `millis`, never `getLong`: the CRM writes this as a
                    // Firestore Timestamp and `getLong` on one throws. 0 when
                    // the field is absent, which is an INDEFINITE suspension
                    // and is said in those words on the screen.
                    onNavigateToSuspended(reason, snap.millis("suspendedUntil", 0L))
                    return@LaunchedEffect
                }
                AccountRestriction.Banned -> {
                    // "Banned", not the old "suspended". The fallback sentence
                    // was the same one the suspension path uses, so a banned
                    // host with no reason recorded was told to wait it out.
                    val reason = snap.getString("banReason")
                        .orEmpty().ifBlank { "Your account has been banned." }
                    onNavigateToBanned(reason)
                    return@LaunchedEffect
                }
                AccountRestriction.None -> Unit
            }

            /*
             * A deletion that has been requested and not yet carried out.
             *
             * Checked after the ban and before anything else, because it is a
             * question the person has to answer before they are let back in.
             * The old behaviour was to let them straight through to Home — into
             * an account that was permanently hidden from discovery by a flag
             * nothing would ever clear, with nothing on screen to explain why
             * nobody could find them.
             */
            if (snap.getBoolean("isDeleted") == true) {
                onNavigateToRecoverAccount()
                return@LaunchedEffect
            }

            /*
             * HAS ANOTHER DEVICE TAKEN THE SESSION WHILE THIS APP WAS CLOSED?
             *
             * The same comparison SessionViewModel makes live, for the case the
             * live listener cannot cover: the phone was not running when it was
             * displaced. New structured record first, old flat string second —
             * `startMobileSession` writes both for one release so that a handset
             * on the previous build, which reads only the string, still loses its
             * session when it should. See functions/src/identity.ts.
             */
            val remoteSessionId = snap.getString("activeMobileSession.sessionId")
                ?.takeIf { it.isNotBlank() }
                ?: snap.getString("sessionToken").orEmpty()
            val localSessionId = sessionManager.sessionToken.first()
            if (remoteSessionId.isNotBlank() && localSessionId.isNotBlank() && remoteSessionId != localSessionId) {
                /*
                 * Tell them what took it, then tear down completely.
                 *
                 * This branch cleared SessionManager but left the push token
                 * registered, while the branch above cleared the token but not
                 * SessionManager, and MainActivity's did something different
                 * again. All three now run `tearDownSession`, which also mints a
                 * quick-login secret while the credential is still valid — for a
                 * GUEST that is the difference between losing a session and
                 * losing the account, because an anonymous credential cannot be
                 * re-obtained by any other means.
                 *
                 * `deviceName` is read from the record the OTHER device wrote, so
                 * it names the handset that displaced this one. Empty when the
                 * session was claimed by an older build, and `anotherDevice`
                 * degrades to the generic sentence in that case.
                 */
                val replacedBy = snap.getString("activeMobileSession.deviceName").orEmpty()
                ForcedSignOut.raise(ForcedSignOut.anotherDevice(replacedBy))
                sessionViewModel.tearDownSession()
                onNavigateToLogin()
                return@LaunchedEffect
            }

            // Verification is host-only and is not a gate on entering the app.
            // It used to block every user at signup on `isFaceVerified`; a
            // host who has not captured yet lands on Home and is prompted
            // there, because an unverified host can still go live and earn —
            // they just cannot be featured or withdraw.
            val profileComplete = snap.getBoolean("isProfileComplete") ?: false
            if (!profileComplete) onNavigateToProfileSetup() else onNavigateToMain()
        } catch (e: Exception) {
            onNavigateToMain()
        }
    }

    // Figma "01 Splash" (19:2): ambient glows on ink/950, brand mark springing
    // in, wordmark + gold tagline, a thin progress ring at the bottom.
    val c = ZipperTheme.colors
    Box(Modifier.fillMaxSize().background(c.bgBase)) {
        AmbientGlows()
        Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.md)) {
            // Same three stops as the Login brand mark, read from tokens rather
            // than the literals 0xFFFF3D8B / 0xFFE81E6E / 0xFF8B5CF6 they used to
            // be. The two screens are seen back to back on every cold start, so
            // a drift between them would be the first thing a user notices.
            Box(
                Modifier.size(112.dp).scale(scale.value)
                    .background(Brush.linearGradient(listOf(c.brandGradientFrom, c.brandPrimaryPressed, c.brandGradientTo)), RoundedCornerShape(24.dp)),
                contentAlignment = Alignment.Center,
            ) {
                AsyncImage(model = R.drawable.ic_splash_logo, contentDescription = "Zipper", modifier = Modifier.size(64.dp))
            }
            Text("Zipper", style = ZipperTheme.type.displayM, color = c.textPrimary)
            Text("LIVE. CONNECT. SHINE.", style = ZipperTheme.type.overline, color = c.brandVip)
        }
        CircularProgressIndicator(
            color = c.brandPrimary, strokeWidth = 2.dp,
            modifier = Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 48.dp).size(24.dp),
        )
    }
}

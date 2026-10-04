package com.zipper.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.appcompat.app.AppCompatDelegate
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.*
import androidx.core.os.LocaleListCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.navigation.compose.rememberNavController
import androidx.navigation.compose.currentBackStackEntryAsState
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.app.navigation.Screen
import com.zipper.app.navigation.ZipperNavGraph
import com.zipper.app.ui.screens.auth.EmailLinkReturn
import com.zipper.app.ui.screens.auth.ForcedSignOut
import com.zipper.app.ui.screens.auth.SessionEvent
import com.zipper.app.ui.screens.auth.SessionViewModel
import com.zipper.app.ui.screens.profile.ProfileViewModel
import com.zipper.app.ui.screens.update.AppUpdateGate
import com.zipper.app.ui.theme.ZipperTheme
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import androidx.activity.result.contract.ActivityResultContracts
import com.zipper.app.data.repository.CallRepository
import com.zipper.app.service.PushNotifications
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    private val sessionViewModel: SessionViewModel by viewModels()
    private val profileViewModel: ProfileViewModel by viewModels()

    /**
     * The OTA updater.
     *
     * Activity-scoped rather than obtained per-destination with `hiltViewModel()`:
     * a download is tens of megabytes and must not be cancelled by navigating
     * away from whatever screen happened to be on top when it started, and the
     * "once per launch" guard needs a lifetime that survives a rotation but not a
     * cold start. See [com.zipper.app.ui.screens.update.UpdateViewModel].
     */
    private val updateViewModel: com.zipper.app.ui.screens.update.UpdateViewModel by viewModels()

    @Inject lateinit var callRepo: CallRepository
    private val callWatcher: com.zipper.app.ui.screens.call.CallWatcherViewModel by viewModels()

    /**
     * A notification tap arrives as intent extras. The nav controller lives
     * inside setContent, so the extras are parked here and consumed by a
     * LaunchedEffect once the graph is up and the user is signed in.
     */
    sealed class PendingNav {
        data class Call(val callId: String) : PendingNav()
        data class Chat(val uid: String) : PendingNav()
        data class Live(val roomId: String) : PendingNav()

        /**
         * A guest tapped the email sign-in link we sent them.
         *
         * Carries no payload. The link is a one-time credential in a query
         * string and it travels through [EmailLinkReturn] instead of through
         * anything the nav library will hold on to. See that object.
         */
        object EmailLink : PendingNav()
    }
    private val pendingNav = mutableStateOf<PendingNav?>(null)

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* best-effort */ }

    /**
     * Is this intent the email sign-in link coming home?
     *
     * ── WHY IT IS ASKED HERE ─────────────────────────────────────────────────
     *
     * An email link is an `ACTION_VIEW` on an https URL, which arrives at the
     * Activity and nowhere else — there is no ViewModel, no composition and
     * possibly no process when it is sent, because the person has been away in
     * a mail client. So the Activity is the only place that can catch it, and
     * `FirebaseAuth.isSignInWithEmailLink` is the only reliable way to tell one
     * from any other link the intent filter happens to match: the filter is
     * declared on a path prefix, and a path prefix is a guess.
     *
     * Handled BEFORE the notification extras below, because a link intent has
     * no extras at all and that branch returns immediately on one.
     *
     * @return true when this intent was a sign-in link and has been taken.
     */
    private fun consumeEmailLink(intent: Intent?): Boolean {
        if (intent == null) return false
        val link = intent.data?.toString() ?: return false
        if (!FirebaseAuth.getInstance().isSignInWithEmailLink(link)) return false
        EmailLinkReturn.deliver(link)
        pendingNav.value = PendingNav.EmailLink
        // Cleared for the same reason the extras below are: so a recreate does
        // not replay it — and because it is a credential, which has no business
        // sitting on the Activity's intent for the rest of the session.
        intent.setData(null)
        return true
    }

    private fun consumeIntent(intent: Intent?) {
        if (consumeEmailLink(intent)) return
        val extras = intent?.extras ?: return
        val callId = extras.getString(PushNotifications.EXTRA_CALL_ID)
        val chatUid = extras.getString(PushNotifications.EXTRA_CHAT_UID)
        val roomId = extras.getString(PushNotifications.EXTRA_LIVE_ROOM_ID)
        when {
            callId != null -> {
                PushNotifications.cancelIncomingCall(this)
                if (extras.getString(PushNotifications.EXTRA_CALL_ACTION) == "decline") {
                    lifecycleScope.launch { try { callRepo.declineCall(callId) } catch (_: Exception) {} }
                } else {
                    pendingNav.value = PendingNav.Call(callId)
                }
            }
            chatUid != null -> pendingNav.value = PendingNav.Chat(chatUid)
            roomId != null -> pendingNav.value = PendingNav.Live(roomId)
        }
        // Clear so a config change does not replay the tap.
        intent?.replaceExtras(Bundle())
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        /*
         * FLAG_SECURE blocks screenshots and screen recording, and keeps the
         * app out of the recents thumbnail. It matters here: this app shows
         * live video of people, private chats, and KYC documents, and a
         * screenshot of any of those is somebody else's face or bank details
         * sitting in a gallery.
         *
         * Off in DEBUG ONLY, because a build nobody can screenshot is a build
         * nobody can report a bug about — a UI problem gets described in prose
         * instead of shown, which is slower and less accurate for everyone.
         *
         * Tied to BuildConfig.DEBUG rather than a constant somebody flips by
         * hand, so it cannot be left switched off by accident. A release build
         * is secure whatever state the working tree was in when it was cut;
         * there is no toggle to remember.
         */
        if (!BuildConfig.DEBUG) {
            window.setFlags(
                android.view.WindowManager.LayoutParams.FLAG_SECURE,
                android.view.WindowManager.LayoutParams.FLAG_SECURE
            )
        }

        // A full-screen call intent launched this activity behind the keyguard,
        // so the phone rang and showed the LOCK SCREEN rather than the call. The
        // manifest carries the same two flags for the cold-start case; these
        // cover an activity that already exists. API 27+ (O_MR1).
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }

        val uid = FirebaseAuth.getInstance().currentUser?.uid

        // Restore saved language preference on startup.
        // AppCompatDelegate persists the locale across sessions on API 33+;
        // for older APIs we re-read Firestore once to cover the first cold launch.
        if (uid != null) {
            lifecycleScope.launch {
                try {
                    val snap = FirebaseFirestore.getInstance()
                        .collection("users").document(uid).get().await()
                    val lang = snap.getString("appLanguage") ?: "en"
                    if (lang.isNotBlank() && lang != "en") {
                        AppCompatDelegate.setApplicationLocales(
                            LocaleListCompat.forLanguageTags(lang)
                        )
                    }
                } catch (_: Exception) { /* best-effort — fall back to device locale */ }
            }
        }

        // Cover the few milliseconds between here and the first composition. The
        // destination listener below is what actually keeps the watch running
        // for the rest of the session — this call is stopped again the moment
        // that listener reports Splash, which is where every cold start begins.
        if (uid != null) {
            sessionViewModel.startWatching()
        }
        consumeIntent(intent)

        setContent {
            val profileState by profileViewModel.state.collectAsStateWithLifecycle()
            val systemDark = isSystemInDarkTheme()
            val darkTheme = when (profileState.user?.theme) {
                "dark"  -> true
                "light" -> false
                else    -> systemDark   // "system" or null (before user doc loads)
            }

            ZipperTheme(darkTheme = darkTheme) {
                val navController = rememberNavController()

                // React to mid-session kicks and bans in real-time
                LaunchedEffect(Unit) {
                    sessionViewModel.events.collect { event ->
                        when (event) {
                            is SessionEvent.KickedOut -> {
                                /*
                                 * Say WHY, AND SAY WHAT TOOK IT, on the screen
                                 * they are about to land on.
                                 *
                                 * This used to drop the person on Login with no
                                 * message at all: the app they were using simply
                                 * became a login form mid-tap. The only reading
                                 * available to them was that it had crashed or
                                 * that their account was gone — the two things it
                                 * is least like — and the support ticket that
                                 * followed said "the app logged me out by itself".
                                 *
                                 * The name comes from the server's
                                 * `activeMobileSession.deviceName`, which is why
                                 * the record had to replace the old opaque
                                 * string: "opened on a Motorola" either matches
                                 * a handset they recognise, and they stop
                                 * worrying, or it does not, and they have a
                                 * reason to secure the account. A bare "another
                                 * device" gives them neither. `anotherDevice`
                                 * falls back to exactly that wording when the
                                 * name is empty, which is what an account
                                 * claimed by the previous build looks like.
                                 *
                                 * Raised BEFORE the navigation, so the login
                                 * screen's first composition already has it.
                                 */
                                ForcedSignOut.raise(
                                    ForcedSignOut.anotherDevice(event.replacedByDeviceName)
                                )
                                /*
                                 * One teardown, shared with both of SplashScreen's
                                 * forced sign-outs. It mints a quick-login secret
                                 * while the session is still valid (without which a
                                 * kicked-out GUEST loses the account, not just the
                                 * session), drops this phone's push token so the
                                 * account stops ringing a device that can no longer
                                 * answer, clears SessionManager — which this handler
                                 * never did — and only then signs out of Firebase.
                                 *
                                 * Not awaited: being displaced is not a moment to
                                 * hold somebody on a spinner. It runs to completion
                                 * in the ViewModel's scope, which outlives this
                                 * navigation.
                                 */
                                sessionViewModel.forceSignOut()
                                navController.navigate(Screen.Login.route) {
                                    popUpTo(0) { inclusive = true }
                                }
                            }
                            is SessionEvent.Banned -> {
                                FirebaseAuth.getInstance().currentUser?.uid?.let {
                                    PushNotifications.clearToken(it)
                                }
                                // The session is KEPT — the banned screen is
                                // where an appeal is written, and an appeal is
                                // a write about the signed-in account. See
                                // SplashScreen for the whole reasoning.
                                sessionViewModel.stopWatching()
                                navController.navigate(Screen.Banned.createRoute(event.reason)) {
                                    popUpTo(0) { inclusive = true }
                                }
                            }
                            /*
                             * Suspended mid-session — handled exactly as a ban
                             * is, and landing somewhere else.
                             *
                             * The token goes for the same reason: the account is
                             * shut out of the product for the duration, and a
                             * phone that goes on ringing for calls it cannot
                             * answer is worse than silence. `syncToken()` runs
                             * again on Home when they are let back in.
                             *
                             * The session is KEPT, again for the same reason —
                             * the appeal is a write about the signed-in account,
                             * and the suspended screen carries the same appeal
                             * form. What differs is only the destination: a
                             * suspension leaves the DEVICE alone, so that screen
                             * offers a way back to Login for a different
                             * account, which is the one thing the banned screen
                             * must never offer.
                             *
                             * `untilMillis` is carried through from the snapshot
                             * that raised this rather than read again on the
                             * next screen, because the listener is stopped on
                             * the line below and this value was already in hand.
                             */
                            is SessionEvent.Suspended -> {
                                FirebaseAuth.getInstance().currentUser?.uid?.let {
                                    PushNotifications.clearToken(it)
                                }
                                sessionViewModel.stopWatching()
                                navController.navigate(
                                    Screen.Suspended.createRoute(event.reason, event.untilMillis)
                                ) {
                                    popUpTo(0) { inclusive = true }
                                }
                            }
                        }
                    }
                }

                /*
                 * ONE-DEVICE ENFORCEMENT RUNS ON EVERY SIGNED-IN SCREEN, NOT JUST HOME.
                 *
                 * `startWatching()` used to be called for `Screen.Main.route` and
                 * nowhere else. In the ordinary flow that was survivable by luck
                 * rather than by design: navigating Home → Chat → Go Live leaves
                 * the listener registered, because the only thing that ever
                 * removed it was the Login/Splash branch. But "started at Home"
                 * is not the same as "started while signed in", and the gaps were
                 * real:
                 *
                 *  - The `startWatching()` in onCreate, which exists for a cold
                 *    start that is already signed in, was IMMEDIATELY UNDONE:
                 *    this listener fires once as soon as it is added, the current
                 *    destination at that point is Splash, and Splash was in the
                 *    stop branch.
                 *  - Any signed-in destination reached without passing through
                 *    Home therefore watched nothing at all — ProfileSetup,
                 *    FaceVerification and RecoverAccount all sit in that hole,
                 *    and a person can spend several minutes in profile setup.
                 *  - Returning to Home from Settings re-ran `startWatching()`,
                 *    which tore the listener down and rebuilt it — a wasted
                 *    document read per navigation. `startWatching()` is now
                 *    idempotent (see SessionViewModel.watchingUid), which is what
                 *    makes calling it this liberally free.
                 *
                 * So the test is inverted: watch UNLESS this is a screen where
                 * there is deliberately no session to watch. `startWatching()`
                 * no-ops when nobody is signed in, which is what makes a deny
                 * list safe for Terms.
                 *
                 * Banned is on the deny list for a reason of its own. The banned
                 * screen deliberately KEEPS the session so an appeal can be
                 * written (see SplashScreen), and the listener re-emits Banned on
                 * every snapshot — so watching there would navigate to Banned,
                 * re-register, re-emit, and navigate again, for ever.
                 *
                 * Suspended is on it for EXACTLY the same reason, and had to be
                 * added with the event: it keeps the session for the appeal,
                 * `isSuspended` stays true for the whole suspension, and the
                 * listener emits Suspended on every snapshot. Leaving it off the
                 * list would have been the same infinite navigation loop, on the
                 * screen where somebody is trying to read a date and type an
                 * appeal.
                 */
                LaunchedEffect(navController) {
                    navController.addOnDestinationChangedListener { _, destination, _ ->
                        val route = destination.route
                        val noSessionHere = route == Screen.Splash.route ||
                            route == Screen.Login.route ||
                            route == Screen.Banned.route ||
                            route == Screen.Suspended.route
                        if (noSessionHere) {
                            sessionViewModel.stopWatching()
                            callWatcher.stop()
                        } else {
                            sessionViewModel.startWatching()
                        }
                        // Home-only, and once: these are prompts and a token
                        // sync, not session state. The call watcher stays where
                        // it was — it already rings on every screen once
                        // started, because nothing but Login/Splash stops it.
                        if (route == Screen.Main.route) {
                            callWatcher.start()
                            // The FCM token is useless until it is on the user doc, and
                            // onNewToken fires before login on a fresh install.
                            PushNotifications.syncToken()
                            if (android.os.Build.VERSION.SDK_INT >= 33) {
                                notificationPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
                            }
                            // Android 14 revokes full-screen intents for non-default
                            // dialers; without it the ring is a quiet heads-up. Ask once.
                            if (android.os.Build.VERSION.SDK_INT >= 34 &&
                                !androidx.core.app.NotificationManagerCompat.from(this@MainActivity).canUseFullScreenIntent() &&
                                !getSharedPreferences("push", MODE_PRIVATE).getBoolean("fsiAsked", false)
                            ) {
                                getSharedPreferences("push", MODE_PRIVATE).edit().putBoolean("fsiAsked", true).apply()
                                try {
                                    startActivity(Intent(android.provider.Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT)
                                        .setData(android.net.Uri.parse("package:$packageName")))
                                } catch (_: Exception) {}
                            }
                        }
                    }
                }

                // Incoming call (Firestore watcher) — rings on any screen while the app is open.
                val incoming by callWatcher.incomingCall.collectAsStateWithLifecycle()
                LaunchedEffect(incoming) {
                    val call = incoming ?: return@LaunchedEffect
                    val route = navController.currentBackStackEntry?.destination?.route ?: return@LaunchedEffect
                    callWatcher.consumeIncomingCall()
                    if (route.startsWith("incoming_call") || route.startsWith("video_call")) return@LaunchedEffect
                    PushNotifications.cancelIncomingCall(this@MainActivity)
                    navController.navigate(Screen.IncomingCall.createRoute(call.callId)) { launchSingleTop = true }
                }

                // Notification deep links — only once signed in and past the splash.
                val pending by pendingNav
                val backStack by navController.currentBackStackEntryAsState()
                LaunchedEffect(pending, backStack?.destination?.route) {
                    val p = pending ?: return@LaunchedEffect
                    val route = backStack?.destination?.route ?: return@LaunchedEffect
                    // Signed out (an expired session, a cold start that lands on
                    // Login): KEEP the destination pending rather than dropping it.
                    // This effect re-runs on every route change, so it is consumed
                    // the moment auth is present and the user is past Splash/Login.
                    if (FirebaseAuth.getInstance().currentUser == null) return@LaunchedEffect
                    if (route == Screen.Splash.route || route == Screen.Login.route) return@LaunchedEffect
                    pendingNav.value = null
                    when (p) {
                        is PendingNav.Call -> navController.navigate(Screen.IncomingCall.createRoute(p.callId)) { launchSingleTop = true }
                        is PendingNav.Chat -> navController.navigate(Screen.Chat.createRoute(p.uid)) { launchSingleTop = true }
                        is PendingNav.Live -> navController.navigate(Screen.LiveViewer.createRoute(p.roomId)) { launchSingleTop = true }
                        /*
                         * `launchSingleTop` is load-bearing here, not tidiness.
                         * The common case is that the person is ALREADY on this
                         * screen — the app was in the background showing "check
                         * your email" — and a second copy would bring a second
                         * ViewModel with an empty state, leaving the one
                         * collecting [EmailLinkReturn] behind it on the stack.
                         */
                        is PendingNav.EmailLink -> navController.navigate(Screen.SecureEmail.route) { launchSingleTop = true }
                    }
                }

                ZipperNavGraph(navController = navController)

                /*
                 * ── WHERE THE UPDATE CHECK RUNS, AND WHY IT IS HERE ──────────
                 *
                 * Here: at the composition root, a sibling of the NavHost rather
                 * than a call inside any destination.
                 *
                 * WHY NOT INSIDE A DESTINATION
                 * A dialog owned by a composable inside the graph dies when the
                 * user navigates, and so does the download behind it — the person
                 * taps Update, opens a chat while it runs, and comes back to
                 * nothing. Out here the gate outlives every navigation, and a
                 * REQUIRED update covers whatever screen they are standing on
                 * instead of only the one it was launched from.
                 *
                 * WHY NOT IN ZipperApp / onCreate
                 * There is no composition in either, so the dialog would have to
                 * be a notification or a second Activity. And `onCreate` runs
                 * before the splash has decided anything, which is the next point.
                 *
                 * WHY IT WAITS FOR THE AUTH GATE
                 * `authResolved` is "we have left Splash". Splash is where this app
                 * reads `bannedDevices`, resolves the session, decides between
                 * Login / ProfileSetup / Main / Banned / Suspended and navigates
                 * with `popUpTo(0)`. Raising a dialog during that is racing it:
                 * the dialog would sit over a screen that is about to be replaced,
                 * and on the mandatory path it would be a modal the person cannot
                 * dismiss stacked on top of an auth decision they cannot see.
                 *
                 * Every other destination counts as resolved, including Login —
                 * deliberately. Somebody who cannot get past Login on an old build
                 * is exactly who needs the update most, and "sign in first" would
                 * put the fix behind the thing that is broken.
                 *
                 * ONCE PER LAUNCH is enforced by the ViewModel, not by this
                 * effect: `authResolved` is derived from the route, so it flips
                 * false→true once and then stays true for the life of the
                 * Activity, and `checkOnce()` no-ops thereafter. The manual
                 * Settings row goes through a different entry point.
                 */
                val currentRoute = backStack?.destination?.route
                AppUpdateGate(
                    viewModel = updateViewModel,
                    authResolved = currentRoute != null && currentRoute != Screen.Splash.route,
                )
            }
        }
    }

    // Called when Chrome redirects back after reCAPTCHA, and when a mailed
    // email sign-in link is opened while this task is already alive — which is
    // the ordinary case for that flow, since the person only left to fetch it.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        consumeIntent(intent)
    }
}

package com.zipper.app.navigation

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.google.firebase.auth.FirebaseAuth
import com.zipper.app.util.installedVersionLabel
import com.zipper.app.BuildConfig
import com.zipper.app.ui.screens.update.UpdateCheckRequest
import com.zipper.app.ui.screens.auth.BanKind
import com.zipper.app.ui.screens.auth.BannedScreen
import com.zipper.app.ui.screens.auth.FaceVerificationScreen
import com.zipper.app.ui.screens.auth.LoginScreen
import com.zipper.app.ui.screens.auth.ProfileSetupScreen
import com.zipper.app.ui.screens.auth.RecoverAccountScreen
import com.zipper.app.ui.screens.auth.SecureAccountScreen
import com.zipper.app.ui.screens.auth.SecureEmailScreen
import com.zipper.app.ui.screens.auth.SplashScreen
import com.zipper.app.ui.screens.auth.SuspendedScreen
import com.zipper.app.ui.screens.auth.TermsScreen
import com.zipper.app.ui.screens.bag.MyBagScreen
import com.zipper.app.ui.screens.beans.BeanHistoryScreen
import com.zipper.app.ui.screens.call.CallHistoryScreen
import com.zipper.app.ui.screens.call.IncomingCallScreen
import com.zipper.app.ui.screens.call.VideoCallScreen
import com.zipper.app.ui.screens.diamond.DiamondHistoryScreen
import com.zipper.app.ui.screens.diamond.DiamondShopScreen
import com.zipper.app.ui.screens.diamond.ResellerListScreen
import com.zipper.app.ui.screens.earnings.EarningsScreen
import com.zipper.app.ui.screens.level.DailyRewardsScreen
import com.zipper.app.ui.screens.level.LevelScreen
import com.zipper.app.ui.screens.live.GoLiveScreen
import com.zipper.app.ui.screens.live.LiveSummaryGifters
import com.zipper.app.ui.screens.live.LiveSummaryScreen
import com.zipper.app.ui.screens.live.WatchLiveScreen
import com.zipper.app.ui.screens.main.MainScreen
import com.zipper.app.ui.screens.messages.ChatScreen
import com.zipper.app.ui.screens.party.PartyListScreen
import com.zipper.app.ui.screens.party.PartyRoomScreen
import com.zipper.app.ui.screens.blocked.BlockedUsersScreen
import com.zipper.app.ui.screens.profile.EditProfileScreen
import com.zipper.app.ui.screens.profile.GalleryViewerScreen
import com.zipper.app.ui.screens.profile.GiftDetailsScreen
import com.zipper.app.ui.screens.profile.GiftDetailsViewModel
import com.zipper.app.ui.screens.profile.OtherUserProfileScreen
import com.zipper.app.ui.screens.profile.ProfileScreen
import com.zipper.app.ui.screens.profile.ProfileViewModel
import com.zipper.app.ui.screens.feedback.FeedbackScreen
import com.zipper.app.ui.screens.settings.LegalScreen
import com.zipper.app.ui.screens.settings.PrivacyPolicyScreen
import com.zipper.app.ui.screens.settings.SettingsScreen
import com.zipper.app.ui.screens.agency.AgencyDashboardScreen
import com.zipper.app.ui.screens.seller.BuyCoinScreen
import com.zipper.app.ui.screens.seller.SellerDashboardScreen
import com.zipper.app.ui.screens.social.LikesScreen
import com.zipper.app.ui.screens.partner.PartnerApplyScreen
import com.zipper.app.ui.screens.partner.PartnerHubScreen
import com.zipper.app.ui.screens.partner.RechargeRequestScreen
import com.zipper.app.ui.components.LoadingState
import com.zipper.app.ui.components.clickableNoRipple
import com.zipper.app.ui.theme.ZipperPink

@Composable
fun ZipperNavGraph(
    navController: NavHostController = rememberNavController(),
) {
    // One AuthViewModel for the graph so sign-out (token clear + Firebase
    // signOut + session clear) runs from every logout entry point.
    val authVm: com.zipper.app.ui.screens.auth.AuthViewModel = hiltViewModel()
    /*
     * B43: the handset's own id, for the quick-login credential minted on the
     * way out. Logout passed nothing, so the server recorded every such
     * credential against device "" and never retired this phone's older ones.
     * Read the same way Login, Splash and profile setup read it.
     */
    val context = androidx.compose.ui.platform.LocalContext.current
    val deviceId = remember {
        android.provider.Settings.Secure.getString(
            context.contentResolver, android.provider.Settings.Secure.ANDROID_ID,
        ) ?: ""
    }
    /*
     * B11: starts the sign-out and NOTHING else. Login is shown by the effect
     * below once the sign-out has actually finished — it used to be navigated
     * to on the next line, while the sign-out was still running, and the tail
     * of that sign-out then wiped whatever was signed in on Login by then.
     */
    val signOutAndGoToLogin: () -> Unit = {
        authVm.signOut(deviceId)
    }
    /*
     * Leave only once the deletion request has actually landed.
     *
     * The Settings call site used to navigate on the same line as the call, so
     * a failed request showed the same goodbye as a successful one over an
     * account that was untouched. The request sets `accountDeleted`; this
     * waits for it. A failure leaves the person on Settings with the reason in
     * `uiState.error`.
     */
    val authState by authVm.uiState.collectAsStateWithLifecycle()
    LaunchedEffect(authState.accountDeleted) {
        if (authState.accountDeleted) {
            authVm.onAccountDeleted()
            navController.navigate(Screen.Login.route) { popUpTo(0) { inclusive = true } }
        }
    }
    // B11: the same shape for a sign-out — Login only once it has finished.
    LaunchedEffect(authState.navigateToLogin) {
        if (authState.navigateToLogin) {
            authVm.onNavigatedToLogin()
            navController.navigate(Screen.Login.route) { popUpTo(0) { inclusive = true } }
        }
    }

    NavHost(
        navController = navController,
        startDestination = Screen.Splash.route,
    ) {
        composable(Screen.Splash.route) {
            SplashScreen(
                onNavigateToLogin = {
                    navController.navigate(Screen.Login.route) {
                        popUpTo(Screen.Splash.route) { inclusive = true }
                    }
                },
                onNavigateToProfileSetup = {
                    navController.navigate(Screen.ProfileSetup.route) {
                        popUpTo(Screen.Splash.route) { inclusive = true }
                    }
                },
                onNavigateToMain = {
                    navController.navigate(Screen.Main.route) {
                        popUpTo(Screen.Splash.route) { inclusive = true }
                    }
                },
                onNavigateToBanned = { reason ->
                    navController.navigate(Screen.Banned.createRoute(reason)) {
                        popUpTo(0) { inclusive = true }
                    }
                },
                /*
                 * The same screen, told it is the HANDSET that is barred rather
                 * than the account in it. Splash is the one caller that knows
                 * for certain: it reads `bannedDevices` itself, before it has
                 * even looked at who is signed in.
                 */
                onNavigateToDeviceBanned = { reason ->
                    navController.navigate(Screen.Banned.createRoute(reason, BanKind.Device)) {
                        popUpTo(0) { inclusive = true }
                    }
                },
                /*
                 * A suspension goes somewhere else entirely, and carries the
                 * date it ends on — the whole point of separating it from a ban
                 * is that it has an end.
                 */
                onNavigateToSuspended = { reason, untilMillis ->
                    navController.navigate(Screen.Suspended.createRoute(reason, untilMillis)) {
                        popUpTo(0) { inclusive = true }
                    }
                },
                // `popUpTo(0)` so Back cannot slip past the question.
                onNavigateToRecoverAccount = {
                    navController.navigate(Screen.RecoverAccount.route) {
                        popUpTo(0) { inclusive = true }
                    }
                },
            )
        }

        composable(Screen.RecoverAccount.route) {
            RecoverAccountScreen(
                onRecovered = {
                    navController.navigate(Screen.Main.route) {
                        popUpTo(0) { inclusive = true }
                    }
                },
                // C7: a recovered account whose profile was never finished goes
                // to setup, like any other sign-in — never Home half-made.
                onRecoveredNeedsSetup = {
                    navController.navigate(Screen.ProfileSetup.route) {
                        popUpTo(0) { inclusive = true }
                    }
                },
                // The account is gone and the session with it. Login, where the
                // same phone number can now sign up again from scratch.
                onDeletedForGood = {
                    navController.navigate(Screen.Login.route) {
                        popUpTo(0) { inclusive = true }
                    }
                },
            )
        }

        /*
         * A guest turning their account into a permanent one.
         *
         * The session's uid is not changed by this flow in either direction: on
         * success it is the same uid with a number on it, and on a refusal it is
         * the same uid with nothing changed at all.
         *
         * UGP-C: success ends on SETTINGS, explicitly — `popBackStack()` only
         * got there when Settings happened to be the screen underneath. Cancel
         * is still a plain Back.
         */
        composable(Screen.SecureAccount.route) {
            SecureAccountScreen(
                onDone = { navController.backToSettings(Screen.SecureAccount.route) },
                onCancel = { navController.popBackStack() },
            )
        }

        /*
         * The same thing by email — by a six-digit code, inside the app (UGP-C).
         * No link, no mail-client round trip, no deep link back into this
         * destination: the old link flow and its `MainActivity` hand-off are
         * gone, along with the sign-in mode this screen used to have.
         */
        composable(Screen.SecureEmail.route) {
            SecureEmailScreen(
                onDone = { navController.backToSettings(Screen.SecureEmail.route) },
                onCancel = { navController.popBackStack() },
            )
        }

        /*
         * Approved contact rule: the same two screens, opened from the partner
         * hub or an application form. Done — or Cancel — returns to the screen
         * that opened them, which re-reads the server's answer on resume, so
         * the person goes back to the application they meant to make.
         */
        composable(Screen.SecureAccountForPartner.route) {
            SecureAccountScreen(
                onDone = { navController.popBackStack() },
                onCancel = { navController.popBackStack() },
            )
        }
        composable(Screen.SecureEmailForPartner.route) {
            SecureEmailScreen(
                onDone = { navController.popBackStack() },
                onCancel = { navController.popBackStack() },
            )
        }

        composable(Screen.Login.route) {
            LoginScreen(
                onNavigateToProfileSetup = {
                    navController.navigate(Screen.ProfileSetup.route) {
                        popUpTo(Screen.Login.route) { inclusive = true }
                    }
                },
                onNavigateToMain = {
                    navController.navigate(Screen.Main.route) {
                        popUpTo(Screen.Login.route) { inclusive = true }
                    }
                },
                /*
                 * Three findings, three screens.
                 *
                 * This used to collapse a barred device, a banned account and a
                 * suspension into one destination with one word, because
                 * `AuthResult.Banned` carried only a reason string. It carries
                 * the kind now — `resolveIdentity` on the server has always
                 * distinguished them — so a seven-day suspension no longer
                 * reads as a permanent ban until the next cold start.
                 */
                onNavigateToBanned = { reason, kind, untilMs ->
                    val route = when (kind) {
                        com.zipper.app.data.repository.RestrictionKind.Suspension ->
                            Screen.Suspended.createRoute(reason, untilMs)
                        com.zipper.app.data.repository.RestrictionKind.Device ->
                            Screen.Banned.createRoute(reason, BanKind.Device)
                        com.zipper.app.data.repository.RestrictionKind.Account ->
                            Screen.Banned.createRoute(reason)
                    }
                    navController.navigate(route) { popUpTo(0) { inclusive = true } }
                },
                // `popUpTo(0)` so Back cannot slip past the question.
                onNavigateToRecoverAccount = {
                    navController.navigate(Screen.RecoverAccount.route) {
                        popUpTo(0) { inclusive = true }
                    }
                },
                onNavigateToTerms = { navController.navigate(Screen.Terms.route) },
            )
        }


        composable(
            route = Screen.Banned.route,
            arguments = Screen.Banned.navArguments,
        ) { backStack ->
            /*
             * Read as it arrives — NOT through `URLDecoder.decode`, which this
             * used to do.
             *
             * `createRoute` encodes with `Uri.encode` and Navigation decodes the
             * argument with `Uri.decode` before handing it over (see the note in
             * Screen.Banned), so decoding again here was a SECOND decode, in the
             * other encoding. Two ways it showed:
             *
             *   "Spam: 50% off links"  — `URLDecoder` sees a `%` that is not the
             *                            start of a valid escape and throws
             *                            IllegalArgumentException, out of the
             *                            destination, on the one screen nobody
             *                            can navigate away from.
             *   "C++ spam in comments" — form decoding turns each `+` into a
             *                            space, which is the exact bug
             *                            `Uri.encode` was chosen to avoid.
             */
            val reason = backStack.arguments?.getString("reason").orEmpty()
            BannedScreen(
                reason = reason,
                // Missing or unrecognised reads as an account ban. See BanKind.
                kind = BanKind.fromArg(backStack.arguments?.getString("kind")),
            )
        }

        /*
         * A suspension, which is not a ban and does not bar this phone.
         *
         * `onBackToLogin` is the graph's own `signOutAndGoToLogin` — the same
         * call "Switch account" in Settings makes. That is the entire point of
         * the screen: the device is clean, so another eligible account may be
         * signed in here, and it has to be a real sign-out rather than a bare
         * navigation or Login would find the suspended credential still in place
         * and walk straight back onto this screen.
         */
        composable(
            route = Screen.Suspended.route,
            arguments = Screen.Suspended.navArguments,
        ) { backStack ->
            SuspendedScreen(
                reason = backStack.arguments?.getString("reason").orEmpty(),
                // 0 when the argument is missing, which is also what an
                // INDEFINITE suspension carries. The screen says "no end date"
                // for it rather than formatting the epoch at somebody.
                untilMillis = backStack.arguments?.getLong("untilMs") ?: 0L,
                onBackToLogin = signOutAndGoToLogin,
            )
        }

        composable(Screen.Terms.route) {
            TermsScreen(onBack = { navController.popBackStack() })
        }

        composable(Screen.ProfileSetup.route) {
            ProfileSetupScreen(
                onNavigateToMain = {
                    navController.navigate(Screen.Main.route) {
                        popUpTo(0) { inclusive = true }
                    }
                },
                // A host who has just redeemed a code. `popUpTo(0)` so Back from
                // the capture cannot return to a setup form that has already
                // been submitted.
                onNavigateToFaceVerification = { gender ->
                    navController.navigate(Screen.FaceVerification.createRoute(gender)) {
                        popUpTo(0) { inclusive = true }
                    }
                },
                onNavigateToLogin = {
                    navController.navigate(Screen.Login.route) {
                        popUpTo(0) { inclusive = true }
                    }
                },
            )
        }

        composable(
            route = Screen.FaceVerification.route,
            arguments = Screen.FaceVerification.navArguments,
        ) { backStack ->
            val gender = backStack.arguments?.getString("gender") ?: "unknown"
            FaceVerificationScreen(
                declaredGender = gender,
                onNavigateToMain = {
                    navController.navigate(Screen.Main.route) {
                        popUpTo(0) { inclusive = true }
                    }
                },
                onNavigateToLogin = {
                    navController.navigate(Screen.Login.route) {
                        popUpTo(0) { inclusive = true }
                    }
                },
            )
        }

        // ── Main shell ────────────────────────────────────────────────────
        //
        // APK 20 / spec §8: an Owner presents an authenticator code before Main
        // renders, whichever way they arrived (OwnerMfaGateHost). Everyone else
        // passes after one local read. A refusal (the Observer, a server that
        // cannot run the step, "Sign out") ends the app session with the
        // reason shown on Login — the same forced sign-out Splash uses.
        composable(Screen.Main.route) {
            com.zipper.app.ui.screens.auth.OwnerMfaGateHost(
                onRefused = { reason ->
                    reason?.let { com.zipper.app.ui.screens.auth.ForcedSignOut.raise(it) }
                    signOutAndGoToLogin()
                },
            ) {
                MainScreen(
                    onNavigateToEditProfile  = { navController.navigate(Screen.EditProfile.route) },
                    onNavigateToSettings     = { navController.navigate(Screen.Settings.route) },
                    onNavigateToDiamondShop  = { navController.navigate(Screen.DiamondShop.route) },
                    onNavigateToBeansCenter  = { navController.navigate(Screen.BeansCenter.route) },
                    onNavigateToProfile      = { navController.navigate(Screen.OwnProfile.route) },
                    onNavigateToUserProfile  = { uid -> navController.navigate(Screen.UserProfile.createRoute(uid)) },
                    onNavigateToGoLive       = { navController.navigate(Screen.LiveBroadcast.route) },
                    onNavigateToWatchLive    = { roomId -> navController.navigate(Screen.LiveViewer.createRoute(roomId)) },
                    onNavigateToPartyRooms   = { navController.navigate(Screen.PartyList.route) },
                    onNavigateToMyBag        = { navController.navigate(Screen.MyBag.route) },
                    onNavigateToEarnings     = { navController.navigate(Screen.Earnings.route) },
                    onNavigateToCallHistory  = { navController.navigate(Screen.CallHistory.route) },
                    onNavigateToLikes        = { tab -> navController.navigate(Screen.LikesScreen.createRoute(tab)) },
                    onNavigateToLevel        = { navController.navigate(Screen.LevelScreen.route) },
                    onNavigateToDailyRewards = { navController.navigate(Screen.DailyRewards.route) },
                    onNavigateToIncomingCall = { callId -> navController.navigate(Screen.IncomingCall.createRoute(callId)) { launchSingleTop = true } },
                    onNavigateToChat             = { uid -> navController.navigate(Screen.Chat.createRoute(uid)) },
                    onNavigateToAgencyDashboard  = { navController.navigate(Screen.AgencyDashboard.route) },
                    onNavigateToSellerDashboard  = { navController.navigate(Screen.SellerDashboard.route) },
                    onNavigateToWork             = { navController.navigate(Screen.Work.route) },
                    onNavigateToFeedback         = { navController.navigate(Screen.Feedback.route) },
                    // Not popUpTo(0) here: this host is already using the app, and
                    // the capture is skippable — Back must return them to Me.
                    onNavigateToFaceVerification = { gender ->
                        navController.navigate(Screen.FaceVerification.createRoute(gender))
                    },
                    onNavigateToPartnerHub = { navController.navigate(Screen.PartnerHub.route) },
                    onLogout = signOutAndGoToLogin,
                )
            }
        }

        // ── Becoming a partner ────────────────────────────────────────────
        composable(Screen.PartnerHub.route) {
            PartnerHubScreen(
                onBack = { navController.popBackStack() },
                onApply = { kind -> navController.navigate(Screen.PartnerApply.createRoute(kind)) },
                onVerifyPhone = { navController.navigate(Screen.SecureAccountForPartner.route) },
                onVerifyEmail = { navController.navigate(Screen.SecureEmailForPartner.route) },
            )
        }
        composable(
            Screen.PartnerApply.route,
            arguments = listOf(navArgument("kind") { type = NavType.StringType }),
        ) {
            PartnerApplyScreen(
                onBack = { navController.popBackStack() },
                // Back to the hub, which re-reads eligibility and shows the
                // application as pending; the form is popped so Back cannot
                // re-submit it.
                onDone = {
                    navController.popBackStack(Screen.PartnerHub.route, inclusive = false)
                },
                onVerifyPhone = { navController.navigate(Screen.SecureAccountForPartner.route) },
                onVerifyEmail = { navController.navigate(Screen.SecureEmailForPartner.route) },
            )
        }
        composable(
            Screen.RechargeRequest.route,
            arguments = listOf(
                navArgument("sellerId") { type = NavType.StringType },
                navArgument("sellerName") { type = NavType.StringType },
            ),
        ) {
            RechargeRequestScreen(
                onBack = { navController.popBackStack() },
                onDone = { navController.popBackStack() },
            )
        }

        // ── Video Call ────────────────────────────────────────────────────
        composable(
            route     = Screen.VideoCall.route,
            arguments = Screen.VideoCall.navArguments,
        ) { backStack ->
            val callId     = backStack.arguments?.getString("callId")      ?: return@composable
            val isOutgoing = backStack.arguments?.getBoolean("isOutgoing") ?: true
            VideoCallScreen(
                callId    = callId,
                isOutgoing = isOutgoing,
                onCallEnded = {
                    navController.popBackStack()
                },
                onRecharge = { navController.navigate(Screen.DiamondShop.route) },
            )
        }

        // ── Incoming Call ─────────────────────────────────────────────────
        composable(
            route     = Screen.IncomingCall.route,
            arguments = Screen.IncomingCall.navArguments,
        ) { backStack ->
            val callId = backStack.arguments?.getString("callId") ?: return@composable
            IncomingCallScreen(
                callId = callId,
                onCallAccepted = { cId ->
                    navController.navigate(Screen.VideoCall.createRoute(cId, isOutgoing = false)) {
                        popUpTo(Screen.IncomingCall.route) { inclusive = true }
                    }
                },
                onCallDeclined = { navController.popBackStack() },
            )
        }

        // ── Live ─────────────────────────────────────────────────────────────
        composable(Screen.LiveBroadcast.route) {
            GoLiveScreen(
                onBack = { navController.popBackStack() },
                onOpenProfile = { uid -> navController.navigate(Screen.UserProfile.createRoute(uid)) },
                onLiveEnded = { summary ->
                    // Every figure the card prints goes into the route. The
                    // gifter ROWS cannot — a route argument is a string — so
                    // they are handed over separately; see LiveSummaryGifters.
                    LiveSummaryGifters.handOff(summary.topGifters)
                    navController.navigate(
                        Screen.LiveSummary.createRoute(
                            durationSeconds = summary.durationSeconds,
                            totalBeans      = summary.totalBeans,
                            peakViewers     = summary.peakViewers,
                            gifterCount     = summary.gifterCount,
                        )
                    ) {
                        popUpTo(Screen.LiveBroadcast.route) { inclusive = true }
                    }
                },
            )
        }

        composable(
            route      = Screen.LiveSummary.route,
            arguments  = Screen.LiveSummary.navArguments,
        ) { backStack ->
            val durationSeconds = backStack.arguments?.getLong("durationSeconds") ?: 0L
            val totalBeans      = backStack.arguments?.getLong("totalBeans")      ?: 0L
            val peakViewers     = backStack.arguments?.getInt("peakViewers")      ?: 0
            val gifterCount     = backStack.arguments?.getInt("gifterCount")      ?: 0
            LiveSummaryScreen(
                durationSeconds = durationSeconds,
                totalBeans      = totalBeans,
                peakViewers     = peakViewers,
                gifterCount     = gifterCount,
                topGifters      = LiveSummaryGifters.rows,
                onDone = { navController.popBackStack(Screen.Main.route, inclusive = false) },
            )
        }

        composable(
            route = Screen.LiveViewer.route,
            arguments = listOf(navArgument("roomId") { type = NavType.StringType }),
        ) { backStack ->
            val roomId = backStack.arguments?.getString("roomId") ?: ""
            WatchLiveScreen(
                roomId        = roomId,
                onBack        = { navController.popBackStack() },
                onRecharge    = { navController.navigate(Screen.DiamondShop.route) },
                onOpenProfile = { uid -> navController.navigate(Screen.UserProfile.createRoute(uid)) },
            )
        }

        // ── Party rooms ───────────────────────────────────────────────────
        composable(Screen.PartyList.route) {
            PartyListScreen(
                onBack = { navController.popBackStack() },
                onOpenRoom = { roomId -> navController.navigate(Screen.PartyRoom.createRoute(roomId)) },
            )
        }

        composable(
            route = Screen.PartyRoom.route,
            arguments = listOf(navArgument("roomId") { type = NavType.StringType }),
        ) { backStack ->
            val roomId = backStack.arguments?.getString("roomId") ?: ""
            PartyRoomScreen(
                roomId        = roomId,
                onBack        = { navController.popBackStack() },
                onRecharge    = { navController.navigate(Screen.DiamondShop.route) },
                onOpenProfile = { uid -> navController.navigate(Screen.UserProfile.createRoute(uid)) },
            )
        }

        composable(Screen.EditProfile.route) {
            EditProfileScreen(onBack = { navController.popBackStack() })
        }

        // ── Own profile ───────────────────────────────────────────────────
        composable(Screen.OwnProfile.route) {
            val vm: ProfileViewModel = hiltViewModel()
            val state by vm.state.collectAsStateWithLifecycle()
            val user = state.user
            if (state.isLoading || user == null) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(MaterialTheme.colorScheme.background),
                    contentAlignment = Alignment.Center,
                ) { CircularProgressIndicator(color = ZipperPink) }
            } else {
                ProfileScreen(
                    user                 = user,
                    isOwnProfile         = true,
                    currentUserDiamonds  = user.diamonds,
                    giftsSent            = state.giftsSent,
                    giftsReceived        = state.giftsReceived,
                    onBack               = { navController.popBackStack() },
                    onEditProfile        = { navController.navigate(Screen.EditProfile.route) },
                    onOpenGallery        = { startIdx ->
                        navController.currentBackStackEntry
                            ?.savedStateHandle
                            ?.set("mediaUrls", user.mediaUrls)
                        navController.navigate(
                            Screen.GalleryViewer.createRoute(user.uid, startIdx)
                        )
                    },
                    onViewAllGiftsSent     = { navController.navigate(Screen.GiftDetails.createRoute(user.uid, "sent")) },
                    onViewAllGiftsReceived = { navController.navigate(Screen.GiftDetails.createRoute(user.uid, "received")) },
                )
            }
        }

        // ── Gallery viewer ────────────────────────────────────────────────
        composable(
            route     = Screen.GalleryViewer.route,
            arguments = Screen.GalleryViewer.navArguments,
        ) { backStack ->
            val startIndex = backStack.arguments?.getInt("startIndex") ?: 0
            val mediaUrls = navController.previousBackStackEntry
                ?.savedStateHandle
                ?.get<List<String>>("mediaUrls") ?: emptyList()
            GalleryViewerScreen(
                mediaUrls  = mediaUrls,
                startIndex = startIndex,
                onBack     = { navController.popBackStack() },
            )
        }

        // ── Gift details ──────────────────────────────────────────────────
        composable(
            route     = Screen.GiftDetails.route,
            arguments = Screen.GiftDetails.navArguments,
        ) { backStack ->
            val type  = backStack.arguments?.getString("type") ?: "received"
            val title = if (type == "sent") "Gifts Sent" else "Gifts Received"
            // The ViewModel reads {uid} and {type} straight off the route, so
            // this works for the signed-in user and for anybody else's profile.
            val vm: GiftDetailsViewModel = hiltViewModel()
            val giftState by vm.state.collectAsStateWithLifecycle()
            GiftDetailsScreen(
                title  = title,
                gifts  = giftState.gifts,
                onBack = { navController.popBackStack() },
                isLoading = giftState.isLoading,
            )
        }

        // ── Diamond Wallet (history + recharge) ───────────────────────────
        composable(Screen.DiamondHistory.route) {
            val vm: ProfileViewModel = hiltViewModel()
            val state by vm.state.collectAsStateWithLifecycle()
            DiamondHistoryScreen(
                currentDiamonds = state.user?.diamonds ?: 0L,
                transactions    = state.diamondTransactions,
                onBack          = { navController.popBackStack() },
                onRecharge      = { navController.navigate(Screen.ResellerList.route) },
            )
        }

        // ── Reseller list (buy diamonds) ──────────────────────────────────
        composable(Screen.ResellerList.route) {
            ResellerListScreen(
                onBack         = { navController.popBackStack() },
                onMessage      = { uid -> navController.navigate(Screen.Chat.createRoute(uid)) },
                onViewProfile  = { uid -> navController.navigate(Screen.UserProfile.createRoute(uid)) },
                onPaid         = { sellerId, name -> navController.navigate(Screen.RechargeRequest.createRoute(sellerId, name)) },
            )
        }

        // ── Bean Wallet (history + convert) ──────────────────────────────
        composable(Screen.BeansCenter.route) {
            val vm: ProfileViewModel = hiltViewModel()
            val state by vm.state.collectAsStateWithLifecycle()
            BeanHistoryScreen(
                currentBeans = state.user?.beans ?: 0L,
                transactions = state.beanTransactions,
                beansPerDiamond = state.beansPerDiamond,
                onBack       = { navController.popBackStack() },
                onConvert    = { amount -> vm.convertBeans(amount) },
            )
        }

        // ── Likes ─────────────────────────────────────────────────────────
        composable(
            route     = Screen.LikesScreen.route,
            arguments = Screen.LikesScreen.navArguments,
        ) { backStack ->
            val initialTab = backStack.arguments?.getInt("initialTab") ?: 0
            LikesScreen(
                initialTab    = initialTab,
                onBack        = { navController.popBackStack() },
                onViewProfile = { uid -> navController.navigate(Screen.UserProfile.createRoute(uid)) },
                // viewModel is automatically provided by hiltViewModel()
            )
        }

        // ── My Level ──────────────────────────────────────────────────────
        composable(Screen.LevelScreen.route) {
            // LevelScreen owns its own LevelScreenViewModel and derives the level
            // from live thresholds, so it no longer takes them as arguments.
            LevelScreen(onBack = { navController.popBackStack() })
        }

        // ── Daily Rewards ─────────────────────────────────────────────────
        composable(Screen.DailyRewards.route) {
            DailyRewardsScreen(
                onBack = { navController.popBackStack() },
                // viewModel provided by hiltViewModel() inside the screen
            )
        }

        // ── My Bag ────────────────────────────────────────────────────────
        composable(Screen.MyBag.route) {
            val vm: ProfileViewModel = hiltViewModel()
            val state by vm.state.collectAsStateWithLifecycle()
            MyBagScreen(
                videoCards = state.user?.videoCards ?: 0,
                onBack     = { navController.popBackStack() },
                onEquip    = { /* handled inside MyBagScreen ViewModel */ },
                onBuy      = { /* handled inside MyBagScreen ViewModel */ },
            )
        }

        // ── Call History ──────────────────────────────────────────────────
        composable(Screen.CallHistory.route) {
            CallHistoryScreen(
                onBack        = { navController.popBackStack() },
                onViewProfile = { uid -> navController.navigate(Screen.UserProfile.createRoute(uid)) },
            )
        }

        // ── Settings ──────────────────────────────────────────────────────
        composable(Screen.Settings.route) {
            val vm: ProfileViewModel = hiltViewModel()
            val state by vm.state.collectAsStateWithLifecycle()
            val context = androidx.compose.ui.platform.LocalContext.current
            /*
             * The server's answer, with the client's guess only as a fallback.
             *
             * `isAnonymous` is the wrong question — it reads false for a guest
             * who returned through quick sign-in, which hid "add your phone
             * number" from exactly the people whose account exists on this
             * handset and nowhere else. So the server answers it from
             * `providerData` and the answer is cached.
             *
             * But the cache is written at sign-in, and everybody already
             * signed in when this ships has never had it written. For them
             * null means "nobody has asked yet", and `isAnonymous` — imperfect
             * as it is — is right for the ordinary case of a guest who signed
             * in anonymously on this install. It corrects itself the next time
             * they sign in.
             */
            val serverSaysGuest by authVm.isGuest.collectAsStateWithLifecycle()
            val isGuestAccount = serverSaysGuest
                ?: (FirebaseAuth.getInstance().currentUser?.isAnonymous == true)
            /*
             * Null when the updater is compiled out, which turns the Settings row
             * back into a plain version line. The gate that owns the dialog lives
             * in MainActivity, above the NavHost, so this only has to raise the
             * request — see UpdateCheckRequest.
             */
            val onCheckForUpdates: (() -> Unit)? =
                if (BuildConfig.OTA_ENABLED) ({ UpdateCheckRequest.request() }) else null
            SettingsScreen(
                /*
                 * `versionName (versionCode)`, read from BuildConfig rather than
                 * from the composable's "1.0.0" default — which is what this
                 * screen has been showing all along, and was already wrong before
                 * anybody bumped anything.
                 *
                 * The versionCode is in the string because it is the only value
                 * the OTA updater compares. See the row in SettingsScreen.
                 */
                appVersion                    = context.installedVersionLabel(),
                onCheckForUpdates             = onCheckForUpdates,
                savedTheme                    = state.user?.theme ?: "system",
                savedLanguage                 = state.user?.appLanguage ?: "en",
                isAgent                       = state.user?.isAgent ?: false,
                isSeller                      = state.user?.isSeller ?: false,
                isGuest                       = isGuestAccount,
                // What this account has BOUND today. Each missing one gets an
                // "Add …" row — for every account, not only guests: a phone
                // account may add an email and the other way round.
                //
                // UGP-1.7: bound = on the Auth record AND recorded on
                // users/{uid}. Reading the Auth record alone hid the row after
                // a link whose server bind had failed — the one state whose
                // retry lives behind that row.
                //
                // Until the profile has loaded the document side is unknown, so
                // neither row is shown — rather than both flashing up for every
                // account and moving the layout under a finger (UGP review).
                hasPhone                      = state.user == null || com.zipper.app.util.ContactRules.phoneBound(
                    authPhone = FirebaseAuth.getInstance().currentUser?.phoneNumber,
                    docPhone  = state.user?.phoneNumber,
                ),
                hasEmail                      = state.user == null || com.zipper.app.util.ContactRules.emailBound(
                    authEmail         = FirebaseAuth.getInstance().currentUser?.email,
                    authEmailVerified = FirebaseAuth.getInstance().currentUser?.isEmailVerified == true,
                    docEmail          = state.user?.email,
                ),
                onThemeChange                 = { vm.saveTheme(it) },
                onLanguageChange              = { code ->
                    vm.saveLanguage(code)
                    // Apply locale immediately — recreates the activity on older APIs
                    applyAppLocale(context, code)
                },
                onBack                        = { navController.popBackStack() },
                onNavigateToBlockedUsers      = { navController.navigate(Screen.BlockedUsers.route) },
                onNavigateToAgencyDashboard   = { navController.navigate(Screen.AgencyDashboard.route) },
                onNavigateToSellerDashboard   = { navController.navigate(Screen.SellerDashboard.route) },
                // Fires the request only. The navigation happens in response to
                // `accountDeleted` below, so a failed request keeps the person
                // on Settings with the reason instead of showing them a goodbye
                // over an account that is still there.
                onDeleteAccount               = { authVm.deleteAccount() },
                onSwitchAccount               = signOutAndGoToLogin,
                onFeedback                    = { navController.navigate(Screen.Feedback.route) },
                onPrivacyPolicy               = { navController.navigate(Screen.LegalDoc.createRoute("privacy_policy")) },
                onTerms                       = { navController.navigate(Screen.LegalDoc.createRoute("terms_of_service")) },
                onLogout                      = signOutAndGoToLogin,
                // UGP-E2: no "Sign out and forget this device" any more.
                // Rendered for any account missing a bound contact. See
                // the section in SettingsScreen for why they are the first thing
                // on the screen for the people who do see them.
                onSecureAccount               = { navController.navigate(Screen.SecureAccount.route) },
                onSecureEmail                 = { navController.navigate(Screen.SecureEmail.route) },
            )
        }

        // ── Diamond Shop ──────────────────────────────────────────────────
        composable(Screen.DiamondShop.route) {
            val vm: ProfileViewModel = hiltViewModel()
            val state by vm.state.collectAsStateWithLifecycle()
            DiamondShopScreen(
                currentDiamonds  = state.user?.diamonds ?: 0L,
                onBack           = { navController.popBackStack() },
                onNavigateToChat = { sellerUid, prefilledMsg ->
                    // Navigate to chat with pre-filled message via SavedStateHandle
                    navController.currentBackStackEntry
                        ?.savedStateHandle
                        ?.set("prefilledMsg", prefilledMsg)
                    navController.navigate(Screen.Chat.createRoute(sellerUid))
                },
                onViewResellers = { navController.navigate(Screen.ResellerList.route) },
            )
        }

        // ── Earnings ──────────────────────────────────────────────────────
        composable(Screen.Earnings.route) {
            EarningsScreen(
                onBack = { navController.popBackStack() },
                onConvertBeans = { navController.navigate(Screen.BeansCenter.route) },
                onEditRate = { navController.navigate(Screen.EditProfile.route) },
            )
        }

        // ── 1-to-1 Chat ───────────────────────────────────────────────────
        composable(
            route     = Screen.Chat.route,
            arguments = listOf(navArgument("uid") { type = NavType.StringType }),
        ) { backStack ->
            val uid = backStack.arguments?.getString("uid") ?: return@composable
            // Optional pre-filled message from DiamondShop → seller flow
            // Set by the Diamond Shop on ITS entry; by the time Chat composes,
            // currentBackStackEntry is Chat itself.
            val prefilledMsg = navController.previousBackStackEntry
                ?.savedStateHandle
                ?.get<String>("prefilledMsg") ?: ""
            ChatScreen(
                otherUid    = uid,
                convoId     = "",    // computed inside ChatViewModel from uid + myUid
                onBack      = { navController.popBackStack() },
                onJoinLive  = { roomId -> navController.navigate(Screen.LiveViewer.createRoute(roomId)) },
                onOpenProfile = { u -> navController.navigate(Screen.UserProfile.createRoute(u)) },
                prefilledMessage = prefilledMsg,
            )
        }

        // ── Privacy Policy (legacy static screen) ─────────────────────────
        composable(Screen.PrivacyPolicy.route) {
            PrivacyPolicyScreen(onBack = { navController.popBackStack() })
        }

        // ── Legal Doc (CRM-managed: privacy_policy / terms_of_service / faq) ──
        composable(
            route     = Screen.LegalDoc.route,
            arguments = Screen.LegalDoc.navArguments,
        ) { backStack ->
            val docType = backStack.arguments?.getString("docType") ?: "privacy_policy"
            LegalScreen(
                docType = docType,
                onBack  = { navController.popBackStack() },
            )
        }

        // ── Blocked users ─────────────────────────────────────────────────
        composable(Screen.BlockedUsers.route) {
            BlockedUsersScreen(
                onBack        = { navController.popBackStack() },
                onViewProfile = { uid -> navController.navigate(Screen.UserProfile.createRoute(uid)) },
            )
        }

        // ── User profile (other users) ────────────────────────────────────
        composable(
            route = Screen.UserProfile.route,
            arguments = listOf(navArgument("uid") { type = NavType.StringType }),
        ) {
            OtherUserProfileScreen(
                onBack      = { navController.popBackStack() },
                onStartCall = { callId -> navController.navigate(Screen.VideoCall.createRoute(callId, isOutgoing = true)) },
                onMessage   = { uid -> navController.navigate(Screen.Chat.createRoute(uid)) },
                onJoinLive  = { roomId -> navController.navigate(Screen.LiveViewer.createRoute(roomId)) },
                onJoinParty = { roomId -> navController.navigate(Screen.PartyRoom.createRoute(roomId)) },
                onRecharge  = { navController.navigate(Screen.DiamondShop.route) },
                onOpenGallery = { uid, startIdx, urls ->
                    navController.currentBackStackEntry?.savedStateHandle?.set("mediaUrls", urls)
                    navController.navigate(Screen.GalleryViewer.createRoute(uid, startIdx))
                },
            )
        }

        // ── Feedback / Help & Support ─────────────────────────────────────
        composable(Screen.Feedback.route) {
            FeedbackScreen(onBack = { navController.popBackStack() })
        }

        // ── Agency Dashboard ──────────────────────────────────────────────
        composable(Screen.AgencyDashboard.route) {
            AgencyDashboardScreen(
                onBack = { navController.popBackStack() },
                // B2: a host row opens the host's PUBLIC profile — the same
                // destination Home, call history and likes already use.
                onOpenHost = { uid -> navController.navigate(Screen.UserProfile.createRoute(uid)) },
                onOpenHostEarnings = { id -> navController.navigate(Screen.WorkModule.createRoute("agency.hosts", id)) },
            )
        }

        // ── Seller Dashboard ──────────────────────────────────────────────
        composable(Screen.SellerDashboard.route) {
            SellerDashboardScreen(
                onBack     = { navController.popBackStack() },
                onBuyCoins = { navController.navigate(Screen.BuyCoin.route) },
            )
        }

        // ── Work (mobile parity) ──────────────────────────────────────────
        // One hub, one list and one detail render every declared CRM capability;
        // the API session decides what each person is offered and allowed.
        val workNav = object : com.zipper.app.ui.screens.work.WorkNav {
            override fun module(moduleId: String, param: String) { navController.navigate(Screen.WorkModule.createRoute(moduleId, param)) }
            override fun detail(moduleId: String) { navController.navigate(Screen.WorkDetail.createRoute(moduleId)) }
            override fun appProfile(uid: String) { navController.navigate(Screen.UserProfile.createRoute(uid)) }
            override fun appLive(roomId: String) { navController.navigate(Screen.LiveViewer.createRoute(roomId)) }
            override fun back() { navController.popBackStack() }
        }
        composable(Screen.Work.route) {
            com.zipper.app.ui.screens.work.WorkHubScreen(nav = workNav)
        }
        composable(
            route = Screen.WorkModule.route,
            arguments = listOf(
                navArgument("moduleId") { type = NavType.StringType },
                navArgument("p") { type = NavType.StringType; defaultValue = "" },
            ),
        ) {
            com.zipper.app.ui.screens.work.WorkListScreen(nav = workNav)
        }
        composable(
            route = Screen.WorkDetail.route,
            arguments = listOf(navArgument("moduleId") { type = NavType.StringType }),
        ) {
            com.zipper.app.ui.screens.work.WorkDetailScreen(nav = workNav)
        }

        // ── Buy Coins (seller pays Zippern to top up coin inventory) ──────
        composable(Screen.BuyCoin.route) {
            BuyCoinScreen(onBack = { navController.popBackStack() })
        }
    }

    /*
     * B11: while a sign-out runs, cover the screen it was started from.
     *
     * Login now waits for the sign-out to finish — usually a second or two of
     * network — and the screen underneath must not look idle, or invite a
     * second tap on something that belongs to an account on its way out. A
     * sibling of the NavHost, so it sits above whichever destination is shown;
     * the empty click swallows taps until it goes.
     */
    if (authState.signingOut) {
        Box(
            Modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.background.copy(alpha = 0.72f))
                .clickableNoRipple { },
        ) {
            LoadingState()
        }
    }
}

// ── Locale helper ─────────────────────────────────────────────────────────────

/**
 * Applies [languageCode] as the per-app locale using AppCompatDelegate.
 *
 * On API 33+  : delegates to LocaleManager — no manual restart needed.
 * On API < 33 : AppCompat stores the preference and recreates via attachBaseContext2.
 *               Passing an empty locale list resets to the device default.
 */
fun applyAppLocale(@Suppress("UNUSED_PARAMETER") context: android.content.Context, languageCode: String) {
    val list = if (languageCode.isBlank() || languageCode == "en")
        androidx.core.os.LocaleListCompat.getEmptyLocaleList()
    else
        androidx.core.os.LocaleListCompat.forLanguageTags(languageCode)
    androidx.appcompat.app.AppCompatDelegate.setApplicationLocales(list)
}

// ── Contact binding exit ─────────────────────────────────────────────────────

/**
 * UGP-C: a finished phone or email binding always lands on Settings.
 *
 * If Settings is already underneath (the ordinary case — it is the only screen
 * with the "Add …" rows) this pops back to it, so Back from Settings behaves as
 * it always did. Otherwise the binding screen is replaced by Settings, so Back
 * can never return to a "Done" step for a flow that is over.
 */
internal fun NavHostController.backToSettings(fromRoute: String) {
    if (popBackStack(Screen.Settings.route, inclusive = false)) return
    navigate(Screen.Settings.route) {
        popUpTo(fromRoute) { inclusive = true }
        launchSingleTop = true
    }
}

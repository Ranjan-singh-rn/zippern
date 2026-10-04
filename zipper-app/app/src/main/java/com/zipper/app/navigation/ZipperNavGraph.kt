package com.zipper.app.navigation

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
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
import com.zipper.app.ui.screens.host.JoinAgencyScreen
import com.zipper.app.ui.theme.ZipperPink

@Composable
fun ZipperNavGraph(
    navController: NavHostController = rememberNavController(),
) {
    // One AuthViewModel for the graph so sign-out (token clear + Firebase
    // signOut + session clear) runs from every logout entry point.
    val authVm: com.zipper.app.ui.screens.auth.AuthViewModel = hiltViewModel()
    val signOutAndGoToLogin: () -> Unit = {
        authVm.signOut()
        navController.navigate(Screen.Login.route) { popUpTo(0) { inclusive = true } }
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
         * Both exits are `popBackStack()` — back to Settings, and nowhere else.
         * The session is not touched by this flow in either direction: on success
         * it is the same uid with a number on it, and on a refusal it is the same
         * uid with nothing changed at all, so there is no reason to disturb the
         * stack and every reason not to.
         */
        composable(Screen.SecureAccount.route) {
            SecureAccountScreen(
                onDone = { navController.popBackStack() },
                onCancel = { navController.popBackStack() },
            )
        }

        /*
         * The same thing by email.
         *
         * Both exits are `popBackStack()` for the same reasons as above. One
         * extra property this destination has to keep: `MainActivity` navigates
         * here with `launchSingleTop` when a sign-in link comes back, so if the
         * person is already standing on it — the ordinary case, the app was
         * simply in the background — the screen and its ViewModel are NOT
         * recreated and the link lands in the flow that is already running.
         */
        composable(Screen.SecureEmail.route) {
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
        composable(Screen.Main.route) {
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
                onNavigateToFeedback         = { navController.navigate(Screen.Feedback.route) },
                // Not popUpTo(0) here: this host is already using the app, and
                // the capture is skippable — Back must return them to Me.
                onNavigateToFaceVerification = { gender ->
                    navController.navigate(Screen.FaceVerification.createRoute(gender))
                },
                onNavigateToJoinAgency = { navController.navigate(Screen.JoinAgency.route) },
                onLogout = signOutAndGoToLogin,
            )
        }

        /*
         * Redeeming an agency code on an account that already exists.
         *
         * Popped off the stack on success rather than left behind: the code has
         * been consumed, so returning to the form with Back would offer a
         * submission the server will now refuse as already used. The capture
         * screen it hands on to is the same one the first-run flow uses.
         */
        composable(Screen.JoinAgency.route) {
            JoinAgencyScreen(
                onBack = { navController.popBackStack() },
                onActivated = {
                    navController.navigate(Screen.FaceVerification.createRoute("unknown")) {
                        popUpTo(Screen.JoinAgency.route) { inclusive = true }
                    }
                },
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
                /*
                 * NOT `signOutAndGoToLogin`. The difference is the whole point.
                 *
                 * `authVm.signOut()` mints a quick-login secret on the way out
                 * so the account can be recovered with one tap; this calls
                 * `signOutAndForget()`, which revokes that secret server-side
                 * and erases it from Block Store, so the login screen comes back
                 * with no "Continue as …" button on it.
                 *
                 * Same `popUpTo(0)` as every other sign-out: the whole stack
                 * goes, so Back cannot walk into a screen belonging to an
                 * account that is no longer signed in.
                 */
                onSignOutAndForget            = {
                    authVm.signOutAndForget()
                    navController.navigate(Screen.Login.route) { popUpTo(0) { inclusive = true } }
                },
                // Guests only — the rows are not rendered for anyone else. See
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
            AgencyDashboardScreen(onBack = { navController.popBackStack() })
        }

        // ── Seller Dashboard ──────────────────────────────────────────────
        composable(Screen.SellerDashboard.route) {
            SellerDashboardScreen(
                onBack     = { navController.popBackStack() },
                onBuyCoins = { navController.navigate(Screen.BuyCoin.route) },
            )
        }

        // ── Buy Coins (seller pays Zippern to top up coin inventory) ──────
        composable(Screen.BuyCoin.route) {
            BuyCoinScreen(onBack = { navController.popBackStack() })
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

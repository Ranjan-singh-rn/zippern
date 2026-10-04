package com.zipper.app.navigation

import androidx.navigation.NavType
import androidx.navigation.navArgument
import com.zipper.app.ui.screens.auth.BanKind

sealed class Screen(val route: String) {
    // Auth
    object Splash        : Screen("splash")
    object Login         : Screen("login")
    /*
     * There is no separate OTP destination.
     *
     * There used to be, and it was unreachable: `LoginScreen` declared an
     * `onNavigateToOtp` callback and never called it, because the
     * `verificationId` lives in the AuthViewModel that LoginScreen creates and a
     * separate destination would get a fresh one. The OTP step is an
     * AnimatedContent stage inside LoginScreen instead.
     *
     * Removed rather than left in place: the dead screen called
     * `verifyOtp(code)` without a device id, so reviving it would have silently
     * skipped the banned-device check on the one path a banned user is most
     * likely to try.
     */
    object ProfileSetup  : Screen("profile_setup")
    /**
     * A banned ACCOUNT, or a barred DEVICE. Not a suspension — that is
     * [Suspended], because the person can do something there that they cannot
     * do here.
     *
     * `kind` is a route segment rather than something the screen works out for
     * itself, because it cannot: the two findings arrive as an identical
     * string. See [BanKind].
     */
    object Banned        : Screen("banned/{kind}/{reason}") {
        /*
         * `Uri.encode`, not `URLEncoder.encode`.
         *
         * They are not the same encoding. `URLEncoder` is form encoding: it
         * turns a space into `+`. Navigation decodes the argument with
         * `Uri.decode`, which leaves `+` alone — so a ban reason arrived on the
         * screen as "Harassment+of+another+user", shown to the person whose
         * account had just been closed, at the one moment the wording of the
         * message matters most.
         *
         * `reason` is the LAST segment on purpose: it is the one piece of free
         * text here, and keeping it at the end means a route that is being read
         * in a stack trace still has its fixed parts where they are expected.
         *
         * A blank reason is defaulted HERE rather than trusted from the caller.
         *
         * An empty segment does not match the route pattern, so `navigate()`
         * throws — on a screen the person cannot leave. Callers were expected
         * to pass a fallback and most did, but a present-but-EMPTY `banReason`
         * survives a `?:` and arrives blank, so the guard belongs where it
         * cannot be forgotten.
         */
        fun createRoute(reason: String, kind: BanKind = BanKind.Account): String {
            val text = reason.ifBlank {
                if (kind == BanKind.Device) "This device has been blocked."
                else "Your account has been banned."
            }
            return "banned/${kind.arg}/${android.net.Uri.encode(text)}"
        }
        val navArguments = listOf(
            navArgument("kind")   { type = NavType.StringType },
            navArgument("reason") { type = NavType.StringType },
        )
    }

    /**
     * A suspension: shut out of the product, temporarily, with THIS DEVICE LEFT
     * ALONE.
     *
     * Its own destination rather than an argument on [Banned] because what
     * differs is behaviour, not wording — the screen offers a way back to Login
     * so another eligible account can be used on the same phone, which is the
     * one thing a banned person must not be offered.
     *
     * `untilMs` is when it ends, in millis, and 0 means INDEFINITE — the field
     * is absent on the document for a suspension that runs until a reviewer
     * lifts it. The screen says so rather than formatting the epoch.
     */
    object Suspended     : Screen("suspended/{untilMs}/{reason}") {
        /** Blank-safe for the reason given on [Banned.createRoute]. */
        fun createRoute(reason: String, untilMillis: Long): String {
            val text = reason.ifBlank { "Your account has been suspended." }
            return "suspended/$untilMillis/${android.net.Uri.encode(text)}"
        }
        val navArguments = listOf(
            navArgument("untilMs") { type = NavType.LongType   },
            navArgument("reason")  { type = NavType.StringType },
        )
    }
    /** The choice offered on the next sign-in after a deletion request. */
    object RecoverAccount : Screen("recover_account")

    /**
     * A guest attaching a phone number, so the account stops being tied to one
     * handset. Reached from Settings, and offered to nobody else.
     *
     * No arguments: the account it acts on is the one already signed in, and
     * that is the entire point — the number is LINKED to the current uid rather
     * than signed in with. A uid in the route would be a uid somebody could
     * change.
     */
    object SecureAccount : Screen("secure_account")

    /**
     * The same thing by email. Reached from Settings, and from the Android
     * intent that carries the sign-in link back into the app.
     *
     * No arguments, for the reason [SecureAccount] has none and one more: the
     * link itself is a one-time credential in a query string, and a route is a
     * string the nav library keeps in the back stack. It travels through
     * `EmailLinkReturn` instead.
     */
    object SecureEmail : Screen("secure_email")

    object FaceVerification : Screen("face_verification/{gender}") {
        fun createRoute(gender: String) = "face_verification/$gender"
        val navArguments = listOf(navArgument("gender") { type = NavType.StringType })
    }

    /**
     * Redeem an agency referral code on an account that already exists.
     *
     * The code field used to live on the first-run profile setup form and
     * nowhere else, so an agency could invite somebody who already had the app
     * and that person had no way to accept — the code was shown on their profile
     * as a read-only row, and the Go Live screen told them to "apply with an
     * agency referral code" with nowhere to type one.
     *
     * No arguments: the server reads the identity it matches on from the caller's
     * own token and user document, and anything this route carried would be a
     * second, weaker answer to a question already settled server-side.
     */
    object JoinAgency : Screen("join_agency")

    // Main shell
    object Main          : Screen("main")

    // Home tab
    object Home          : Screen("home")
    object UserProfile   : Screen("user_profile/{uid}") {
        fun createRoute(uid: String) = "user_profile/$uid"
    }

    // Live
    object LiveBroadcast : Screen("live_broadcast")
    object LiveViewer    : Screen("live_viewer/{roomId}") {
        fun createRoute(roomId: String) = "live_viewer/$roomId"
    }
    object LiveSummary   : Screen("live_summary/{durationSeconds}/{totalBeans}/{peakViewers}/{gifterCount}") {
        // The host's session earnings are BEANS. This argument was named
        // totalDiamonds and carried beans, which is how the end-of-stream card
        // came to overstate a host's earnings by 20x.
        //
        // `peakViewers` was `totalViewers`, and its only caller passed a literal
        // 0 — there was no cumulative viewer figure anywhere in the app to give
        // it, and the name promised one. It now carries the highest concurrent
        // audience, which the app can actually produce, and the card labels it
        // as that rather than as a night's total.
        //
        // `gifterCount` is new. The card used to count the gifter rows handed to
        // it, and those arrived as an empty list, so every host was told 0.
        fun createRoute(durationSeconds: Long, totalBeans: Long, peakViewers: Int, gifterCount: Int) =
            "live_summary/$durationSeconds/$totalBeans/$peakViewers/$gifterCount"
        val navArguments = listOf(
            navArgument("durationSeconds") { type = NavType.LongType },
            navArgument("totalBeans")      { type = NavType.LongType },
            navArgument("peakViewers")     { type = NavType.IntType  },
            navArgument("gifterCount")     { type = NavType.IntType  },
        )
    }

    // Party
    object PartyList     : Screen("party_list")
    object PartyRoom     : Screen("party_room/{roomId}") {
        fun createRoute(roomId: String) = "party_room/$roomId"
    }

    // Games
    object Games         : Screen("games")

    // Messages
    object Messages      : Screen("messages")
    object Chat          : Screen("chat/{uid}") {
        fun createRoute(uid: String) = "chat/$uid"
    }

    // Profile / Me
    object MyProfile     : Screen("my_profile")
    object OwnProfile    : Screen("own_profile")          // Full ProfileScreen for own profile
    object EditProfile   : Screen("edit_profile")
    object MyBag         : Screen("my_bag")
    object DiamondShop   : Screen("diamond_shop")
    object BeansCenter   : Screen("beans_center")
    object Settings      : Screen("settings")
    object CallHistory   : Screen("call_history")
    object DiamondHistory : Screen("diamond_history")
    object Earnings      : Screen("earnings")
    object BlockedUsers  : Screen("blocked_users")
    object Feedback      : Screen("feedback")

    // Reseller / social / level / daily
    object ResellerList   : Screen("reseller_list")
    object LikesScreen    : Screen("likes_screen/{initialTab}") {
        fun createRoute(initialTab: Int = 0) = "likes_screen/$initialTab"
        val navArguments = listOf(navArgument("initialTab") { type = NavType.IntType; defaultValue = 0 })
    }
    object LevelScreen    : Screen("level_screen")
    object DailyRewards   : Screen("daily_rewards")

    // Gallery viewer
    object GalleryViewer : Screen("gallery_viewer/{uid}/{startIndex}") {
        fun createRoute(uid: String, startIndex: Int = 0) = "gallery_viewer/$uid/$startIndex"
        val navArguments = listOf(
            navArgument("uid")        { type = NavType.StringType },
            navArgument("startIndex") { type = NavType.IntType; defaultValue = 0 },
        )
    }

    // Gift details (sent or received)
    object GiftDetails : Screen("gift_details/{uid}/{type}") {
        fun createRoute(uid: String, type: String) = "gift_details/$uid/$type"
        val navArguments = listOf(
            navArgument("uid")  { type = NavType.StringType },
            navArgument("type") { type = NavType.StringType },
        )
    }

    // Terms
    object Terms          : Screen("terms")
    object PrivacyPolicy  : Screen("privacy_policy")

    // Legal documents fetched from Firestore (CRM-managed policies)
    // docType: "privacy_policy" | "terms_of_service" | "faq"
    object LegalDoc : Screen("legal_doc/{docType}") {
        fun createRoute(docType: String) = "legal_doc/$docType"
        val navArguments = listOf(navArgument("docType") { type = NavType.StringType })
    }

    // Call
    object VideoCall : Screen("video_call/{callId}/{isOutgoing}") {
        fun createRoute(callId: String, isOutgoing: Boolean) =
            "video_call/$callId/$isOutgoing"
        val navArguments = listOf(
            navArgument("callId")     { type = NavType.StringType },
            navArgument("isOutgoing") { type = NavType.BoolType   },
        )
    }
    object IncomingCall : Screen("incoming_call/{callId}") {
        fun createRoute(callId: String) = "incoming_call/$callId"
        val navArguments = listOf(
            navArgument("callId") { type = NavType.StringType }
        )
    }

    // Agency / Seller dashboards
    object AgencyDashboard : Screen("agency_dashboard")
    object SellerDashboard : Screen("seller_dashboard")
    object BuyCoin         : Screen("buy_coin")
}

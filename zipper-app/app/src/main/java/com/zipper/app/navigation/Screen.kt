package com.zipper.app.navigation

import androidx.navigation.NavType
import androidx.navigation.navArgument

sealed class Screen(val route: String) {
    // Auth
    object Splash        : Screen("splash")
    object Login         : Screen("login")
    object OtpVerify     : Screen("otp_verify/{phoneNumber}") {
        fun createRoute(phone: String) = "otp_verify/$phone"
        val navArguments = listOf(navArgument("phoneNumber") { type = NavType.StringType })
    }
    object ProfileSetup  : Screen("profile_setup")
    object FaceVerification : Screen("face_verification/{gender}") {
        fun createRoute(gender: String) = "face_verification/$gender"
        val navArguments = listOf(navArgument("gender") { type = NavType.StringType })
    }

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

    // Terms
    object Terms         : Screen("terms")

    // Call
    object VideoCall     : Screen("video_call/{uid}/{roomId}/{isOutgoing}") {
        fun createRoute(uid: String, roomId: String, isOutgoing: Boolean) =
            "video_call/$uid/$roomId/$isOutgoing"
    }
}

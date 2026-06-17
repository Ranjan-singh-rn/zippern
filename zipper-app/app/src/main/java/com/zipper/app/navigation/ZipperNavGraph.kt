package com.zipper.app.navigation

import androidx.compose.runtime.Composable
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.zipper.app.ui.screens.placeholder.PlaceholderScreen

@Composable
fun ZipperNavGraph(
    navController: NavHostController = rememberNavController(),
) {
    NavHost(
        navController = navController,
        startDestination = Screen.Splash.route,
    ) {
        composable(Screen.Splash.route) {
            PlaceholderScreen("Splash — Auth check coming in Phase 1")
        }
        composable(Screen.Login.route) {
            PlaceholderScreen("Login Screen — Phase 1")
        }
        composable(Screen.Main.route) {
            PlaceholderScreen("Main Shell + Bottom Nav — Phase 2")
        }
        composable(Screen.Home.route) {
            PlaceholderScreen("Home Feed — Phase 2")
        }
        composable(Screen.Games.route) {
            PlaceholderScreen("Games — Phase 9")
        }
        composable(Screen.Messages.route) {
            PlaceholderScreen("Messages — Phase 8")
        }
        composable(Screen.MyProfile.route) {
            PlaceholderScreen("My Profile — Phase 3")
        }
    }
}

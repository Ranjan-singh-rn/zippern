package com.zipper.app.navigation

import androidx.compose.runtime.Composable
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.zipper.app.ui.screens.auth.FaceVerificationScreen
import com.zipper.app.ui.screens.auth.LoginScreen
import com.zipper.app.ui.screens.auth.OtpVerifyScreen
import com.zipper.app.ui.screens.auth.ProfileSetupScreen
import com.zipper.app.ui.screens.auth.SplashScreen
import com.zipper.app.ui.screens.auth.TermsScreen
import com.zipper.app.ui.screens.main.MainScreen

@Composable
fun ZipperNavGraph(
    navController: NavHostController = rememberNavController(),
) {
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
                onNavigateToFaceVerification = {
                    navController.navigate(Screen.FaceVerification.createRoute("unknown")) {
                        popUpTo(Screen.Splash.route) { inclusive = true }
                    }
                },
                onNavigateToMain = {
                    navController.navigate(Screen.Main.route) {
                        popUpTo(Screen.Splash.route) { inclusive = true }
                    }
                },
            )
        }

        composable(Screen.Login.route) {
            LoginScreen(
                onNavigateToOtp = { phone -> navController.navigate(Screen.OtpVerify.createRoute(phone)) },
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
                onNavigateToTerms = { navController.navigate(Screen.Terms.route) },
            )
        }

        composable(Screen.Terms.route) {
            TermsScreen(onBack = { navController.popBackStack() })
        }

        composable(
            route = Screen.OtpVerify.route,
            arguments = Screen.OtpVerify.navArguments,
        ) { backStack ->
            val phone = backStack.arguments?.getString("phoneNumber") ?: ""
            OtpVerifyScreen(
                phoneNumber = phone,
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
                onBack = { navController.popBackStack() },
            )
        }

        composable(Screen.ProfileSetup.route) {
            ProfileSetupScreen(
                onNavigateToFaceVerification = { g ->
                    navController.navigate(Screen.FaceVerification.createRoute(g)) {
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

        composable(Screen.Main.route) {
            MainScreen()
        }
    }
}

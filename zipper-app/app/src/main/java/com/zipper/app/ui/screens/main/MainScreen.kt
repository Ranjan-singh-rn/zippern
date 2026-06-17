package com.zipper.app.ui.screens.main

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Message
import androidx.compose.material.icons.automirrored.outlined.Message
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.LiveTv
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.SportsEsports
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.LiveTv
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.SportsEsports
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.zipper.app.ui.screens.placeholder.PlaceholderScreen
import com.zipper.app.ui.theme.ZipperPink

data class BottomNavItem(
    val label: String,
    val route: String,
    val selectedIcon: ImageVector,
    val unselectedIcon: ImageVector,
)

val bottomNavItems = listOf(
    BottomNavItem("Home",     "tab_home",     Icons.Filled.Home,                      Icons.Outlined.Home),
    BottomNavItem("Live",     "tab_live",     Icons.Filled.LiveTv,                    Icons.Outlined.LiveTv),
    BottomNavItem("Games",    "tab_games",    Icons.Filled.SportsEsports,             Icons.Outlined.SportsEsports),
    BottomNavItem("Messages", "tab_messages", Icons.AutoMirrored.Filled.Message,      Icons.AutoMirrored.Outlined.Message),
    BottomNavItem("Me",       "tab_me",       Icons.Filled.Person,                    Icons.Outlined.Person),
)

@Composable
fun MainScreen() {
    val tabNavController = rememberNavController()
    val backStackEntry by tabNavController.currentBackStackEntryAsState()
    val currentRoute = backStackEntry?.destination?.route

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        bottomBar = {
            NavigationBar(
                containerColor = MaterialTheme.colorScheme.surface,
                contentColor = MaterialTheme.colorScheme.onSurface,
                tonalElevation = 0.dp,
            ) {
                bottomNavItems.forEach { item ->
                    val selected = currentRoute == item.route
                    NavigationBarItem(
                        selected = selected,
                        onClick = {
                            tabNavController.navigate(item.route) {
                                popUpTo(tabNavController.graph.startDestinationId) { saveState = true }
                                launchSingleTop = true
                                restoreState = true
                            }
                        },
                        icon = {
                            Icon(
                                if (selected) item.selectedIcon else item.unselectedIcon,
                                contentDescription = item.label,
                            )
                        },
                        label = { Text(item.label) },
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = ZipperPink,
                            selectedTextColor = ZipperPink,
                            unselectedIconColor = MaterialTheme.colorScheme.onSurface.copy(0.45f),
                            unselectedTextColor = MaterialTheme.colorScheme.onSurface.copy(0.45f),
                            indicatorColor = ZipperPink.copy(0.12f),
                        ),
                    )
                }
            }
        },
    ) { padding ->
        NavHost(
            navController = tabNavController,
            startDestination = "tab_home",
            modifier = Modifier.padding(padding),
        ) {
            composable("tab_home")     { PlaceholderScreen("Home Feed — Phase 2") }
            composable("tab_live")     { PlaceholderScreen("Live — Phase 4") }
            composable("tab_games")    { PlaceholderScreen("Games — Phase 9") }
            composable("tab_messages") { PlaceholderScreen("Messages — Phase 8") }
            composable("tab_me")       { PlaceholderScreen("Me / Profile — Phase 3") }
        }
    }
}

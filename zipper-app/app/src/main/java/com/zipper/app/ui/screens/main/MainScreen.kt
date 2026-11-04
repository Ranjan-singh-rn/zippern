package com.zipper.app.ui.screens.main

import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Message
import androidx.compose.material.icons.automirrored.outlined.Message
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.LiveTv
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.LiveTv
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.material.icons.filled.SportsEsports
import androidx.compose.material.icons.outlined.SportsEsports
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.zipper.app.data.repository.GameRepository
import com.zipper.app.ui.screens.games.GamesHubScreen
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import javax.inject.Inject
import com.zipper.app.ui.screens.home.HomeScreen
import com.zipper.app.ui.screens.live.LiveBrowseScreen
import com.zipper.app.ui.screens.call.CallWatcherViewModel
import com.zipper.app.ui.screens.messages.MessagesScreen
import com.zipper.app.ui.screens.profile.MyProfileScreen
import com.zipper.app.ui.screens.profile.ProfileViewModel
import com.zipper.app.ui.theme.ZipperTheme
import com.zipper.app.ui.theme.Space
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import com.zipper.app.ui.components.HairlineDivider
import com.zipper.app.ui.components.clickableNoRipple

data class BottomNavItem(
    val label: String,
    val route: String,
    val selectedIcon: ImageVector,
    val unselectedIcon: ImageVector,
)

/*
 * The Games tab (B6, 3 Nov 2026) is back with the games — and only when the owner has switched games on in the
 * CRM (`appConfig/games`: the master switch and at least one game). Switched off, the tab does not exist; the
 * `tab_games` route stays registered so a stale deep link cannot crash.
 */
val bottomNavItems = listOf(
    BottomNavItem("Home",     "tab_home",     Icons.Filled.Home,                      Icons.Outlined.Home),
    BottomNavItem("Live",     "tab_live",     Icons.Filled.LiveTv,                    Icons.Outlined.LiveTv),
    BottomNavItem("Messages", "tab_messages", Icons.AutoMirrored.Filled.Message,      Icons.AutoMirrored.Outlined.Message),
    BottomNavItem("Me",       "tab_me",       Icons.Filled.Person,                    Icons.Outlined.Person),
)

val gamesNavItem = BottomNavItem("Games", "tab_games", Icons.Filled.SportsEsports, Icons.Outlined.SportsEsports)

/** The tab list: Games between Live and Messages when games are switched on. */
fun navItemsFor(gamesOn: Boolean): List<BottomNavItem> =
    if (!gamesOn) bottomNavItems else bottomNavItems.take(2) + gamesNavItem + bottomNavItems.drop(2)

@HiltViewModel
class GamesTabViewModel @Inject constructor(repo: GameRepository) : ViewModel() {
    val visible: StateFlow<Boolean> = repo.gamesVisibleFlow().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), false)
}

@Composable
fun MainScreen(
    onNavigateToEditProfile: () -> Unit = {},
    onNavigateToSettings: () -> Unit = {},
    onNavigateToDiamondShop: () -> Unit = {},
    onNavigateToBeansCenter: () -> Unit = {},
    onNavigateToProfile: () -> Unit = {},
    onNavigateToUserProfile: (String) -> Unit = {},
    onNavigateToGoLive: () -> Unit = {},
    onNavigateToWatchLive: (String) -> Unit = {},
    /** Opens one party room — from the Live tab's "Party" page. */
    onNavigateToPartyRoom: (String) -> Unit = {},
    onNavigateToMyBag: () -> Unit = {},
    onNavigateToStore: () -> Unit = {},
    onNavigateToEarnings: () -> Unit = {},
    onNavigateToCallHistory: () -> Unit = {},
    onNavigateToLikes: (Int) -> Unit = {},
    onNavigateToLevel: () -> Unit = {},
    onNavigateToDailyRewards: () -> Unit = {},
    onNavigateToIncomingCall: (String) -> Unit = {},
    onNavigateToChat: (String) -> Unit = {},
    onNavigateToAgencyDashboard: () -> Unit = {},
    onNavigateToSellerDashboard: () -> Unit = {},
    onNavigateToWork: () -> Unit = {},
    onNavigateToFeedback: () -> Unit = {},
    /** The liveness capture, for a host who has not completed it. */
    onNavigateToFaceVerification: (String) -> Unit = {},
    /** "Become a partner" — apply as Host, Agency, Sub-agency or Coin Seller. */
    onNavigateToPartnerHub: () -> Unit = {},
    /** A game from the Games tab: multiplayer games open their lobby, quick games their table. */
    onOpenGame: (gameId: String, multiplayer: Boolean) -> Unit = { _, _ -> },
    /** Rankings (B8): Top hosts and Top supporters, from the trophy on Home. */
    onNavigateToRankings: () -> Unit = {},
    /** B10: the account switcher, from the Me tab. */
    onNavigateToSwitchAccount: () -> Unit = {},
    onLogout: () -> Unit = {},
) {
    val gamesTab: GamesTabViewModel = hiltViewModel()
    val gamesOn by gamesTab.visible.collectAsStateWithLifecycle()
    val tabNavController  = rememberNavController()
    // Incoming calls are watched at the Activity level (MainActivity), so a
    // ring reaches the user on every screen, not only the Main tabs.
    val backStackEntry by tabNavController.currentBackStackEntryAsState()
    val currentRoute = backStackEntry?.destination?.route

    Scaffold(
        containerColor = ZipperTheme.colors.bgBase,
        // Don't let the outer Scaffold consume window insets — each inner screen
        // applies statusBarsPadding() / navigationBarsPadding() itself. Without
        // this, the status-bar inset is counted twice (once here, once in TopAppBar
        // or HomeTopBar) causing the extra gap at the top of Home / Live tabs.
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        bottomBar = {
            ZipperBottomNav(currentRoute, navItemsFor(gamesOn)) { route ->
                tabNavController.navigate(route) {
                    // inclusive = true: always pop everything so tab nav has only
                    // ONE entry at a time. This prevents the inner NavController's
                    // BackHandler from consuming system back presses while the user
                    // is on a screen above MainScreen (OwnProfile, GalleryViewer, etc.)
                    popUpTo(tabNavController.graph.startDestinationId) {
                        inclusive = true
                        saveState = true
                    }
                    launchSingleTop = true
                    restoreState = true
                }
            }
        },
    ) { padding ->
        NavHost(
            navController = tabNavController,
            startDestination = "tab_home",
            modifier = Modifier.padding(padding),
            // O10: switching tabs is instant (the default was a 700 ms cross-fade of both tabs).
            enterTransition = { androidx.compose.animation.EnterTransition.None },
            exitTransition = { androidx.compose.animation.ExitTransition.None },
            popEnterTransition = { androidx.compose.animation.EnterTransition.None },
            popExitTransition = { androidx.compose.animation.ExitTransition.None },
        ) {
            composable("tab_home") {
                HomeScreen(
                    onNavigateToProfile     = onNavigateToUserProfile,
                    onWatchLive             = onNavigateToWatchLive,
                    onNavigateToDiamondShop = onNavigateToDiamondShop,
                    onNavigateToRankings    = onNavigateToRankings,
                )
            }
            // Two top tabs: Live (streams + Go Live) and Party (party rooms + Start Party).
            composable("tab_live") {
                val profileVm: ProfileViewModel = hiltViewModel()
                val profileState by profileVm.state.collectAsStateWithLifecycle()
                LiveBrowseScreen(
                    currentUser       = profileState.user,
                    onWatchLive       = onNavigateToWatchLive,
                    onGoLive          = onNavigateToGoLive,
                    onOpenPartyRoom   = onNavigateToPartyRoom,
                    onBecomeHost      = onNavigateToPartnerHub,
                    onVerifyFace      = onNavigateToFaceVerification,
                )
            }
            composable("tab_games") {
                GamesHubScreen(onOpenGame = onOpenGame, onRecharge = onNavigateToDiamondShop)
            }
            composable("tab_messages") {
                MessagesScreen(
                    onNavigateToChat = { otherUid, _ -> onNavigateToChat(otherUid) },
                    onNavigateToFeedback = onNavigateToFeedback,
                )
            }
            composable("tab_me") {
                MyProfileScreen(
                    onNavigateToProfile             = onNavigateToProfile,
                    onNavigateToEditProfile         = onNavigateToEditProfile,
                    onNavigateToSettings            = onNavigateToSettings,
                    onNavigateToDiamondShop         = onNavigateToDiamondShop,
                    onNavigateToBeansCenter         = onNavigateToBeansCenter,
                    onNavigateToMyBag               = onNavigateToMyBag,
                    onNavigateToStore               = onNavigateToStore,
                    onNavigateToEarnings            = onNavigateToEarnings,
                    onNavigateToCallHistory         = onNavigateToCallHistory,
                    onNavigateToLikes               = onNavigateToLikes,
                    onNavigateToLevel               = onNavigateToLevel,
                    onNavigateToDailyRewards        = onNavigateToDailyRewards,
                    onNavigateToAgencyDashboard     = onNavigateToAgencyDashboard,
                    onNavigateToSellerDashboard     = onNavigateToSellerDashboard,
                    onNavigateToWork                = onNavigateToWork,
                    onNavigateToFeedback            = onNavigateToFeedback,
                    onNavigateToFaceVerification    = onNavigateToFaceVerification,
                    onNavigateToPartnerHub          = onNavigateToPartnerHub,
                    onNavigateToSwitchAccount       = onNavigateToSwitchAccount,
                    onLogout                        = onLogout,
                )
            }
        }
    }
}

/*
 * Bottom nav — Figma "02 Main shell" (42:29). 64dp on bg/raised with a
 * hairline top border. Each item: a 56×28 indicator pill (brand tint when
 * selected) holding a 24 icon, then an 11sp Medium label 2dp below —
 * rose/400 when selected, ink/500 otherwise.
 */
@Composable
fun ZipperBottomNav(currentRoute: String?, items: List<BottomNavItem> = bottomNavItems, onSelect: (String) -> Unit) {
    val c = ZipperTheme.colors
    Column(Modifier.fillMaxWidth().background(c.bgRaised)) {
        HairlineDivider()
        Row(
            Modifier.fillMaxWidth().height(64.dp).padding(horizontal = Space.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            items.forEach { item ->
                val selected = currentRoute == item.route
                Column(
                    Modifier.weight(1f).fillMaxHeight().clickableNoRipple { onSelect(item.route) },
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Box(
                        Modifier.size(56.dp, 28.dp)
                            .background(if (selected) c.tintBrandSubtle else Color.Transparent, CircleShape),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            if (selected) item.selectedIcon else item.unselectedIcon,
                            contentDescription = item.label,
                            tint = if (selected) c.brandPrimary else c.textMuted,
                            modifier = Modifier.size(24.dp),
                        )
                    }
                    Spacer(Modifier.height(2.dp))
                    Text(
                        item.label,
                        style = ZipperTheme.type.caption,
                        color = if (selected) c.textBrand else c.textMuted,
                    )
                }
            }
        }
        Spacer(Modifier.navigationBarsPadding())
    }
}

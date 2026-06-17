package com.zipper.datingapp.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.zipper.datingapp.R
import com.zipper.datingapp.ui.theme.AppSurface
import com.zipper.datingapp.ui.theme.BrandPink
import com.zipper.datingapp.ui.theme.BrandPurple
import com.zipper.datingapp.ui.theme.OutlineDefault
import com.zipper.datingapp.ui.theme.TextMuted
import com.zipper.datingapp.ui.theme.TextSecondary

@Composable
fun MainBottomNavigation(
    selectedTab: Int,
    onTabSelected: (Int) -> Unit,
    unreadCount: Int
) {
    val topBorderColor = OutlineDefault
    NavigationBar(
        containerColor = AppSurface,
        tonalElevation = 0.dp,
        modifier = Modifier.drawBehind {
            drawLine(
                color = topBorderColor,
                start = Offset(0f, 0f),
                end = Offset(size.width, 0f),
                strokeWidth = 1.dp.toPx()
            )
        }
    ) {
        val items = listOf(
            NavTab(R.string.nav_home,    Icons.Default.Home,                    0),
            NavTab(R.string.nav_live,    Icons.Default.Podcasts,                1),
            NavTab(R.string.nav_chats,   Icons.AutoMirrored.Filled.Chat,        2),
            NavTab(R.string.nav_games,   Icons.Default.SportsEsports,            3),
            NavTab(R.string.nav_settings,Icons.Default.Settings,                4),
        )

        items.forEach { item ->
            val label = stringResource(item.labelRes)
            val isSelected = selectedTab == item.index
            val isLive = item.index == 1

            NavigationBarItem(
                modifier = Modifier.defaultMinSize(minWidth = 48.dp, minHeight = 56.dp),
                selected = isSelected,
                onClick = { onTabSelected(item.index) },
                icon = {
                    BadgedBox(
                        badge = {
                            if (item.index == 2 && unreadCount > 0) {
                                Badge(
                                    containerColor = BrandPink,
                                    contentColor = Color.White,
                                ) { Text(unreadCount.toString()) }
                            }
                        }
                    ) {
                        if (isLive) {
                            // Gradient circle for the Live broadcast tab
                            Box(
                                modifier = Modifier
                                    .size(if (isSelected) 44.dp else 40.dp)
                                    .background(
                                        brush = Brush.linearGradient(
                                            colors = listOf(BrandPink, BrandPurple)
                                        ),
                                        shape = CircleShape
                                    ),
                                contentAlignment = Alignment.Center
                            ) {
                                Icon(
                                    imageVector = item.icon,
                                    contentDescription = label,
                                    tint = Color.White,
                                    modifier = Modifier.size(20.dp)
                                )
                            }
                        } else {
                            Icon(item.icon, contentDescription = label)
                        }
                    }
                },
                // Show label only for the selected item
                label = if (isSelected) {
                    { Text(label, style = MaterialTheme.typography.labelSmall) }
                } else null,
                alwaysShowLabel = false,
                colors = NavigationBarItemDefaults.colors(
                    selectedIconColor   = BrandPink,
                    selectedTextColor   = BrandPink,
                    unselectedIconColor = TextSecondary,
                    unselectedTextColor = TextMuted,
                    indicatorColor      = BrandPink.copy(alpha = 0.12f),
                )
            )
        }
    }
}

/**
 * Side navigation rail shown on Medium and Expanded width classes.
 * Uses the same tab model as [MainBottomNavigation] with identical
 * brand styling: gradient Live button, BrandPink selected state.
 */
@Composable
fun MainNavigationRail(
    selectedTab: Int,
    onTabSelected: (Int) -> Unit,
    unreadCount: Int,
) {
    val rightBorderColor = OutlineDefault
    NavigationRail(
        modifier = Modifier
            .fillMaxHeight()
            .width(80.dp)
            .drawBehind {
                drawLine(
                    color = rightBorderColor,
                    start = Offset(size.width, 0f),
                    end = Offset(size.width, size.height),
                    strokeWidth = 1.dp.toPx(),
                )
            },
        containerColor = AppSurface,
        contentColor = MaterialTheme.colorScheme.onSurface,
        header = {
            Spacer(Modifier.height(16.dp))
        },
    ) {
        val items = listOf(
            NavTab(R.string.nav_home,     Icons.Default.Home,                 0),
            NavTab(R.string.nav_live,     Icons.Default.Podcasts,             1),
            NavTab(R.string.nav_chats,    Icons.AutoMirrored.Filled.Chat,     2),
            NavTab(R.string.nav_games,    Icons.Default.SportsEsports,        3),
            NavTab(R.string.nav_settings, Icons.Default.Settings,             4),
        )

        items.forEach { item ->
            val label = stringResource(item.labelRes)
            val isSelected = selectedTab == item.index
            val isLive = item.index == 1

            Spacer(Modifier.height(4.dp))

            NavigationRailItem(
                selected = isSelected,
                onClick = { onTabSelected(item.index) },
                icon = {
                    BadgedBox(
                        badge = {
                            if (item.index == 2 && unreadCount > 0) {
                                Badge(
                                    containerColor = BrandPink,
                                    contentColor = Color.White,
                                ) { Text(unreadCount.toString()) }
                            }
                        }
                    ) {
                        if (isLive) {
                            Box(
                                modifier = Modifier
                                    .size(if (isSelected) 40.dp else 36.dp)
                                    .background(
                                        brush = Brush.linearGradient(
                                            colors = listOf(BrandPink, BrandPurple)
                                        ),
                                        shape = CircleShape,
                                    ),
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(
                                    imageVector = item.icon,
                                    contentDescription = label,
                                    tint = Color.White,
                                    modifier = Modifier.size(18.dp),
                                )
                            }
                        } else {
                            Icon(item.icon, contentDescription = label)
                        }
                    }
                },
                label = {
                    Text(
                        label,
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Normal,
                        modifier = Modifier.padding(top = 2.dp),
                    )
                },
                alwaysShowLabel = false,
                colors = NavigationRailItemDefaults.colors(
                    selectedIconColor   = BrandPink,
                    selectedTextColor   = BrandPink,
                    unselectedIconColor = TextSecondary,
                    unselectedTextColor = TextMuted,
                    indicatorColor      = BrandPink.copy(alpha = 0.12f),
                ),
            )
        }
    }
}

private data class NavTab(val labelRes: Int, val icon: ImageVector, val index: Int)

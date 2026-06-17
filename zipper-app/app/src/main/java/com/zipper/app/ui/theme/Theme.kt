package com.zipper.app.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

private val DarkColorScheme = darkColorScheme(
    primary          = ZipperPink,
    secondary        = ZipperPurple,
    tertiary         = ZipperGold,
    background       = DarkBackground,
    surface          = DarkSurface,
    surfaceVariant   = DarkSurfaceVar,
    onPrimary        = Color.White,
    onSecondary      = Color.White,
    onTertiary       = Color.Black,
    onBackground     = TextOnDark,
    onSurface        = TextOnDark,
    onSurfaceVariant = TextSecondaryDark,
    error            = ZipperError,
    onError          = Color.White,
)

private val LightColorScheme = lightColorScheme(
    primary          = ZipperPink,
    secondary        = ZipperPurple,
    tertiary         = ZipperGold,
    background       = LightBackground,
    surface          = LightSurface,
    surfaceVariant   = LightCard,
    onPrimary        = Color.White,
    onSecondary      = Color.White,
    onTertiary       = Color.Black,
    onBackground     = TextOnLight,
    onSurface        = TextOnLight,
    onSurfaceVariant = TextSecondaryLight,
    error            = ZipperError,
    onError          = Color.White,
)

@Composable
fun ZipperTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colorScheme = if (darkTheme) DarkColorScheme else LightColorScheme
    val view = LocalView.current

    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as? android.app.Activity)?.window ?: return@SideEffect
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !darkTheme
                isAppearanceLightNavigationBars = !darkTheme
            }
        }
    }

    MaterialTheme(
        colorScheme = colorScheme,
        typography  = ZipperTypography,
        content     = content,
    )
}

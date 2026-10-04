package com.zipper.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

/**
 * The app's theme. Screens reach tokens through [ZipperTheme.colors],
 * [ZipperTheme.type] and the [Space] / [Radius] / [Size] objects.
 *
 * Material's `colorScheme` is populated too, so Material components (text
 * fields, switches, sheets) pick up the palette without every call site
 * restyling them — but a screen should prefer the semantic tokens, which say
 * what a colour is FOR rather than which Material slot happened to hold it.
 *
 * Dark is the ONLY mode the app resolves to. The designs were drawn dark-first:
 * this is an app used at night, in a live room, on a phone whose screen is the
 * only light. The long note further down, above the `ZipperTheme` composable,
 * explains why the system setting is ignored rather than honoured.
 */
object ZipperTheme {
    val colors: ZipperColors
        @Composable @ReadOnlyComposable get() = LocalZipperColors.current

    val type: ZipperTypeScale
        @Composable @ReadOnlyComposable get() = LocalZipperType.current
}

private fun ZipperColors.toMaterial() = if (isDark) {
    darkColorScheme(
        primary = brandPrimary, onPrimary = textOnBrand,
        primaryContainer = tintBrandMedium, onPrimaryContainer = textPrimary,
        secondary = brandSecondary, onSecondary = textOnBrand,
        secondaryContainer = tintVioletSubtle, onSecondaryContainer = textPrimary,
        tertiary = brandVip, onTertiary = Ink.i950,
        background = bgBase, onBackground = textPrimary,
        surface = bgRaised, onSurface = textPrimary,
        surfaceVariant = bgElevated, onSurfaceVariant = textSecondary,
        surfaceContainer = bgRaised, surfaceContainerHigh = bgElevated,
        surfaceContainerHighest = bgElevated, surfaceContainerLow = bgBase,
        outline = borderDefault, outlineVariant = borderSubtle,
        error = statusDanger, onError = textOnBrand,
        errorContainer = tintDangerSubtle, onErrorContainer = textPrimary,
        scrim = bgScrim,
    )
} else {
    lightColorScheme(
        primary = brandPrimary, onPrimary = textOnBrand,
        primaryContainer = tintBrandMedium, onPrimaryContainer = textPrimary,
        secondary = brandSecondary, onSecondary = textOnBrand,
        secondaryContainer = tintVioletSubtle, onSecondaryContainer = textPrimary,
        tertiary = brandVip, onTertiary = Ink.i0,
        background = bgBase, onBackground = textPrimary,
        surface = bgRaised, onSurface = textPrimary,
        surfaceVariant = bgSunken, onSurfaceVariant = textSecondary,
        surfaceContainer = bgRaised, surfaceContainerHigh = bgElevated,
        surfaceContainerHighest = bgSunken, surfaceContainerLow = bgBase,
        outline = borderDefault, outlineVariant = borderSubtle,
        error = statusDanger, onError = textOnBrand,
        errorContainer = tintDangerSubtle, onErrorContainer = textPrimary,
        scrim = bgScrim,
    )
}

/*
 * ── Why this app is dark on every device, whatever the system says ────────────
 *
 * A phone set to light mode used to resolve [LightZipperColors], and the result
 * was not a light version of Zipper — it was a broken one.
 *
 * The palette is not the problem: every one of the 42 colour roles in
 * [ZipperColors] has a deliberate light value. The problem is the 43 screens
 * sitting on top of it, which were drawn dark-first and still carry roughly 300
 * hardcoded `Color.White` / `Color.Black` / `Color(0xFF…)` literals. A literal
 * does not move when the palette moves, so on a light background it collapses
 * into it.
 *
 * The clearest casualty, and the one users actually reported, was the login
 * screen. "Continue with Google" and "Continue as Guest" are
 * `ButtonStyle.Secondary`: fill = `bgElevated`, which is `Ink.i0` — pure white —
 * in the light palette. `ZipperButton` then paints every label with
 * `textOnBrand`, which is `Ink.i0` in BOTH palettes. White text on a white
 * button, behind a border that fades to nothing because the two buttons are also
 * drawn at 0.4 alpha until the terms box is ticked. The controls were not
 * mis-styled, they were invisible, and a new user on a light-mode phone had no
 * way to sign in at all.
 *
 * So the theme ignores both the system setting and the stored per-user
 * preference, and always resolves [DarkZipperColors]. This is not a placeholder
 * for "light is coming later": dark-only is what this category is (Chamet,
 * HiClub and the rest ship no light mode) and it is what the Figma file is. A
 * light-mode phone now gets a coherent dark app instead of an unusable light one.
 *
 * Three things have to move TOGETHER if light mode is ever built:
 *   1. the `darkTheme` argument below starts being honoured again,
 *   2. `Theme.Zipper` in res/values/themes.xml goes back to a DayNight parent, and
 *   3. the system-bar block in the SideEffect below stops pinning dark.
 * Changing one without the others is the original bug in a new shape: a DayNight
 * window theme under a hardcoded-dark Compose tree paints a white window, white
 * dialog backgrounds and a white flash on every cold start; pinned dark bars
 * under a light UI hide the clock and the navigation buttons.
 *
 * Still outstanding, and deliberately out of this change:
 *   • `ZipperButton` in ui/components/Buttons.kt hardcodes `content =
 *     c.textOnBrand` for all four styles. That is only correct for Primary and
 *     Danger, whose fills ARE brand-coloured. Secondary and Ghost need a colour
 *     derived from the surface they sit on. Dormant while the app is dark;
 *     it is the first thing to fix if light mode is revived.
 *   • Settings › Appearance › Theme still shows a Light / Dark / System pill
 *     (SettingsScreen.kt) wired to `users/{uid}.theme`. Nothing reads that field
 *     any more, so the pill is inert and should be hidden or removed.
 */
@Composable
fun ZipperTheme(
    // Accepted and deliberately IGNORED. Kept in the signature so MainActivity's
    // call site — which still computes the user's light/dark/system choice — does
    // not have to change, and so reviving light mode is one edit here rather than
    // a hunt through call sites.
    @Suppress("UNUSED_PARAMETER") darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colors = DarkZipperColors
    val view = LocalView.current

    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as? android.app.Activity)?.window ?: return@SideEffect

            /*
             * The system bars, and the third place the device's light mode leaks in.
             *
             * MainActivity calls `enableEdgeToEdge()` with no arguments. Its default
             * navigation-bar style is `SystemBarStyle.auto(lightScrim, darkScrim)`,
             * and "auto" resolves by reading `resources.configuration.uiMode` — the
             * DEVICE's night setting, which no app theme can change. On a phone set
             * to light mode it therefore picks the light scrim — white at 90% alpha
             * in androidx.activity — and paints the navigation bar with it.
             *
             * That was survivable while the app followed the system too. It is not
             * survivable now: a near-white navigation bar under a near-black app,
             * carrying the light-coloured icons set below, means the back and home
             * buttons are white on white on any handset still using three-button
             * navigation. Exactly the class of bug this whole change is fixing.
             *
             * So both bars are pinned transparent here, after enableEdgeToEdge has
             * had its say, and the app's own `bgBase` shows through. The Compose
             * screens already reserve that space with `navigationBarsPadding()` /
             * `statusBarsPadding()`, so nothing is hidden underneath.
             */
            window.statusBarColor = android.graphics.Color.TRANSPARENT
            window.navigationBarColor = android.graphics.Color.TRANSPARENT

            // With a transparent bar the framework will add its own translucent
            // scrim unless told not to, which shows up as a faintly lighter band
            // across the bottom of an otherwise flat ink/950 screen. The app does
            // not need the contrast help — everything behind the bar is already
            // the darkest colour in the palette. API 29+; below that the property
            // does not exist and enableEdgeToEdge leaves both bars transparent
            // anyway, so there is nothing to undo.
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                window.isStatusBarContrastEnforced = false
                window.isNavigationBarContrastEnforced = false
            }

            WindowCompat.getInsetsController(window, view).apply {
                // Hardcoded false rather than derived from the device's mode.
                // "Light appearance" means DARK icons, for use on a LIGHT bar — so
                // on a light-mode phone the old `!darkTheme` would now paint a dark
                // grey clock, battery and gesture pill onto a bar that is
                // transparent over Ink.i950. They would vanish.
                isAppearanceLightStatusBars = false
                isAppearanceLightNavigationBars = false
            }
        }
    }

    CompositionLocalProvider(
        LocalZipperColors provides colors,
        LocalZipperType provides ZipperType,
    ) {
        MaterialTheme(
            colorScheme = colors.toMaterial(),
            typography  = ZipperTypography,
            shapes      = ZipperShapes,
            content     = content,
        )
    }
}

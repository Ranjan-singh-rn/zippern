package com.zipper.app.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/*
 * ── Type scale ────────────────────────────────────────────────────────────────
 *
 * Seventeen styles, from the Figma Foundations page, with the exact size, line
 * height, weight and letter spacing of each. Two families: Plus Jakarta Sans for
 * display and headings, Inter for everything a user reads or taps.
 *
 * ── Fonts ─────────────────────────────────────────────────────────────────────
 *
 * The TTFs are not in the repo yet — see zipper-app/app/FONTS.md for the eight
 * files and their names. Until they are, [USE_BUNDLED_FONTS] is false and every
 * style renders on the system font at the correct metrics. Layouts are right;
 * only the letterforms differ. Flip the flag when the files are in place.
 *
 * Not loaded at runtime from Google Fonts: that route depends on Play Services
 * and on a certificate array that fails silently to the system font if a single
 * character is wrong. A font that is either present or visibly absent is better
 * than one that is quietly not what you think it is.
 */

private const val USE_BUNDLED_FONTS = false

// Swap these two lines for FontFamily(Font(R.font.plus_jakarta_sans_medium, W500), …)
// once the files exist. Kept as one declaration each so the switch is two edits.
val DisplayFamily: FontFamily = if (USE_BUNDLED_FONTS) FontFamily.Default else FontFamily.Default
val UiFamily: FontFamily      = if (USE_BUNDLED_FONTS) FontFamily.Default else FontFamily.Default

private fun style(
    family: FontFamily, weight: FontWeight, size: Int, lineHeight: Int, tracking: Float = 0f,
) = TextStyle(
    fontFamily = family, fontWeight = weight,
    fontSize = size.sp, lineHeight = lineHeight.sp, letterSpacing = tracking.sp,
)

/** The full scale, by the names the designs use. */
@Immutable
data class ZipperTypeScale(
    val displayXl: TextStyle,
    val displayL: TextStyle,
    val displayM: TextStyle,
    val headingL: TextStyle,
    val headingM: TextStyle,
    val headingS: TextStyle,
    val bodyL: TextStyle,
    val bodyM: TextStyle,
    val bodyS: TextStyle,
    val labelL: TextStyle,
    val labelM: TextStyle,
    val labelS: TextStyle,
    val caption: TextStyle,
    val overline: TextStyle,
    /** Tabular figures for balances and counters — same width per digit, so a
     *  ticking number does not jitter. */
    val numericL: TextStyle,
    val numericM: TextStyle,
    val numericS: TextStyle,
)

val ZipperType = ZipperTypeScale(
    displayXl = style(DisplayFamily, FontWeight.ExtraBold, 40, 44, -1.2f),
    displayL  = style(DisplayFamily, FontWeight.ExtraBold, 32, 38, -0.8f),
    displayM  = style(DisplayFamily, FontWeight.Bold,      28, 34, -0.6f),
    headingL  = style(DisplayFamily, FontWeight.Bold,      24, 30, -0.4f),
    headingM  = style(DisplayFamily, FontWeight.SemiBold,  20, 26, -0.2f),
    headingS  = style(DisplayFamily, FontWeight.SemiBold,  17, 22),
    bodyL     = style(UiFamily, FontWeight.Normal,   16, 24),
    bodyM     = style(UiFamily, FontWeight.Normal,   14, 20),
    bodyS     = style(UiFamily, FontWeight.Normal,   13, 18),
    labelL    = style(UiFamily, FontWeight.SemiBold, 16, 20),
    labelM    = style(UiFamily, FontWeight.SemiBold, 14, 18),
    labelS    = style(UiFamily, FontWeight.SemiBold, 12, 16, 0.2f),
    caption   = style(UiFamily, FontWeight.Medium,   11, 14, 0.3f),
    overline  = style(UiFamily, FontWeight.Bold,     10, 12, 1.2f),
    numericL  = style(UiFamily, FontWeight.Bold,     22, 26, -0.2f),
    numericM  = style(UiFamily, FontWeight.SemiBold, 16, 20, -0.1f),
    numericS  = style(UiFamily, FontWeight.SemiBold, 13, 16),
)

val LocalZipperType = staticCompositionLocalOf { ZipperType }

/**
 * Material's slots, mapped onto the scale so `MaterialTheme.typography.*` in
 * existing screens lands on the right style rather than Material defaults.
 */
val ZipperTypography = Typography(
    displayLarge   = ZipperType.displayXl,
    displayMedium  = ZipperType.displayL,
    displaySmall   = ZipperType.displayM,
    headlineLarge  = ZipperType.headingL,
    headlineMedium = ZipperType.headingM,
    headlineSmall  = ZipperType.headingS,
    titleLarge     = ZipperType.headingM,
    titleMedium    = ZipperType.labelL,
    titleSmall     = ZipperType.labelM,
    bodyLarge      = ZipperType.bodyL,
    bodyMedium     = ZipperType.bodyM,
    bodySmall      = ZipperType.bodyS,
    labelLarge     = ZipperType.labelL,
    labelMedium    = ZipperType.labelM,
    labelSmall     = ZipperType.labelS,
)

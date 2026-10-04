package com.zipper.app.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/*
 * ── Design tokens ─────────────────────────────────────────────────────────────
 *
 * Generated from the Figma file's variable collections (Foundations page).
 * Primitives first — the raw palette — then semantic roles that pick from them
 * per mode. Screens use the SEMANTIC names through [ZipperTheme.colors]; the
 * primitives exist so a one-off accent can be reached without inventing a hex.
 *
 * If you need a colour that is not here, add it to Figma first, then here.
 * A hex literal in a screen file is a colour the designer never chose.
 */

// ── Primitives ────────────────────────────────────────────────────────────────

object Ink {
    val i0   = Color(0xFFFFFFFF)
    val i50  = Color(0xFFF5F6FA)
    val i100 = Color(0xFFE4E6F0)
    val i200 = Color(0xFFC3C7DA)
    val i300 = Color(0xFF9AA0BC)
    val i400 = Color(0xFF6E7596)
    val i500 = Color(0xFF4A5075)
    val i600 = Color(0xFF333858)
    val i700 = Color(0xFF23263F)
    val i800 = Color(0xFF171930)
    val i900 = Color(0xFF0E0F21)
    val i950 = Color(0xFF070812)
}

object Rose {
    val r200 = Color(0xFFFFC9DE)
    val r300 = Color(0xFFFF9EC4)
    val r400 = Color(0xFFFF6FA8)
    val r500 = Color(0xFFFF3D8B)
    val r600 = Color(0xFFE81E6E)
    val r700 = Color(0xFFC00E56)
}

object Violet {
    val v200 = Color(0xFFDCCCFF)
    val v300 = Color(0xFFC4A8FF)
    val v400 = Color(0xFFA47CFF)
    val v500 = Color(0xFF8B5CF6)
    val v600 = Color(0xFF7038E8)
    val v700 = Color(0xFF5A25C4)
}

object Gold {
    val g200 = Color(0xFFFFEDBF)
    val g300 = Color(0xFFFFE08A)
    val g400 = Color(0xFFFFD05C)
    val g500 = Color(0xFFFFB627)
    val g600 = Color(0xFFE89806)
    val g700 = Color(0xFFB87503)
}

object Aqua {
    val a300 = Color(0xFFA6F0F3)
    val a400 = Color(0xFF5CE1E6)
    val a500 = Color(0xFF22C8D6)
    val a600 = Color(0xFF0FA3B1)
}

object Mint {
    val m300 = Color(0xFFA8F0CE)
    val m400 = Color(0xFF5CE6A8)
    val m500 = Color(0xFF16C77E)
    val m600 = Color(0xFF0EA366)
}

object Coral {
    val c300 = Color(0xFFFFB3BA)
    val c400 = Color(0xFFFF7A88)
    val c500 = Color(0xFFFF4D5E)
    val c600 = Color(0xFFE82D42)
}

object Amber {
    val a400 = Color(0xFFFFC166)
    val a500 = Color(0xFFFFA726)
    val a600 = Color(0xFFE88A00)
}

// ── Semantic roles ────────────────────────────────────────────────────────────

/**
 * Every colour a screen is allowed to use, by role. One instance per mode.
 *
 * `bg` is the surface stack: base is the screen, raised is a card on it,
 * elevated is a sheet or dialog above that. Text and border have three
 * strengths each. Currency colours are fixed per currency so a diamond is the
 * same aqua on every screen — the user learns the colour, not the label.
 */
@Immutable
data class ZipperColors(
    val bgBase: Color,
    val bgRaised: Color,
    val bgElevated: Color,
    val bgSunken: Color,
    val bgInverse: Color,
    val bgScrim: Color,

    val textPrimary: Color,
    val textSecondary: Color,
    val textMuted: Color,
    val textInverse: Color,
    val textBrand: Color,
    val textOnBrand: Color,

    val borderSubtle: Color,
    val borderDefault: Color,
    val borderStrong: Color,

    val brandPrimary: Color,
    val brandPrimaryPressed: Color,
    val brandSecondary: Color,
    val brandGradientFrom: Color,
    val brandGradientTo: Color,
    val brandVip: Color,

    val currencyDiamond: Color,
    val currencyBean: Color,
    val currencyCoin: Color,

    val statusLive: Color,
    val statusOnline: Color,
    val statusSuccess: Color,
    val statusWarning: Color,
    val statusDanger: Color,

    // Tints: brand colours at low alpha, for chips, highlights and hover states.
    val tintBrandSubtle: Color,
    val tintBrandMedium: Color,
    val tintVioletSubtle: Color,
    val tintGoldSubtle: Color,
    val tintDangerSubtle: Color,
    val tintSuccessSubtle: Color,
    val tintDiamondSubtle: Color,

    // Glass: white (dark mode) or ink (light mode) at low alpha, for overlays
    // on video — the live room, the call screen, the PIP.
    val glassLow: Color,
    val glassMid: Color,
    val glassHigh: Color,

    // Scrims, for gradients over media so text stays legible on any frame.
    val scrimSoft: Color,
    val scrimMedium: Color,
    val scrimStrong: Color,

    val isDark: Boolean,
)

val DarkZipperColors = ZipperColors(
    bgBase = Ink.i950, bgRaised = Ink.i900, bgElevated = Ink.i800, bgSunken = Ink.i900,
    bgInverse = Ink.i50, bgScrim = Ink.i950,
    textPrimary = Ink.i0, textSecondary = Ink.i300, textMuted = Ink.i400,
    textInverse = Ink.i900, textBrand = Rose.r400, textOnBrand = Ink.i0,
    borderSubtle = Ink.i800, borderDefault = Ink.i700, borderStrong = Ink.i600,
    brandPrimary = Rose.r500, brandPrimaryPressed = Rose.r600, brandSecondary = Violet.v500,
    brandGradientFrom = Rose.r500, brandGradientTo = Violet.v500, brandVip = Gold.g500,
    currencyDiamond = Aqua.a400, currencyBean = Mint.m400, currencyCoin = Gold.g500,
    statusLive = Coral.c500, statusOnline = Mint.m500, statusSuccess = Mint.m500,
    statusWarning = Amber.a500, statusDanger = Coral.c500,
    tintBrandSubtle = Color(0x1FFF3D8B), tintBrandMedium = Color(0x3DFF3D8B),
    tintVioletSubtle = Color(0x248B5CF6), tintGoldSubtle = Color(0x24FFB627),
    tintDangerSubtle = Color(0x24FF4D5E), tintSuccessSubtle = Color(0x2416C77E),
    tintDiamondSubtle = Color(0x245CE1E6),
    glassLow = Color(0x0FFFFFFF), glassMid = Color(0x1AFFFFFF), glassHigh = Color(0x29FFFFFF),
    scrimSoft = Color(0x66070812), scrimMedium = Color(0x99070812), scrimStrong = Color(0xD1070812),
    isDark = true,
)

/*
 * NOT CURRENTLY USED. `ZipperTheme` resolves [DarkZipperColors] on every device —
 * the long note above the composable in Theme.kt says why. This palette is kept,
 * complete and correct, because the work light mode needs is in the SCREENS (some
 * 300 hardcoded colour literals that ignore whatever is in here), not in the
 * palette. Deleting it would throw away the only part of light mode that is
 * already finished.
 *
 * Two roles below are knowingly identical to their dark counterparts and are the
 * ones to revisit first: `textOnBrand` (white on both, which is what made the
 * login screen's Secondary buttons white-on-white) and `textMuted` (Ink.i400 on
 * both, which lands at roughly 4.5:1 either way — passable, never comfortable).
 */
val LightZipperColors = ZipperColors(
    bgBase = Ink.i50, bgRaised = Ink.i0, bgElevated = Ink.i0, bgSunken = Ink.i100,
    bgInverse = Ink.i900, bgScrim = Ink.i950,
    textPrimary = Ink.i900, textSecondary = Ink.i500, textMuted = Ink.i400,
    textInverse = Ink.i0, textBrand = Rose.r600, textOnBrand = Ink.i0,
    borderSubtle = Ink.i100, borderDefault = Ink.i200, borderStrong = Ink.i300,
    brandPrimary = Rose.r500, brandPrimaryPressed = Rose.r600, brandSecondary = Violet.v500,
    brandGradientFrom = Rose.r500, brandGradientTo = Violet.v500, brandVip = Gold.g600,
    currencyDiamond = Aqua.a500, currencyBean = Mint.m500, currencyCoin = Gold.g600,
    statusLive = Coral.c500, statusOnline = Mint.m500, statusSuccess = Mint.m600,
    statusWarning = Amber.a600, statusDanger = Coral.c600,
    tintBrandSubtle = Color(0x14FF3D8B), tintBrandMedium = Color(0x29FF3D8B),
    tintVioletSubtle = Color(0x1A8B5CF6), tintGoldSubtle = Color(0x1FFFB627),
    tintDangerSubtle = Color(0x1AFF4D5E), tintSuccessSubtle = Color(0x1A16C77E),
    tintDiamondSubtle = Color(0x1A5CE1E6),
    glassLow = Color(0x0A0E0F21), glassMid = Color(0x0F0E0F21), glassHigh = Color(0x1A0E0F21),
    scrimSoft = Color(0x4D070812), scrimMedium = Color(0x73070812), scrimStrong = Color(0xB2070812),
    isDark = false,
)

val LocalZipperColors = staticCompositionLocalOf { DarkZipperColors }

// ── Legacy aliases ────────────────────────────────────────────────────────────
//
// The 43 screens written before the design system referenced these names.
// They now point at the closest token so those screens keep compiling and pick
// up the new palette. Each screen is migrated to `ZipperTheme.colors.*` as it
// is rebuilt from Figma; when the last one goes, so do these.

val ZipperPink          = Rose.r500
val ZipperPurple        = Violet.v500
val ZipperGold          = Gold.g500
val DarkBackground      = Ink.i950
val DarkSurface         = Ink.i900
val DarkCard            = Ink.i800
val DarkSurfaceVar      = Ink.i800
val LightBackground     = Ink.i50
val LightSurface        = Ink.i0
val LightCard           = Ink.i100
val ZipperSuccess       = Mint.m500
val ZipperError         = Coral.c500
val ZipperWarning       = Amber.a500
val DiamondBlue         = Aqua.a400
val BeanGreen           = Mint.m400
val TextOnDark          = Ink.i0
val TextSecondaryDark   = Ink.i300
val TextOnLight         = Ink.i900
val TextSecondaryLight  = Ink.i500

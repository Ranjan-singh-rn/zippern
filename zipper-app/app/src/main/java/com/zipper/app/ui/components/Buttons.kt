package com.zipper.app.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.zipper.app.ui.theme.Size
import com.zipper.app.ui.theme.ZipperTheme

/*
 * Button — from the Figma component set (15:51).
 *
 *   Style: Primary | Secondary | Ghost | Danger
 *   Size:  Large 56 / pad 24 / 16sp · Medium 44 / pad 16 / 14sp · Small 32 / pad 12 / 13sp
 *   Radius: full. Gap between icon and label: 8.
 *
 * Primary is a flat brand fill in Figma; the gradient variant here is for the
 * one or two hero CTAs per flow (Go Live, Recharge) and is opt-in.
 */

enum class ButtonStyle { Primary, Secondary, Ghost, Danger }
enum class ButtonSize(val height: Dp, val padX: Dp, val minWidth: Dp) {
    Large(56.dp, 24.dp, 100.dp),
    Medium(44.dp, 16.dp, 78.dp),
    Small(32.dp, 12.dp, 67.dp),
}

@Composable
fun ZipperButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    style: ButtonStyle = ButtonStyle.Primary,
    size: ButtonSize = ButtonSize.Large,
    icon: ImageVector? = null,
    enabled: Boolean = true,
    loading: Boolean = false,
    /** Brand gradient instead of the flat fill. Primary only. */
    gradient: Boolean = false,
    fullWidth: Boolean = false,
) {
    val c = ZipperTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) 0.97f else 1f, label = "press")

    val labelStyle: TextStyle = when (size) {
        ButtonSize.Large -> ZipperTheme.type.labelL
        ButtonSize.Medium -> ZipperTheme.type.labelM
        ButtonSize.Small -> ZipperTheme.type.labelM.copy(fontSize = ZipperTheme.type.bodyS.fontSize)
    }

    val fill: Color = when (style) {
        ButtonStyle.Primary -> if (pressed) c.brandPrimaryPressed else c.brandPrimary
        ButtonStyle.Secondary -> c.bgElevated
        ButtonStyle.Ghost -> Color.Transparent
        ButtonStyle.Danger -> c.statusDanger
    }
    val border = if (style == ButtonStyle.Secondary) BorderStroke(Size.Stroke.hairline, c.borderDefault) else null

    /*
     * The label colour follows the FILL, not the brand.
     *
     * ── THE BUG THIS CAUSED ──────────────────────────────────────────────────
     *
     * This was `c.textOnBrand` for all four styles. `textOnBrand` is white in
     * both palettes — correctly, because it sits on the pink brand fill and on
     * red. But Secondary's fill is `bgElevated`, which in the light palette is
     * pure white, and Ghost has no fill at all.
     *
     * So in light mode "Sign in with Google" and "Continue as guest" — both
     * Secondary — were white text on a white pill. The only thing left of them
     * was a one-pixel hairline, at 40% alpha because both buttons are disabled
     * until the terms box is ticked. Two invisible controls, on the login
     * screen, and no way for a new user to get into the app at all.
     *
     * Dormant while the app is pinned dark (see ZipperTheme), and fixed anyway:
     * it is the actual fault, it costs nothing in dark mode where `textPrimary`
     * and `textOnBrand` are the same white, and leaving a landmine in a shared
     * button for whoever revives light mode is not a saving.
     */
    val content: Color = when (style) {
        ButtonStyle.Primary, ButtonStyle.Danger -> c.textOnBrand
        ButtonStyle.Secondary, ButtonStyle.Ghost -> c.textPrimary
    }

    val shapeMod = Modifier
        .then(if (fullWidth) Modifier.fillMaxWidth() else Modifier.widthIn(min = size.minWidth))
        .height(size.height)
        .scale(scale)
        .alpha(if (enabled) 1f else 0.4f)

    Surface(
        onClick = onClick,
        enabled = enabled && !loading,
        modifier = modifier.then(shapeMod),
        shape = CircleShape,
        color = if (gradient && style == ButtonStyle.Primary) Color.Transparent else fill,
        border = border,
        interactionSource = interaction,
    ) {
        Box(
            modifier = Modifier
                .then(
                    if (gradient && style == ButtonStyle.Primary)
                        Modifier.background(Brush.horizontalGradient(listOf(c.brandGradientFrom, c.brandGradientTo)))
                    else Modifier
                )
                .padding(horizontal = size.padX),
            contentAlignment = Alignment.Center,
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (loading) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(Size.Icon.sm),
                        color = content, strokeWidth = 2.dp,
                    )
                } else if (icon != null) {
                    Icon(icon, contentDescription = null, tint = content, modifier = Modifier.size(Size.Icon.md))
                }
                Text(text, style = labelStyle, color = content, maxLines = 1)
            }
        }
    }
}

/** Circular icon-only control: the call-screen actions, the top-bar back. */
@Composable
fun IconButtonCircle(
    icon: ImageVector,
    contentDescription: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    size: Dp = Size.Control.md,
    background: Color = ZipperTheme.colors.glassMid,
    tint: Color = ZipperTheme.colors.textPrimary,
    enabled: Boolean = true,
) {
    Surface(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.size(size).alpha(if (enabled) 1f else 0.4f),
        shape = CircleShape,
        color = background,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription, tint = tint, modifier = Modifier.size(Size.Icon.lg))
        }
    }
}

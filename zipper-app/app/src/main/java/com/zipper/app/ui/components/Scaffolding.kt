package com.zipper.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Size
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme

/**
 * The frame every non-immersive screen sits in: status-bar inset, base
 * background, optional top bar, optional bottom bar. Immersive screens (live
 * room, call) draw their own chrome over video and do not use this.
 */
@Composable
fun ZipperScreen(
    modifier: Modifier = Modifier,
    topBar: (@Composable () -> Unit)? = null,
    bottomBar: (@Composable () -> Unit)? = null,
    background: Color = ZipperTheme.colors.bgBase,
    content: @Composable (PaddingValues) -> Unit,
) {
    Surface(modifier = modifier.fillMaxSize(), color = background) {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            topBar?.invoke()
            Box(Modifier.weight(1f)) {
                content(PaddingValues(bottom = if (bottomBar != null) 0.dp else 0.dp))
            }
            bottomBar?.invoke()
        }
    }
}

/**
 * Top bar — 56dp (size/bar/top). Title centred when there is a back action,
 * left-aligned on root tabs. Actions on the right.
 */
@Composable
fun TopBar(
    title: String,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
    centered: Boolean = onBack != null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val c = ZipperTheme.colors
    Box(
        modifier
            .fillMaxWidth()
            .height(Size.Bar.top)
            .padding(horizontal = Space.sm),
    ) {
        if (onBack != null) {
            IconButtonCircle(
                Icons.AutoMirrored.Filled.ArrowBack, "Back", onBack,
                modifier = Modifier.align(Alignment.CenterStart),
                background = Color.Transparent,
            )
        }
        Text(
            title,
            style = if (centered) ZipperTheme.type.headingS else ZipperTheme.type.headingM,
            color = c.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .align(if (centered) Alignment.Center else Alignment.CenterStart)
                .then(if (centered) Modifier.padding(horizontal = Size.Control.md + Space.sm) else Modifier.padding(start = Space.sm)),
        )
        Row(
            Modifier.align(Alignment.CenterEnd),
            horizontalArrangement = Arrangement.spacedBy(Space.xs),
            verticalAlignment = Alignment.CenterVertically,
            content = actions,
        )
    }
}

/** "Section title" with an optional trailing action, e.g. "Top Fans · See all". */
@Composable
fun SectionHeader(
    title: String,
    modifier: Modifier = Modifier,
    action: String? = null,
    onAction: (() -> Unit)? = null,
) {
    val c = ZipperTheme.colors
    Row(
        modifier.fillMaxWidth().padding(horizontal = Space.lg, vertical = Space.sm),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, style = ZipperTheme.type.headingS, color = c.textPrimary)
        if (action != null && onAction != null) {
            Text(
                action, style = ZipperTheme.type.labelM, color = c.textBrand,
                modifier = Modifier.clickableNoRipple(onAction),
            )
        }
    }
}

/** A raised card on the base background. Named to avoid the Material3 `Card`. */
@Composable
fun ZipperCard(
    modifier: Modifier = Modifier,
    color: Color = ZipperTheme.colors.bgRaised,
    padding: PaddingValues = PaddingValues(Space.lg),
    onClick: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val shape = RoundedCornerShape(Radius.lg)
    if (onClick != null) {
        Surface(onClick = onClick, modifier = modifier, shape = shape, color = color) {
            Column(Modifier.padding(padding), content = content)
        }
    } else {
        Surface(modifier = modifier, shape = shape, color = color) {
            Column(Modifier.padding(padding), content = content)
        }
    }
}

/**
 * Empty state. Always says what the user can DO, not just that there is
 * nothing — "No gifts yet" is a dead end; "No gifts yet — go live to receive
 * some" is a next step.
 */
@Composable
fun EmptyState(
    icon: ImageVector,
    title: String,
    body: String,
    modifier: Modifier = Modifier,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    val c = ZipperTheme.colors
    Column(
        modifier.fillMaxWidth().padding(horizontal = Space.x3l, vertical = Space.x5l),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Box(
            Modifier.size(72.dp).background(c.tintBrandSubtle, RoundedCornerShape(Radius.xxl)),
            contentAlignment = Alignment.Center,
        ) { Icon(icon, null, tint = c.textBrand, modifier = Modifier.size(Size.Icon.xxl)) }
        Text(title, style = ZipperTheme.type.headingS, color = c.textPrimary, textAlign = TextAlign.Center)
        Text(body, style = ZipperTheme.type.bodyM, color = c.textSecondary, textAlign = TextAlign.Center)
        if (actionLabel != null && onAction != null) {
            Spacer(Modifier.height(Space.xs))
            ZipperButton(actionLabel, onAction, size = ButtonSize.Medium)
        }
    }
}

@Composable
fun LoadingState(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(color = ZipperTheme.colors.brandPrimary, strokeWidth = 3.dp)
    }
}

/** Hairline divider on the subtle border colour. */
@Composable
fun HairlineDivider(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(Size.Stroke.hairline).background(ZipperTheme.colors.borderSubtle))
}

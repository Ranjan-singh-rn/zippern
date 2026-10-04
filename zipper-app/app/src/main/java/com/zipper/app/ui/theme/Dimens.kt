package com.zipper.app.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.ui.unit.dp

/*
 * Spacing, radius and size tokens, from Figma's Foundations page.
 *
 * Named, not numbered, in screen code: `Space.lg` rather than `16.dp`. When a
 * value here changes, every screen moves together — which is the whole reason
 * to have a token rather than a literal.
 */

object Space {
    val none = 0.dp
    val xxs  = 2.dp
    val xs   = 4.dp
    val sm   = 8.dp
    val md   = 12.dp
    val lg   = 16.dp
    val xl   = 20.dp
    val xxl  = 24.dp
    val x3l  = 32.dp
    val x4l  = 40.dp
    val x5l  = 48.dp
    val x6l  = 64.dp
    val x7l  = 80.dp
}

object Radius {
    val none = 0.dp
    val xs   = 4.dp
    val sm   = 8.dp
    val md   = 12.dp
    val lg   = 16.dp
    val xl   = 20.dp
    val xxl  = 28.dp
    val x3l  = 36.dp
    val full = 999.dp
}

object Size {
    /** Minimum tappable area. Anything a thumb lands on is at least this. */
    val touchMin = 48.dp

    object Icon {
        val xs  = 14.dp
        val sm  = 16.dp
        val i18 = 18.dp
        val md  = 20.dp
        val lg  = 24.dp
        val xl  = 28.dp
        val i30 = 30.dp
        val xxl = 32.dp
    }

    object Avatar {
        val xs  = 28.dp
        val sm  = 36.dp
        val md  = 44.dp
        val lg  = 56.dp
        val xl  = 72.dp
        val xxl = 96.dp
        val x3l = 120.dp
    }

    object Control {
        val sm = 32.dp
        val md = 44.dp
        val lg = 56.dp
    }

    object Bar {
        val nav = 64.dp
        val top = 56.dp
    }

    object Stroke {
        val hairline = 1.dp
        val thick    = 2.dp
    }

    object Media {
        val sm   = 160.dp
        val md   = 220.dp
        val lg   = 300.dp
        val xl   = 360.dp
        /** Picture-in-picture self-view during a call. */
        val pipW = 96.dp
        val pipH = 128.dp
    }
}

/** Material shape slots, on the radius scale. */
val ZipperShapes = Shapes(
    extraSmall = RoundedCornerShape(Radius.xs),
    small      = RoundedCornerShape(Radius.sm),
    medium     = RoundedCornerShape(Radius.md),
    large      = RoundedCornerShape(Radius.lg),
    extraLarge = RoundedCornerShape(Radius.xxl),
)

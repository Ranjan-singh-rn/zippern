package com.zipper.app.ui.components

import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.focus.FocusRequester

/**
 * Ask for focus once the field has been measured and placed — never from the composition that created it.
 *
 * A3 (3 Nov 2026). A focused text field asks every scrolling parent to bring it into view, and a scrolling
 * container that has not been measured yet (its viewport still 0×0) answers with "Expected BringIntoViewRequester
 * to not be used before parents are placed" — thrown from a coroutine Compose runs, which nothing in the app can
 * catch. `LaunchedEffect(Unit) { requester.requestFocus() }` starts before the layout of the frame that composed
 * the field; the next frame starts after that layout, so waiting for it closes the window.
 *
 * A requester whose node is not attached any more (the field left the composition while this waited) throws as
 * well; that is dropped, because focus here is a convenience — the person can still tap the field.
 */
suspend fun FocusRequester.requestFocusAfterLayout() {
    withFrameNanos { }
    runCatching { requestFocus() }
}

package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * WP2 (5 Nov 2026, Owner): on the call screen the side that earns has End (plus chat, like, menu); the side that pays
 * also has Gift and Buy diamonds. Normally the caller pays; when a host rings a user, the user pays.
 */
class CallControlsTest {
    private val both = setOf(CallControls.Control.END, CallControls.Control.CHAT, CallControls.Control.LIKE, CallControls.Control.MENU)

    @Test fun callerPaysWhenTheReceiverEarns() {
        val caller = CallControls.visible("u1", "u1", "h1", earner = "receiver", callLoaded = true)
        assertEquals(both + CallControls.Control.GIFT + CallControls.Control.BUY_DIAMONDS, caller)
        assertEquals(both, CallControls.visible("h1", "u1", "h1", earner = "receiver", callLoaded = true))
    }

    @Test fun aHostWhoRingsAUserDoesNotGetBuyDiamonds() {
        assertEquals(both, CallControls.visible("h1", "h1", "u1", earner = "caller", callLoaded = true))
        assertTrue(CallControls.Control.BUY_DIAMONDS in CallControls.visible("u1", "h1", "u1", earner = "caller", callLoaded = true))
    }

    @Test fun nothingExtraBeforeTheCallIsLoaded() {
        assertEquals(both, CallControls.visible("u1", "u1", "h1", "receiver", callLoaded = false))
        assertFalse(CallControls.isPayer("", "u1", "h1", "receiver"))
    }

    @Test fun theMenuIsTheSameForBoth() {
        assertTrue(CallControls.MENU.containsAll(listOf(CallControls.MenuItem.FLIP_CAMERA, CallControls.MenuItem.MICROPHONE, CallControls.MenuItem.SPEAKER, CallControls.MenuItem.CAMERA)))
    }
}

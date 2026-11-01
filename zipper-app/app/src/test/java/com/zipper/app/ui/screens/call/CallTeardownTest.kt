package com.zipper.app.ui.screens.call

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * P0-6 — the app closes a call on the server when the call screen goes away
 * without a hang-up, and only the payer drives the billing tick.
 *
 * The server side is pinned by functions/test/callBillingP0.test.js; this pins
 * the two client facts it relies on.
 */
class CallTeardownTest {

    private val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
    private val vm = File(main, "com/zipper/app/ui/screens/call/VideoCallViewModel.kt").readText()

    @Test fun `onCleared ends a call that was not hung up`() {
        val start = vm.indexOf("override fun onCleared()")
        assertTrue("onCleared not found", start >= 0)
        val body = vm.substring(start, vm.indexOf("\n    }\n", start))
        assertTrue("onCleared must call endCall for a call still open", body.contains("callRepo.endCall("))
        assertTrue("…only when the call is not already over", body.contains("endReason == null"))
    }

    @Test fun `only the paying side starts the economy tick`() {
        assertTrue(vm.contains("if (_state.value.isPayer) {\n            startEconomyTick()"))
    }
}

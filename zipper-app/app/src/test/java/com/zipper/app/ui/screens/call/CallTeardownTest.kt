package com.zipper.app.ui.screens.call

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * P0-6 — the app closes a call on the server when the call screen goes away
 * without a hang-up.
 *
 * APK 20 / A-14 — BOTH devices tick `tickCall` every ten seconds as a
 * liveness ping; the server charges whole minutes from its own clock, and the
 * earner's tick is never charged. The server side is pinned by
 * functions/test/callBillingP0.test.js; this pins the client facts it relies on.
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

    @Test fun `both sides run the liveness tick, and it charges nothing by itself`() {
        val connected = vm.substring(vm.indexOf("private fun onCallConnected()"), vm.indexOf("private fun refreshDisplay()"))
        assertTrue("the tick starts for payer and earner alike", connected.contains("startLivenessTick()"))
        assertFalse("no payer-only gate on the tick", connected.contains("if (_state.value.isPayer) {\n            startEconomyTick()"))
        val tick = vm.substring(vm.indexOf("private fun startLivenessTick()"), vm.indexOf("private fun applyTick("))
        assertTrue(tick.contains("delay(CallBilling.LIVENESS_TICK_SECONDS * 1000L)"))
        assertTrue(tick.contains("callRepo.tickCall(callId)"))
        assertTrue("a server-ended call is explained", tick.contains("CallBilling.endMessage(reason, it.isPayer)"))
    }

    @Test fun `the timer is derived from the server snapshot, never counted locally`() {
        assertFalse("no local second counter", vm.contains("durationSeconds = it.durationSeconds + 1"))
        assertTrue(vm.contains("CallBilling.display(billing, serverNow"))
        assertTrue(vm.contains("CallBilling.clockOffsetMs(tick.startedAtMs, tick.elapsedSeconds"))
        assertTrue("the earner's figures come from the call document", vm.contains("beansEarned         = maxOf(it.beansEarned, call.beansCredited)"))
    }
}

package com.zipper.app.util

import com.zipper.app.data.repository.EconomyConfigRepository.CallSplitMatrix
import com.zipper.app.data.repository.EconomyConfigRepository.EconomyConfig
import com.zipper.app.data.repository.EconomyConfigRepository.GiftRates
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * O5c (Owner, 5 Nov 2026) — "the viewer cannot call the broadcaster … the CTA button is missing … enabled if the
 * broadcaster turns calls on, disabled if off. Same in party." The price on the room's Call confirmation is the one
 * the profile and the chat quote (one function), and the server's switches are what decide.
 */
class CallPriceTest {

    private val cfg = EconomyConfig(
        diamondPackPriceInr = 2390, diamondPackPriceUsd = 28, sellerWholesalePriceInr = 2000,
        beanToDiamondRate = 20.0, weeklyMinPayoutInr = 1000, weeklyMinPayoutBeans = null,
        callRateBeansPerMin = 750L, userCallRatePerMin = 500L, minHostCallRate = 100L, maxHostCallRate = 12_000L,
        giftRates = GiftRates(50, 50, 55, 50, 0, 20, 0.01), callSplitMatrix = CallSplitMatrix.FALLBACK,
        usdToInrRate = 83.0, isFallback = false,
    )

    private fun user(g: String) = CallPrice.Side(isHost = false, isVerifiedHost = false, callRateBeans = 0, gender = g)
    private fun host(g: String, rate: Long = 0, verified: Boolean = rate > 0) =
        CallPrice.Side(isHost = true, isVerifiedHost = verified, callRateBeans = rate, gender = g)

    @Test fun `a male viewer calling a verified female broadcaster pays her rate grossed up by the split`() {
        // Her income 1,000 beans a minute; male → female earner share 50 % → 2,000 diamonds a minute.
        assertEquals(2_000L, CallPrice.callerPaysPerMin(cfg, me = user("male"), target = host("female", 1_000)))
    }

    @Test fun `an unverified broadcaster is priced at the base rate, rounded up for the earner`() {
        // 750 beans; female → male share 40 % → 1,875 exactly.
        assertEquals(1_875L, CallPrice.callerPaysPerMin(cfg, me = user("female"), target = host("male", 0, verified = false)))
        // 750 beans; male → male 30 % → 2,500.
        assertEquals(2_500L, CallPrice.callerPaysPerMin(cfg, me = user("male"), target = host("male")))
    }

    @Test fun `a host dialling a user is not the payer, two hosts pay the receiver's price, two users the flat rate`() {
        assertEquals(0L, CallPrice.callerPaysPerMin(cfg, me = host("female", 1_000), target = user("male")))
        assertEquals(2_000L, CallPrice.callerPaysPerMin(cfg, me = host("male", 900), target = host("female", 1_000)))
        assertEquals(500L, CallPrice.callerPaysPerMin(cfg, me = user("male"), target = user("female")))
    }

    @Test fun `the rooms ask the server, which refuses a broadcaster or party owner who switched calls off`() {
        val root = generateSequence(File("").absoluteFile) { it.parentFile }
            .first { File(it, "zipper-app/app/build.gradle.kts").exists() }
        val calls = File(root, "functions/src/calls.ts").readText()
        assertTrue("startCall must enforce the live host's switch", calls.contains("hostBlocksCalls"))
        assertTrue("startCall must enforce the party owner's switch", calls.contains("ownerBlocksCalls"))
        val app = File(root, "zipper-app/app/src/main/java/com/zipper/app")
        assertTrue(File(app, "ui/screens/live/WatchLiveViewModel.kt").readText().contains("callStarter"))
        assertTrue(File(app, "ui/screens/party/PartyRoomViewModel.kt").readText().contains("callStarter"))
        assertTrue(File(app, "data/repository/CallStarter.kt").exists())
    }
}

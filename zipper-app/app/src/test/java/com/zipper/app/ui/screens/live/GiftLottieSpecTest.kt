package com.zipper.app.ui.screens.live

import com.airbnb.lottie.compose.LottieCompositionSpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** O2: a gift's Lottie from the CRM plays in live and party rooms — bundled asset or URL. */
class GiftLottieSpecTest {
    @Test fun `a bundled CRM preset is read from the app's assets`() {
        assertEquals(LottieCompositionSpec.Asset("gifts/g1_rose.json"), lottieSpecOf("gifts/g1_rose.json"))
        assertEquals(LottieCompositionSpec.Asset("gifts/g9_rocket.json"), lottieSpecOf("/gifts/g9_rocket.json"))
    }

    @Test fun `an uploaded Lottie is loaded from its URL`() {
        val url = "https://firebasestorage.googleapis.com/v0/b/x/o/contentAssets%2Fgifts%2FRose%2Flottie.json?alt=media"
        assertEquals(LottieCompositionSpec.Url(url), lottieSpecOf(url))
    }

    @Test fun `every bundled preset the CRM offers ships in the app`() {
        val assets = listOf(File("src/main/assets"), File("app/src/main/assets")).first { it.exists() }
        for (n in listOf("g1_rose", "g2_heart", "g3_kiss", "g4_teddy", "g5_ring", "g6_crown", "g7_car", "g8_yacht", "g9_rocket", "g10_castle")) {
            assertTrue("gifts/$n.json", File(assets, "gifts/$n.json").exists())
        }
    }

    @Test fun `the room event carries the Lottie, and the overlay plays it when there is no SVGA`() {
        val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
        val overlay = File(main, "com/zipper/app/ui/screens/live/GiftAnimationOverlay.kt").readText()
        val svga = overlay.indexOf("if (giftEvent.svgaUrl.isNotBlank())")
        val lottie = overlay.indexOf("if (giftEvent.lottieAsset.isNotBlank())")
        assertTrue("SVGA first, then Lottie", svga in 0 until lottie)
        val party = File(main, "com/zipper/app/ui/screens/party/PartyRoomScreen.kt").readText()
        assertTrue(party.contains("lottieAsset = lottieAsset,"))
    }
}

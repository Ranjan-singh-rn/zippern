package com.zipper.app.ui.components

import com.zipper.app.data.model.BagItem
import com.zipper.app.ui.screens.bag.entranceEmoji
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * O9 (5 Nov 2026) — "user entries are not showing in the live or party room". Three causes, each pinned:
 *
 *   1. Every starter entrance is ONE picture wrapped as a Lottie (`ip 0, op 1`): played "once" it finished in 33 ms
 *      and nobody saw it. A picture now rides in (in, hold, out).
 *   2. The arrival ended when the FIRST of effect and banner ended — with animations off (an accessibility setting,
 *      battery saver, the QA emulator) that was at once, banner included.
 *   3. A viewer's own join, landing in the room's first snapshot, was skipped as history.
 */
class DecorTest {

    private val root: File = generateSequence(File("").absoluteFile) { it.parentFile }
        .first { File(it, "zipper-app/app/build.gradle.kts").exists() }
    private val app = File(root, "zipper-app/app/src/main")
    private fun src(rel: String) = File(app, "java/com/zipper/app/$rel").readText()

    @Test fun `every bundled entrance is a still, and a still rides in instead of playing`() {
        assertTrue(isStillEntrance(1f))
        assertFalse(isStillEntrance(90f))
        DecorDefaults.ENTRANCE_LOTTIE.forEach { (id, asset) ->
            val f = File(app, "assets/$asset")
            assertTrue("$id: $asset is not bundled", f.exists())
            // The file's own in/out points: the first "ip"/"op" are the top-level ones in a Bodymovin export
            // (no JSON library on the unit-test classpath; Android's org.json is a stub here).
            val head = f.readText().take(400)
            fun num(key: String) = Regex("\"$key\"\\s*:\\s*([0-9.]+)").find(head)!!.groupValues[1].toDouble()
            val frames = num("op") - num("ip")
            assertTrue("$id is $frames frames — the ride-in is for stills; check how it plays", isStillEntrance(frames.toFloat()))
            // The bike was 3280 × 2764: a 36 MB bitmap to decode on arrival, which did not finish before the arrival
            // was over the first time it played in a room. Nothing shown at 280 dp needs more than 1080 px.
            assertTrue("$id is ${num("w")} × ${num("h")} — downscale it", maxOf(num("w"), num("h")) <= 1080.0)
        }
        val decor = src("ui/components/Decor.kt")
        assertTrue(decor.contains("if (still) StillEntrance(lottie, { rideX.value }, place)"))
        // Loaded and timed at the top of the arrival: the drawing branch is re-created on a recomposition, and the
        // file and the ride's position went with it (the picture never left the edge of the screen).
        assertTrue(decor.contains("val lottieResult = if (lottieSpec != null) rememberLottieComposition(lottieSpec) else null"))
        assertTrue(decor.contains("val rideX = remember(arrival.key) { Animatable(STILL_ENTRANCE_START_X) }"))
        assertTrue("the hold is a delay, so it shows with animations off", decor.contains("delay(STILL_ENTRANCE_HOLD_MS)"))
    }

    @Test fun `an arrival ends when both the effect and the banner are done`() {
        val decor = src("ui/components/Decor.kt")
        assertTrue(decor.contains("LaunchedEffect(effectDone, bannerDone) { if (effectDone && bannerDone) done() }"))
        assertTrue(decor.contains("onFinished = { effectDone = true }"))
        assertFalse("an effect must not end the whole arrival", decor.contains("onFinished = { done() }"))
    }

    @Test fun `the first look at a room still plays a join from the last few seconds`() {
        val decor = src("ui/components/Decor.kt")
        assertTrue(decor.contains("fresh.filter { kotlin.math.abs(now - it.timestamp) <= FIRST_SNAPSHOT_ARRIVAL_MS }"))
        assertFalse(decor.contains("if (comments.size > 3) return@LaunchedEffect"))
        assertEquals(30_000L, FIRST_SNAPSHOT_ARRIVAL_MS)
    }

    @Test fun `each entrance has its own picture in the store grid, not one rocket for all`() {
        assertEquals("🏍️", entranceEmoji(BagItem(id = "en_bike", name = "Bike Entry")))
        assertEquals("🐎", entranceEmoji(BagItem(id = "en_horse", name = "Horse Rider")))
        assertEquals("✈️", entranceEmoji(BagItem(id = "en_jet", name = "Fighter Jet")))
        assertEquals("🛳️", entranceEmoji(BagItem(id = "en_ship", name = "Ship")))
        assertEquals("🚀", entranceEmoji(BagItem(id = "en_rocket", name = "Rocket")))
        val bag = src("ui/screens/bag/MyBagScreen.kt")
        assertTrue("a bundled entrance tile shows one still frame of its own art",
            bag.contains("LottieAnimation(composition = composition, progress = { ENTRANCE_STILL_PROGRESS }, modifier = Modifier.size(72.dp))"))
    }
}

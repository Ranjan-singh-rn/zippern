package com.zipper.app.util

import com.zipper.app.data.model.PublicProfile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * O11 (Owner, 5 Nov 2026) — the Home feed:
 *
 *   "Never show an official owner ID in the home screen … you can show agencies, sub-agencies, coin sellers, but don't
 *    show officials. If the person is female, show the male first. If male, show the female first. If transgender,
 *    show normally."
 */
class HomeOrderTest {

    private fun p(uid: String, gender: String, official: Boolean = false) =
        PublicProfile(uid = uid, gender = gender, isOfficial = official)

    // The server's order: live → party → online → … then most recent. HomeOrder must keep it within each group.
    private val serverOrder = listOf(
        p("f-live", "female"), p("m-live", "male"), p("t-online", "transgender"),
        p("owner", "male", official = true), p("f-recent", "female"), p("m-recent", "male"), p("x-unset", ""),
    )

    @Test fun `an official is never shown, whatever the viewer`() {
        for (viewer in listOf("male", "female", "transgender", "")) {
            val shown = HomeOrder.order(serverOrder, viewer).map { it.uid }
            assertFalse("official shown to a $viewer viewer", "owner" in shown)
            assertEquals(6, shown.size)
        }
        assertFalse(HomeOrder.visible(p("o", "female", official = true)))
        assertTrue(HomeOrder.visible(p("agency-owner", "male")))
    }

    @Test fun `a female viewer sees men first, the server's order kept inside each group`() {
        assertEquals(
            listOf("m-live", "m-recent", "f-live", "t-online", "f-recent", "x-unset"),
            HomeOrder.order(serverOrder, "female").map { it.uid },
        )
    }

    @Test fun `a male viewer sees women first`() {
        assertEquals(
            listOf("f-live", "f-recent", "m-live", "t-online", "m-recent", "x-unset"),
            HomeOrder.order(serverOrder, " Male ").map { it.uid },
        )
    }

    @Test fun `a transgender viewer, or one with no gender set, sees the normal order`() {
        val plain = listOf("f-live", "m-live", "t-online", "f-recent", "m-recent", "x-unset")
        assertEquals(plain, HomeOrder.order(serverOrder, "transgender").map { it.uid })
        assertEquals(plain, HomeOrder.order(serverOrder, "").map { it.uid })
        assertNull(HomeOrder.preferredGender("other"))
    }

    @Test fun `the server keeps officials out of the listing too, and the Home feed uses this order`() {
        val root = generateSequence(File("").absoluteFile) { it.parentFile }
            .first { File(it, "zipper-app/app/build.gradle.kts").exists() }
        val profiles = File(root, "functions/src/profiles.ts").readText()
        assertTrue("publicProfiles.isListed must exclude officials", profiles.contains("u.isOfficial !== true"))
        val home = File(root, "zipper-app/app/src/main/java/com/zipper/app/ui/screens/home/HomeViewModel.kt").readText()
        assertTrue(home.contains("com.zipper.app.util.HomeOrder.order("))
    }
}

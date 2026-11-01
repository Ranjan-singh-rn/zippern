package com.zipper.app.util

import com.zipper.app.data.repository.RestrictionKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * C9 (B25, B26) — the device-key appeal is offered exactly when this phone can
 * send it, and a suspension is never shown as a ban.
 */
class AppealRouteTest {

    @Test fun `signed in uses the ordinary form, with screenshots`() {
        val r = AppealRoute.decide(signedIn = true, hasQuickLoginCredential = false, hasDeviceKey = false)
        assertEquals(AppealRoute.Route.Session, r)
        assertTrue(AppealRoute.showsForm(r))
        assertTrue(AppealRoute.carriesEvidence(r))
    }

    @Test fun `no session but a saved credential and a device key shows the device-key form`() {
        val r = AppealRoute.decide(signedIn = false, hasQuickLoginCredential = true, hasDeviceKey = true)
        assertEquals(AppealRoute.Route.DeviceKey, r)
        assertTrue(AppealRoute.showsForm(r))
        assertFalse("the session-less path cannot upload", AppealRoute.carriesEvidence(r))
    }

    @Test fun `one half of the proof is not enough — the web appeal, as before`() {
        assertEquals(AppealRoute.Route.Web, AppealRoute.decide(false, hasQuickLoginCredential = true, hasDeviceKey = false))
        assertEquals(AppealRoute.Route.Web, AppealRoute.decide(false, hasQuickLoginCredential = false, hasDeviceKey = true))
        assertEquals(AppealRoute.Route.Web, AppealRoute.decide(false, hasQuickLoginCredential = false, hasDeviceKey = false))
        assertFalse(AppealRoute.showsForm(AppealRoute.Route.Web))
        assertFalse(AppealRoute.carriesEvidence(AppealRoute.Route.Web))
    }

    @Test fun `quick-login outcomes map to the right screen`() {
        assertEquals(RestrictionKind.Suspension, AppealRoute.kindOfOutcome("suspended"))
        assertEquals(RestrictionKind.Account, AppealRoute.kindOfOutcome("banned"))
        assertEquals(RestrictionKind.Device, AppealRoute.kindOfOutcome("device_banned"))
        for (other in listOf(null, "", "allow", "deleted", "refused", "rate_limited", "legacy")) {
            assertNull("'$other'", AppealRoute.kindOfOutcome(other))
        }
    }

    @Test fun `a suspension is never read as a ban`() {
        assertTrue(AppealRoute.kindOfOutcome("suspended") != RestrictionKind.Account)
    }

    private val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
    private fun src(rel: String) = File(main, "com/zipper/app/$rel").readText()

    @Test fun `the restriction screens follow the route, not just the session`() {
        val banned = src("ui/screens/auth/BannedScreen.kt")
        assertFalse("the panel must not gate on a session alone",
            banned.contains("val signedIn = remember { FirebaseAuth.getInstance().currentUser != null }"))
        assertTrue(banned.contains("!AppealRoute.showsForm(route) ->"))
        assertTrue(banned.contains("if (!AppealRoute.carriesEvidence(route))"))
        assertTrue(src("ui/screens/auth/BannedViewModel.kt").contains("appeals.appealRoute()"))
        val repo = src("data/repository/AppealRepository.kt")
        assertTrue(repo.contains("suspend fun appealRoute(): com.zipper.app.util.AppealRoute.Route"))
        // …and quick login maps its payload through the one function.
        assertTrue(src("data/repository/AuthRepository.kt")
            .contains("com.zipper.app.util.AppealRoute.kindOfOutcome(value.outcome)"))
    }
}

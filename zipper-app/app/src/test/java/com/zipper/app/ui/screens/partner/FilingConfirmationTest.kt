package com.zipper.app.ui.screens.partner

import com.zipper.app.data.repository.PartnerFunctions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * RF-30 — after a filing whose outcome is unknown, the app looks before it
 * speaks: an application is confirmed from the person's own list; a recharge
 * is sent again with the same request id and cannot be filed twice.
 */
class FilingConfirmationTest {

    private fun app(id: String, kind: String, status: String) =
        PartnerFunctions.Application(id, kind, status, name = "", parentId = "", rejectionReason = "", revocationReason = "")

    private val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
    private fun src(rel: String) = File(main, "com/zipper/app/$rel").readText()

    // ── Which application confirms the filing ───────────────────────────────

    @Test fun `a pending application of the kind just submitted confirms it`() {
        val list = listOf(app("OLD", "agency", "rejected"), app("NEW", "agency", "pending"))
        assertEquals("NEW", FilingConfirmation.pendingApplicationId("agency", list))
    }

    @Test fun `a Host application is found on the same list`() {
        assertEquals("H1", FilingConfirmation.pendingApplicationId("host", listOf(app("H1", "host", "pending"))))
    }

    @Test fun `another kind, or anything not pending, confirms nothing`() {
        val list = listOf(
            app("S", "seller", "pending"),           // another kind
            app("A1", "agency", "rejected"),         // D16: a rejected one holds nothing
            app("A2", "agency", "approved"),
            app("A3", "agency", "awaiting_verification"),
            app("A4", "agency", "revoked"),
            app("", "agency", "pending"),            // no id
        )
        assertNull(FilingConfirmation.pendingApplicationId("agency", list))
        assertNull(FilingConfirmation.pendingApplicationId("sub_agency", list))
        assertNull(FilingConfirmation.pendingApplicationId("agency", emptyList()))
    }

    @Test fun `the sentences never claim it failed`() {
        for (s in listOf(FilingConfirmation.APPLICATION_NOT_CONFIRMED, FilingConfirmation.RECHARGE_NOT_CONFIRMED,
                         FilingConfirmation.APPEAL_NOT_CONFIRMED)) {
            assertTrue(s.contains("couldn't confirm"))
            assertFalse(s.contains("could not be reached"))
            assertFalse(s.contains("failed"))
        }
        assertTrue(FilingConfirmation.RECHARGE_NOT_CONFIRMED.contains("will not be filed twice"))
    }

    @Test fun `the look-again budget is small`() {
        assertTrue(FilingConfirmation.ATTEMPTS in 2..5)
        assertTrue(FilingConfirmation.SPACING_MS in 1_000L..5_000L)
    }

    // ── Wiring, pinned at the source ────────────────────────────────────────

    @Test fun `the application form looks before it speaks`() {
        val vm = src("ui/screens/partner/PartnerApplyViewModel.kt")
        val submit = vm.substring(vm.indexOf("private fun submit()"), vm.indexOf("private suspend fun applicationOnRecord()"))
        val unknown = submit.indexOf("res is PartnerFunctions.Result.Failed && res.outcomeUnknown")
        assertTrue("submit() checks for an unknown outcome", unknown > 0)
        assertTrue("…before the ordinary result handling", unknown < submit.indexOf("is PartnerFunctions.Result.Ok ->"))
        assertTrue(submit.contains("applicationOnRecord()"))
        assertTrue(submit.contains("step = ApplyStep.DONE, filedId = filed"))
        assertTrue(submit.contains("FilingConfirmation.APPLICATION_NOT_CONFIRMED"))
        val look = vm.substring(vm.indexOf("private suspend fun applicationOnRecord()"))
        assertTrue(look.contains("repo.myApplications()"))
        assertTrue(look.contains("FilingConfirmation.pendingApplicationId(kind, mine.value)"))
        assertTrue(look.contains("repeat(FilingConfirmation.ATTEMPTS)"))
    }

    @Test fun `the recharge form sends one request id, the same on every retry`() {
        val screen = src("ui/screens/partner/RechargeRequestScreen.kt")
        assertTrue(screen.contains("savedStateHandle.get<String>(REQUEST_ID_KEY)"))
        assertTrue(screen.contains("java.util.UUID.randomUUID().toString().also { savedStateHandle[REQUEST_ID_KEY] = it }"))
        val send = screen.substring(screen.indexOf("fun send()"))
        assertTrue(send.contains("requestId = s.requestId"))
        assertTrue(send.contains("if (res.outcomeUnknown) FilingConfirmation.RECHARGE_NOT_CONFIRMED else res.userMessage"))
        // The id is set once (from the saved state or a new UUID) and only ever
        // sent — no `copy(requestId = …)` anywhere in the view model.
        val vm = screen.substringAfter("class RechargeRequestViewModel")
        assertEquals("set once, sent once", 2, Regex("requestId = ").findAll(vm).count())
        val fns = src("data/repository/PartnerFunctions.kt")
        assertTrue(fns.contains("\"requestId\" to requestId,"))
        val repo = src("data/repository/PartnerRepository.kt")
        assertTrue(repo.contains("sellerId, diamonds, amountMinor, currency, paymentMethod, reference, proofUrl, requestId,"))
    }

    @Test fun `a UUID is a request id the bridge and the API accept`() {
        val id = java.util.UUID.randomUUID().toString()
        assertTrue(Regex("[A-Za-z0-9_-]{8,64}").matches(id))
    }

    @Test fun `a reinstatement request that may have been filed re-reads the hub`() {
        val vm = src("ui/screens/partner/PartnerHubViewModel.kt")
        val submit = vm.substring(vm.indexOf("fun submitAppeal()"))
        assertTrue(submit.contains("if (res.outcomeUnknown) FilingConfirmation.APPEAL_NOT_CONFIRMED else res.userMessage"))
        assertTrue(submit.contains("if (res.outcomeUnknown) refresh()"))
    }
}

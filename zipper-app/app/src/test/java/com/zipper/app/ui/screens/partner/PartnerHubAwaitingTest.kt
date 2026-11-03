package com.zipper.app.ui.screens.partner

import com.zipper.app.data.repository.PartnerFunctions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Decision 15 (RC) — a role the Owner approved while the account did not yet
 * hold BOTH verified contacts WAITS. The hub shows it as waiting, with the
 * verification steps; never as a role that works, and never as something to
 * apply for again.
 */
class PartnerHubAwaitingTest {

    private fun elig(
        options: List<String> = emptyList(),
        blocked: Map<String, String> = emptyMap(),
        held: List<PartnerFunctions.HeldRole> = emptyList(),
        pendingHostStatus: String = "",
    ) = PartnerFunctions.Eligibility(
        options = options, blocked = blocked, held = held, isHost = false,
        hostAgencyKind = "", pendingHostApplicationId = if (pendingHostStatus.isNotBlank()) "ha_1" else "",
        pendingHostApplicationStatus = pendingHostStatus, isInternal = false,
    )

    @Test fun `a waiting agency is listed as waiting, not as held`() {
        val model = PartnerHubRows.build(
            elig(
                blocked = mapOf("agency" to "Your Agency is approved and waiting for verified contacts."),
                held = listOf(
                    PartnerFunctions.HeldRole("agency", PartnerHubRows.AWAITING, "p_ag", "Star Agency"),
                    PartnerFunctions.HeldRole("seller", "approved", "p_s", "Star Coins"),
                ),
            ),
        )
        assertEquals(listOf("Coin Seller · approved"), model.held)
        assertEquals(listOf("agency"), model.awaiting.map { it.kind })
        assertTrue(model.awaiting.single().title.contains("waiting for verified contacts"))
        assertFalse("a waiting kind is not offered again", model.choice("agency")!!.canApply)
    }

    @Test fun `a waiting Host application is listed too`() {
        val model = PartnerHubRows.build(elig(pendingHostStatus = PartnerHubRows.AWAITING))
        assertEquals(listOf("host"), model.awaiting.map { it.kind })
    }

    @Test fun `hasAwaiting asks the server to check only when something waits`() {
        assertTrue(PartnerHubRows.hasAwaiting(elig(held = listOf(
            PartnerFunctions.HeldRole("seller", PartnerHubRows.AWAITING, "p_s", "S")))))
        assertTrue(PartnerHubRows.hasAwaiting(elig(pendingHostStatus = PartnerHubRows.AWAITING)))
        assertFalse(PartnerHubRows.hasAwaiting(elig(held = listOf(
            PartnerFunctions.HeldRole("seller", "approved", "p_s", "S")))))
        assertFalse(PartnerHubRows.hasAwaiting(elig(pendingHostStatus = "pending")))
    }

    @Test fun `the eligibility parser reads the activation block and the host application status`() {
        val e = PartnerFunctions.parseEligibility(
            mapOf(
                "options" to emptyList<String>(),
                "blocked" to emptyMap<String, String>(),
                "held" to mapOf(
                    "partners" to emptyList<Any>(),
                    "pending_host_application" to mapOf("id" to "ha_9", "status" to "awaiting_verification"),
                ),
                "activation" to mapOf("requirement" to "both", "complete" to false, "missing" to listOf("email")),
            ),
        )
        assertEquals("awaiting_verification", e.pendingHostApplicationStatus)
        assertEquals(listOf("email"), e.activation!!.missing)
    }

    @Test fun `the eligibility parser reads the role rule's parent pin`() {
        val e = PartnerFunctions.parseEligibility(
            mapOf(
                "options" to listOf("host", "seller"),
                "blocked" to emptyMap<String, String>(),
                "held" to mapOf("partners" to emptyList<Any>()),
                "parent_for" to mapOf("host" to "MAIN_X"),
            ),
        )
        assertEquals(mapOf("host" to "MAIN_X"), e.parentFor)
        assertEquals(emptyMap<String, String>(), PartnerFunctions.parseEligibility(emptyMap()).parentFor)
    }

    @Test fun `the verification state parser keeps only what started`() {
        val v = PartnerFunctions.parseVerificationState(
            mapOf(
                "verification" to mapOf("complete" to true, "missing" to emptyList<String>()),
                "waiting" to listOf(mapOf("id" to "p_ag", "kind" to "agency", "name" to "Star")),
                "started" to listOf(
                    mapOf("id" to "p_ag", "kind" to "agency", "activated" to true),
                    mapOf("id" to "ha_1", "kind" to "host", "activated" to false),
                ),
            ),
        )
        assertTrue(v.requirement.complete)
        assertEquals(listOf("agency"), v.waiting.map { it.kind })
        assertEquals(listOf("agency"), v.started.map { it.kind })
        assertEquals("nothing was refused with a reason", emptyList<String>(), v.refusals)
    }

    /** E2E round 2 (3 Nov 2026, QA #51): the server's reason for a role it did not start is kept. */
    @Test fun `the verification state parser keeps the server's reason for a role it did not start`() {
        val why = "Your agency invited you with another email address (q•••@example.com). " +
            "Verify that address to start your Host role, or ask your agency to send a new invitation."
        val v = PartnerFunctions.parseVerificationState(
            mapOf(
                "verification" to mapOf("complete" to true, "missing" to emptyList<String>()),
                "waiting" to listOf(mapOf("id" to "inv_1", "kind" to "host", "name" to "")),
                "started" to listOf(
                    mapOf("id" to "inv_1", "kind" to "host", "activated" to false, "refusal" to why),
                    mapOf("id" to "inv_2", "kind" to "host", "activated" to false, "refusal" to "  "),
                    mapOf("id" to "p_ag", "kind" to "agency", "activated" to true, "refusal" to "ignored"),
                    mapOf("id" to "inv_3", "kind" to "host", "activated" to false, "refusal" to why),
                ),
            ),
        )
        assertEquals(listOf(why), v.refusals)
        assertEquals(listOf("agency"), v.started.map { it.kind })
    }

    @Test fun `the hub says that reason in place of 'Your role is starting'`() {
        val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
        val vm = File(main, "com/zipper/app/ui/screens/partner/PartnerHubViewModel.kt").readText()
        assertTrue(vm.contains("val why = checked.value.refusals.firstOrNull()"))
        assertTrue(vm.contains("if (r.complete && why != null) r.copy(notStarted = why) else r"))
    }
}

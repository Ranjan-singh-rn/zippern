package com.zipper.app.ui.screens.partner

import com.zipper.app.data.repository.PartnerFunctions
import com.zipper.app.data.repository.RoleAppealStatement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * C1, C2 (B04) — a revoked role reads as revoked, offers reinstatement or shows
 * the open request, and is never offered as a first-time application. Plus the
 * parser for the API's eligibility shape, the statement bounds, and the Host
 * card copy (B36).
 */
class PartnerHubRowsTest {

    private val agencyRevoked = PartnerFunctions.RevokedRole(
        kind = "agency", recordId = "p_ag1", revokedAt = "2026-10-01T10:00:00Z",
        reason = "Payout irregularities", appealId = "", appealStatus = "",
    )

    private fun elig(
        options: List<String> = emptyList(),
        blocked: Map<String, String> = emptyMap(),
        held: List<PartnerFunctions.HeldRole> = emptyList(),
        isHost: Boolean = false,
        revoked: List<PartnerFunctions.RevokedRole> = emptyList(),
        hostStatus: String = "",
    ) = PartnerFunctions.Eligibility(
        options = options, blocked = blocked, held = held, isHost = isHost,
        hostAgencyKind = "", pendingHostApplicationId = "", isInternal = false,
        revoked = revoked, hostStatus = hostStatus,
    )

    // ── The two required cases ───────────────────────────────────────────────

    @Test fun `revoked agency plus approved seller - agency revoked with reinstatement, seller held, no apply for agency`() {
        val model = PartnerHubRows.build(
            elig(
                // Even a server that wrongly still lists it must not get an Apply.
                options = listOf("agency", "host"),
                blocked = mapOf("seller" to "You already hold a Coin Seller role."),
                held = listOf(
                    PartnerFunctions.HeldRole("agency", "revoked", "p_ag1", "Star Agency", revokedReason = "Payout irregularities"),
                    PartnerFunctions.HeldRole("seller", "approved", "p_s1", "Star Coins"),
                ),
                revoked = listOf(agencyRevoked),
            ),
        )

        assertEquals(listOf("Coin Seller · approved"), model.held)

        assertEquals(1, model.revoked.size)
        val row = model.revoked.single()
        assertEquals("agency", row.kind)
        assertEquals("Agency · Revoked", row.title)
        assertEquals("Payout irregularities", row.reason)
        assertEquals(PartnerHubRows.Reinstatement.CanRequest(lastDeclined = false, note = ""), row.reinstatement)

        val agency = model.choice("agency")!!
        assertFalse("a revoked kind is never a first-time application", agency.canApply)
        assertEquals(PartnerHubRows.revokedRefusal("agency"), agency.blockedReason)
        assertFalse(model.choice("seller")!!.canApply)
        assertTrue(model.choice("host")!!.canApply)
    }

    @Test fun `an open request is shown as pending and offers nothing to tap`() {
        val model = PartnerHubRows.build(
            elig(revoked = listOf(agencyRevoked.copy(appealId = "ra_1", appealStatus = "pending"))),
        )
        val r = model.revoked.single().reinstatement
        assertTrue(r is PartnerHubRows.Reinstatement.Open)
        assertEquals("pending", (r as PartnerHubRows.Reinstatement.Open).status)
        assertTrue(r.label.contains("waiting for a reviewer"))
        assertFalse(model.choice("agency")!!.canApply)
    }

    // ── The rest of the mapping ──────────────────────────────────────────────

    @Test fun `a recommended request is still open`() {
        val r = PartnerHubRows.reinstatementFor("recommended", "")
        assertTrue(r is PartnerHubRows.Reinstatement.Open)
    }

    @Test fun `a request kept revoked offers a new one and says why`() {
        val model = PartnerHubRows.build(
            elig(revoked = listOf(agencyRevoked.copy(appealId = "ra_1", appealStatus = "kept_revoked"))),
            appeals = listOf(
                PartnerFunctions.RoleAppeal("ra_1", "agency", "p_ag1", "kept_revoked", "s", "t", "Evidence confirmed."),
            ),
        )
        assertEquals(
            PartnerHubRows.Reinstatement.CanRequest(lastDeclined = true, note = "Evidence confirmed."),
            model.revoked.single().reinstatement,
        )
    }

    @Test fun `a status this build does not know offers no second request`() {
        val r = PartnerHubRows.reinstatementFor("escalated", "")
        assertTrue(r is PartnerHubRows.Reinstatement.Open)
        assertEquals(PartnerHubRows.Reinstatement.Restored, PartnerHubRows.reinstatementFor("restored", ""))
    }

    @Test fun `a request the eligibility read did not carry is taken from my requests`() {
        val model = PartnerHubRows.build(
            elig(revoked = listOf(agencyRevoked)),
            appeals = listOf(PartnerFunctions.RoleAppeal("ra_9", "agency", "p_ag1", "pending", "s", "t", "")),
        )
        assertTrue(model.revoked.single().reinstatement is PartnerHubRows.Reinstatement.Open)
    }

    @Test fun `a revoked Host is a revoked row, not a Host chip and not an application`() {
        val model = PartnerHubRows.build(elig(isHost = false, hostStatus = "revoked", options = listOf("host", "seller")))
        assertTrue(model.held.isEmpty())
        val row = model.revoked.single()
        assertEquals("host", row.kind)
        assertEquals("Host · Revoked", row.title)
        assertFalse(model.choice("host")!!.canApply)
        assertTrue(model.choice("seller")!!.canApply)
    }

    @Test fun `a revoked record the list did not name still reads as revoked`() {
        val model = PartnerHubRows.build(
            elig(held = listOf(PartnerFunctions.HeldRole("seller", "revoked", "p_s1", "S", revokedReason = "Chargebacks"))),
        )
        assertEquals("Coin Seller · Revoked", model.revoked.single().title)
        assertEquals("Chargebacks", model.revoked.single().reason)
        assertFalse(model.choice("seller")!!.canApply)
        assertTrue(model.held.isEmpty())
    }

    @Test fun `nothing revoked changes nothing`() {
        val e = elig(options = listOf("host", "seller"), blocked = mapOf("agency" to "x", "sub_agency" to "y"))
        val model = PartnerHubRows.build(e)
        assertTrue(model.revoked.isEmpty())
        assertFalse(PartnerHubRows.hasRevoked(e))
        assertTrue(model.choice("host")!!.canApply)
        assertFalse(model.choice("agency")!!.canApply)
        assertEquals("x", model.choice("agency")!!.blockedReason)
    }

    // ── The parser, fed the API's own shape (C1) ─────────────────────────────

    @Test fun `eligibility parses revoked roles and a revoked host is not a host`() {
        val response: Map<String, Any?> = mapOf(
            "options" to listOf("seller"),
            "blocked" to mapOf("agency" to "Your Agency role was revoked. Request reinstatement instead of applying again."),
            "held" to mapOf(
                "internal" to "",
                "partners" to listOf(
                    mapOf("id" to "p_ag1", "kind" to "agency", "status" to "revoked", "name" to "Star",
                        "parent_id" to null, "revoked_at" to "2026-10-01T10:00:00Z", "revoked_reason" to "Fraud"),
                ),
                "host" to mapOf("agency_id" to "a1", "parent_kind" to "agency", "verified" to true,
                    "status" to "revoked", "revoked_at" to "2026-10-02T10:00:00Z"),
            ),
            "revoked" to listOf(
                mapOf("kind" to "agency", "record_id" to "p_ag1", "revoked_at" to "2026-10-01T10:00:00Z",
                    "reason" to "Fraud", "appeal" to mapOf("id" to "ra_1", "status" to "pending")),
                mapOf("kind" to "host", "record_id" to "uid1", "revoked_at" to "2026-10-02T10:00:00Z",
                    "reason" to "", "appeal" to null),
            ),
        )
        val e = PartnerFunctions.parseEligibility(response)
        assertFalse("a revoked Host is not a Host", e.isHost)
        assertEquals("revoked", e.hostStatus)
        assertEquals(2, e.revoked.size)
        assertEquals(PartnerFunctions.RevokedRole("agency", "p_ag1", "2026-10-01T10:00:00Z", "Fraud", "ra_1", "pending"), e.revoked[0])
        assertEquals("", e.revoked[1].appealStatus)
        assertEquals("Fraud", e.held.single().revokedReason)

        val model = PartnerHubRows.build(e)
        assertTrue(model.revoked.first { it.kind == "agency" }.reinstatement is PartnerHubRows.Reinstatement.Open)
        assertTrue(model.revoked.first { it.kind == "host" }.reinstatement is PartnerHubRows.Reinstatement.CanRequest)
    }

    @Test fun `an active host record is still a host, and an older response parses as before`() {
        val e = PartnerFunctions.parseEligibility(
            mapOf(
                "options" to listOf("sub_agency", "seller"),
                "held" to mapOf("partners" to emptyList<Any>(), "host" to mapOf("parent_kind" to "agency", "status" to "active")),
            ),
        )
        assertTrue(e.isHost)
        assertTrue(e.revoked.isEmpty())
        val legacy = PartnerFunctions.parseEligibility(
            mapOf("held" to mapOf("host" to mapOf("parent_kind" to "agency"))),
        )
        assertTrue("a host record with no status is a live Host", legacy.isHost)
    }

    @Test fun `a role appeal parses its public fields`() {
        val a = PartnerFunctions.parseRoleAppeal(
            mapOf("id" to "ra_7", "kind" to "seller", "record_id" to "p_s1", "status" to "kept_revoked",
                "statement" to "I was not involved", "created_at" to "2026-10-03T00:00:00Z",
                "decision" to mapOf("outcome" to "keep_revoked", "note" to "Confirmed by audit")),
        )
        assertEquals(PartnerFunctions.RoleAppeal("ra_7", "seller", "p_s1", "kept_revoked",
            "I was not involved", "2026-10-03T00:00:00Z", "Confirmed by audit"), a)
        assertEquals("ra_8", PartnerFunctions.parseRoleAppeal(mapOf("_id" to "ra_8")).id)
    }

    // ── The statement bounds (20–2,000, trimmed) ─────────────────────────────

    @Test fun `the reinstatement statement must be 20 to 2000 characters, trimmed`() {
        assertFalse(RoleAppealStatement.isSendable("x".repeat(RoleAppealStatement.MIN - 1)))
        assertTrue(RoleAppealStatement.isSendable("x".repeat(RoleAppealStatement.MIN)))
        assertTrue(RoleAppealStatement.isSendable("x".repeat(RoleAppealStatement.MAX)))
        assertFalse(RoleAppealStatement.isSendable("x".repeat(RoleAppealStatement.MAX + 1)))
        assertFalse("padding does not count", RoleAppealStatement.isSendable("   " + "x".repeat(19) + "\n\n"))
        assertEquals(RoleAppealStatement.TOO_SHORT, RoleAppealStatement.problem("too short"))
        assertEquals(RoleAppealStatement.TOO_LONG, RoleAppealStatement.problem("x".repeat(2001)))
        assertNull(RoleAppealStatement.problem("x".repeat(20)))
        assertEquals(20, RoleAppealStatement.MIN)
        assertEquals(2000, RoleAppealStatement.MAX)
    }

    // ── Wiring, pinned at the source (extra guard) ───────────────────────────

    private val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
    private fun src(rel: String) = File(main, "com/zipper/app/$rel").readText()

    @Test fun `the hub uses the mapping, refreshes on return and after a request`() {
        val hub = src("ui/screens/partner/PartnerHubScreen.kt")
        assertTrue(hub.contains("PartnerHubRows.build(elig, state.roleAppeals)"))
        assertTrue(hub.contains("if (event == Lifecycle.Event.ON_RESUME) viewModel.onResumed()"))
        assertFalse("the four choices must not read options directly", hub.contains("val allowed = role.kind in elig.options"))
        val vm = src("ui/screens/partner/PartnerHubViewModel.kt")
        val submit = vm.substring(vm.indexOf("fun submitAppeal()"))
        assertTrue(submit.contains("RoleAppealStatement.problem("))
        assertTrue(submit.contains("refresh()"))
        val fns = src("data/repository/PartnerFunctions.kt")
        assertTrue(fns.contains("call(\"submitRoleAppeal\", mapOf(\"kind\" to kind, \"statement\" to statement))"))
        assertTrue(fns.contains("call(\"myRoleAppeals\", emptyMap())"))
    }

    @Test fun `the Host card never offers an agency role (B36)`() {
        val profile = src("ui/screens/profile/MyProfileScreen.kt")
        assertFalse(profile.contains("Add an agency, sub-agency or coin seller role."))
        assertTrue(profile.contains("\"Add a sub-agency or coin seller role.\""))
    }
}

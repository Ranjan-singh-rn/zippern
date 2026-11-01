package com.zipper.app.data.work

import com.zipper.app.data.repository.PartnerFunctions
import com.zipper.app.ui.screens.partner.PartnerHubRows
import com.zipper.app.util.CallBilling
import com.zipper.app.util.HostSuspension
import com.zipper.app.util.ServerRefusals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/**
 * Spec §5 HOST ROLE SUSPENSION on Android, as pure functions:
 *
 *   * the Work hub — capabilities (`GET /api/auth/me`) → who is offered
 *     Suspend / Resume Host (`can_approve_kyc`, as `routers/users.py` gates
 *     the two routes); the Host row the server reported for the account
 *     (`GET /users/{uid}/roles`) → which of the two applies; the route and the
 *     body each sends; the server's bounds (reason ≥ 10, days 1–365);
 *   * the host's side — the sentence a suspended host is shown, word for word
 *     the server's, and that it is never treated as a session refusal.
 */
class HostSuspensionActionsTest {

    private val allPerms = Perm::class.java.declaredFields.filter { it.type == String::class.java }.map { it.get(null) as String }

    private fun staff(role: String, perms: List<String>, admin: Boolean = false, team: String? = null) =
        Caps(uid = "s1", role = role, team = team, permissions = perms.toSet(), isInternal = true, isTeamAdmin = admin, canWrite = true)

    private val owner = Caps(uid = "o1", role = "owner", permissions = allPerms.toSet(), isInternal = true, isOwner = true, canWrite = true)
    private val opsAdmin = staff("ops_admin", listOf(Perm.VIEW_USERS, Perm.VIEW_AGENCIES, Perm.APPROVE_KYC, Perm.VIEW_SELLERS,
        Perm.APPROVE_SELLER, Perm.VIEW_FINANCE, Perm.CREATE_TICKETS, Perm.ASSIGN_TICKETS, Perm.CLOSE_TICKETS, Perm.MANAGE_TEAM),
        admin = true, team = "ops")
    private val appAdmin = staff("app_admin", listOf(Perm.VIEW_USERS, Perm.BAN_USERS, Perm.ADJUST_BALANCE, Perm.VIEW_AGENCIES,
        Perm.VIEW_SELLERS, Perm.VIEW_FINANCE, Perm.APP_CONFIG, Perm.CREATE_TICKETS, Perm.ASSIGN_TICKETS, Perm.CLOSE_TICKETS,
        Perm.MANAGE_TEAM, Perm.MONITOR_LIVE), admin = true, team = "app")
    private val supportMember = staff("support_member", listOf(Perm.VIEW_USERS, Perm.CREATE_TICKETS, Perm.ASSIGN_TICKETS), team = "support")
    private val observer = Caps(uid = "observer:x", role = "observer", isInternal = true, isObserver = true, canWrite = false)
    private val agency = Caps(uid = "a1", role = "agency", isExternal = true, partnerIds = mapOf("agency" to "AG1"), partnerStatus = "approved")

    private val record: WorkModule get() = WorkModules.byId("users.record") ?: error("no users.record module")
    private val suspendHost: WorkAction get() = record.pageActions.single { it.id == "user.suspendHost" }
    private val resumeHost: WorkAction get() = record.pageActions.single { it.id == "user.resumeHost" }

    /** The body `GET /users/{uid}/roles` answers with: one Host row in [hostStatus] (none when null), plus [others]. */
    private fun roles(hostStatus: String?, vararg others: Pair<String, String>): Item = mapOf(
        "uid" to "H1",
        "held_count" to 1L,
        "roles" to listOfNotNull(hostStatus?.let { mapOf("role" to "host", "label" to "Host", "status" to it) }) +
            others.map { (role, status) -> mapOf("role" to role, "id" to "P1", "status" to status) },
    )

    /** Which of the two the page would show [c] for this record. */
    private fun offered(root: Item, c: Caps = owner): List<String> =
        listOf(suspendHost, resumeHost).filter { it.gate(c) && it.showFor(root, c) }.map { it.id }

    private val why = "Repeated no-shows on booked calls this week."

    @Test fun `can_approve_kyc is offered both, and nobody else is offered either`() {
        for (c in listOf(owner, opsAdmin)) {
            assertTrue("${c.role} suspends", suspendHost.gate(c))
            assertTrue("${c.role} resumes", resumeHost.gate(c))
        }
        for (c in listOf(appAdmin, supportMember, observer, agency)) {
            assertFalse("${c.role} must not suspend a Host role", suspendHost.gate(c))
            assertFalse("${c.role} must not resume a Host role", resumeHost.gate(c))
        }
        // The same capability as revoking the role beside it, and on the screen every internal session opens.
        val revoke = record.pageActions.single { it.id == "user.revokeHost" }
        for (c in listOf(owner, opsAdmin, appAdmin, supportMember, observer, agency)) {
            assertEquals(c.role, revoke.gate(c), suspendHost.gate(c))
        }
        assertTrue(record.gate(supportMember) && !record.gate(agency))
    }

    @Test fun `the Host row the server reported decides which one applies`() {
        assertEquals(listOf("user.suspendHost"), offered(roles("active")))
        assertEquals(listOf("user.resumeHost"), offered(roles("suspended")))
        assertEquals(listOf("user.resumeHost"), offered(roles("suspended"), opsAdmin))
        assertEquals("a revoked Host is reinstated, never resumed", emptyList<String>(), offered(roles("revoked")))
        assertEquals("an application is not a role", emptyList<String>(), offered(roles("pending")))
        assertEquals("no Host record", emptyList<String>(), offered(roles(null, "seller" to "approved")))
        assertEquals("a suspended PARTNER row is not the Host row", emptyList<String>(), offered(roles(null, "agency" to "suspended")))
        assertEquals("nothing before the record has loaded", emptyList<String>(), offered(emptyMap()))
        assertEquals("never for a session without the capability", emptyList<String>(), offered(roles("active"), supportMember))
        // The reading itself.
        assertEquals("suspended", hostRoleStatus(roles("suspended", "seller" to "approved")))
        assertEquals("active", hostRoleStatus(roles("active", "agency" to "suspended")))
        assertEquals("", hostRoleStatus(roles(null)))
        assertEquals("", hostRoleStatus(mapOf("roles" to "not a list")))
    }

    @Test fun `each sends exactly what routers users reads, to its own route`() {
        assertEquals(ActionKind.Api, suspendHost.kind)
        assertEquals("POST", suspendHost.method)
        assertEquals("/api/users/{param:uid}/suspend-host", suspendHost.path)
        assertEquals("/api/users/{param:uid}/resume-host", resumeHost.path)
        assertEquals("POST", resumeHost.method)
        assertTrue("suspending is the dangerous one", suspendHost.danger && !resumeHost.danger)
        assertTrue(suspendHost.confirm.isNotBlank() && resumeHost.confirm.isNotBlank())
        assertEquals("/api/users/H1/suspend-host",
            WorkTemplate.render(suspendHost.path, roles("active"), record.idPath, mapOf("uid" to "H1"), owner))
        assertEquals(listOf("reason", "days"), suspendHost.inputs.map { it.key })
        assertEquals(listOf("reason"), resumeHost.inputs.map { it.key })
        // `HostSuspend {reason, days?}` and `Reason {reason}`.
        assertEquals(mapOf("reason" to why, "days" to 7L), WorkForm.body(suspendHost.inputs, mapOf("reason" to why, "days" to "7")))
        assertEquals("blank days = until resumed, so it is not sent",
            mapOf("reason" to why), WorkForm.body(suspendHost.inputs, mapOf("reason" to why, "days" to "")))
        assertEquals(mapOf("reason" to "Term served early."),
            WorkForm.body(resumeHost.inputs, mapOf("reason" to "Term served early.")))
    }

    @Test fun `the server's bounds are checked before sending`() {
        assertTrue("a reason under ten characters is refused",
            WorkForm.validate(suspendHost.inputs, mapOf("reason" to "too short")).containsKey("reason"))
        assertTrue(WorkForm.validate(suspendHost.inputs, mapOf("reason" to why)).isEmpty())
        assertTrue("0 days", WorkForm.validate(suspendHost.inputs, mapOf("reason" to why, "days" to "0")).containsKey("days"))
        assertTrue("366 days", WorkForm.validate(suspendHost.inputs, mapOf("reason" to why, "days" to "366")).containsKey("days"))
        assertTrue("not a number", WorkForm.validate(suspendHost.inputs, mapOf("reason" to why, "days" to "seven")).containsKey("days"))
        assertTrue("1 and 365 are fine", WorkForm.validate(suspendHost.inputs, mapOf("reason" to why, "days" to "1")).isEmpty() &&
            WorkForm.validate(suspendHost.inputs, mapOf("reason" to why, "days" to "365")).isEmpty())
        assertTrue("resuming needs a reason", WorkForm.validate(resumeHost.inputs, emptyMap()).containsKey("reason"))
        assertTrue(WorkForm.validate(resumeHost.inputs, mapOf("reason" to "Lifted.")).isEmpty())
    }

    @Test fun `a suspended host reads the server's sentence, word for word`() {
        val until = Instant.parse("2026-11-04T10:15:00Z").toEpochMilli()
        assertEquals("Your Host role is suspended until 04 Nov 2026, 10:15 UTC — reason: Repeated no-shows.",
            HostSuspension.message(until, "Repeated no-shows."))
        assertEquals("Your Host role is suspended until it is resumed — reason: Under review.",
            HostSuspension.message(null, "Under review."))
        assertEquals("0 is indefinite, never 1 January 1970",
            "Your Host role is suspended until it is resumed — reason: x", HostSuspension.message(0L, "x"))
        assertEquals("a blank reason drops the suffix", "Your Host role is suspended until it is resumed",
            HostSuspension.message(null, "  "))
        assertEquals("09 Sep 2026, 00:05 UTC", HostSuspension.whenUtc(Instant.parse("2026-09-09T00:05:00Z").toEpochMilli()))
        // From the account's own document: only a Host whose flag is set.
        assertEquals(HostSuspension.message(until, "r"), HostSuspension.messageFor(true, true, until, "r"))
        assertNull(HostSuspension.messageFor(isHost = true, hostSuspended = false, untilMs = until, reason = "r"))
        assertNull(HostSuspension.messageFor(isHost = false, hostSuspended = true, untilMs = until, reason = "r"))
        // The callable refusal is recognised — and it is NOT a session refusal (no sign-out).
        assertTrue(HostSuspension.isRefusal("HOST_ROLE_SUSPENDED"))
        assertFalse(HostSuspension.isRefusal("ACCOUNT_RESTRICTED"))
        assertFalse(HostSuspension.isRefusal(null))
        assertNull(ServerRefusals.classify(HostSuspension.CODE))
        // A call the server ended for it: the payer is not told why.
        val payer = CallBilling.endMessage(CallBilling.END_HOST_SUSPENDED, isPayer = true)!!
        assertFalse(payer.contains("suspend", ignoreCase = true))
        assertTrue(CallBilling.endMessage(CallBilling.END_HOST_SUSPENDED, isPayer = false)!!.contains("Host role is suspended"))
        // The partner hub: still a Host (the role is held), shown as suspended.
        val elig = PartnerFunctions.Eligibility(options = emptyList(), blocked = emptyMap(), held = emptyList(), isHost = true,
            hostAgencyKind = "agency", pendingHostApplicationId = "", hostStatus = "suspended")
        assertEquals(listOf("Host · under an agency · suspended"), PartnerHubRows.build(elig).held)
        val parsed = PartnerFunctions.parseEligibility(
            mapOf("held" to mapOf("host" to mapOf("parent_kind" to "agency", "status" to "suspended"))),
        )
        assertTrue("a suspended Host still holds the role", parsed.isHost)
        assertEquals("suspended", parsed.hostStatus)
    }
}

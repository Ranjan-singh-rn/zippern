package com.zipper.app.data.work

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * APK 20 part 2 — CRM / mobile Work-hub parity for the routes added this
 * week, as PURE functions: capabilities (`GET /api/auth/me`) → the modules
 * and actions a session is offered; the sessions screen's row mapping; the
 * held-items envelope; the §5 ban body; and the source pins that keep access
 * on the server's word (no local role booleans gate a work screen).
 */
class WorkParityTest {

    private val allPerms = Perm::class.java.declaredFields.filter { it.type == String::class.java }.map { it.get(null) as String }

    private fun staff(role: String, perms: List<String>, admin: Boolean = false, team: String? = null) =
        Caps(uid = "s1", role = role, team = team, permissions = perms.toSet(), isInternal = true, isTeamAdmin = admin, canWrite = true)

    private val owner = Caps(uid = "o1", role = "owner", permissions = allPerms.toSet(), isInternal = true, isOwner = true, canWrite = true)
    private val observer = Caps(uid = "observer:x", role = "observer", isInternal = true, isObserver = true, canWrite = false)
    private val appAdmin = staff("app_admin", listOf(Perm.VIEW_USERS, Perm.BAN_USERS, Perm.ADJUST_BALANCE, Perm.VIEW_AGENCIES, Perm.VIEW_SELLERS,
        Perm.VIEW_FINANCE, Perm.APP_CONFIG, Perm.CREATE_TICKETS, Perm.ASSIGN_TICKETS, Perm.CLOSE_TICKETS, Perm.MANAGE_TEAM, Perm.MONITOR_LIVE),
        admin = true, team = "app")
    private val appMember = staff("app_member", listOf(Perm.VIEW_USERS, Perm.BAN_USERS, Perm.CREATE_TICKETS, Perm.MONITOR_LIVE), team = "app")
    private val opsAdmin = staff("ops_admin", listOf(Perm.VIEW_USERS, Perm.VIEW_AGENCIES, Perm.APPROVE_KYC, Perm.VIEW_SELLERS, Perm.APPROVE_SELLER,
        Perm.VIEW_FINANCE, Perm.CREATE_TICKETS, Perm.ASSIGN_TICKETS, Perm.CLOSE_TICKETS, Perm.MANAGE_TEAM), admin = true, team = "ops")
    private val opsMember = staff("ops_member", listOf(Perm.VIEW_AGENCIES, Perm.VIEW_SELLERS, Perm.CREATE_TICKETS), team = "ops")
    private val financeAdmin = staff("finance_admin", listOf(Perm.VIEW_USERS, Perm.ADJUST_BALANCE, Perm.VIEW_AGENCIES, Perm.VIEW_SELLERS,
        Perm.COIN_OPERATIONS, Perm.VIEW_FINANCE, Perm.PROCESS_PAYOUT, Perm.CREATE_TICKETS, Perm.ASSIGN_TICKETS, Perm.CLOSE_TICKETS, Perm.MANAGE_TEAM),
        admin = true, team = "finance")
    private val financeMember = staff("finance_member", listOf(Perm.VIEW_AGENCIES, Perm.VIEW_SELLERS, Perm.COIN_OPERATIONS, Perm.VIEW_FINANCE,
        Perm.PROCESS_PAYOUT, Perm.CREATE_TICKETS), team = "finance")
    private val supportMember = staff("support_member", listOf(Perm.VIEW_USERS, Perm.CREATE_TICKETS, Perm.ASSIGN_TICKETS), team = "support")
    private val techMember = staff("tech_member", listOf(Perm.ECONOMY_CONFIG, Perm.COMMISSION_SLABS, Perm.APP_CONFIG, Perm.CREATE_TICKETS), team = "tech")
    private val agency = Caps(uid = "a1", role = "agency", isExternal = true, partnerIds = mapOf("agency" to "AG1"), partnerStatus = "approved")
    private val seller = Caps(uid = "b1", role = "seller", isExternal = true, partnerIds = mapOf("seller" to "SL1"), partnerStatus = "approved")
    private val dual = Caps(uid = "d1", role = "agency", isExternal = true, partnerIds = mapOf("agency" to "AG2", "seller" to "SL2"), partnerStatus = "approved")
    /** An Agency that was revoked while the Coin Seller stayed live: the server grants the seller scope only. */
    private val sellerAfterAgencyRevoked = Caps(uid = "d2", role = "seller", isExternal = true, partnerIds = mapOf("seller" to "SL3"), partnerStatus = "approved")
    private val pending = Caps(uid = "p1", role = "agency", isExternal = true, partnerStatus = "pending")

    private fun module(id: String) = WorkModules.byId(id) ?: error("no module $id")
    private fun offered(c: Caps) = WorkModules.all.filter { it.gate(c) }.map { it.id }.toSet()
    private fun actions(moduleId: String, c: Caps, item: Item = emptyMap()) =
        module(moduleId).let { m -> (m.actions + m.pageActions).filter { it.gate(c) && it.showFor(item, c) }.map { it.id }.toSet() }

    // ── The capability → module / action mapping ────────────────────────────

    @Test fun `appeals - can_ban_users recommends, nobody decides on mobile, everyone internal reads the restriction`() {
        val pendingAppeal = mapOf("id" to "ap1", "status" to "pending", "restriction" to mapOf("state" to "banned", "category" to "fraud"))
        for (c in listOf(owner, appAdmin, appMember)) {
            assertTrue("${c.role} reads appeals", "accountAppeals" in offered(c))
            assertTrue("${c.role} recommends", "appeal.recommend" in actions("accountAppeals", c, pendingAppeal))
            assertTrue("${c.role} sees the CRM-only marker", "appeal.decide" in actions("accountAppeals", c, pendingAppeal))
        }
        for (c in listOf(opsAdmin, opsMember, financeMember, supportMember, techMember, observer)) {
            assertTrue("${c.role} reads appeals", "accountAppeals" in offered(c))
            assertFalse("${c.role} must not recommend", "appeal.recommend" in actions("accountAppeals", c, pendingAppeal))
        }
        val decide = module("accountAppeals").actions.single { it.id == "appeal.decide" }
        assertEquals("the decision is a read-only marker, never a call", ActionKind.Info, decide.kind)
        assertTrue(decide.help.endsWith("Decide in the CRM."))
        assertTrue("the decide route is NOT called from mobile",
            (module("accountAppeals").actions + module("accountAppeals").pageActions).none { it.kind == ActionKind.Api && it.path.endsWith("/decide") })
        val recommend = module("accountAppeals").actions.single { it.id == "appeal.recommend" }
        assertEquals("/api/users/appeals/{item:id}/recommend", recommend.path)
        assertEquals(listOf("outcome", "note"), recommend.inputs.map { it.key })
        assertEquals(setOf("uphold", "overturn"), recommend.inputs[0].options.map { it.first }.toSet())
        assertEquals(10, recommend.inputs[1].minLen)
        // The body the server reads (routers/users.py `AppealRecommendation`).
        assertEquals(mapOf("outcome" to "overturn", "note" to "The ban cites a report that was dismissed."),
            WorkForm.body(recommend.inputs, mapOf("outcome" to "overturn", "note" to "The ban cites a report that was dismissed.")))
        assertTrue(WorkForm.validate(recommend.inputs, mapOf("outcome" to "uphold", "note" to "too short")).containsKey("note"))
        // Decided appeals offer neither.
        assertFalse("appeal.recommend" in actions("accountAppeals", appAdmin, mapOf("status" to "upheld")))
        assertFalse("appeal.decide" in actions("accountAppeals", appAdmin, mapOf("status" to "upheld")))
        // The restriction block the rows carry is shown, evidence paths are not dumped.
        val paths = module("accountAppeals").detail.map { it.path }
        for (p in listOf("restriction.state", "restriction.category", "restriction.scope", "restriction.evidence", "restriction.decidedByName",
            "recommendation.outcome", "recommendation.note")) assertTrue(p, p in paths)
        assertTrue("evidence" in module("accountAppeals").hide)
    }

    @Test fun `ban carries scope, category and evidence exactly as routers users Ban reads them`() {
        val ban = module("users.record").pageActions.single { it.id == "user.ban" }
        assertEquals("/api/users/{param:uid}/ban", ban.path)
        assertEquals(listOf("reason", "scope", "category", "evidence"), ban.inputs.map { it.key })
        assertEquals(setOf("account", "account_and_devices"), ban.inputs[1].options.map { it.first }.toSet())
        assertEquals("the default is what a ban has always done", "account_and_devices", ban.inputs[1].default)
        assertEquals(InputType.Lines, ban.inputs[3].type)
        assertEquals(10L, ban.inputs[3].max)
        val values = mapOf("reason" to "Payment fraud across three accounts", "scope" to "account", "category" to "fraud",
            "evidence" to "report:r1\nreport:r2\n\n https://x/y ")
        assertTrue(WorkForm.validate(ban.inputs, values).isEmpty())
        assertEquals(mapOf("reason" to "Payment fraud across three accounts", "scope" to "account", "category" to "fraud",
            "evidence" to listOf("report:r1", "report:r2", "https://x/y")), WorkForm.body(ban.inputs, values))
        // Blank category and evidence are simply absent: the server's defaults apply.
        assertEquals(mapOf("reason" to "Spam links", "scope" to "account_and_devices"),
            WorkForm.body(ban.inputs, mapOf("reason" to "Spam links", "scope" to "account_and_devices", "category" to "", "evidence" to "")))
        assertTrue(WorkForm.validate(ban.inputs, values + ("evidence" to (1..11).joinToString("\n") { "r$it" })).containsKey("evidence"))
        // Gate: the ban permission, as the route declares.
        for (c in listOf(owner, appAdmin, appMember)) assertTrue(c.role, ban.gate(c))
        for (c in listOf(opsAdmin, financeAdmin, supportMember, observer, agency)) assertFalse(c.role, ban.gate(c))
        // The live-room ban takes the same body.
        assertEquals(ban.inputs.map { it.key }, module("live.rooms").actions.single { it.id == "live.ban" }.inputs.map { it.key })
    }

    @Test fun `warning history - every internal session reads it, can_view_users issues from it`() {
        val m = module("users.warnings")
        assertEquals("/api/users/{param:uid}/warnings", (m.source as Source.Api).path)
        for (c in listOf(owner, appAdmin, opsMember, supportMember, techMember, observer)) assertTrue(c.role, m.gate(c))
        for (c in listOf(agency, seller)) assertFalse(c.role, m.gate(c))
        assertTrue("warnings.warn" in actions("users.warnings", supportMember))
        assertFalse("warnings.warn" in actions("users.warnings", opsMember))
        assertFalse("warnings.warn" in actions("users.warnings", observer))
        val warn = m.pageActions.single { it.id == "warnings.warn" }
        assertEquals("/api/users/{param:uid}/warn", warn.path)
        assertEquals("{uuid}", warn.fixed["request_id"])
        // The stored warning: `deduction{currency, amount, status}` and the card written back as `deductionCardId`.
        assertTrue(m.detail.any { it.path == "deductionCardId" })
        assertTrue(m.detail.any { it.path == "deduction.status" })
        assertFalse("not on the stored warning", m.detail.any { it.path == "deduction.card_id" || it.path == "deduction.card_stage" })
        val users = src("backend/app/services/users.py")
        assertTrue(users.contains("{\"deductionCardId\": card[\"id\"]}") && users.contains("\"status\": \"requested\","))
        // A deduction is a nested body the server reads as `Warn.deduction`.
        assertEquals(mapOf("reason" to "Abusive messages", "deduction" to mapOf("currency" to "beans", "amount" to 500L)),
            WorkForm.body(warn.inputs, mapOf("reason" to "Abusive messages", "deduction.currency" to "beans", "deduction.amount" to "500")))
        assertTrue("an amount without a currency is not asked for",
            WorkForm.validate(warn.inputs, mapOf("reason" to "Abusive messages", "deduction.currency" to "")).isEmpty())
        assertTrue("the user record links here", module("users.record").pageActions.any { it.id == "user.warnings" && it.target?.moduleId == "users.warnings" })
    }

    @Test fun `departments and reports-to - any internal session, the vacancy label is the server's`() {
        val m = module("departments")
        assertEquals("/api/staff/departments", (m.source as Source.Api).path)
        for (c in listOf(owner, observer, opsMember, techMember)) assertTrue(c.role, m.gate(c))
        for (c in listOf(agency, seller, pending)) assertFalse(c.role, m.gate(c))
        assertTrue(m.actions.isEmpty() && m.pageActions.isEmpty())
        val filled = Departments.transform(mapOf("team" to "ops", "label" to "Operations", "vacancy" to false,
            "admins" to listOf(mapOf("uid" to "u1", "name" to "Asha"))))
        assertEquals("Asha", filled["admin_label"])
        assertEquals("Filled", filled["seat_label"])
        val vacant = Departments.transform(mapOf("team" to "finance", "label" to "Finance", "vacancy" to true, "admins" to emptyList<Any>(),
            "vacancy_since" to "2026-10-30T09:00:00Z", "vacancy_cause" to "admin deactivated"))
        assertEquals("Owner (vacancy)", vacant["admin_label"])
        assertEquals(Departments.VACANT, vacant["seat_label"])
        // The label is the server's own sentence (`staff.REPORTS_TO_OWNER_VACANCY`), and the server's `vacancy` wins.
        assertTrue(src("backend/app/services/staff.py").contains("REPORTS_TO_OWNER_VACANCY = \"${Departments.OWNER_VACANCY}\""))
        assertEquals("u9", Departments.transform(mapOf("vacancy" to false, "admins" to listOf(mapOf("uid" to "u9", "name" to ""))))["admin_label"])
        assertEquals(Departments.OWNER_VACANCY, Departments.transform(mapOf("vacancy" to true, "admins" to listOf(mapOf("uid" to "u9", "name" to "Ravi"))))["admin_label"])
        // The staff roster shows the RESOLVED line, never a raw uid of whoever invited them.
        val staff = module("staff")
        assertTrue(staff.detail.any { it.path == "reports_to_resolved.label" })
        assertFalse(staff.detail.any { it.path == "reports_to" })
        assertTrue(staff.subtitle.any { it.path == "reports_to_resolved.label" })
    }

    @Test fun `transfers show the recommendation and the hold the route serves`() {
        val m = module("transfers")
        val paths = m.detail.map { it.path }
        // `transfer_requests.view`: `recommendation.by` is the filer's `{uid, role}` (no name is stored).
        for (p in listOf("recommendation.by.uid", "recommendation.by.role", "recommendation.note", "recommendation.at", "hold", "hold.at")) assertTrue(p, p in paths)
        assertFalse("recommendation.by.name" in paths)
        assertEquals(FieldKind.Uid, m.detail.single { it.path == "recommendation.by.uid" }.kind)
        val svc = src("backend/app/services/transfer_requests.py")
        assertTrue(svc.contains("\"by\": doc.get(\"requested_by\") or {},"))
        assertTrue(svc.contains("return {\"uid\": str(actor.get(\"uid\", \"\")), \"role\": str(actor.get(\"role\", \"\"))}"))
        assertTrue(svc.contains("\"status\": str(doc.get(\"status\") or \"frozen\"),"))
        assertTrue(m.subtitle.any { it.path == "hold.status" })
        // Filing stays with can_approve_kyc; deciding stays the Owner's (unchanged).
        assertTrue("transfer.new" in actions("transfers", opsAdmin))
        assertFalse("transfer.decide" in actions("transfers", opsAdmin, mapOf("status" to "pending")))
        assertTrue("transfer.decide" in actions("transfers", owner, mapOf("status" to "pending")))
    }

    @Test fun `held items - can_process_payout reads, finance admin or an owner releases, the type comes from the array`() {
        val m = module("heldItems")
        val src = m.source as Source.Api
        assertEquals("/api/partner-ops/held-items", src.path)
        assertEquals(listOf("cards", "recharges", "sales", "subagency_payouts"), src.arrayKeys)
        for (c in listOf(owner, financeAdmin, financeMember)) assertTrue(c.role, m.gate(c))
        for (c in listOf(appAdmin, opsAdmin, observer, agency, seller, techMember)) assertFalse(c.role, m.gate(c))
        val held = mapOf("id" to "c9", "held" to mapOf("reason" to "role_revoked", "partner_id" to "AG1"))
        assertTrue("held.release" in actions("heldItems", financeAdmin, held))
        assertTrue("held.release" in actions("heldItems", owner, held))
        assertFalse("a finance member reads the list but the service refuses the release", "held.release" in actions("heldItems", financeMember, held))
        assertFalse("released rows offer nothing", "held.release" in actions("heldItems", financeAdmin,
            mapOf("id" to "c9", "held" to mapOf("reason" to "role_revoked", "released_at" to "2026-10-31T00:00:00Z"))))
        // The rows of the envelope, each tagged, each typed for the release route.
        val body = mapOf(
            "cards" to listOf(mapOf("id" to "c1", "title" to "Commission payout", "held" to mapOf("reason" to "role_revoked"))),
            "recharges" to listOf(mapOf("id" to "r1", "seller_name" to "S Ltd")),
            "sales" to emptyList<Any>(),
            "subagency_payouts" to listOf(mapOf("id" to "p1", "sub_name" to "Sub A")),
            "total" to 3L,
        )
        val rows = WorkRows.rows(body, src).map(m.rowTransform!!)
        assertEquals(listOf("card", "recharge", "subagency_payout"), rows.map { it["held_type"] })
        assertEquals(listOf("Commission payout", "Recharge · S Ltd", "Sub-agency payout · Sub A"), rows.map { it["held_title"] })
        val release = m.actions.single { it.id == "held.release" }
        assertEquals("/api/partner-ops/held-items/card/c1/release",
            WorkTemplate.render(release.path, rows[0], m.idPath, emptyMap(), financeAdmin))
        assertEquals("/api/partner-ops/held-items/subagency_payout/p1/release",
            WorkTemplate.render(release.path, rows[2], m.idPath, emptyMap(), financeAdmin))
        assertEquals(5, release.inputs.single().minLen)
        assertEquals("subagency_payout", HeldItems.typeOf("subagency_payouts"))
        assertEquals(emptyList<Item>(), WorkRows.rows(mapOf("total" to 0L), src))
    }

    @Test fun `held items read the marker release_hold writes`() {
        val paths = module("heldItems").detail.map { it.path }
        for (p in listOf("held.reason", "held.partner_id", "held.at", "held.by.name", "held.released_at", "held.released_by.name", "held.release_reason")) {
            assertTrue(p, p in paths)
        }
        assertFalse("held.released_reason" in paths)
        val freeze = src("backend/app/services/money_freeze.py")
        assertTrue(freeze.contains("\"held.released_by\": _who(actor),") && freeze.contains("\"held.release_reason\": reason,"))
        assertTrue(freeze.contains("return {\"uid\": str(a.get(\"uid\") or \"\"), \"name\": str(a.get(\"name\") or \"\"), \"role\": str(a.get(\"role\") or \"\")}"))
        // The envelope tag is plumbing, never shown as a field.
        assertTrue(WorkDisplay.isHidden("__from"))
        assertEquals("card", HeldItems.transform(mapOf("__from" to "cards", "id" to "x"))["held_type"])
        assertEquals("", HeldItems.transform(mapOf("id" to "x"))["held_type"])
    }

    @Test fun `replica drift reads a balances row as it is stored`() {
        val m = module("replicaDrift")
        val paths = (m.detail + m.subtitle).map { it.path }.toSet()
        for (p in listOf("holder_type", "holder_id", "currency", "amount", "replica_pending", "replica_stale_at")) assertTrue(p, p in paths)
        for (p in listOf("owner_uid", "balance", "replica_error")) assertFalse("no such key on a balances row: $p", p in paths)
        val money = src("backend/app/services/money.py")
        assertTrue(money.contains("\"\$set\": {\"replica_stale\": True, \"replica_stale_at\": now},"))
        assertTrue(money.contains("return int(doc[\"amount\"]) if doc else 0"))
    }

    @Test fun `an appeal recommendation reads the fields recommend_appeal stores`() {
        val paths = module("accountAppeals").detail.map { it.path }
        for (p in listOf("recommendation.outcome", "recommendation.note", "recommendation.byName", "recommendation.byRole", "recommendation.at")) {
            assertTrue(p, p in paths)
        }
        assertFalse("recommendation.by.name" in paths)
        val appeals = src("backend/app/services/appeals.py")
        assertTrue(appeals.contains("\"byName\": str(actor.get(\"name\", \"\")),") && appeals.contains("\"byRole\": str(actor.get(\"role\", \"\")),"))
        assertTrue(appeals.contains("\"decidedByName\": str(user.get(f\"{verb}ByName\") or \"\"),"))
    }

    @Test fun `a second role is the partner's own application brought into the queue, never a staff grant`() {
        val all = WorkModules.all.flatMap { it.actions + it.pageActions }
        assertTrue("spec §4: no staff role-grant control", all.none { it.path.contains("grant-capability") })
        val second = module("partners.directory").actions.single { it.id == "partner.secondRole" }
        assertEquals("/api/partner-ops/partners/{item:id}/second-role", second.path)
        assertEquals(listOf("new_partner_id", "reason"), second.inputs.map { it.key })
        assertTrue(second.confirm.isNotBlank())
        for (c in listOf(owner, opsAdmin)) assertTrue(c.role, second.gate(c))
        for (c in listOf(opsMember, financeAdmin, appAdmin, observer, agency)) assertFalse(c.role, second.gate(c))
        val ops = src("backend/app/routers/partner_ops.py")
        assertTrue(ops.contains("new_partner_id: str = Field(min_length=1, max_length=200)"))
        assertTrue(src("zipper-crm/lib/apiPartners.ts").contains("`/partner-ops/partners/\${encodeURIComponent(id)}/second-role`"))
    }

    @Test fun `replica drift and payout policy are reads`() {
        val drift = module("replicaDrift")
        assertEquals("/api/partner-ops/money/replica-drift", (drift.source as Source.Api).path)
        for (c in listOf(owner, financeAdmin, financeMember)) assertTrue(c.role, drift.gate(c))
        for (c in listOf(appAdmin, opsAdmin, observer, seller)) assertFalse(c.role, drift.gate(c))
        assertTrue("no repair from mobile", (drift.actions + drift.pageActions).none { it.path.contains("repair") })
        assertTrue(drift.actions.isEmpty() && drift.pageActions.isEmpty())
        val policy = module("reports.payoutPolicy")
        assertEquals("/api/reports/payout-policy", (policy.source as Source.Api).path)
        for (c in listOf(owner, observer, opsMember, financeMember)) assertTrue(c.role, policy.gate(c))
        assertFalse(policy.gate(agency))
    }

    @Test fun `owner fast path is a CRM-only marker on the money board, for owners, on undecided cards`() {
        val fast = module("cards.board").actions.single { it.id == "card.fastPath" }
        assertEquals(ActionKind.Info, fast.kind)
        assertTrue(fast.showFor(mapOf("stage" to "requested"), owner))
        assertFalse(fast.showFor(mapOf("stage" to "requested"), financeAdmin))
        assertFalse(fast.showFor(mapOf("stage" to "executed"), owner))
        assertTrue("the fast-path route is never called from mobile", WorkModules.all.flatMap { it.actions + it.pageActions }
            .none { it.kind == ActionKind.Api && it.path.contains("owner-fast-path") })
    }

    // ── Sessions / sign out everywhere ──────────────────────────────────────

    @Test fun `sessions - offered to every signed-in work account, partners included; the observer gets no write`() {
        val m = module("sessions")
        assertEquals("/api/auth/sessions", (m.source as Source.Api).path)
        for (c in listOf(owner, observer, appAdmin, opsMember, techMember, agency, seller, dual, pending)) assertTrue(c.role, m.gate(c))
        val revokes = m.pageActions.filter { it.path == "/api/auth/sessions/revoke-all" }
        assertEquals(2, revokes.size)
        assertEquals(setOf(false, true), revokes.map { it.fixed["include_current"] }.toSet())
        for (c in listOf(owner, agency, seller, opsMember)) assertEquals(c.role, setOf("sessions.revokeOthers", "sessions.revokeAll"), actions("sessions", c))
        assertEquals(emptySet<String>(), actions("sessions", observer))
        revokes.forEach { assertTrue(it.danger && it.confirm.isNotBlank() && it.inputs.isEmpty()) }
        // The body is exactly `{include_current}`.
        assertEquals(mapOf("include_current" to false), WorkForm.body(revokes[0].inputs, emptyMap(), revokes[0].fixed))
    }

    @Test fun `sessions - a row maps to what the screen shows, never a token`() {
        val row = mapOf("id" to "a1b2c3d4", "current" to true, "client" to "android", "ip" to "49.37.1.2",
            "user_agent" to "Zipper/20 (Android 14; Pixel 7) " + "x".repeat(80), "issued_at" to "2026-10-31T08:00:00+00:00",
            "expires_at" to "2026-11-07T08:00:00+00:00", "last_active_at" to "2026-11-01T07:59:00+00:00", "mfa_verified" to true, "renewed" to false)
        val shown = SessionRows.transform(row)
        assertEquals("Zipper app (Android) — this device", shown["title"])
        assertEquals("current, two-step verified", shown["state"])
        assertTrue((shown["where"] as String).startsWith("49.37.1.2 · Zipper/20 (Android 14; Pixel 7)"))
        assertTrue((shown["where"] as String).endsWith("…"))
        val crm = SessionRows.transform(mapOf("id" to "e5f6", "current" to false, "client" to "crm", "mfa_verified" to false, "renewed" to true))
        assertEquals("CRM (browser)", crm["title"])
        assertEquals("two-step pending, renewed", crm["state"])
        assertEquals("—", crm["where"])
        val unknown = SessionRows.transform(mapOf("id" to "9", "client" to "unknown", "mfa_verified" to null))
        assertEquals("Unknown client", unknown["title"])
        assertEquals("live", unknown["state"])
        assertEquals("Unknown client", SessionRows.clientLabel(null))
        assertEquals("ios", SessionRows.clientLabel(" ios "))
        // Nothing on the row mapping or the detail list names a token.
        assertFalse(shown.keys.any { it.contains("token") })
        assertTrue(module("sessions").detail.none { it.path.contains("token") })
        assertTrue(WorkDisplay.isHidden("token"))
    }

    // ── Multi-role partners ─────────────────────────────────────────────────

    @Test fun `a dual-role login is offered both portals, a revoked agency never hides a live seller`() {
        val both = offered(dual)
        assertTrue(both.containsAll(listOf("agency.statement", "agency.hosts", "seller.statement", "seller.history", "partner.records", "sessions")))
        assertEquals(listOf("Agency", "Coin Seller"), dual.heldPartnerRoles)
        assertEquals("Agency, Coin Seller · Approved", dual.roleSummary)
        val sellerOnly = offered(sellerAfterAgencyRevoked)
        assertTrue(sellerOnly.containsAll(listOf("seller.statement", "seller.history", "sales", "recharges", "partner.records")))
        assertFalse(sellerOnly.any { it.startsWith("agency.") })
        assertEquals("Coin Seller · Approved", sellerAfterAgencyRevoked.roleSummary)
        assertFalse(sellerAfterAgencyRevoked.isPendingPartner)
        // Every live record of the login is listed with its own status on "My partner records".
        val records = module("partner.records")
        assertTrue(records.subtitle.any { it.path == "status" && it.kind == FieldKind.Status })
        assertEquals("status", records.statusPath)
        assertEquals("Owner", owner.roleSummary)
        assertEquals("Ops Member · ops", opsMember.roleSummary)
        assertEquals("Agency · Pending", pending.roleSummary)
    }

    // ── The role matrix for the parity document ─────────────────────────────

    @Test fun `every role is offered what the matrix says`() {
        val expectModules = mapOf(
            "owner" to listOf("accountAppeals", "heldItems", "replicaDrift", "sessions", "departments", "users.warnings", "transfers", "reports.payoutPolicy"),
            "finance_admin" to listOf("heldItems", "replicaDrift", "sessions", "departments", "users.warnings", "accountAppeals"),
            "finance_member" to listOf("heldItems", "replicaDrift", "sessions", "departments", "accountAppeals"),
            "app_admin" to listOf("accountAppeals", "sessions", "departments", "users.warnings", "live.rooms"),
            "app_member" to listOf("accountAppeals", "sessions", "departments", "users.warnings"),
            "ops_admin" to listOf("transfers", "roleAppeals", "sessions", "departments", "accountAppeals"),
            "support_member" to listOf("users.warnings", "sessions", "departments"),
            "agency" to listOf("sessions", "partner.records", "agency.statement"),
            "seller" to listOf("sessions", "partner.records", "seller.statement"),
        )
        val sessions = mapOf("owner" to owner, "finance_admin" to financeAdmin, "finance_member" to financeMember, "app_admin" to appAdmin,
            "app_member" to appMember, "ops_admin" to opsAdmin, "support_member" to supportMember, "agency" to agency, "seller" to seller)
        for ((role, mods) in expectModules) {
            val got = offered(sessions.getValue(role))
            for (m in mods) assertTrue("$role → $m", m in got)
        }
        val notFor = mapOf(
            "app_admin" to listOf("heldItems", "replicaDrift", "transfers"),
            "ops_admin" to listOf("heldItems", "replicaDrift"),
            "support_member" to listOf("heldItems", "transfers", "roleAppeals"),
            "agency" to listOf("accountAppeals", "heldItems", "departments", "users.warnings", "staff"),
            "seller" to listOf("accountAppeals", "heldItems", "departments", "users.warnings", "staff"),
        )
        for ((role, mods) in notFor) {
            val got = offered(sessions.getValue(role))
            for (m in mods) assertFalse("$role must not see $m", m in got)
        }
    }

    // ── Per-role counts, from the server's own permission table ────────────

    /** `roles.PERMISSIONS`, read from the backend source: role → permission keys. */
    private fun permissionTable(): Map<String, Set<String>> {
        val roles = src("backend/app/core/roles.py")
        val all = Regex("""^\s+CAN_[A-Z_]+ = "(can_[a-z_]+)"""", RegexOption.MULTILINE).findAll(roles).map { it.groupValues[1] }.toSet()
        val start = roles.indexOf("PERMISSIONS: dict[Role, frozenset[Permission]] = {")
        val block = roles.substring(start, roles.indexOf("\n}\n", start))
        val entries = Regex("""^\s*Role\.([A-Z_]+):\s*frozenset\(""", RegexOption.MULTILINE).findAll(block).toList()
        return entries.mapIndexed { i, m ->
            val body = block.substring(m.range.last, if (i + 1 < entries.size) entries[i + 1].range.first else block.length)
            val perms = if (body.contains("ALL_PERMISSIONS")) all
                else Regex("""Permission\.CAN_([A-Z_]+)""").findAll(body).map { "can_" + it.groupValues[1].lowercase() }.toSet()
            m.groupValues[1].lowercase() to perms
        }.toMap()
    }

    /** What `GET /auth/me` (`roles.capability_profile`) answers for [role]. */
    private fun me(role: String, table: Map<String, Set<String>>, ids: Map<String, String> = emptyMap()): Caps {
        val internal = role == "owner" || role == "observer" || role.endsWith("_admin") || role.endsWith("_member")
        val external = role == "agency" || role == "seller"
        return Caps(uid = "u-$role", role = role, team = if (role.contains('_')) role.substringBefore('_') else null,
            permissions = table[role].orEmpty(), isInternal = internal, isExternal = external,
            isOwner = role == "owner", isObserver = role == "observer", isTeamAdmin = role.endsWith("_admin"),
            canWrite = internal && role != "observer", partnerIds = if (external) ids else emptyMap(),
            partnerStatus = if (external) (if (ids.isEmpty()) "pending" else "approved") else null)
    }

    private fun kindOf(a: WorkAction) = when (a.kind) {
        ActionKind.Api -> if (a.method == "GET") "read" else "write"
        ActionKind.FirestoreUpdate, ActionKind.FirestoreCreate -> "write"
        ActionKind.Info -> "crm-only"
        ActionKind.Navigate, ActionKind.OpenUrl -> "link"
    }

    /** [screens, writes, reads, links, CRM-only markers] — distinct action ids, by gate (the row state aside). */
    private fun counts(c: Caps): List<Int> {
        val offered = WorkModules.all.filter { it.gate(c) }
        val kinds = LinkedHashMap<String, String>()
        for (m in offered) for (a in m.actions + m.pageActions) if (a.gate(c)) kinds.getOrPut(a.id) { kindOf(a) }
        return listOf(offered.size) + listOf("write", "read", "link", "crm-only").map { k -> kinds.values.count { it == k } }
    }

    @Test fun `the per-role counts in the parity document are the code's`() {
        val table = permissionTable()
        assertEquals("the server's sixteen roles", 16, table.size)
        assertEquals(allPerms.toSet(), table.getValue("owner"))
        assertTrue(table.getValue("observer").isEmpty() && table.getValue("agency").isEmpty())
        val staffRoles = listOf("owner", "observer") + listOf("app", "ops", "finance", "tech", "support", "marketing")
            .flatMap { listOf("${it}_admin", "${it}_member") }
        val sessions = LinkedHashMap<String, Caps>()
        staffRoles.forEach { sessions[it] = me(it, table) }
        sessions["agency"] = me("agency", table, mapOf("agency" to "AG1"))
        sessions["seller"] = me("seller", table, mapOf("seller" to "SL1"))
        sessions["agency+seller"] = me("agency", table, mapOf("agency" to "AG2", "seller" to "SL2"))
        sessions["pending partner"] = me("agency", table)

        val doc = listOf(File("../docs/WORK-HUB-PARITY-2026-11.md"), File("docs/WORK-HUB-PARITY-2026-11.md"),
            File(repoRoot, "zipper-app/docs/WORK-HUB-PARITY-2026-11.md")).first { it.exists() }.readText()
        val block = doc.substringAfter("<!-- role-counts:begin -->").substringBefore("<!-- role-counts:end -->")
        val documented = block.lines().filter { it.startsWith("| `") }.associate { line ->
            val cells = line.trim().trim('|').split('|').map { it.trim() }
            cells[0].trim('`') to cells.drop(1).take(5).map { it.toInt() }
        }
        assertEquals(sessions.keys.toList(), documented.keys.toList())
        // Written next to the test report so a change of module or gate shows the new table to paste.
        val table2 = sessions.entries.joinToString("\n") { (name, c) -> "| `$name` | " + counts(c).joinToString(" | ") + " |" }
        File("build").mkdirs()
        File("build/work-hub-role-counts.md").writeText(table2 + "\n")
        for ((name, c) in sessions) assertEquals("$name (see build/work-hub-role-counts.md)", documented.getValue(name), counts(c))
        // The observer is offered reads only; a partner never a staff screen.
        assertEquals(0, counts(sessions.getValue("observer"))[1])
        assertEquals(0, counts(sessions.getValue("agency"))[4])
    }

    @Test fun `sessions are offered on the server's word, and the observer gets no write`() {
        val m = module("sessions")
        assertFalse("an empty /me answer is offered nothing", m.gate(Caps()))
        assertFalse(m.gate(Caps.from(mapOf("uid" to "x", "role" to "owner"))))
        assertTrue(m.gate(Caps.from(mapOf("uid" to "x", "role" to "agency", "is_external" to true))))
        val revoke = m.pageActions.first()
        assertFalse(revoke.gate(observer))
        assertTrue(revoke.gate(pending))
    }

    // ── Source pins ─────────────────────────────────────────────────────────

    private val repoRoot: File = generateSequence(File("").absoluteFile) { it.parentFile }
        .first { File(it, "backend/app/core/deps.py").exists() }
    private fun src(rel: String) = File(repoRoot, rel).readText()

    @Test fun `no work module is gated by a local boolean - every gate reads the capabilities the server sent`() {
        val dir = File(repoRoot, "zipper-app/app/src/main/java/com/zipper/app/data/work")
        val files = dir.listFiles { f -> f.name.startsWith("Modules") && f.extension == "kt" }!!.map { it.name to it.readText() }
        assertTrue(files.size >= 8)
        for ((name, s) in files) {
            for (bad in listOf("BuildConfig.", "SharedPreferences", "DataStore", "FirebaseAuth", "isAgent", "isOfficial", "crmRole", "SessionManager")) {
                assertFalse("$name reads $bad instead of the server's capabilities", s.contains(bad))
            }
        }
        // Capabilities come from one place: the /me body, through Caps.from.
        val caps = src("zipper-app/app/src/main/java/com/zipper/app/data/work/Caps.kt")
        assertTrue(caps.contains("fun from(body: Any?): Caps"))
        assertTrue(caps.contains("isOwner = b(\"is_owner\")") && caps.contains("permissions = m[\"permissions\"]"))
        val repo = src("zipper-app/app/src/main/java/com/zipper/app/data/work/WorkRepository.kt")
        assertTrue(repo.contains("api.get(\"/api/auth/me\")") && repo.contains("Caps.from(r.body)"))
        // The hub lists only what the server's capability profile admits.
        val hub = src("zipper-app/app/src/main/java/com/zipper/app/ui/screens/work/WorkViewModels.kt")
        assertTrue(hub.contains("groups = WorkModules.offered(r.value)"))
        assertTrue(hub.contains("when (val r = repo.caps())"))
        // …and names every live role the session holds, each with the server's status.
        val screens = src("zipper-app/app/src/main/java/com/zipper/app/ui/screens/work/WorkScreens.kt")
        assertTrue(screens.contains("Text(caps.roleSummary,"))
        // No work screen or view-model reads a local role flag either.
        for ((name, s) in listOf("WorkScreens.kt" to screens, "WorkViewModels.kt" to hub)) {
            for (bad in listOf("isAgent", "isOfficial", "crmRole", "SessionManager", "BuildConfig.", "DataStore", "\"superadmin\"")) {
                assertFalse("$name reads $bad", s.contains(bad))
            }
        }
    }

    @Test fun `the new routes exist on the backend with the permission keys the gates mirror`() {
        val users = src("backend/app/routers/users.py")
        assertTrue(users.contains("\"/appeals/{appeal_id}/recommend\""))
        assertTrue(Regex("""/appeals/\{appeal_id\}/recommend",\s*dependencies=\[Depends\(require_permission\(Permission\.CAN_BAN_USERS\)\)\]""").containsMatchIn(users))
        assertTrue(users.contains("scope: str = Field(default=\"account_and_devices\", pattern=r\"^(account|account_and_devices)$\")"))
        assertTrue(users.contains("evidence: list[str] = Field(default_factory=list, max_length=10)"))
        val staff = src("backend/app/routers/staff.py")
        assertTrue(staff.contains("@router.get(\"/departments\")"))
        assertTrue(src("backend/app/services/staff.py").contains("REPORTS_TO_OWNER_VACANCY = \"Owner (vacancy)\""))
        val ops = src("backend/app/routers/partner_ops.py")
        assertTrue(ops.contains("@router.get(\"/held-items\")") && ops.contains("@router.post(\"/held-items/{item_type}/{item_id}/release\")"))
        assertTrue(ops.contains("@router.get(\"/money/replica-drift\")"))
        assertTrue(src("backend/app/services/money_freeze.py").contains("return R.is_owner_value(role) or role == str(R.Role.FINANCE_ADMIN)"))
        val auth = src("backend/app/routers/auth.py")
        assertTrue(auth.contains("@router.get(\"/sessions\")") && auth.contains("@router.post(\"/sessions/revoke-all\")"))
        assertTrue(auth.contains("client: str = Field(default=\"crm\", max_length=16)"))
        val deps = src("backend/app/core/deps.py")
        assertTrue(deps.contains("(\"GET\", \"/api/auth/sessions\")") && deps.contains("(\"POST\", \"/api/auth/sessions/revoke-all\")"))
        assertTrue(src("backend/app/services/transfer_requests.py").contains("\"recommendation\": {"))
        assertTrue(src("backend/app/routers/reports.py").contains("@router.get(\"/payout-policy\")"))
    }

    @Test fun `info markers send nothing and lines inputs become arrays`() {
        val info = crmOnly("x", "X (CRM)", "Why.")
        assertEquals(ActionKind.Info, info.kind)
        assertEquals("GET", info.method)
        assertEquals("", info.path)
        assertEquals("Why. Decide in the CRM.", info.help)
        assertEquals(listOf("a", "b"), WorkForm.lines(" a \n\nb\n"))
        assertEquals(emptyList<String>(), WorkForm.lines(""))
        val i = Input("refs", "Refs", InputType.Lines, required = false, max = 2, maxLen = 3)
        assertTrue(WorkForm.validate(listOf(i), mapOf("refs" to "a\nb\nc")).containsKey("refs"))
        assertTrue(WorkForm.validate(listOf(i), mapOf("refs" to "abcd")).containsKey("refs"))
        assertTrue(WorkForm.validate(listOf(i), mapOf("refs" to "")).isEmpty())
        assertNull(WorkForm.body(listOf(i), mapOf("refs" to ""))["refs"])
    }
}

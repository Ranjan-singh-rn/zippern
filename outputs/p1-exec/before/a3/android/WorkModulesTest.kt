package com.zipper.app.data.work

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Mobile parity — the declared work screens against the backend's own source.
 *
 * Reads every `backend/app/routers` file and `backend/app/core/deps.py` from the
 * repository so a typo in a route, a partner screen calling a route partners
 * cannot reach, or a write offered to a read-only session fails here rather
 * than on a phone. Also writes `build/work-parity-matrix.md` (role × screen).
 */
class WorkModulesTest {

    private val repoRoot: File = generateSequence(File("").absoluteFile) { it.parentFile }
        .first { File(it, "backend/app/core/deps.py").exists() }

    private fun src(rel: String) = File(repoRoot, rel).readText()

    /** (METHOD, normalised path) for every backend route. */
    private val routes: Set<Pair<String, String>> by lazy {
        val out = HashSet<Pair<String, String>>()
        File(repoRoot, "backend/app/routers").listFiles { f -> f.name.endsWith(".py") }!!.forEach { f ->
            val s = f.readText()
            val prefix = Regex("""APIRouter\(([^)]*)\)""").find(s)?.groupValues?.get(1)
                ?.let { Regex("""prefix\s*=\s*"([^"]*)"""").find(it)?.groupValues?.get(1) }.orEmpty()
            Regex("""@router\.(get|post|put|patch|delete)\(\s*"([^"]*)"""").findAll(s).forEach { m ->
                out += m.groupValues[1].uppercase() to norm("/api$prefix${m.groupValues[2]}")
            }
        }
        out
    }

    private val partnerReachable: Set<Pair<String, String>> by lazy {
        val s = src("backend/app/core/deps.py")
        val start = s.indexOf("PARTNER_REACHABLE")
        val block = s.substring(start, s.indexOf("})", start) + 2)
        Regex("""\(\s*"(GET|POST|PATCH|DELETE)"\s*,\s*"([^"]+)"\s*\)""").findAll(block)
            .map { it.groupValues[1] to norm(it.groupValues[2]) }.toSet()
    }

    private fun norm(p: String) = p.substringBefore('?').replace(Regex("""\{[^}]+\}"""), "{}")

    /** What a declared path calls, in route form: placeholders become `{}`. */
    private fun declared(path: String) = norm(path.replace("\$job", "{}"))

    private fun routeExists(method: String, path: String): Boolean {
        val p = declared(path)
        if ((method to p) in routes) return true
        // A fixed segment where the route has a parameter (`/documents/host/{id}` → `/documents/{kind}/{id}`).
        val parts = p.split('/')
        return routes.any { (m, r) ->
            m == method && r.split('/').let { rp -> rp.size == parts.size && rp.indices.all { i -> rp[i] == parts[i] || rp[i] == "{}" } }
        }
    }

    // ── Sessions to test with ───────────────────────────────────────────────
    private val allPerms = Perm::class.java.declaredFields.filter { it.type == String::class.java }.map { it.get(null) as String }

    private fun staff(role: String, perms: List<String>, admin: Boolean = false, team: String? = null) =
        Caps(uid = "s1", role = role, team = team, permissions = perms.toSet(), isInternal = true, isTeamAdmin = admin, canWrite = true)

    private val owner = Caps(uid = "o1", role = "owner", permissions = allPerms.toSet(), isInternal = true, isOwner = true, canWrite = true)
    private val observer = Caps(uid = "observer:x", role = "observer", isInternal = true, isObserver = true, canWrite = false)
    private val opsMember = staff("ops_member", listOf(Perm.VIEW_AGENCIES, Perm.VIEW_SELLERS, Perm.CREATE_TICKETS), team = "ops")
    private val agency = Caps(uid = "a1", role = "agency", isExternal = true, partnerIds = mapOf("agency" to "AG1"), partnerStatus = "approved")
    private val seller = Caps(uid = "b1", role = "seller", isExternal = true, partnerIds = mapOf("seller" to "SL1"), partnerStatus = "approved")
    private val pending = Caps(uid = "p1", role = "agency", isExternal = true, partnerStatus = "pending")

    // ── Registry integrity ──────────────────────────────────────────────────
    @Test fun `module ids are unique and every link resolves`() {
        val ids = WorkModules.all.map { it.id }
        assertEquals(ids.size, ids.toSet().size)
        val targets = WorkModules.all.flatMap { m ->
            m.detail.mapNotNull { it.link?.moduleId } + m.header.mapNotNull { it.link?.moduleId } +
                (m.actions + m.pageActions).mapNotNull { it.target?.moduleId }
        }
        targets.filterNot { it.startsWith("app.") }.forEach { assertTrue("link to $it", it in ids) }
    }

    @Test fun `every API route a screen calls exists on the backend`() {
        for (m in WorkModules.all) {
            (m.source as? Source.Api)?.let { assertTrue("${m.id}: GET ${it.path}", routeExists("GET", it.path)) }
            m.detailPath?.let { assertTrue("${m.id} detail: $it", routeExists("GET", it)) }
            for (a in m.actions + m.pageActions) if (a.kind == ActionKind.Api) {
                assertTrue("${m.id}/${a.id}: ${a.method} ${a.path}", routeExists(a.method, a.path))
            }
            m.pageActions.plus(m.actions).flatMap { it.inputs }.mapNotNull { it.lookup }.forEach {
                assertTrue("${m.id} lookup ${it.path}", routeExists("GET", it.path))
            }
        }
    }

    @Test fun `every write is behind a confirmation`() {
        for (m in WorkModules.all) for (a in m.actions + m.pageActions) {
            val writes = (a.kind == ActionKind.Api && a.method != "GET") || a.kind == ActionKind.FirestoreUpdate || a.kind == ActionKind.FirestoreCreate
            if (writes) assertTrue("${m.id}/${a.id} has no confirmation", a.confirm.isNotBlank())
        }
    }

    @Test fun `ticket screens write through the API, never Firestore (P1-D)`() {
        val ticketCollections = setOf("techTickets", "feedbackTickets", "supportTickets")
        val ticketModules = WorkModules.all.filter { (it.source as? Source.Firestore)?.collection in ticketCollections }
        assertEquals(3, ticketModules.size)
        for (m in ticketModules) for (a in m.actions + m.pageActions) {
            assertFalse("${m.id}/${a.id} writes Firestore directly",
                a.kind == ActionKind.FirestoreUpdate || a.kind == ActionKind.FirestoreCreate)
            if (a.kind == ActionKind.Api) assertTrue("${m.id}/${a.id}: ${a.path}", a.path.startsWith("/api/tickets/"))
            // Who acted comes from the session on the server — never sent from here.
            val sent = a.inputs.map { it.key } + a.fixed.keys
            assertFalse("${m.id}/${a.id} sends an actor name", sent.any { it.endsWith("ByName") || it.endsWith("reportedBy") })
        }
    }

    // ── Who is offered what ─────────────────────────────────────────────────
    private fun offeredWrites(c: Caps): List<String> = WorkModules.all.filter { it.gate(c) }.flatMap { m ->
        (m.actions + m.pageActions).filter { it.gate(c) }.filter {
            (it.kind == ActionKind.Api && it.method != "GET") || it.kind == ActionKind.FirestoreUpdate || it.kind == ActionKind.FirestoreCreate
        }.map { "${m.id}/${it.id}" }
    }

    @Test fun `the observer is offered reads only`() {
        assertEquals(emptyList<String>(), offeredWrites(observer))
    }

    @Test fun `a partner session only ever calls routes on the partner allowlist`() {
        assertTrue("allowlist parsed", partnerReachable.size >= 20)
        for (c in listOf(agency, seller)) {
            for (m in WorkModules.all.filter { it.gate(c) }) {
                assertFalse("${m.id} reads Firestore as a partner", m.source is Source.Firestore)
                (m.source as? Source.Api)?.let { assertTrue("${c.role} → ${m.id}: GET ${it.path}", ("GET" to declared(it.path)) in partnerReachable) }
                for (a in (m.actions + m.pageActions).filter { it.gate(c) && it.kind == ActionKind.Api }) {
                    assertTrue("${c.role} → ${m.id}/${a.id}: ${a.method} ${a.path}", (a.method to declared(a.path)) in partnerReachable)
                }
            }
        }
    }

    @Test fun `partners get their portals, not staff screens`() {
        val agencyMods = WorkModules.all.filter { it.gate(agency) }.map { it.id }.toSet()
        assertTrue(agencyMods.containsAll(listOf("agency.statement", "agency.hosts", "agency.subs", "agency.reports", "agency.appeals")))
        assertFalse(agencyMods.any { it.startsWith("seller.") || it == "users.search" || it == "cards.board" || it == "frozenMoney" })
        val sellerMods = WorkModules.all.filter { it.gate(seller) }.map { it.id }.toSet()
        assertTrue(sellerMods.containsAll(listOf("seller.statement", "seller.history", "sales", "recharges")))
        assertFalse(sellerMods.any { it.startsWith("agency.") })
        // A waiting applicant sees where they stand, and nothing with money in it.
        val pendingMods = WorkModules.all.filter { it.gate(pending) }.map { it.id }.toSet()
        assertTrue("partner.verification" in pendingMods)
        assertFalse(pendingMods.any { it.startsWith("agency.") || it.startsWith("seller.") })
    }

    @Test fun `owner-only decisions are offered to the owner only`() {
        val ownerOnly = listOf("roleAppeals/roleAppeal.decide", "transfers/transfer.decide", "frozenMoney/freeze.decide",
            "recharges/recharge.approve", "sales/sale.approve", "cards.board/card.sign", "approvals/approval.approve")
        val ownerWrites = offeredWrites(owner).toSet()
        ownerOnly.forEach { assertTrue("owner offered $it", it in ownerWrites) }
        val ops = staff("ops_admin", listOf(Perm.VIEW_USERS, Perm.VIEW_AGENCIES, Perm.APPROVE_KYC, Perm.VIEW_SELLERS,
            Perm.APPROVE_SELLER, Perm.VIEW_FINANCE, Perm.CREATE_TICKETS, Perm.ASSIGN_TICKETS, Perm.CLOSE_TICKETS, Perm.MANAGE_TEAM), admin = true, team = "ops")
        val opsWrites = offeredWrites(ops).toSet()
        ownerOnly.forEach { assertFalse("ops admin offered $it", it in opsWrites) }
        assertTrue("ops admin recommends reinstatements", "roleAppeals/roleAppeal.recommend" in opsWrites)
        assertTrue("ops admin decides host verification", "hostVerification/verify.review" in opsWrites)
    }

    @Test fun `a member without a permission is not offered its action`() {
        val writes = offeredWrites(opsMember).toSet()
        assertFalse(writes.any { it.endsWith("user.ban") || it.endsWith("appeal.decide") || it.endsWith("verify.review") })
    }

    @Test fun `app permission names are the server's`() {
        val roles = src("backend/app/core/roles.py")
        val server = Regex("""CAN_[A-Z_]+ = "(can_[a-z_]+)"""").findAll(roles).map { it.groupValues[1] }.toSet()
        assertEquals(server, allPerms.toSet())
    }

    // ── The matrix, for the parity report ───────────────────────────────────
    @Test fun `write the role-by-screen matrix`() {
        val sessions = linkedMapOf(
            "Owner" to owner, "Observer" to observer,
            "App admin" to staff("app_admin", listOf(Perm.VIEW_USERS, Perm.BAN_USERS, Perm.ADJUST_BALANCE, Perm.VIEW_AGENCIES,
                Perm.VIEW_SELLERS, Perm.VIEW_FINANCE, Perm.APP_CONFIG, Perm.CREATE_TICKETS, Perm.ASSIGN_TICKETS, Perm.CLOSE_TICKETS,
                Perm.MANAGE_TEAM, Perm.MONITOR_LIVE), admin = true, team = "app"),
            "Ops member" to opsMember,
            "Finance admin" to staff("finance_admin", listOf(Perm.VIEW_USERS, Perm.ADJUST_BALANCE, Perm.VIEW_AGENCIES, Perm.VIEW_SELLERS,
                Perm.COIN_OPERATIONS, Perm.VIEW_FINANCE, Perm.PROCESS_PAYOUT, Perm.CREATE_TICKETS, Perm.ASSIGN_TICKETS,
                Perm.CLOSE_TICKETS, Perm.MANAGE_TEAM), admin = true, team = "finance"),
            "Support member" to staff("support_member", listOf(Perm.VIEW_USERS, Perm.CREATE_TICKETS, Perm.ASSIGN_TICKETS), team = "support"),
            "Agency" to agency, "Coin seller" to seller, "Pending partner" to pending,
        )
        val sb = StringBuilder("| Screen | CRM | " + sessions.keys.joinToString(" | ") + " |\n|---|---|" + "---|".repeat(sessions.size) + "\n")
        for (m in WorkModules.all) {
            sb.append("| ${m.title} (`${m.id}`) | ${m.crm} | ")
            sb.append(sessions.values.joinToString(" | ") { c ->
                if (!m.gate(c)) "—" else {
                    val w = (m.actions + m.pageActions).count { a -> a.gate(c) && a.kind != ActionKind.Navigate && a.kind != ActionKind.OpenUrl && a.method != "GET" }
                    if (w > 0) "R+$w" else "R"
                }
            })
            sb.append(" |\n")
        }
        val out = File("build/work-parity-matrix.md")
        out.parentFile?.mkdirs()
        out.writeText(sb.toString())
        assertTrue(out.length() > 0)
    }
}

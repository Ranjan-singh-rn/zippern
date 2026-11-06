package com.zipper.app.data.work

import com.google.firebase.functions.FirebaseFunctions
import com.zipper.app.data.api.ApiClient
import com.zipper.app.data.repository.AuthRepository
import com.zipper.app.data.repository.MoneyFunctions
import com.zipper.app.util.SessionManager
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

    /**
     * [s] with every comment removed — line comments and block/KDoc comments
     * (nested, as Kotlin allows) — while code AND string contents are kept.
     * Source assertions about what code DOES run over this, so prose can
     * neither fail a check nor satisfy one. (P1-A3b: a KDoc that NAMED
     * `startMobileSession` to say it is never called failed a raw-text check.)
     * Aware of strings, raw strings, `${'$'}{}` templates, char literals and
     * backtick names, so a `//` inside "https://…" stays code.
     */
    private fun codeOnly(s: String): String {
        val out = StringBuilder(s.length)
        val stack = ArrayList<Char>().apply { add('c') } // c code · s string · r raw string · t template
        val depth = ArrayList<Int>()
        val n = s.length
        var i = 0
        while (i < n) {
            val ch = s[i]
            val nx = if (i + 1 < n) s[i + 1] else '\u0000'
            when (stack.last()) {
                'c', 't' -> {
                    if (ch == '/' && nx == '/') {
                        while (i < n && s[i] != '\n') i++
                        continue
                    }
                    if (ch == '/' && nx == '*') {
                        var level = 1
                        i += 2
                        while (i < n && level > 0) {
                            when {
                                s.startsWith("/*", i) -> { level++; i += 2 }
                                s.startsWith("*/", i) -> { level--; i += 2 }
                                else -> i++
                            }
                        }
                        out.append(' ')
                        continue
                    }
                    if (s.startsWith("\"\"\"", i)) { stack.add('r'); out.append("\"\"\""); i += 3; continue }
                    if (ch == '"') { stack.add('s'); out.append(ch); i++; continue }
                    if (ch == '`') {
                        val j = s.indexOf('`', i + 1)
                        val end = if (j >= 0) j else n - 1
                        out.append(s, i, end + 1); i = end + 1; continue
                    }
                    if (ch == '\'') {
                        val end = if (nx == '\\') s.indexOf('\'', i + 3).let { if (it >= 0) it else n - 1 }
                                  else minOf(i + 2, n - 1)
                        out.append(s, i, end + 1); i = end + 1; continue
                    }
                    if (stack.last() == 't' && ch == '{') {
                        depth[depth.size - 1] = depth.last() + 1
                    } else if (stack.last() == 't' && ch == '}') {
                        depth[depth.size - 1] = depth.last() - 1
                        if (depth.last() == 0) {
                            depth.removeAt(depth.size - 1); stack.removeAt(stack.size - 1)
                            out.append(ch); i++; continue
                        }
                    }
                }
                's' -> {
                    if (ch == '\\') { out.append(s, i, minOf(i + 2, n)); i += 2; continue }
                    if (ch == '"') { stack.removeAt(stack.size - 1); out.append(ch); i++; continue }
                    if (ch == '$' && nx == '{') { stack.add('t'); depth.add(1); out.append("\${"); i += 2; continue }
                }
                'r' -> {
                    if (s.startsWith("\"\"\"", i)) {
                        var j = i
                        while (j < n && s[j] == '"') j++
                        out.append(s, i, j); i = j; stack.removeAt(stack.size - 1); continue
                    }
                    if (ch == '$' && nx == '{') { stack.add('t'); depth.add(1); out.append("\${"); i += 2; continue }
                }
            }
            out.append(ch)
            i++
        }
        return out.toString()
    }

    @Test fun `codeOnly strips comments and nothing else`() {
        val stripped = codeOnly(
            "/** KDoc names startMobileSession */\n" +
                "val u = \"https://x\" // trailing comment: startMobileSession\n" +
                "/* outer /* nested startMobileSession */ still comment */ go()\n" +
                "val t = \"\${f(\"http://y\")}\"; keep()\n" +
                "val r = \"\"\" // raw, not a comment \"\"\"; raw()\n" +
                "val q = '\"'; quote()\n" +
                "fun `it's /* a name`() { named() }\n" +
                "call(\"startMobileSession\")",
        )
        assertFalse("comments are removed", stripped.contains("KDoc") || stripped.contains("trailing comment") || stripped.contains("nested"))
        for (kept in listOf("\"https://x\"", "go()", "keep()", "// raw, not a comment", "raw()", "quote()", "named()", "call(\"startMobileSession\")")) {
            assertTrue("kept: $kept", stripped.contains(kept))
        }
    }

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

    @Test fun `owner two-step sign-in is offered to owners only, and verify is a route ApiClient adopts (P1-A3)`() {
        val m = WorkModules.all.single { it.id == "owner.mfa" }
        assertTrue(m.gate(owner))
        for (c in listOf(observer, opsMember, agency, seller)) assertFalse("${c.role} offered owner MFA", m.gate(c))
        assertEquals(setOf("/api/auth/mfa/verify", "/api/auth/mfa/bind"), m.pageActions.map { it.path }.toSet())
        // ApiClient swaps in the session this route returns; the path must match exactly.
        assertTrue(src("zipper-app/app/src/main/java/com/zipper/app/data/api/ApiClient.kt")
            .contains("MFA_VERIFY = \"/api/auth/mfa/verify\""))
        // P1-A3b: the MFA calls carry this app's Firebase sign-in, and only they do.
        val client = src("zipper-app/app/src/main/java/com/zipper/app/data/api/ApiClient.kt")
        assertTrue(client.contains("path != MFA_VERIFY && path != MFA_ENROL_CONFIRM && path != MFA_BIND"))
        assertTrue(client.contains("\"firebase_id_token\" to idToken, \"client\" to \"android\""))
        assertTrue(client.contains("MFA_ENROL_CONFIRM = \"/api/auth/mfa/enrol/confirm\""))
        assertEquals("the token is attached in exactly the two send paths", 2,
            Regex("withFirebaseSignIn\\(method, path, body\\)").findAll(client).count())
        // The server accepts it on both routes.
        val auth = src("backend/app/routers/auth.py")
        assertTrue(auth.contains("firebase_id_token: str = Field(default=\"\", max_length=8192)"))
        // Every route a pending Owner session may reach exists in the server's own list.
        val pending = src("backend/app/services/owner_mfa.py")
        assertTrue(pending.contains("(\"POST\", \"/api/auth/mfa/verify\")"))
        assertTrue(pending.contains("(\"GET\", \"/api/auth/mfa/status\")"))
    }

    @Test fun `owner work uses a separate Firebase app and never the personal sign-in (P1-A3b)`() {
        // Selection is pure: ownerWork only for a confirmed session of the same person.
        assertTrue(OwnerWorkFirebase.selects("u1", "u1", "u1"))
        assertFalse(OwnerWorkFirebase.selects("u1", null, "u1"))        // redeemed, not confirmed
        assertFalse(OwnerWorkFirebase.selects("u1", "u1", null))        // ownerWork signed out
        assertFalse(OwnerWorkFirebase.selects("u2", "u1", "u1"))        // personal account changed
        assertFalse(OwnerWorkFirebase.selects(null, null, null))
        // CODE only (comments stripped): prose may describe these invariants
        // without failing or satisfying them. "Never starts a mobile session"
        // is proven by wiring in the next test, not by searching for a word.
        val owner = codeOnly(src("zipper-app/app/src/main/java/com/zipper/app/data/work/OwnerWorkFirebase.kt"))
        assertTrue("its own named FirebaseApp", owner.contains("FirebaseApp.initializeApp(context, FirebaseApp.getInstance().options, APP_NAME)"))
        assertTrue("its own FirebaseAuth, never the personal (default) instance",
            owner.contains("FirebaseAuth.getInstance(app)") && !owner.contains("FirebaseAuth.getInstance()"))
        assertTrue("signed out at every cold start", owner.contains("init {") && owner.contains("runCatching { auth.signOut() }"))
        val client = codeOnly(src("zipper-app/app/src/main/java/com/zipper/app/data/api/ApiClient.kt"))
        assertFalse("the personal FirebaseAuth is never signed in with the MFA custom token",
            Regex("""(?<!ownerWork\.)\bauth\.signInWithCustomToken""").containsMatchIn(client))
        assertFalse("the personal FirebaseAuth is never signed out by Owner work",
            Regex("""\bauth\.signOut\(""").containsMatchIn(client))
        assertTrue("the custom token is redeemed in ownerWork", client.contains("ownerWork.redeem(customToken)"))
        assertTrue("and confirmed with ITS ID token", client.contains("send(\"POST\", MFA_BIND_CONFIRM"))
        assertTrue("the custom token is stripped from what reaches a screen", client.contains("binding - \"custom_token\""))
        assertTrue("sign-out and account change drop ownerWork", Regex("ownerWork\\.signOut\\(\\)").findAll(client).count() >= 3)
        val repo = codeOnly(src("zipper-app/app/src/main/java/com/zipper/app/data/work/WorkRepository.kt"))
        assertTrue("the work layer resolves Firestore per call", repo.contains("get() = workFirestore.current()"))
    }

    /**
     * "Owner work never starts a backend mobile session" — proven by WIRING.
     * A mobile session is started only by the `startMobileSession` callable
     * (functions/src/identity.ts). The app reaches it only through
     * MoneyFunctions, only from AuthRepository's personal sign-in, and only on
     * a FirebaseFunctions instance bound to the DEFAULT FirebaseApp, so even
     * an indirect call carries the personal sign-in's token, never ownerWork's.
     */
    @Test fun `owner work never starts a backend mobile session (P1-A3b)`() {
        val mainRoot = File(repoRoot, "zipper-app/app/src/main/java")
        val code = mainRoot.walkTopDown().filter { it.isFile && it.extension == "kt" }
            .associate { it.relativeTo(mainRoot).invariantSeparatorsPath to codeOnly(it.readText()) }
        assertTrue("scanned the app sources", code.size > 50)
        val moneyFunctions = "com/zipper/app/data/repository/MoneyFunctions.kt"
        val authRepository = "com/zipper/app/data/repository/AuthRepository.kt"

        // 1. Only MoneyFunctions names the session callables.
        assertEquals(setOf(moneyFunctions),
            code.filterValues { it.contains("\"startMobileSession\"") || it.contains("\"endMobileSession\"") }.keys)
        // 2. Only AuthRepository (the personal sign-in) starts a session.
        assertEquals(setOf(authRepository),
            code.filter { (path, c) -> path != moneyFunctions && Regex("""\.startMobileSession\s*\(""").containsMatchIn(c) }.keys)
        // 3. Every FirebaseFunctions instance belongs to the DEFAULT app (region only, no FirebaseApp).
        val instances = code.values.flatMap { c ->
            Regex("""FirebaseFunctions\.getInstance\(([^)]*)\)""").findAll(c).map { it.groupValues[1].trim() }.toList()
        }
        assertTrue("a FirebaseFunctions provider exists", instances.isNotEmpty())
        assertTrue("FirebaseFunctions bound to another FirebaseApp: $instances",
            instances.all { it.isEmpty() || it.matches(Regex("\"[a-z0-9-]+\"")) })
        // 4. No Owner work component depends on the mobile-session machinery (its real DI graph).
        val forbidden = listOf(MoneyFunctions::class.java, FirebaseFunctions::class.java,
            AuthRepository::class.java, SessionManager::class.java)
        for (k in listOf(OwnerWorkFirebase::class.java, WorkFirestore::class.java, WorkRepository::class.java, ApiClient::class.java)) {
            val deps = k.declaredConstructors.flatMap { it.parameterTypes.asList() } + k.declaredFields.map { it.type }
            val bad = deps.filter { d -> forbidden.any { it.isAssignableFrom(d) } }
            assertTrue("${k.simpleName} depends on $bad", bad.isEmpty())
        }
        // 5. …and none of them names it in code.
        for (path in listOf("com/zipper/app/data/work/OwnerWorkFirebase.kt", "com/zipper/app/data/api/ApiClient.kt",
            "com/zipper/app/data/work/WorkRepository.kt")) {
            val c = code.getValue(path)
            for (name in listOf("startMobileSession", "endMobileSession", "MoneyFunctions", "FirebaseFunctions",
                "SessionManager", "AuthRepository")) {
                assertFalse("$path references $name in code", c.contains(name))
            }
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

    @Test fun `the paid seller approves or rejects their own recharge, staff do not get the seller buttons`() {
        val sellerWrites = offeredWrites(seller).toSet()
        assertTrue("recharges/recharge.sellerApprove" in sellerWrites)
        assertTrue("recharges/recharge.sellerReject" in sellerWrites)
        assertFalse("recharges/recharge.approve" in sellerWrites)
        val ownerWrites = offeredWrites(owner).toSet()
        assertFalse("recharges/recharge.sellerApprove" in ownerWrites)
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

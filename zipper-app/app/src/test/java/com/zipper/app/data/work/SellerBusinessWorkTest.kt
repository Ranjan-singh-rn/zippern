package com.zipper.app.data.work

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.UUID

/**
 * O3 (5 Nov 2026) — the coin seller's B9 business in the Work tab: margin and credit, borrowing within the limit,
 * buying from another seller, "I was not paid", self-use, and the staff trade desk.
 *
 * Pure: the declared modules, their gates and the bodies they send, against the backend's own request models
 * (read from `backend/app/routers/partner_ops.py`), so a renamed field fails here and not on a phone.
 */
class SellerBusinessWorkTest {

    private val allPerms = Perm::class.java.declaredFields.filter { it.type == String::class.java }.map { it.get(null) as String }
    private fun staff(role: String, perms: List<String>) =
        Caps(uid = "s1", role = role, permissions = perms.toSet(), isInternal = true, canWrite = true)

    private val owner = Caps(uid = "o1", role = "owner", permissions = allPerms.toSet(), isInternal = true, isOwner = true, canWrite = true)
    private val observer = Caps(uid = "observer:x", role = "observer", isInternal = true, isObserver = true, canWrite = false)
    private val financeMember = staff("finance_member", listOf(Perm.VIEW_AGENCIES, Perm.VIEW_SELLERS, Perm.COIN_OPERATIONS, Perm.VIEW_FINANCE))
    private val opsMember = staff("ops_member", listOf(Perm.VIEW_AGENCIES, Perm.VIEW_SELLERS, Perm.CREATE_TICKETS))
    private val seller = Caps(uid = "b1", role = "seller", isExternal = true, partnerIds = mapOf("seller" to "SL1"), partnerStatus = "approved")
    private val agency = Caps(uid = "a1", role = "agency", isExternal = true, partnerIds = mapOf("agency" to "AG1"), partnerStatus = "approved")
    private val pending = Caps(uid = "p1", role = "seller", isExternal = true, partnerStatus = "pending")

    private fun module(id: String) = WorkModules.byId(id) ?: error("no module $id")
    private fun action(moduleId: String, actionId: String) =
        module(moduleId).let { m -> (m.actions + m.pageActions).single { it.id == actionId } }
    private fun offered(c: Caps) = WorkModules.all.filter { it.gate(c) }.map { it.id }.toSet()

    private val repoRoot: File = generateSequence(File("").absoluteFile) { it.parentFile }
        .first { File(it, "backend/app/core/deps.py").exists() }

    /** The field names of a pydantic model in routers/partner_ops.py. */
    private fun modelFields(name: String): Set<String> {
        val s = File(repoRoot, "backend/app/routers/partner_ops.py").readText()
        val start = s.indexOf("class $name(BaseModel):")
        assertTrue("model $name exists", start >= 0)
        val body = s.substring(start).lines().drop(1).takeWhile { it.isBlank() || it.startsWith("    ") }
        return body.mapNotNull { Regex("""^\s{4}([a-z_]+):""").find(it)?.groupValues?.get(1) }.toSet()
    }

    /** What an action sends: its inputs at their keys plus its fixed fields (as WorkRepository renders them). */
    private fun sentKeys(a: WorkAction): Set<String> = (a.inputs.filter { !it.asQuery }.map { it.key } + a.fixed.keys).toSet()

    // ── Who sees what ───────────────────────────────────────────────────────

    @Test fun `a seller gets the business and trades screens, an agency or an applicant does not`() {
        assertTrue(offered(seller).containsAll(listOf("seller.business", "seller.trades", "seller.statement")))
        for (c in listOf(agency, pending)) {
            assertFalse("${c.role} offered seller.business", "seller.business" in offered(c))
            assertFalse("${c.role} offered seller.trades", "seller.trades" in offered(c))
        }
        assertFalse("the staff desk is not a partner screen", "sellerTrades" in offered(seller))
    }

    @Test fun `the seller can borrow, buy from another seller, use their own coins and report a trade not paid`() {
        for (id in listOf("seller.borrow", "trade.file", "seller.selfUse")) assertTrue(id, action("seller.business", id).gate(seller))
        assertTrue(action("seller.trades", "trade.file").gate(seller))
        assertTrue(action("seller.trades", "trade.dispute").gate(seller))
        // The seller never sets their own terms or decides a trade.
        assertFalse(action("seller.business", "seller.tier").gate(seller))
        assertFalse(action("seller.business", "seller.creditLimit").gate(seller))
        assertFalse(action("sellerTrades", "trade.approve").gate(seller))
        assertFalse(action("sellerTrades", "trade.reject").gate(seller))
    }

    @Test fun `staff - Owner sets terms and approves, Finance rejects, the observer and ops only read`() {
        assertTrue(action("seller.business", "seller.tier").gate(owner))
        assertTrue(action("seller.business", "seller.creditLimit").gate(owner))
        assertTrue(action("sellerTrades", "trade.approve").gate(owner))
        assertFalse(action("sellerTrades", "trade.approve").gate(financeMember))
        assertTrue(action("sellerTrades", "trade.reject").gate(financeMember))
        assertTrue("sellerTrades" in offered(financeMember) && "sellerTrades" in offered(observer))
        assertFalse("ops has no coin operations: no trade desk", "sellerTrades" in offered(opsMember))
        // Self-use is the seller's own wallet: the server refuses staff, so staff are not offered it.
        for (c in listOf(owner, financeMember)) assertFalse(action("seller.business", "seller.selfUse").gate(c))
        // The observer is offered nothing that writes.
        for (m in listOf("seller.business", "sellerTrades")) for (a in module(m).actions + module(m).pageActions) {
            assertFalse("observer offered ${a.id}", a.gate(observer))
        }
    }

    @Test fun `a trade can be reported not paid only by its selling seller, while pending and not yet reported`() {
        val dispute = action("seller.trades", "trade.dispute")
        val selling = mapOf("id" to "t1", "status" to "pending", "seller_id" to "SL1", "buyer_id" to "SL9")
        assertTrue(dispute.showFor(selling, seller))
        assertFalse("the buyer cannot report their own purchase", dispute.showFor(selling + ("seller_id" to "SL9") + ("buyer_id" to "SL1"), seller))
        assertFalse("already reported", dispute.showFor(selling + ("disputed" to true), seller))
        assertFalse("decided", dispute.showFor(selling + ("status" to "approved"), seller))
        val approve = action("sellerTrades", "trade.approve")
        assertTrue(approve.showFor(selling, owner))
        assertFalse("a reported trade cannot be approved", approve.showFor(selling + ("disputed" to true), owner))
        assertTrue("…but can be rejected", action("sellerTrades", "trade.reject").showFor(selling + ("disputed" to true), financeMember))
    }

    // ── The bodies match the server's models ────────────────────────────────

    @Test fun `every body is the backend request model, field for field`() {
        assertEquals(modelFields("SellerTradeFiling"), sentKeys(action("seller.business", "trade.file")))
        assertEquals(modelFields("BorrowRequest"), sentKeys(action("seller.business", "seller.borrow")))
        assertEquals(modelFields("SelfUse"), sentKeys(action("seller.business", "seller.selfUse")))
        assertEquals(modelFields("SellerTier"), sentKeys(action("seller.business", "seller.tier")))
        assertEquals(modelFields("CreditLimit"), sentKeys(action("seller.business", "seller.creditLimit")))
        for (id in listOf("trade.approve", "trade.reject")) assertEquals(modelFields("TradeDecision"), sentKeys(action("sellerTrades", id)))
        assertEquals(modelFields("TradeDecision"), sentKeys(action("seller.trades", "trade.dispute")))
    }

    @Test fun `a trade filing - rupees become paise, coins a number, and a fresh request id the server accepts`() {
        val a = action("seller.business", "trade.file")
        val values = mapOf("buyer_seller_id" to "SL1", "seller_seller_id" to "SL2", "coins" to "100000",
            "amount_paid_minor" to "850.50", "payment_ref" to "UTR123")
        assertTrue(WorkForm.validate(a.inputs, values).isEmpty())
        val body = WorkForm.body(a.inputs, values, mapOf("client_request_id" to "abc12345"))
        assertEquals(100000L, body["coins"])
        assertEquals(85050L, body["amount_paid_minor"])
        assertEquals("SL2", body["seller_seller_id"])
        // `{uuid}` is rendered as a UUID without dashes: 32 hex characters, inside CLIENT_REQUEST_ID.
        assertEquals("{uuid}", a.fixed["client_request_id"])
        val rendered = UUID.randomUUID().toString().replace("-", "")
        assertTrue(Regex("[A-Za-z0-9_-]{8,64}").matches(rendered))
        val svc = File(repoRoot, "backend/app/services/seller_business.py").readText()
        assertTrue(svc.contains("CLIENT_REQUEST_ID = re.compile(r\"[A-Za-z0-9_-]{8,64}\")"))
        // The buyer id defaults to this screen's seller (the session's own record for a seller).
        assertEquals("{param:seller_id}", a.inputs.single { it.key == "buyer_seller_id" }.default)
        assertEquals("SL1", WorkTemplate.render("{param:seller_id}", null, "id", mapOf("seller_id" to "SL1"), seller, encode = false))
        // Missing pieces are refused before anything is sent.
        assertTrue(WorkForm.validate(a.inputs, values - "payment_ref").containsKey("payment_ref"))
        assertTrue(WorkForm.validate(a.inputs, values + ("coins" to "0")).containsKey("coins"))
        assertTrue(WorkForm.validate(a.inputs, values + ("amount_paid_minor" to "12.345")).containsKey("amount_paid_minor"))
    }

    @Test fun `borrowing - 1 to 30 days, as the server bounds it`() {
        val a = action("seller.business", "seller.borrow")
        val ok = mapOf("coins" to "50000", "days" to "14", "reason" to "Festival week stock")
        assertTrue(WorkForm.validate(a.inputs, ok).isEmpty())
        assertTrue(WorkForm.validate(a.inputs, ok + ("days" to "0")).containsKey("days"))
        assertTrue(WorkForm.validate(a.inputs, ok + ("days" to "31")).containsKey("days"))
        assertTrue(WorkForm.validate(a.inputs, ok + ("reason" to "no")).containsKey("reason"))
        assertEquals(mapOf("coins" to 50000L, "days" to 14L, "reason" to "Festival week stock"), WorkForm.body(a.inputs, ok))
        val routers = File(repoRoot, "backend/app/routers/partner_ops.py").readText()
        assertTrue(routers.contains("days: int = Field(ge=1, le=30)"))
        assertEquals("14", a.inputs.single { it.key == "days" }.default)
    }

    @Test fun `every route is on the partner allowlist where a seller can reach it, and staff-only where not`() {
        val deps = File(repoRoot, "backend/app/core/deps.py").readText()
        for (r in listOf(
            "(\"GET\", \"/api/partner-ops/sellers/{seller_id}/profit\")",
            "(\"POST\", \"/api/partner-ops/sellers/{seller_id}/borrow-requests\")",
            "(\"POST\", \"/api/partner-ops/seller-trades\")",
            "(\"GET\", \"/api/partner-ops/seller-trades\")",
            "(\"POST\", \"/api/partner-ops/seller-trades/{trade_id}/dispute\")",
            "(\"POST\", \"/api/partner-ops/sellers/{seller_id}/self-use\")",
            "(\"POST\", \"/api/partner-ops/sellers/{seller_id}/repayment-requests\")",
        )) assertTrue(r, deps.contains(r))
        for (r in listOf("/seller-trades/{trade_id}/approve", "/seller-trades/{trade_id}/reject",
            "/sellers/{seller_id}/tier", "/sellers/{seller_id}/credit-limit")) {
            assertFalse("$r must stay staff-only", deps.contains("\"/api/partner-ops$r\""))
        }
    }

    // ── O7 (5 Nov 2026): paying back borrowed coins ─────────────────────────

    @Test fun `a seller pays back borrowed coins by payment or by returning stock, only while something is owed`() {
        val a = action("seller.business", "seller.repay")
        assertEquals("/api/partner-ops/sellers/{param:seller_id}/repayment-requests", a.path)
        assertTrue("the seller files it", a.gate(seller))
        assertTrue("staff with coin operations file it for a seller", a.gate(financeMember))
        assertFalse(a.gate(agency)); assertFalse(a.gate(opsMember)); assertFalse(a.gate(observer))
        assertTrue("offered while something is owed", a.showFor(mapOf("credit_outstanding" to 2000), seller))
        assertFalse("not when nothing is owed", a.showFor(mapOf("credit_outstanding" to 0), seller))
        assertFalse(a.showFor(emptyMap(), seller))
        // What it sends is exactly the server's model.
        assertEquals(modelFields("SellerRepayment"), sentKeys(a))
        val pay = mapOf("method" to "payment", "coins" to "2000", "amount_paid_minor" to "400", "payment_ref" to "UTR123",
            "reason" to "Paid by UPI")
        assertTrue(WorkForm.validate(a.inputs, pay).isEmpty())
        assertTrue("a payment needs its reference", WorkForm.validate(a.inputs, pay - "payment_ref").containsKey("payment_ref"))
        assertEquals(40000L, WorkForm.body(a.inputs, pay)["amount_paid_minor"])
        val ret = mapOf("method" to "return_coins", "coins" to "500", "reason" to "Unsold stock")
        assertTrue("a return needs no payment fields", WorkForm.validate(a.inputs, ret).isEmpty())
        assertEquals(mapOf("method" to "return_coins", "coins" to 500L, "reason" to "Unsold stock"), WorkForm.body(a.inputs, ret))
    }

    // ── Rows ────────────────────────────────────────────────────────────────

    @Test fun `a trade row says who bought from whom and carries the CRM's two flags`() {
        val r = sellerTradeRow(mapOf("id" to "t1", "status" to "pending", "buyer_name" to "Ravi Coins", "seller_id" to "SL2",
            "disputed" to true, "shortfall" to mapOf("available" to 10, "needed" to 100)))
        assertEquals("Ravi Coins bought from SL2", r["trade_line"])
        assertEquals("pending · not paid reported · seller short of coins", r["trade_state"])
        assertEquals("t1", r["id"])
        val plain = sellerTradeRow(mapOf("status" to "approved", "buyer_id" to "SL1", "seller_name" to "Asha Store"))
        assertEquals("SL1 bought from Asha Store", plain["trade_line"])
        assertEquals("approved", plain["trade_state"])
        // Total: an empty row still reads.
        assertEquals("? bought from ?", sellerTradeRow(emptyMap())["trade_line"])
        // Staff identities on a trade are not shown to the seller.
        val m = module("seller.trades")
        assertTrue(m.hide.containsAll(listOf("created_by", "approved_by", "rejected_by", "disputed_by", "history")))
        assertEquals("trade_state", m.statusPath)
    }

    @Test fun `the business screen reads the profit answer as a header, with no rows`() {
        val m = module("seller.business")
        val src = m.source as Source.Api
        assertEquals("__none__", src.arrayKey)
        assertTrue(WorkRows.rows(mapOf("inventory_coins" to 5), src).isEmpty())
        val svc = File(repoRoot, "backend/app/services/seller_business.py").readText()
        val answer = svc.substring(svc.indexOf("async def seller_profit"))
        for (f in m.header) assertTrue("profit answers ${f.path}", answer.contains("\"${f.path}\""))
    }
}

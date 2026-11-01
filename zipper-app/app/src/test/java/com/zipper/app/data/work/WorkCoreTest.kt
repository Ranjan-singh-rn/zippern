package com.zipper.app.data.work

import com.zipper.app.data.api.ApiError
import com.zipper.app.data.api.ApiTime
import com.zipper.app.util.Json
import com.zipper.app.util.jsonPath
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mobile parity — the pure core: JSON, API errors, capabilities, templates, forms, display. */
class WorkCoreTest {

    // ── JSON ────────────────────────────────────────────────────────────────
    @Test fun `json parses objects, arrays, numbers, escapes`() {
        val v = Json.parse("""{"a":1,"b":[true,false,null],"c":"x\"y\né","d":1.5,"e":-3,"f":{"g":12345678901}}""")
        assertEquals(1L, v.jsonPath("a"))
        assertEquals(true, v.jsonPath("b.0"))
        assertNull(v.jsonPath("b.2"))
        assertEquals("x\"y\né", v.jsonPath("c"))
        assertEquals(1.5, v.jsonPath("d"))
        assertEquals(-3L, v.jsonPath("e"))
        assertEquals(12345678901L, v.jsonPath("f.g"))
    }

    @Test fun `json writes what it reads`() {
        val src = mapOf("reason" to "a \"quoted\"\nline", "n" to 5L, "ok" to true, "list" to listOf(1L, "two"), "none" to null)
        assertEquals(src, Json.parse(Json.write(src)))
    }

    @Test(expected = Json.ParseError::class) fun `json refuses trailing junk`() { Json.parse("{} x") }

    // ── API errors ──────────────────────────────────────────────────────────
    @Test fun `the server's sentence is kept`() {
        val e = ApiError.fromResponse(403, mapOf("detail" to "Only a business owner can approve this."))
        assertEquals("Only a business owner can approve this.", e.message)
        assertEquals(ApiError.Kind.Forbidden, e.kind)
    }

    @Test fun `structured and validation details are readable`() {
        val s = ApiError.fromResponse(400, mapOf("detail" to mapOf("message" to "Verify both contacts.", "code" to "CONTACT_VERIFICATION_REQUIRED")))
        assertEquals("Verify both contacts.", s.message)
        assertEquals("CONTACT_VERIFICATION_REQUIRED", s.code)
        val v = ApiError.fromResponse(422, mapOf("detail" to listOf(mapOf("loc" to listOf("body", "reason"), "msg" to "too short"))))
        assertEquals("reason: too short", v.message)
        assertEquals(ApiError.Kind.Invalid, v.kind)
        assertEquals(ApiError.Kind.Conflict, ApiError.fromResponse(409, null).kind)
        assertEquals(ApiError.Kind.Unavailable, ApiError.fromResponse(503, null).kind)
        assertTrue(ApiError.fromResponse(500, null).message.isNotBlank())
    }

    @Test fun `iso instants from the api`() {
        assertEquals(0L, ApiTime.parseIsoMillis("1970-01-01T00:00:00Z"))
        assertEquals(1000L, ApiTime.parseIsoMillis("1970-01-01T00:00:01.000000+00:00"))
        assertEquals(7_200_000L, ApiTime.parseIsoMillis("1970-01-01T01:00:00-01:00"))
        assertNull(ApiTime.parseIsoMillis("yesterday"))
    }

    // ── Capabilities ────────────────────────────────────────────────────────
    private fun me(role: String, perms: List<String> = emptyList(), owner: Boolean = false, observer: Boolean = false,
                   internal: Boolean = true, admin: Boolean = false, ids: Map<String, String> = emptyMap(), team: String? = null) =
        Caps.from(mapOf("uid" to "u1", "name" to "N", "email" to "e@x", "role" to role, "team" to team,
            "permissions" to perms, "is_internal" to internal, "is_external" to !internal, "is_owner" to owner,
            "is_observer" to observer, "is_team_admin" to admin, "can_write" to (internal && !observer),
            "partner_ids" to ids, "partner_status" to if (internal) null else "approved"))

    @Test fun `caps read the server's own table`() {
        val ops = me("ops_admin", listOf(Perm.APPROVE_KYC, Perm.VIEW_USERS), admin = true, team = "ops")
        assertTrue(ops.has(Perm.APPROVE_KYC))
        assertFalse(ops.has(Perm.BAN_USERS))
        assertTrue(ops.requireTeamAdmin)
        assertFalse(ops.requireOwner)
        assertTrue(ops.canVerifyCard("ops"))
        assertFalse(ops.canVerifyCard("finance"))
    }

    @Test fun `the observer never writes, even with a permission listed`() {
        val obs = me("observer", listOf(Perm.BAN_USERS), observer = true)
        assertFalse(obs.requireWrite)
        assertFalse(obs.has(Perm.BAN_USERS))
        assertTrue(obs.readsAll)
    }

    @Test fun `a partner is scoped to its own ids and holds no staff power`() {
        val ag = me("agency", internal = false, ids = mapOf("agency" to "A1"))
        assertTrue(ag.isAgencyPartner)
        assertFalse(ag.isSellerPartner)
        assertFalse(ag.requireWrite)
        assertFalse(ag.has(Perm.VIEW_USERS))
        assertEquals("A1", ag.agencyId)
        val pending = me("seller", internal = false)
        assertTrue(pending.isPendingPartner)
    }

    @Test fun `missing keys read as the narrowest session`() {
        val c = Caps.from(mapOf("role" to "owner"))
        assertFalse(c.isOwner)
        assertFalse(c.requireWrite)
        assertEquals(Caps(), Caps.from("not an object"))
    }

    // ── Templates ───────────────────────────────────────────────────────────
    private val agency = me("agency", internal = false, ids = mapOf("agency" to "A 1"))

    @Test fun `templates fill from the row, the params and the session`() {
        val item = mapOf("id" to "r/1", "host" to mapOf("uid" to "h1"))
        assertEquals("/api/x/r%2F1/h1", WorkTemplate.render("/api/x/{id}/{item:host.uid}", item, "id", emptyMap(), agency))
        assertEquals("/api/partners/agencies/A%201/hosts", WorkTemplate.render("/api/partners/agencies/{agency}/hosts", null, "id", emptyMap(), agency))
        assertEquals("/api/u/7", WorkTemplate.render("/api/u/{param:uid}", null, "id", mapOf("uid" to "7"), agency))
    }

    @Test fun `a template with a missing value is not sent`() {
        assertNull(WorkTemplate.render("/api/users/{param:uid}/ban", null, "id", emptyMap(), agency))
        assertNull(WorkTemplate.render("/api/x/{seller}", null, "id", emptyMap(), agency))
    }

    // ── Forms ───────────────────────────────────────────────────────────────
    private val inputs = listOf(
        Input("reason", "Reason", InputType.LongText, minLen = 3, maxLen = 10),
        Input("days", "Days", InputType.Int, required = false, min = 1, max = 365),
        Input("amount_minor", "Amount", InputType.Rupees, min = 1),
        choice("action", "Action", "warn" to "Warn", "suspend" to "Suspend"),
        Input("deduction.amount", "Deduct", InputType.Int, min = 1, showIf = { it["action"] == "suspend" }),
        yesNo("approve", "Decision"),
        Input("period", "Period", asQuery = true, required = false),
    )

    @Test fun `validation mirrors the route's own constraints`() {
        val ok = mapOf("reason" to "spam!", "amount_minor" to "15.5", "action" to "warn", "approve" to "true")
        assertTrue(WorkForm.validate(inputs, ok).isEmpty())
        val bad = WorkForm.validate(inputs, mapOf("reason" to "x", "days" to "0", "amount_minor" to "1.234", "action" to "nuke", "approve" to "true"))
        assertEquals(setOf("reason", "days", "amount_minor", "action"), bad.keys)
        // A hidden input is not required.
        assertFalse(WorkForm.validate(inputs, ok).containsKey("deduction.amount"))
        assertTrue(WorkForm.validate(inputs, ok + ("action" to "suspend")).containsKey("deduction.amount"))
    }

    @Test fun `the body is typed, nested, and leaves out blanks and query inputs`() {
        val body = WorkForm.body(inputs, mapOf("reason" to " spam ", "days" to "", "amount_minor" to "1,500.5",
            "action" to "suspend", "deduction.amount" to "40", "approve" to "false", "period" to "2026-10"),
            fixed = mapOf("request_id" to "abc"))
        assertEquals("spam", body["reason"])
        assertFalse(body.containsKey("days"))
        assertEquals(150050L, body["amount_minor"])
        assertEquals(mapOf("amount" to 40L), body["deduction"])
        assertEquals(false, body["approve"])
        assertFalse(body.containsKey("period"))
        assertEquals("abc", body["request_id"])
        assertEquals(mapOf("period" to "2026-10"), WorkForm.query(inputs, mapOf("period" to "2026-10")))
    }

    @Test fun `money is paise in and Indian-grouped out`() {
        assertEquals(100L, WorkForm.rupeesToPaise("1"))
        assertEquals(123456789L, WorkForm.rupeesToPaise("₹12,34,567.89"))
        assertNull(WorkForm.rupeesToPaise("1.234"))
        assertNull(WorkForm.rupeesToPaise("-5"))
        assertEquals("12,34,567.89", WorkForm.formatPaise(123456789L))
        assertEquals("1,000", WorkForm.formatPaise(100000L))
        assertEquals("999", WorkForm.indian(999))
        assertEquals("1,00,00,000", WorkForm.indian(10_000_000))
        assertEquals("2026-10-31T00:00:00Z", WorkForm.normaliseDate("2026-10-31"))
    }

    // ── Rows & display ──────────────────────────────────────────────────────
    @Test fun `rows come from a bare array, a key, or nowhere`() {
        assertEquals(1, WorkRows.rows(listOf(mapOf("id" to "a"), "junk"), null).size)
        assertEquals(2, WorkRows.rows(mapOf("appeals" to listOf(mapOf("id" to 1), mapOf("id" to 2))), "appeals").size)
        assertTrue(WorkRows.rows(mapOf("x" to 1), "appeals").isEmpty())
        assertTrue(WorkRows.matches(mapOf("name" to "Star Agency"), "star", listOf("name"), "id"))
        assertFalse(WorkRows.matches(mapOf("name" to "Star Agency"), "moon", listOf("name"), "id"))
    }

    @Test fun `secrets never reach the screen, bank numbers are masked`() {
        val fields = WorkDisplay.allFields(mapOf("token" to "t", "set_password_link" to "https://x", "accountNumber" to "123456789012", "name" to "A"))
        assertEquals(listOf("Account Number", "Name"), fields.map { it.first })
        assertEquals("••••••••9012", fields.first().second)
    }

    @Test fun `values read in the kind they are`() {
        assertEquals("₹1,500.50", WorkDisplay.value(150050L, FieldKind.Money))
        assertEquals("12,000", WorkDisplay.value(12000L, FieldKind.Count))
        assertEquals("Refund pending", WorkDisplay.value("refund_pending", FieldKind.Status))
        assertEquals("Yes", WorkDisplay.value(true, FieldKind.Bool))
        assertEquals("—", WorkDisplay.value(null, FieldKind.Text))
    }
}

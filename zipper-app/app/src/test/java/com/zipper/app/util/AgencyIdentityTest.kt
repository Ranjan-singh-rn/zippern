package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * B1 — readable identities on "My agency" and the seller dashboard.
 *
 * Names come from records, ids are labelled, nothing is invented, and the
 * screens' role and action rules are left as they were.
 */
class AgencyIdentityTest {

    // ── Agency card ─────────────────────────────────────────────────────────
    @Test fun `the agency is named by agencyName, then a legacy name, never by its id`() {
        assertEquals("Star Agency", AgencyIdentity.agencyName("Star Agency", "old"))
        assertEquals("old", AgencyIdentity.agencyName("  ", "old"))
        assertNull(AgencyIdentity.agencyName(null, " "))
        assertEquals("Agency ID: ag-1", AgencyIdentity.reference(AgencyIdentity.AGENCY_ID, "ag-1"))
        assertEquals("Agency ID: —", AgencyIdentity.reference(AgencyIdentity.AGENCY_ID, ""))
    }

    @Test fun `the referral code is the agency record's, blank when not issued`() {
        assertEquals("STAR7K2Q", AgencyIdentity.referralCode(" STAR7K2Q "))
        assertEquals("", AgencyIdentity.referralCode(null))
    }

    // ── Roster ──────────────────────────────────────────────────────────────
    @Test fun `roster rows carry the host name and a uid, current rows only`() {
        val rows = AgencyIdentity.roster(listOf(
            "u1" to mapOf("uid" to "u1", "name" to "Asha"),
            "doc2" to mapOf<String, Any?>("name" to " Ravi "),                 // no uid field → doc id
            "u3" to mapOf("uid" to "u3", "name" to "Gone", "active" to false), // history, not a host
            "u4" to mapOf<String, Any?>("uid" to "u4"),                         // no name
            "u1b" to mapOf("uid" to "u1", "name" to "Asha"),                   // same host twice
        ))
        assertEquals(listOf("u1", "doc2", "u4"), rows.map { it.uid })
        assertEquals(listOf("Asha", "Ravi", ""), rows.map { it.name })
        assertEquals(3L, AgencyIdentity.hostCount(rows))
    }

    @Test fun `a host with no name says so, and the avatar letter never comes from a uid`() {
        assertEquals("Asha", AgencyIdentity.displayName("Asha"))
        assertEquals(AgencyIdentity.NO_NAME, AgencyIdentity.displayName(""))
        assertEquals(AgencyIdentity.NAME_UNAVAILABLE, AgencyIdentity.displayName(null, lookedUp = false))
        assertEquals("A", AgencyIdentity.initial("asha"))
        assertEquals("?", AgencyIdentity.initial(""))
        assertEquals("Host ID: u1", AgencyIdentity.reference(AgencyIdentity.HOST_ID, "u1"))
        assertTrue(AgencyIdentity.isName("Asha"))
        assertFalse(AgencyIdentity.isName(AgencyIdentity.NOT_FOUND))
    }

    @Test fun `id labels are distinct`() {
        val labels = listOf(AgencyIdentity.AGENCY_ID, AgencyIdentity.HOST_ID, AgencyIdentity.BUYER_ID, AgencyIdentity.REQUEST_ID)
        assertEquals(labels.size, labels.toSet().size)
    }

    // ── Seller dashboard ────────────────────────────────────────────────────
    @Test fun `buyer name - public name, else recorded name, else the honest sentence`() {
        assertEquals("Meera", RechargeDisplay.buyerName("b1", "Meera", "old", profileLookedUp = true, profileFound = true))
        assertEquals("old", RechargeDisplay.buyerName("b1", null, "old", profileLookedUp = true, profileFound = false))
        assertEquals(AgencyIdentity.NOT_FOUND, RechargeDisplay.buyerName("b1", null, "", profileLookedUp = true, profileFound = false))
        assertEquals(AgencyIdentity.NO_NAME, RechargeDisplay.buyerName("b1", "", "", profileLookedUp = true, profileFound = true))
        assertEquals(AgencyIdentity.NAME_UNAVAILABLE, RechargeDisplay.buyerName("b1", null, "", profileLookedUp = false, profileFound = false))
        assertEquals(AgencyIdentity.NAME_UNAVAILABLE, RechargeDisplay.buyerName("", null, "", profileLookedUp = true, profileFound = false))
    }

    @Test fun `refund statuses are shown as what they are`() {
        assertEquals("Refund pending", RechargeDisplay.status("refund_pending").second)
        assertEquals("Refunded", RechargeDisplay.status("refunded").second)
        assertEquals("Partly reversed", RechargeDisplay.status("reversed").second)
        assertEquals(RechargeDisplay.Tone.Success, RechargeDisplay.status("approved").first)
        assertEquals(RechargeDisplay.Tone.Danger, RechargeDisplay.status("rejected").first)
        assertEquals("Status not recorded", RechargeDisplay.status(null).second)
        assertTrue(RechargeDisplay.HISTORY_STATUSES.containsAll(listOf("approved", "rejected", "refund_pending", "refunded", "reversed")))
        assertFalse(RechargeDisplay.HISTORY_STATUSES.contains("pending"))
    }

    @Test fun `buyer lookups are batched by 30, de-duplicated, blanks dropped`() {
        val ids = (1..61).map { "b$it" } + listOf("b1", "", null, "a/b")
        assertEquals(listOf(30, 30, 1), RechargeDisplay.lookupBatches(ids).map { it.size })
    }

    // ── The screens (source checks) ─────────────────────────────────────────
    private val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
    private fun src(path: String) = File(main, "com/zipper/app/$path").readText()

    @Test fun `my agency reads the agency record, not the user doc, and invents no counts`() {
        val dash = src("ui/screens/agency/AgencyDashboardScreen.kt")
        assertTrue(dash.contains("agSnap.getString(\"agencyName\")"))
        assertTrue(dash.contains("agSnap.getString(\"referralCode\")"))
        assertFalse("referral code is not read from users/{uid}", dash.contains("currentUser?.referralCode"))
        assertFalse("no stored counter nobody updates", dash.contains("subAgenciesCount"))
        assertFalse(dash.contains("totalHosts"))
        assertTrue(dash.contains("Stat(\"Hosts\", indianGrouping(hosts.size.toLong()))"))
        assertTrue(dash.contains("Stat(\"Sub-agencies\", AgencyIdentity.NOT_COUNTED)"))
        assertTrue(dash.contains("AgencyIdentity.reference(AgencyIdentity.HOST_ID, host.uid)"))
        assertFalse("the uid is not the avatar letter", dash.contains("initial = host.uid"))
        // Role visibility and the payout action are unchanged.
        assertTrue(dash.contains("currentUser?.ownAgencyId"))
        assertTrue(dash.contains("takeIf { !it.isHost }?.agencyId"))
        assertTrue(dash.contains("document(reportId).update(\"status\", \"submitted\")"))
    }

    @Test fun `seller dashboard names buyers from the public profile only, and decides nothing`() {
        val dash = src("ui/screens/seller/SellerDashboardScreen.kt")
        assertTrue(dash.contains("collection(\"publicProfiles\")"))
        assertFalse("no read of a buyer's private users doc", dash.contains("collection(\"users\")"))
        assertTrue(dash.contains(".whereIn(\"status\", RechargeDisplay.HISTORY_STATUSES)"))
        assertFalse(dash.contains("\"Unknown buyer\""))
        assertTrue(dash.contains("AgencyIdentity.reference(AgencyIdentity.BUYER_ID, request.buyerUid)"))
        assertTrue(dash.contains("AgencyIdentity.reference(AgencyIdentity.REQUEST_ID, request.id)"))
        // Still read-only on requests: nothing writes a recharge status from here.
        assertFalse(dash.contains("collection(\"rechargeRequests\").document("))
    }
}

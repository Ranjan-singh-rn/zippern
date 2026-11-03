package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * FX-05 (RF-17) — the seller screens read the seller RECORD named on the login
 * document, not `sellers/{uid}`.
 *
 * Every seller record created today has an automatic id, so the old
 * `sellers/{currentUid}` read found nothing for an approved seller: an empty
 * dashboard and a failing online toggle.
 */
class SellerRecordIdTest {

    @Test fun `the linked record wins over the uid`() {
        assertEquals("auto-id-123", SellerRecordId.resolve("uid-1", "auto-id-123"))
        assertEquals("auto-id-123", SellerRecordId.resolve("uid-1", "  auto-id-123 "))
    }

    @Test fun `no link falls back to a legacy uid-keyed record`() {
        assertEquals("uid-1", SellerRecordId.resolve("uid-1", null))
        assertEquals("uid-1", SellerRecordId.resolve("uid-1", ""))
        assertEquals("uid-1", SellerRecordId.resolve("uid-1", "   "))
    }

    @Test fun `two sellers keep two records`() {
        assertEquals("rec-a", SellerRecordId.resolve("uid-a", "rec-a"))
        assertEquals("rec-b", SellerRecordId.resolve("uid-b", "rec-b"))
    }

    private val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
    private fun src(path: String) = File(main, "com/zipper/app/$path").readText()

    @Test fun `the dashboard reads, listens to and toggles the resolved record`() {
        val dash = src("ui/screens/seller/SellerDashboardScreen.kt")
        assertTrue(dash.contains("collection(\"crmUsers\").document(currentUid).get().await().getString(\"sellerId\")"))
        assertTrue(dash.contains("com.zipper.app.util.SellerRecordId.resolve(currentUid, crmSellerId)"))
        assertTrue(dash.contains("Firebase.firestore.collection(\"sellers\").document(sellerId)"))
        assertTrue(dash.contains(".document(sellerId.ifBlank { currentUid }).update(\"isOnline\", newValue)"))
        assertFalse("no direct uid-keyed seller read is left",
            dash.contains("collection(\"sellers\").document(currentUid)"))
    }

    @Test fun `buy coins reads the resolved record`() {
        val buy = src("ui/screens/seller/BuyCoinScreen.kt")
        // B9 (3 Nov 2026): the resolved record is kept in `sellerRecordId` — read from it, and written on the
        // purchase request so staff can match it — instead of being resolved inline in the read.
        assertTrue(buy.contains("sellerRecordId = com.zipper.app.util.SellerRecordId.resolve(currentUid, crmSellerId)"))
        assertTrue(buy.contains(".document(sellerRecordId).get().await()"))
        assertTrue(buy.contains("\"sellerId\"        to sellerRecordId"))
        assertFalse(buy.contains("collection(\"sellers\").document(currentUid)"))
    }

    /** B2b (3 Nov 2026): a Coin Seller is never offered their own listing to buy from. */
    @Test fun `a listing is the seller's own by the linked record or by the uid`() {
        assertTrue(SellerRecordId.isOwnListing("SELL_1", "u1", "SELL_1"))
        assertTrue("the uid-keyed legacy record", SellerRecordId.isOwnListing("u1", "u1", null))
        assertTrue(SellerRecordId.isOwnListing(" u1 ", "u1", ""))
        assertFalse(SellerRecordId.isOwnListing("SELL_2", "u1", "SELL_1"))
        assertFalse("nobody signed in owns nothing", SellerRecordId.isOwnListing("SELL_1", "", "SELL_1"))
        assertFalse("an empty linked id matches nothing", SellerRecordId.isOwnListing("", "u1", ""))
    }

    @Test fun `the reseller list leaves the seller's own listing out and says so`() {
        val list = src("ui/screens/diamond/ResellerListScreen.kt")
        assertTrue(list.contains("SellerRecordId.isOwnListing(it.uid, me, linked)"))
        assertTrue(list.contains("all - mine.toSet()"))
        assertTrue(list.contains("a seller can't buy diamonds from their own stock"))
    }
}

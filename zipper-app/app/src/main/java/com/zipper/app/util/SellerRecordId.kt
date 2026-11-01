package com.zipper.app.util

/**
 * FX-05 — which `sellers/{id}` document is THIS login's Coin Seller record.
 *
 * The seller screens read `sellers/{currentUid}`. Every seller record the app
 * and the CRM create today has an automatic id (`partner_applications.py`
 * writes `collection('sellers').document()`; the CRM signups use `addDoc`), so
 * an approved seller's dashboard read an empty document and its online toggle
 * failed (RF-17). The record is named on the login document instead —
 * `crmUsers/{uid}.sellerId`, written by the server when the application is
 * filed and when it is decided — which the owner may read. A uid-keyed record
 * (the old convention, still honoured by `firestore.rules`) is the fallback.
 *
 * Pure: unit-tested in `SellerRecordIdTest`.
 */
object SellerRecordId {

    /** The seller record id named on the login document, else [uid]. */
    fun resolve(uid: String, crmSellerId: String?): String {
        val linked = crmSellerId?.trim().orEmpty()
        return if (linked.isNotEmpty()) linked else uid
    }
}

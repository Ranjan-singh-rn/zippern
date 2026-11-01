package com.zipper.app.util

/**
 * B1 — what the seller dashboard says about a recharge request.
 *
 * Statuses are the ones the API mirrors to `rechargeRequests/{id}`
 * (backend/app/services/recharges.py `RechargeStatus`). History used to ask only
 * for approved/rejected, so a request that was later refunded or reversed — the
 * seller's coins restored, the buyer's diamonds taken back — vanished from the
 * seller's history instead of being shown as what it became.
 *
 * Display only: nothing here decides, approves or moves anything.
 */
object RechargeDisplay {

    enum class Tone { Success, Danger, Warning, Neutral }

    /** Every settled or in-refund status — the History tab. `pending` is the Pending tab. */
    val HISTORY_STATUSES = listOf("approved", "rejected", "refund_pending", "refunded", "reversed")

    fun status(raw: String?): Pair<Tone, String> = when (val s = raw?.trim().orEmpty()) {
        "approved" -> Tone.Success to "Approved"
        "rejected" -> Tone.Danger to "Rejected"
        "refund_pending" -> Tone.Warning to "Refund pending"
        "refunded" -> Tone.Neutral to "Refunded"
        "reversed" -> Tone.Neutral to "Partly reversed"
        "pending" -> Tone.Warning to "Pending"
        "" -> Tone.Neutral to "Status not recorded"
        else -> Tone.Neutral to s.replace('_', ' ').replaceFirstChar { it.uppercase() }
    }

    /**
     * The buyer's name: the public profile's display name (a name, never a
     * contact), else the name the request itself recorded, else an honest
     * sentence. `profileLookedUp` false = the lookup could not be made (it failed),
     * which is not the same as "this person has no profile".
     */
    fun buyerName(buyerUid: String?, publicName: String?, recordedName: String?, profileLookedUp: Boolean, profileFound: Boolean): String =
        publicName?.trim()?.takeIf { it.isNotEmpty() }
            ?: recordedName?.trim()?.takeIf { it.isNotEmpty() }
            ?: when {
                // No buyer uid on the request: nothing was looked up, so nothing is "not found".
                buyerUid.isNullOrBlank() || !profileLookedUp -> AgencyIdentity.NAME_UNAVAILABLE
                !profileFound -> AgencyIdentity.NOT_FOUND
                else -> AgencyIdentity.NO_NAME
            }

    /** Distinct, usable buyer uids, in chunks of 30 (Firestore `in` limit). */
    fun lookupBatches(uids: List<String?>): List<List<String>> =
        uids.mapNotNull { it?.trim()?.takeIf { id -> id.isNotEmpty() && '/' !in id } }.distinct().chunked(30)
}

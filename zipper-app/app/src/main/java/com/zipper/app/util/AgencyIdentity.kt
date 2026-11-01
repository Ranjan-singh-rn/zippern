package com.zipper.app.util

/**
 * B1 — how the "My agency" and seller screens name the records they show.
 *
 * One rule, the CRM's (`zipper-crm/lib/identity.ts`):
 *   1. the NAME first, taken from a record — never invented;
 *   2. a LABELLED id so the record stays traceable ("Agency ID", "Host ID", "Buyer ID");
 *   3. a missing name says so instead of showing a bare id as if it were a name.
 *
 * Pure (no Android, no Firebase) so `AgencyIdentityTest` runs it on the JVM.
 */
object AgencyIdentity {

    const val AGENCY_ID = "Agency ID"
    const val HOST_ID = "Host ID"
    const val BUYER_ID = "Buyer ID"
    const val REQUEST_ID = "Request ID"

    const val NO_NAME = "No name on record"
    const val NAME_UNAVAILABLE = "Name unavailable"
    const val NOT_FOUND = "Profile not found"
    const val NOT_ISSUED = "—"
    const val NOT_COUNTED = "—"

    fun reference(label: String, id: String?): String = "$label: ${id?.trim().orEmpty().ifBlank { "—" }}"

    /**
     * The agency's own name. Every writer stores it as `agencyName`
     * (backend partner_ops / partner_applications, CRM partnerRoles); `name` is
     * read only as a fallback for an older record. Null when the record has neither —
     * the screen then titles itself "My agency" and shows the labelled id.
     */
    fun agencyName(agencyName: String?, legacyName: String?): String? =
        agencyName?.trim()?.takeIf { it.isNotEmpty() } ?: legacyName?.trim()?.takeIf { it.isNotEmpty() }

    /**
     * The referral code ISSUED TO THE AGENCY, from `agencies/{id}.referralCode`
     * (the backend issues it there). `users/{uid}.referralCode` has no writer and
     * is not read. Blank → not issued yet; the app never makes one up.
     */
    fun referralCode(agencyRecordCode: String?): String = agencyRecordCode?.trim().orEmpty()

    data class RosterRow(val uid: String, val name: String)

    /**
     * Current roster rows only (FX-10: `active: false` is history; a row without
     * the field predates the marker and is current). The uid is the row's `uid`
     * field, else the document id; the name is the row's `name`, as the grant wrote it.
     */
    fun roster(rows: List<Pair<String, Map<String, Any?>>>): List<RosterRow> =
        rows.filter { (_, data) -> data["active"] != false }
            .map { (docId, data) ->
                val uid = (data["uid"] as? String)?.trim()?.takeIf { it.isNotEmpty() } ?: docId
                RosterRow(uid = uid, name = (data["name"] as? String)?.trim().orEmpty())
            }
            .distinctBy { it.uid }

    /** The host count is the number of CURRENT roster rows — the same set the list shows. */
    fun hostCount(roster: List<RosterRow>): Long = roster.size.toLong()

    /** A person's line: the name if the record has one, else the honest sentence. */
    fun displayName(name: String?, lookedUp: Boolean = true): String =
        name?.trim()?.takeIf { it.isNotEmpty() } ?: if (lookedUp) NO_NAME else NAME_UNAVAILABLE

    /** True when [display] is a real name, not one of the sentences above. */
    fun isName(display: String?): Boolean =
        !display.isNullOrBlank() && display !in setOf(NO_NAME, NAME_UNAVAILABLE, NOT_FOUND)

    /**
     * B2: whether a roster uid can be put in the `user_profile/{uid}` route. A
     * blank id or one with a path separator would not match the route (or would
     * match a different one), so such a row is shown but not tappable.
     */
    fun canOpenProfile(uid: String?): Boolean =
        !uid.isNullOrBlank() && uid.none { it == '/' || it == '?' || it == '#' || it.isWhitespace() }

    /** One character for an avatar — from the NAME, never from a uid. */
    fun initial(name: String?): String =
        name?.trim()?.firstOrNull { it.isLetterOrDigit() }?.uppercaseChar()?.toString() ?: "?"
}

package com.zipper.app.data.work

import com.zipper.app.util.jsonList
import com.zipper.app.util.jsonMap
import com.zipper.app.util.jsonText

/**
 * What this API session may do — as the SERVER said it (`GET /api/auth/me`,
 * built from `backend/app/core/roles.py`), never a copy of the CRM's lists.
 *
 * It only decides which work screens and buttons are OFFERED. Every request
 * still runs the route's own dependency on the server; a screen this offers
 * that the server refuses shows the server's refusal.
 *
 * The predicates are named after the backend dependencies they mirror
 * (`require_internal`, `require_write`, `require_owner`, `require_team_admin`,
 * `require_permission(…)`), so each module's gate reads like its route.
 */
data class Caps(
    val uid: String = "",
    val name: String = "",
    val email: String = "",
    /** Backend `Role` value: owner, observer, ops_admin, …, agency, seller. */
    val role: String = "",
    val team: String? = null,
    val permissions: Set<String> = emptySet(),
    val isInternal: Boolean = false,
    val isExternal: Boolean = false,
    val isOwner: Boolean = false,
    val isObserver: Boolean = false,
    val isTeamAdmin: Boolean = false,
    val canWrite: Boolean = false,
    /** A partner session's own records: `{"agency": id}`, `{"seller": id}`. Empty for staff. */
    val partnerIds: Map<String, String> = emptyMap(),
    val partnerStatus: String? = null,
) {
    // ── Mirrors of backend/app/core/deps.py ──────────────────────────────────
    val requireInternal: Boolean get() = isInternal
    val requireWrite: Boolean get() = isInternal && canWrite
    val requireOwner: Boolean get() = isOwner
    val requireTeamAdmin: Boolean get() = isOwner || isTeamAdmin

    /** `require_permission(p)` — built on require_write, so the observer and partners never pass. */
    fun has(p: String): Boolean = requireWrite && p in permissions
    fun hasAny(vararg ps: String): Boolean = requireWrite && ps.any { it in permissions }

    /** `R.can_read_all`. */
    val readsAll: Boolean get() = role == "owner" || role == "observer"

    /** `can_verify_money(role, team)` for a card of [cardTeam]. */
    fun canVerifyCard(cardTeam: String?): Boolean =
        requireWrite && (isOwner || role == "finance_admin" || (isTeamAdmin && team != null && team == cardTeam))

    val agencyId: String? get() = partnerIds["agency"]
    val sellerId: String? get() = partnerIds["seller"]
    val isAgencyPartner: Boolean get() = isExternal && !agencyId.isNullOrBlank()
    val isSellerPartner: Boolean get() = isExternal && !sellerId.isNullOrBlank()

    /** A partner whose application is still waiting: a session with no record behind it. */
    val isPendingPartner: Boolean get() = isExternal && partnerIds.isEmpty()

    /** Rule-side role names (firestore.rules reads `crmUsers.role`): owner is `superadmin` there. */
    val crmRole: String get() = if (role == "owner") "superadmin" else role

    val label: String get() = when {
        isOwner -> "Owner"
        isObserver -> "Observer"
        role == "agency" -> "Agency"
        role == "seller" -> "Coin Seller"
        role.isNotBlank() -> role.split('_').joinToString(" ") { it.replaceFirstChar { c -> c.uppercase() } }
        else -> "No role"
    }

    companion object {
        /** From the `/api/auth/me` body. Unknown or missing keys give the narrowest reading. */
        fun from(body: Any?): Caps {
            val m = body.jsonMap() ?: return Caps()
            fun b(k: String) = m[k] == true
            return Caps(
                uid = m["uid"].jsonText().orEmpty(),
                name = m["name"].jsonText().orEmpty(),
                email = m["email"].jsonText().orEmpty(),
                role = m["role"].jsonText().orEmpty(),
                team = m["team"].jsonText(),
                permissions = m["permissions"].jsonList()?.mapNotNull { it.jsonText() }?.toSet() ?: emptySet(),
                isInternal = b("is_internal"),
                isExternal = b("is_external"),
                isOwner = b("is_owner"),
                isObserver = b("is_observer"),
                isTeamAdmin = b("is_team_admin"),
                canWrite = b("can_write"),
                partnerIds = m["partner_ids"].jsonMap()
                    ?.mapNotNull { (k, v) -> v.jsonText()?.takeIf { it.isNotBlank() }?.let { k to it } }
                    ?.toMap() ?: emptyMap(),
                partnerStatus = m["partner_status"].jsonText(),
            )
        }
    }
}

/** The 20 capabilities, spelled as the server spells them (`roles.Permission`). */
object Perm {
    const val VIEW_USERS = "can_view_users"
    const val BAN_USERS = "can_ban_users"
    const val ADJUST_BALANCE = "can_adjust_balance"
    const val VIEW_AGENCIES = "can_view_agencies"
    const val APPROVE_KYC = "can_approve_kyc"
    const val VIEW_SELLERS = "can_view_sellers"
    const val APPROVE_SELLER = "can_approve_seller"
    const val COIN_OPERATIONS = "can_coin_operations"
    const val VIEW_FINANCE = "can_view_finance"
    const val PROCESS_PAYOUT = "can_process_payout"
    const val ECONOMY_CONFIG = "can_economy_config"
    const val COMMISSION_SLABS = "can_commission_slabs"
    const val APP_CONFIG = "can_app_config"
    const val CREATE_TICKETS = "can_create_tickets"
    const val ASSIGN_TICKETS = "can_assign_tickets"
    const val CLOSE_TICKETS = "can_close_tickets"
    const val APPROVE_REQUESTS = "can_approve_requests"
    const val MANAGE_TEAM = "can_manage_team"
    const val MONITOR_LIVE = "can_monitor_live"
    const val SEND_BROADCASTS = "can_send_broadcasts"
}

package com.zipper.app.data.work

import com.zipper.app.util.jsonText

/*
 * Finance: host withdrawals and agency salary requests (Firestore queues the
 * CRM reads, with the decision written exactly as the CRM writes it and the
 * money moved only by a card), weekly payout reports, operating costs and the
 * owners' capital account. No balance is computed here: amounts are read from
 * the server and every movement is a card the server verifies, signs and
 * executes.
 */

/** firestore.rules `isFinance() || isSuperAdmin()` — the withdrawal / salary decision clause. */
private val financeDecider: (Caps) -> Boolean = { c ->
    c.requireWrite && (c.isOwner || c.role == "finance_admin" || c.role == "finance_member")
}

/** firestore.rules `isFinance() || isAdmin()` — who may read these queues at all. */
private val financeReader: (Caps) -> Boolean = { c ->
    c.isInternal && !c.isObserver && (c.isOwner || c.isTeamAdmin || c.role == "finance_member")
}

private fun month(): Input = Input("period", "Month (YYYY-MM)", minLen = 7, maxLen = 7,
    help = "For example 2026-10.")

private val expenseCategories = arrayOf(
    "staff_salaries" to "Staff salaries", "infrastructure" to "Infrastructure", "marketing" to "Marketing",
    "gateway_fees" to "Gateway fees", "binance_fees" to "Binance fees", "taxes" to "Taxes",
    "refunds_to_users" to "Refunds to users", "other" to "Other",
)

/**
 * B1 / spec §5 §11 — items of a revoked partner held for Finance review.
 * `GET /partner-ops/held-items` answers `{cards, recharges, sales,
 * subagency_payouts, total}`; the release route names the item's TYPE
 * (`card | recharge | sale | subagency_payout`), which is the array's name
 * without its plural. Pure, so the JVM test pins the mapping.
 */
object HeldItems {
    val arrays = listOf("cards", "recharges", "sales", "subagency_payouts")

    fun typeOf(arrayName: String): String = when (arrayName) {
        "cards" -> "card"
        "recharges" -> "recharge"
        "sales" -> "sale"
        "subagency_payouts" -> "subagency_payout"
        else -> arrayName.removeSuffix("s")
    }

    fun label(type: String): String = when (type) {
        "card" -> "Money card"
        "recharge" -> "Recharge"
        "sale" -> "Coin sale"
        "subagency_payout" -> "Sub-agency payout"
        else -> type
    }

    /** Adds `held_type` and `held_label` from the array the row came from; a row's own `title` is kept. */
    fun transform(item: Item): Item {
        val type = typeOf(item["__from"].jsonText().orEmpty())
        val title = item["title"].jsonText()?.takeIf { it.isNotBlank() }
            ?: listOfNotNull(label(type), item["seller_name"].jsonText() ?: item["sub_name"].jsonText() ?: item["buyer_uid"].jsonText())
                .joinToString(" · ")
        return item + mapOf("held_type" to type, "held_label" to label(type), "held_title" to title)
    }

    /** Finance's admin or an Owner — `money_freeze.can_decide_held`, which the route re-checks. */
    fun mayRelease(c: Caps): Boolean = c.has(Perm.PROCESS_PAYOUT) && (c.isOwner || c.role == "finance_admin")
}

internal val moneyModules: List<WorkModule> = listOf(

    WorkModule(
        id = "withdrawals", title = "Host withdrawals", group = Group.Money,
        summary = "Withdrawal requests hosts filed: approve, then raise the card that pays them.",
        crm = "/finance/withdrawals",
        gate = financeReader,
        source = Source.Firestore("withdrawalRequests", orderBy = "requestedAt"),
        filters = listOf(Filter("status", "Status", listOf("pending" to "Pending", "approved" to "Approved",
            "paid" to "Paid", "rejected" to "Rejected", "" to "All"))),
        titlePaths = listOf("hostName", "hostUid", "uid"), nameUidPaths = listOf("hostUid"),
        subtitle = listOf(Field("Beans", "beans", FieldKind.Count), Field("Requested", "requestedAt", FieldKind.Date)),
        detail = listOf(Field("Host", "hostName"), Field("Host account", "hostUid", FieldKind.Uid, link = Link("users.record", "uid")),
            Field("Agency ID", "agencyId"), Field("Beans", "beans", FieldKind.Count), Field("Amount (₹, as requested)", "inrAmount", FieldKind.Rupees),
            Field("Status", "status", FieldKind.Status), Field("Payment type", "paymentType"),
            Field("Requested", "requestedAt", FieldKind.Date), Field("Processed", "processedAt", FieldKind.Date),
            Field("Rejection reason", "rejectionReason", FieldKind.LongText), Field("Notes", "notes", FieldKind.LongText)),
        hide = setOf("accountNumber", "ifscCode", "upiId", "binanceUid", "phoneNumber", "bankName"),
        actions = listOf(
            WorkAction("withdrawal.approve", "Approve request", kind = ActionKind.FirestoreUpdate,
                gate = financeDecider, showFor = statusIn("pending"),
                inputs = listOf(Input("notes", "Notes (optional)", InputType.LongText, required = false, maxLen = 1000)),
                firestoreFields = mapOf("status" to "approved", "processedAt" to FsValue.ServerTimestamp, "processedBy" to FsValue.ActorName),
                confirm = "Approve this request? It is paid only by the card raised for it."),
            WorkAction("withdrawal.reject", "Reject request", kind = ActionKind.FirestoreUpdate, danger = true,
                gate = financeDecider, showFor = statusIn("pending", "approved"),
                inputs = listOf(Input("rejectionReason", "Reason", InputType.LongText, minLen = 3, maxLen = 1000)),
                firestoreFields = mapOf("status" to "rejected", "processedAt" to FsValue.ServerTimestamp, "processedBy" to FsValue.ActorName),
                confirm = "Reject this withdrawal request?"),
            WorkAction("withdrawal.card", "Raise payment card", "/api/partner-ops/hosts/{item:hostUid}/withdrawals",
                gate = { c -> c.has(Perm.PROCESS_PAYOUT) }, showFor = statusIn("pending", "approved"),
                inputs = listOf(Input("beans", "Beans", InputType.Int, min = 1, prefillPath = "beans"), reason()),
                fixed = mapOf("request_collection" to "withdrawalRequests", "request_id" to "{item:id}"),
                confirm = "Raise the host withdrawal card for this request? The beans must match the request exactly."),
        ),
        searchPaths = listOf("hostName", "hostUid", "agencyId"),
    ),
    WorkModule(
        id = "salaryRequests", title = "Agency salary requests", group = Group.Money,
        summary = "Host-salary requests agencies filed: approve, then raise the card that pays.",
        crm = "/agencies/[id]/salary, /agency-dashboard (salary)",
        gate = financeReader,
        source = Source.Firestore("salaryRequests", orderBy = "createdAt"),
        filters = listOf(Filter("status", "Status", listOf("pending" to "Pending", "approved" to "Approved",
            "paid" to "Paid", "distributed" to "Distributed", "rejected" to "Rejected", "" to "All"))),
        titlePaths = listOf("hostName", "hostUid"), nameUidPaths = listOf("hostUid"),
        subtitle = listOf(Field("Agency", "agencyId"), Field("Beans", "beansEarned", FieldKind.Count)),
        detail = listOf(Field("Host", "hostName"), Field("Host account", "hostUid", FieldKind.Uid, link = Link("users.record", "uid")),
            Field("Agency ID", "agencyId"), Field("Period", "period"), Field("Beans earned", "beansEarned", FieldKind.Count),
            Field("Amount (₹, as requested)", "amountInr", FieldKind.Rupees), Field("Status", "status", FieldKind.Status),
            Field("Notes", "notes", FieldKind.LongText), Field("Filed", "createdAt", FieldKind.Date)),
        actions = listOf(
            WorkAction("salary.approve", "Approve request", kind = ActionKind.FirestoreUpdate,
                gate = financeDecider, showFor = statusIn("pending"),
                firestoreFields = mapOf("status" to "approved", "approvedAt" to FsValue.ServerTimestamp),
                confirm = "Approve this salary request? It is paid only by the card raised for it."),
            WorkAction("salary.reject", "Reject request", kind = ActionKind.FirestoreUpdate, danger = true,
                gate = financeDecider, showFor = statusIn("pending"),
                inputs = listOf(Input("rejectionReason", "Reason", InputType.LongText, minLen = 3, maxLen = 1000)),
                firestoreFields = mapOf("status" to "rejected", "rejectedAt" to FsValue.ServerTimestamp),
                confirm = "Reject this salary request?"),
            WorkAction("salary.card", "Raise payment card", "/api/partner-ops/hosts/{item:hostUid}/withdrawals",
                gate = { c -> c.has(Perm.PROCESS_PAYOUT) }, showFor = statusIn("pending", "approved"),
                inputs = listOf(Input("beans", "Beans", InputType.Int, min = 1, prefillPath = "beansEarned"), reason()),
                fixed = mapOf("request_collection" to "salaryRequests", "request_id" to "{item:id}"),
                confirm = "Raise the payment card for this salary request?"),
        ),
    ),
    WorkModule(
        id = "payoutReports", title = "Weekly payout reports", group = Group.Money,
        summary = "Weekly agency payout reports and their approval.",
        crm = "/finance/payouts",
        gate = financeReader,
        source = Source.Firestore("weeklyPayoutReports", orderBy = "createdAt"),
        filters = listOf(Filter("status", "Status", listOf("" to "All", "generated" to "Generated", "submitted" to "Submitted",
            "approved" to "Approved", "rejected" to "Rejected"))),
        titlePaths = listOf("agencyName", "weekStart", "id"),
        subtitle = listOf(Field("Week", "weekStart"), Field("Payout", "totalPayout", FieldKind.Rupees)),
        detail = listOf(Field("Agency", "agencyName"), Field("Agency ID", "agencyId"), Field("Week from", "weekStart"),
            Field("Week to", "weekEnd"), Field("Hosts", "totalHostCount", FieldKind.Count),
            Field("Beans earned", "totalBeansEarned", FieldKind.Count), Field("Payout (₹)", "totalPayout", FieldKind.Rupees),
            Field("Status", "status", FieldKind.Status), Field("Rejection reason", "rejectedReason", FieldKind.LongText),
            Field("Created", "createdAt", FieldKind.Date)),
        actions = listOf(
            WorkAction("payout.approve", "Approve", kind = ActionKind.FirestoreUpdate,
                gate = { c -> c.requireWrite && (c.isOwner || c.role == "finance_admin") },
                showFor = statusIn("generated", "submitted"),
                firestoreFields = mapOf("status" to "approved", "approvedBy" to FsValue.ActorUid, "approvedAt" to FsValue.ServerTimestamp),
                confirm = "Approve this weekly payout report?"),
            WorkAction("payout.reject", "Reject", kind = ActionKind.FirestoreUpdate, danger = true,
                gate = { c -> c.requireWrite && (c.isOwner || c.role == "finance_admin") },
                showFor = statusIn("generated", "submitted"),
                inputs = listOf(Input("rejectedReason", "Reason", InputType.LongText, minLen = 3, maxLen = 1000)),
                firestoreFields = mapOf("status" to "rejected", "approvedBy" to FsValue.ActorUid, "approvedAt" to FsValue.ServerTimestamp),
                confirm = "Reject this weekly payout report?"),
        ),
        note = "The weekly report's data model is under review (parity audit R12); decisions here are the CRM's own writes.",
    ),
    WorkModule(
        id = "expenses", title = "Operating costs", group = Group.Money,
        summary = "The expense register: raise a cost, repeat a recurring one, mark it paid.",
        crm = "/finance/costs",
        gate = { c -> c.isInternal },
        source = Source.Api("/api/expenses"),
        params = listOf(month().copy(required = false, asQuery = true)),
        filters = listOf(Filter("stage", "Stage", listOf("" to "All", "requested" to "Requested", "awaiting_signoff" to "Awaiting signature",
            "approved" to "Approved", "executed" to "Paid", "rejected" to "Rejected"))),
        titlePaths = listOf("title"), statusPath = "stage",
        subtitle = listOf(Field("Amount", "amount", FieldKind.Money), Field("Payee", "payload.payee")),
        detail = cardDetail,
        actions = CardActions.all + WorkAction("expense.repeat", "Repeat for another month", "/api/expenses/{item:id}/repeat",
            gate = { c -> c.requireWrite },
            inputs = listOf(month(), Input("amount_inr_minor", "Amount (₹)", InputType.Rupees, min = 1),
                Input("invoice_ref", "Invoice reference", minLen = 1, maxLen = 200), reason(),
                Input("evidence_url", "Invoice link (optional)", required = false, maxLen = 2000)),
            confirm = "Raise the next period's expense card from this one?"),
        pageActions = listOf(
            WorkAction("expense.new", "Raise an expense", "/api/expenses",
                gate = { c -> c.requireWrite },
                inputs = listOf(choice("category", "Category", *expenseCategories),
                    Input("amount_inr_minor", "Amount (₹)", InputType.Rupees, min = 1), month(),
                    Input("payee", "Payee", minLen = 1, maxLen = 200), Input("invoice_ref", "Invoice reference", minLen = 1, maxLen = 200),
                    reason(), Input("evidence_url", "Invoice link (optional)", required = false, maxLen = 2000),
                    yesNo("recurring", "Recurring", "Recurring every month", "One-off").copy(default = "false"),
                    Input("note", "Note (optional)", InputType.LongText, required = false, maxLen = 2000)),
                confirm = "Raise this expense card? It is paid only after it is verified and signed."),
            WorkAction("expense.due", "Recurring costs due", "/api/expenses/recurring-due", method = "GET",
                gate = { c -> c.isInternal }, inputs = listOf(month().copy(asQuery = true))),
        ),
    ),
    WorkModule(
        id = "capital", title = "Owners' capital", group = Group.Money,
        summary = "Capital introduced and drawn by each owner.",
        crm = "/finance/capital",
        gate = { c -> c.isInternal },
        source = Source.Api("/api/capital", arrayKey = "owners", limitParam = null),
        header = listOf(Field("Owners", "totals.owners", FieldKind.Count), Field("Introduced", "totals.introduced_minor", FieldKind.Money),
            Field("Drawn", "totals.drawn_minor", FieldKind.Money), Field("Outstanding", "totals.outstanding_minor", FieldKind.Money),
            Field("Note", "totals.note", FieldKind.LongText)),
        idPath = "owner_uid", titlePaths = listOf("owner_name", "owner_uid"), statusPath = null,
        subtitle = listOf(Field("Outstanding", "outstanding_minor", FieldKind.Money)),
        detail = listOf(Field("Owner", "owner_name"), Field("Introduced", "introduced_minor", FieldKind.Money),
            Field("Drawn", "drawn_minor", FieldKind.Money), Field("Outstanding", "outstanding_minor", FieldKind.Money),
            Field("Movements", "movements", FieldKind.Json)),
        pageActions = listOf(WorkAction("capital.record", "Record a movement", "/api/capital",
            gate = { c -> c.requireWrite },
            inputs = listOf(choice("direction", "Direction", "in" to "Capital in", "out" to "Drawings out"),
                Input("owner_uid", "Owner account ID", minLen = 1, maxLen = 200), Input("owner_name", "Owner name", required = false, maxLen = 200),
                Input("amount_minor", "Amount (₹)", InputType.Rupees, min = 1),
                Input("method", "Method", required = false, default = "bank", maxLen = 40),
                Input("reference", "Bank reference (UTR)", minLen = 1, maxLen = 200), reason()),
            confirm = "Raise a capital card? An owner cannot sign their own movement; it settles after signature.")),
    ),

    // ── B1 money integrity (Finance / Owner) ─────────────────────────────────
    WorkModule(
        id = "heldItems", title = "Held items", group = Group.Money,
        summary = "Pending cards, recharges, sales and sub-agency payouts of a revoked partner, held for Finance review.",
        crm = "/frozen-money (held items), /board (held)",
        // `require_internal` + `enforce_permission(CAN_PROCESS_PAYOUT)` on the route.
        gate = { c -> c.has(Perm.PROCESS_PAYOUT) },
        source = Source.Api("/api/partner-ops/held-items", arrayKeys = HeldItems.arrays),
        filters = listOf(Filter("include_released", "Show", listOf("false" to "Still held", "true" to "Including released"))),
        rowTransform = HeldItems::transform,
        titlePaths = listOf("held_title"), statusPath = "held.reason",
        subtitle = listOf(Field("Type", "held_label"), Field("Partner", "held.partner_id"),
            Field("Held since", "held.at", FieldKind.Date), Field("Released", "held.released_at", FieldKind.Date)),
        detail = listOf(Field("Type", "held_label"), Field("Record ID", "id"), Field("Why held", "held.reason", FieldKind.Status),
            Field("Partner kind", "held.partner_kind"), Field("Partner ID", "held.partner_id"),
            Field("Note", "held.note", FieldKind.LongText), Field("Held", "held.at", FieldKind.Date), Field("Held by", "held.by.name"),
            // `money_freeze.release_hold` writes `released_at`, `released_by` and `release_reason`.
            Field("Released", "held.released_at", FieldKind.Date), Field("Released by", "held.released_by.name"),
            Field("Release reason", "held.release_reason", FieldKind.LongText),
            Field("Stage", "stage", FieldKind.Status), Field("Status", "status", FieldKind.Status),
            Field("Amount", "amount", FieldKind.Count), Field("Diamonds", "diamonds", FieldKind.Count),
            Field("Amount (₹)", "amount_minor", FieldKind.Money), Field("Subject", "subject", FieldKind.Json),
            Field("Raised", "created_at", FieldKind.Date)),
        actions = listOf(WorkAction("held.release", "Release hold", "/api/partner-ops/held-items/{item:held_type}/{item:id}/release",
            gate = HeldItems::mayRelease, showFor = { i, _ -> stat(i, "held.released_at").isBlank() },
            inputs = listOf(reason(5, 1000, help = "Kept on the item with who released it and when.")),
            confirm = "Lift this hold? The item can then be decided through its ordinary route; nothing is approved or executed here.")),
        note = "Nothing on this list is approved, cancelled or executed by the machine. Finance's admin or an Owner releases a hold; the item is then decided where it normally is.",
        searchPaths = listOf("held_title", "held.partner_id", "held_label"),
    ),
    WorkModule(
        id = "replicaDrift", title = "Replica drift", group = Group.Money,
        summary = "Balances whose last Firestore sync failed — Mongo is right, the app's copy is stale.",
        crm = "/finance (replica drift)",
        gate = { c -> c.has(Perm.PROCESS_PAYOUT) },
        source = Source.Api("/api/partner-ops/money/replica-drift", arrayKey = "balances"),
        header = listOf(Field("Stale balances", "count", FieldKind.Count)),
        // A `balances` row as stored: holder_type / holder_id / currency / amount,
        // plus `replica_stale_at` and the `replica_pending` deltas still owed.
        titlePaths = listOf("holder_id", "id"), statusPath = null,
        subtitle = listOf(Field("Holder", "holder_type"), Field("Currency", "currency"),
            Field("Stale since", "replica_stale_at", FieldKind.Date)),
        detail = listOf(Field("Balance row", "id"), Field("Holder type", "holder_type"), Field("Holder ID", "holder_id"),
            Field("Currency", "currency"), Field("Balance (Mongo, authoritative)", "amount", FieldKind.Count),
            Field("Pending deltas", "replica_pending", FieldKind.Json), Field("Stale since", "replica_stale_at", FieldKind.Date),
            Field("Updated", "updated_at", FieldKind.Date)),
        note = "Read-only here. The sweep replays every pending delta every 15 minutes; the manual repair (`replica-drift/repair`) is an Owner / Finance action in the CRM.",
    ),
)

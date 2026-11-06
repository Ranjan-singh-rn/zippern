package com.zipper.app.data.work

import com.zipper.app.util.jsonPath
import com.zipper.app.util.jsonText

/*
 * Agencies, sub-agencies and coin sellers (staff side): the directory and
 * onboarding queue, one partner's record, recharges, sales and the seller
 * credit book. Lifecycle and money actions are the CRM's own routes.
 */

private val partnerViewer: (Caps) -> Boolean = { c ->
    c.isInternal && (c.readsAll || c.has(Perm.VIEW_AGENCIES) || c.has(Perm.VIEW_SELLERS) ||
        c.hasAny(Perm.APPROVE_KYC, Perm.APPROVE_SELLER) || c.has(Perm.COIN_OPERATIONS))
}

/** The CRM's /seller-trades page: the Owner and Finance (`can_coin_operations`); the Observer reads. */
private val tradeDesk: (Caps) -> Boolean = { c -> c.isInternal && (c.readsAll || c.has(Perm.COIN_OPERATIONS)) }

private val partnerSubtitle = listOf(Field("Kind", "kind"), Field("Created", "created_at", FieldKind.Date))

private val partnerLinks = listOf(
    WorkAction("partner.agencyStatement", "Commission statement", kind = ActionKind.Navigate, gate = { true },
        showFor = { i, _ -> stat(i, "kind") in setOf("agency", "sub_agency") }, target = Link("agency.statement", "{item:id}")),
    WorkAction("partner.agencyHosts", "Host earnings", kind = ActionKind.Navigate, gate = { true },
        showFor = { i, _ -> stat(i, "kind") in setOf("agency", "sub_agency") }, target = Link("agency.hosts", "{item:id}")),
    WorkAction("partner.agencySubs", "Sub-agencies", kind = ActionKind.Navigate, gate = { true },
        showFor = { i, _ -> stat(i, "kind") == "agency" }, target = Link("agency.subs", "{item:id}")),
    WorkAction("partner.sellerStatement", "Seller statement", kind = ActionKind.Navigate, gate = { true },
        showFor = { i, _ -> stat(i, "kind") == "seller" }, target = Link("seller.statement", "{item:id}")),
    WorkAction("partner.sellerHistory", "Seller history", kind = ActionKind.Navigate, gate = { true },
        showFor = { i, _ -> stat(i, "kind") == "seller" }, target = Link("seller.history", "{item:id}")),
    // B9: margin, credit, tier and limit (the CRM's business panel on /sellers/[id]) and this seller's trades.
    WorkAction("partner.sellerBusiness", "Coin business", kind = ActionKind.Navigate, gate = { true },
        showFor = { i, _ -> stat(i, "kind") == "seller" }, target = Link("seller.business", "{item:id}")),
    WorkAction("partner.sellerTrades", "Trades with other sellers", kind = ActionKind.Navigate, gate = tradeDesk,
        showFor = { i, _ -> stat(i, "kind") == "seller" }, target = Link("sellerTrades", "{item:id}")),
    WorkAction("partner.owner", "Owner's account", kind = ActionKind.Navigate, gate = { c -> c.isInternal },
        showFor = { i, _ -> stat(i, "owner_crm_uid").isNotBlank() }, target = Link("users.record", "{item:owner_crm_uid}")),
)

private val rechargeDetail = listOf(
    Field("Request ID", "id"), Field("Status", "status", FieldKind.Status),
    Field("Buyer", "buyer_uid", FieldKind.Uid, link = Link("users.record", "uid")),
    Field("Seller", "seller_name"), Field("Seller ID", "seller_id"),
    Field("Diamonds", "diamonds", FieldKind.Count), Field("Amount", "amount_minor", FieldKind.Money),
    Field("Currency", "currency"), Field("Method", "payment_method"), Field("Reference (UTR)", "reference"),
    Field("Credited", "credited_diamonds", FieldKind.Count), Field("Refunded", "refunded_diamonds", FieldKind.Count),
    Field("Could not be recovered", "unrecoverable_diamonds", FieldKind.Count),
    Field("Shortfall", "shortfall", FieldKind.Json), Field("Rejection reason", "rejection_reason", FieldKind.LongText),
    Field("Refund reason", "refund_reason", FieldKind.LongText),
    Field("Filed", "created_at", FieldKind.Date), Field("History", "history", FieldKind.Json),
)

internal val partnersModules: List<WorkModule> = listOf(

    WorkModule(
        id = "partners.directory", title = "Agencies & sellers", group = Group.Partners,
        summary = "Every agency, sub-agency and coin seller, and the onboarding queue.",
        crm = "/agencies, /sellers, /kyc (partners), /onboarding",
        gate = partnerViewer,
        source = Source.Api("/api/partner-ops/partners"),
        filters = listOf(
            Filter("status", "Status", listOf("" to "All", "pending" to "Pending", "awaiting_verification" to "Awaiting verification",
                "approved" to "Approved", "suspended" to "Suspended", "revoked" to "Revoked", "rejected" to "Rejected")),
            Filter("kind", "Kind", listOf("" to "All kinds", "agency" to "Agencies", "sub_agency" to "Sub-agencies", "seller" to "Coin sellers")),
        ),
        subtitle = partnerSubtitle,
        detail = partnerDetail,
        detailPath = "/api/partner-ops/partners/{id}",
        hide = setOf("login_email", "virtual_account"),
        actions = PartnerActions.all + partnerLinks,
        pageSize = 100,
        searchPaths = listOf("name", "parent_name", "kind"),
    ),
    WorkModule(
        id = "partners.one", title = "Partner record", group = Group.Partners,
        summary = "One agency or seller: status, standing, balances and every lifecycle action.",
        crm = "/agencies/[id], /sellers/[id]",
        gate = partnerViewer,
        source = Source.Api("/api/partner-ops/partners/{param:partner_id}", arrayKey = "__none__", limitParam = null),
        params = listOf(Input("partner_id", "Partner ID", minLen = 1, maxLen = 200)),
        header = partnerDetail,
        hide = setOf("login_email", "virtual_account"),
        pageActions = PartnerActions.all + partnerLinks,
    ),
    WorkModule(
        id = "recharges", title = "Recharges", group = Group.Money,
        summary = "Buyers who paid a coin seller off the app: verify, credit, refuse or refund.",
        crm = "/recharges, /seller-dashboard (recharges)",
        gate = { c -> c.isSellerPartner || (c.isInternal && (c.readsAll || c.has(Perm.COIN_OPERATIONS) || c.has(Perm.VIEW_SELLERS))) },
        source = Source.Api("/api/partner-ops/recharges"),
        filters = listOf(Filter("status", "Status", listOf("pending" to "Pending", "approved" to "Approved",
            "rejected" to "Rejected", "refund_pending" to "Refund pending", "refunded" to "Refunded",
            "reversed" to "Partly reversed", "" to "All"))),
        titlePaths = listOf("seller_name", "id"), nameUidPaths = listOf("buyer_uid"),
        subtitle = listOf(Field("Diamonds", "diamonds", FieldKind.Count), Field("Paid", "amount_minor", FieldKind.Money),
            Field("Filed", "created_at", FieldKind.Date)),
        detail = rechargeDetail,
        hide = setOf("approved_by", "reviewed_by", "refund_requested_by", "refund_decided_by", "created_by"),
        actions = listOf(
            WorkAction("recharge.proof", "Open payment proof", kind = ActionKind.OpenUrl, gate = { true }, urlPath = "proof_url",
                showFor = { i, _ -> stat(i, "proof_url").startsWith("https://") }),
            // Owner rule (6 Nov 2026): the seller who was paid approves their own sale; it is filed through the
            // ledger at once. Refused by the server while the seller owes borrowed coins — then Zipper verifies.
            WorkAction("recharge.sellerApprove", "Payment received — approve", "/api/partner-ops/recharges/{item:id}/seller-approve",
                gate = { c -> c.isSellerPartner }, showFor = statusIn("pending"),
                fixed = mapOf("reason" to "Seller confirmed the payment was received"),
                confirm = "Did this payment reach your account? Your coins go to the buyer as diamonds now, and the sale is recorded."),
            WorkAction("recharge.sellerReject", "Not received — reject", "/api/partner-ops/recharges/{item:id}/seller-reject", danger = true,
                gate = { c -> c.isSellerPartner }, showFor = statusIn("pending"),
                inputs = listOf(reason()), confirm = "Reject this request? Nothing moves and the buyer is told."),
            WorkAction("recharge.approve", "Approve & credit", "/api/partner-ops/recharges/{item:id}/approve", danger = true,
                gate = { c -> c.isOwner && c.has(Perm.COIN_OPERATIONS) }, showFor = statusIn("pending", "approving"),
                inputs = listOf(reason()),
                confirm = "Payment verified? The seller's coins become the buyer's diamonds, once."),
            WorkAction("recharge.reject", "Reject", "/api/partner-ops/recharges/{item:id}/reject", danger = true,
                gate = { c -> c.has(Perm.COIN_OPERATIONS) }, showFor = statusIn("pending"),
                inputs = listOf(reason()), confirm = "Reject this recharge request? The buyer and seller are told."),
            WorkAction("recharge.refund", "Open refund", "/api/partner-ops/recharges/{item:id}/refund",
                gate = { c -> c.has(Perm.COIN_OPERATIONS) }, showFor = statusIn("approved"),
                inputs = listOf(reason()), confirm = "Open a refund review? Nothing moves until an Owner decides."),
            WorkAction("recharge.refundDecide", "Decide refund", "/api/partner-ops/recharges/{item:id}/refund/decide", danger = true,
                gate = { c -> c.isOwner && c.has(Perm.COIN_OPERATIONS) }, showFor = statusIn("refund_pending", "refunding"),
                inputs = listOf(yesNo("approve", "Decision", "Approve the refund", "Refuse the refund"), reason()),
                confirm = "Decide this refund? An approval takes back only the diamonds that are still there."),
        ),
        searchPaths = listOf("seller_name", "reference", "buyer_uid", "id"),
    ),
    WorkModule(
        id = "sales", title = "Coin sales", group = Group.Money,
        summary = "Diamonds a coin seller sold to a buyer; an Owner approves each one.",
        crm = "/sales, /seller-dashboard (file a sale)",
        gate = { c -> c.isSellerPartner || (c.isInternal && (c.readsAll || c.has(Perm.COIN_OPERATIONS) || c.has(Perm.VIEW_SELLERS))) },
        source = Source.Api("/api/partner-ops/sales"),
        filters = listOf(Filter("status", "Status", listOf("" to "All", "pending" to "Pending", "approved" to "Approved", "failed" to "Failed"))),
        titlePaths = listOf("buyer_uid"), nameUidPaths = listOf("buyer_uid"),
        subtitle = listOf(Field("Diamonds", "diamonds", FieldKind.Count), Field("Paid", "amount_paid_minor", FieldKind.Money),
            Field("Filed", "created_at", FieldKind.Date)),
        detail = listOf(Field("Sale ID", "id"), Field("Seller ID", "seller_id"),
            Field("Buyer", "buyer_uid", FieldKind.Uid, link = Link("app.profile", "uid")),
            Field("Diamonds", "diamonds", FieldKind.Count), Field("Amount paid", "amount_paid_minor", FieldKind.Money),
            Field("Status", "status", FieldKind.Status), Field("Reason", "reason", FieldKind.LongText),
            Field("Approved", "approved_at", FieldKind.Date), Field("Failure", "failure", FieldKind.Json),
            Field("Filed", "created_at", FieldKind.Date)),
        hide = setOf("recorded_by", "approved_by"),
        actions = listOf(WorkAction("sale.approve", "Approve", "/api/partner-ops/sales/{item:id}/approve", danger = true,
            gate = { c -> c.isOwner && c.has(Perm.COIN_OPERATIONS) }, showFor = statusIn("pending"),
            inputs = listOf(reason()),
            confirm = "Approve this sale? The seller's coins are debited and the buyer's diamonds credited.")),
        pageActions = listOf(WorkAction("sale.new", "File a sale", "/api/partner-ops/sales",
            gate = { c -> c.isSellerPartner || c.requireWrite },
            inputs = listOf(
                Input("seller_id", "Seller ID", default = "{seller}", minLen = 1, maxLen = 200),
                Input("buyer_uid", "Buyer", InputType.Lookup, minLen = 1, maxLen = 200,
                    lookup = LookupSpec("/api/partner-ops/buyers/lookup", "q", 3, "uid", "name", listOf("email", "phone", "uid")),
                    help = "Type the buyer's exact account ID, email or phone, then pick them."),
                Input("diamonds", "Diamonds", InputType.Int, min = 1),
                Input("amount_paid_minor", "Amount the buyer paid (₹)", InputType.Rupees, required = false, min = 0),
                reason(),
            ),
            confirm = "File this sale for an Owner's approval? Nothing moves until it is approved.")),
    ),
    WorkModule(
        id = "sellerTrades", title = "Seller-to-seller trades", group = Group.Money,
        summary = "Coins one seller bought from another: check the payment reference, then an Owner approves and the coins move once.",
        crm = "/seller-trades",
        gate = tradeDesk,
        source = Source.Api("/api/partner-ops/seller-trades", limitParam = null),
        params = listOf(Input("seller_id", "Seller ID (optional)", required = false, maxLen = 64, asQuery = true,
            help = "Blank lists every seller's trades.")),
        filters = listOf(Filter("status", "Status", listOf("pending" to "Pending", "approved" to "Approved", "rejected" to "Rejected", "" to "All"))),
        titlePaths = listOf("trade_line", "id"), statusPath = "trade_state",
        subtitle = listOf(Field("Coins", "coins", FieldKind.Count), Field("Paid", "amount_paid_minor", FieldKind.Money),
            Field("Reference", "payment_ref"), Field("Filed", "created_at", FieldKind.Date)),
        detail = sellerTradeDetail + listOf(Field("History", "history", FieldKind.Json)),
        hide = setOf("client_request_id"),
        rowTransform = ::sellerTradeRow,
        searchPaths = listOf("buyer_name", "seller_name", "payment_ref", "buyer_id", "seller_id"),
        note = "Check the reference against the bank or UPI statement first. A trade the selling seller reported as not paid " +
            "cannot be approved — reject it and the buyer can file again with proof.",
        actions = listOf(
            WorkAction("trade.approve", "Approve — move the coins", "/api/partner-ops/seller-trades/{item:id}/approve", danger = true,
                gate = { c -> c.isOwner && c.has(Perm.COIN_OPERATIONS) },
                showFor = { i, _ -> stat(i) == "pending" && i["disputed"] != true },
                inputs = listOf(reason(label = "How the payment was verified")),
                confirm = "Payment verified? The selling seller's coins move to the buyer, once."),
            WorkAction("trade.reject", "Reject", "/api/partner-ops/seller-trades/{item:id}/reject", danger = true,
                gate = { c -> c.has(Perm.COIN_OPERATIONS) }, showFor = statusIn("pending"),
                inputs = listOf(reason()),
                confirm = "Reject this trade? Nothing has moved, so nothing moves back; the buyer can file again with proof."),
        ),
    ),
    WorkModule(
        id = "credit.overdue", title = "Seller credit", group = Group.Money,
        summary = "Sellers whose coin credit is overdue, and the exposure across the book.",
        crm = "/lending, /partners (exposure)",
        gate = { c -> c.isInternal },
        source = Source.Api("/api/partners/credit/overdue"),
        subtitle = listOf(Field("Outstanding", "outstanding", FieldKind.Count), Field("Days overdue", "days_overdue", FieldKind.Count)),
        statusPath = null,
        detail = listOf(Field("Seller", "name"), Field("Seller ID", "id"), Field("Outstanding coins", "outstanding", FieldKind.Count),
            Field("Due", "due_at", FieldKind.Date), Field("Days overdue", "days_overdue", FieldKind.Count)),
        actions = listOf(WorkAction("credit.open", "Open seller", kind = ActionKind.Navigate, gate = { true },
            target = Link("partners.one", "{item:id}"))),
        pageActions = listOf(WorkAction("credit.exposure", "Exposure across all sellers", "/api/partners/credit/exposure",
            method = "GET", gate = { c -> c.readsAll || c.role in setOf("finance_admin", "finance_member", "ops_admin") })),
    ),
    WorkModule(
        id = "coinRequests", title = "Coin purchase requests (legacy)", group = Group.Money,
        summary = "Purchase requests sellers filed in the app before purchases became cards.",
        crm = "/coin-purchases (Firestore requests)",
        gate = { c -> c.isInternal && !c.isObserver && (c.has(Perm.COIN_OPERATIONS)) },
        source = Source.Firestore("coinPurchaseRequests", orderBy = "createdAt"),
        filters = listOf(Filter("status", "Status", listOf("pending" to "Pending", "" to "All"))),
        titlePaths = listOf("sellerName", "id"),
        subtitle = listOf(Field("Coins", "coinsRequested", FieldKind.Count), Field("Filed", "createdAt", FieldKind.Date)),
        detail = listOf(Field("Seller", "sellerName"), Field("Seller ID", "sellerUid"), Field("Coins", "coinsRequested", FieldKind.Count),
            Field("Amount paid (as recorded)", "amountPaid", FieldKind.Rupees), Field("Reference", "transactionRef"),
            Field("Status", "status", FieldKind.Status), Field("Proof", "paymentProofUrl", FieldKind.Url),
            Field("Filed", "createdAt", FieldKind.Date)),
        hide = setOf("sellerEmail"),
        actions = listOf(
            WorkAction("coinReq.proof", "Open payment proof", kind = ActionKind.OpenUrl, gate = { true }, urlPath = "paymentProofUrl",
                showFor = { i, _ -> stat(i, "paymentProofUrl").startsWith("https://") }),
            WorkAction("coinReq.convert", "Raise purchase card", "/api/partner-ops/sellers/{item:sellerUid}/coin-purchases",
            gate = { c -> c.has(Perm.COIN_OPERATIONS) }, showFor = statusIn("pending"),
            inputs = listOf(
                Input("coins", "Coins", InputType.Int, min = 1, prefillPath = "coinsRequested"),
                Input("amount_paid_minor", "Amount paid (₹)", InputType.Rupees, min = 0, prefillPath = "amountPaid"),
                Input("payment_ref", "Payment reference (UTR)", minLen = 1, maxLen = 200, prefillPath = "transactionRef"),
                Input("evidence_url", "Proof link", required = false, maxLen = 2000, prefillPath = "paymentProofUrl"),
                reason()),
            confirm = "Raise a coin purchase card from this request? Nothing moves until it is signed and executed."),
        ),
    ),
)

/** Rows of a card list that belong to one partner (used by the partner record's links). */
internal fun cardSubjectIs(id: String): (Item) -> Boolean = { it.jsonPath("subject.id").jsonText() == id }

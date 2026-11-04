package com.zipper.app.data.work

/*
 * Partner portals: what the CRM's /agency-dashboard and /seller-dashboard show
 * an agency or coin-seller login, through the partner-reachable API routes
 * (`PARTNER_REACHABLE` in backend/app/core/deps.py). A partner session can
 * only ever reach its own ids; staff open the same screens for any id.
 */

private val agencyViewer: (Caps) -> Boolean = { c -> c.isAgencyPartner || c.isInternal }
private val sellerViewer: (Caps) -> Boolean = { c -> c.isSellerPartner || c.isInternal }

private fun agencyParam() = Input("agency_id", "Agency ID", default = "{agency}", minLen = 1,
    help = "Your own agency is filled in. Staff may enter any agency id.")

private fun sellerParam() = Input("seller_id", "Seller ID", default = "{seller}", minLen = 1,
    help = "Your own seller record is filled in. Staff may enter any seller id.")

// ── Coin seller: the B9 business (3 Nov 2026) ────────────────────────────────
// What the CRM's SellerBusinessPanel offers (/seller-dashboard for the seller, /sellers/[id] for staff) and its
// /seller-trades page, on the same routes (backend routers/partner_ops.py, services/seller_business.py). These
// screens FILE requests and SHOW the server's figures: nothing here approves, signs, executes or computes money.

/** Who is offered "borrow" and "buy from another seller": the seller, or staff with coin operations (as the CRM). */
private val sellerFiler: (Caps) -> Boolean = { c -> c.isSellerPartner || c.has(Perm.COIN_OPERATIONS) }

/** Owner-only seller terms (`require_owner` + `can_coin_operations` on both routes). */
private val sellerTerms: (Caps) -> Boolean = { c -> c.isOwner && c.has(Perm.COIN_OPERATIONS) }

/**
 * `POST /partner-ops/seller-trades` (`SellerTradeFiling`): the BUYING seller files "I paid this seller for these
 * coins". The server scopes `buyer_seller_id` to the session's own seller record, refuses a self-trade, a
 * circular trade and a reused payment reference, and moves nothing until an Owner approves.
 * `client_request_id` makes a repeated tap the same request.
 */
internal fun sellerTradeFiling() = WorkAction("trade.file", "Buy coins from another seller", "/api/partner-ops/seller-trades",
    gate = sellerFiler,
    inputs = listOf(
        Input("buyer_seller_id", "Your seller ID (buying)", default = "{param:seller_id}", minLen = 1, maxLen = 64,
            help = "Your own seller record is filled in."),
        Input("seller_seller_id", "Seller ID you paid", minLen = 1, maxLen = 64,
            help = "Ask the other seller for their seller ID."),
        Input("coins", "Coins", InputType.Int, min = 1),
        Input("amount_paid_minor", "Amount you paid them (₹)", InputType.Rupees, min = 0),
        Input("payment_ref", "Payment reference (UTR / TxID)", minLen = 1, maxLen = 200),
    ),
    fixed = mapOf("client_request_id" to "{uuid}"),
    confirm = "File this trade? Pay the other seller first. Zipper checks the payment and the coins move only when an Owner approves it.")

/**
 * O7 (Owner, 5 Nov 2026): "if a seller borrowed coins from us, for those coins he needs to pay — and that payment is
 * not in the app or the CRM." `POST /partner-ops/sellers/{seller_id}/repayment-requests` (`SellerRepayment`): a
 * payment to Zipper with its amount and reference, or unsold borrowed coins handed back from stock. The server scopes
 * the seller id to the session's own record, refuses more than is owed (or, for a return, more than is in stock),
 * and moves nothing until one Owner approves it. Offered only while something is owed.
 */
internal fun sellerRepayment() = WorkAction("seller.repay", "Pay back borrowed coins",
    "/api/partner-ops/sellers/{param:seller_id}/repayment-requests",
    gate = sellerFiler,
    showFor = { item, _ -> (stat(item, "credit_outstanding").toDoubleOrNull() ?: 0.0) > 0.0 },
    inputs = listOf(
        Input("method", "How you are paying back", InputType.Choice, default = "payment",
            options = listOf("payment" to "I paid Zipper (bank / UPI)", "return_coins" to "Return unsold coins from my stock")),
        Input("coins", "Borrowed coins this pays back", InputType.Int, min = 1,
            help = "Up to \"You owe now\" above."),
        Input("amount_paid_minor", "Amount you paid (₹)", InputType.Rupees, min = 1,
            showIf = { it["method"] != "return_coins" }),
        Input("payment_ref", "Payment reference (UTR / TxID)", minLen = 1, maxLen = 200,
            showIf = { it["method"] != "return_coins" }),
        reason(label = "Note for Zipper"),
    ),
    confirm = "Send this to Zipper? Nothing changes until an Owner approves it: a payment lowers what you owe; " +
        "returned coins leave your stock and lower what you owe by the same.")

/** The trade fields a seller may read. Who on the staff decided is not shown to a partner (as the ledger screens). */
internal val sellerTradeDetail = listOf(
    Field("Trade", "trade_line"), Field("Status", "trade_state", FieldKind.Status),
    Field("Buying seller", "buyer_name"), Field("Buying seller ID", "buyer_id"),
    Field("Selling seller", "seller_name"), Field("Selling seller ID", "seller_id"),
    Field("Coins", "coins", FieldKind.Count), Field("Amount paid", "amount_paid_minor", FieldKind.Money),
    Field("Payment reference", "payment_ref"), Field("Filed", "created_at", FieldKind.Date),
    Field("Not-paid report", "dispute_reason", FieldKind.LongText), Field("Reported", "disputed_at", FieldKind.Date),
    Field("Selling seller short of coins", "shortfall", FieldKind.Json),
    Field("Approved", "approved_at", FieldKind.Date), Field("Rejected", "rejected_at", FieldKind.Date),
    Field("Rejection reason", "rejection_reason", FieldKind.LongText),
)

internal val sellerTradeHide = setOf(
    "created_by", "approved_by", "rejected_by", "disputed_by", "history", "client_request_id", "approval_reason",
)

/**
 * A trade row as the lists read it: who bought from whom, and the state with the two flags the CRM shows
 * (disputed, selling seller short of coins). Pure and total — `SellerBusinessWorkTest` runs it.
 */
internal fun sellerTradeRow(i: Item): Item {
    val buyer = stat(i, "buyer_name").ifBlank { stat(i, "buyer_id") }.ifBlank { "?" }
    val seller = stat(i, "seller_name").ifBlank { stat(i, "seller_id") }.ifBlank { "?" }
    val state = listOf(stat(i)).filter { it.isNotBlank() } +
        listOfNotNull(if (i["disputed"] == true) "not paid reported" else null, if (i["shortfall"] != null) "seller short of coins" else null)
    return i + mapOf("trade_line" to "$buyer bought from $seller", "trade_state" to state.joinToString(" · "))
}

internal val sellerTradeStatuses = listOf("" to "All", "pending" to "Pending", "approved" to "Approved", "rejected" to "Rejected")

internal val partnerModules: List<WorkModule> = listOf(

    // ── Agency ────────────────────────────────────────────────────────────────
    WorkModule(
        id = "agency.statement", title = "Commission statement", group = Group.Mine,
        summary = "Commission earned, paid and outstanding, with every ledger movement.",
        crm = "/agency-dashboard (statement), /partners (agency tab)",
        gate = agencyViewer,
        source = Source.Api("/api/partners/agencies/{param:agency_id}/statement", arrayKey = "entries"),
        params = listOf(agencyParam(),
            Input("since", "From (optional)", InputType.DateTime, required = false, asQuery = true),
            Input("until", "To (optional)", InputType.DateTime, required = false, asQuery = true)),
        header = listOf(
            Field("Agency", "name"), Field("Agency ID", "agency_id"),
            Field("Commission earned", "commission_earned", FieldKind.Money),
            Field("Commission paid", "commission_paid", FieldKind.Money),
            Field("Outstanding", "commission_outstanding", FieldKind.Money),
            Field("Hosts", "host_count", FieldKind.Count),
            Field("From", "period_from", FieldKind.Date), Field("To", "period_to", FieldKind.Date),
            Field("How commission is computed", "commission_rule"),
            Field("Commission basis", "commission_basis", FieldKind.Json),
        ),
        titlePaths = listOf("action"), statusPath = null,
        subtitle = listOf(Field("When", "at", FieldKind.Date), Field("Amount", "amount", FieldKind.Money)),
        detail = listOf(
            Field("Action", "action"), Field("When", "at", FieldKind.Date),
            Field("Amount", "amount", FieldKind.Money), Field("Balance before", "balance_before", FieldKind.Money),
            Field("Balance after", "balance_after", FieldKind.Money), Field("Reason", "reason", FieldKind.LongText),
            Field("Card", "card_id"), Field("Details", "meta", FieldKind.Json),
        ),
        // Staff identities on ledger rows are not the partner's business (inventory flag 1).
        hide = setOf("actor", "idempotency_key"),
        searchPaths = listOf("action", "reason"),
    ),
    WorkModule(
        id = "agency.hosts", title = "Host earnings", group = Group.Mine,
        summary = "Your hosts' bean earnings — the operational view of the roster.",
        crm = "/agency-dashboard (hosts), /agencies/[id] (hosts tab)",
        gate = agencyViewer,
        source = Source.Api("/api/partners/agencies/{param:agency_id}/hosts"),
        params = listOf(agencyParam(),
            Input("since", "Since (optional)", InputType.DateTime, required = false, asQuery = true)),
        idPath = "host_id", titlePaths = listOf("host_id"), statusPath = null,
        nameUidPaths = listOf("host_id"),
        subtitle = listOf(Field("Beans earned", "beans_earned", FieldKind.Count), Field("Last earned", "last_earned_at", FieldKind.Date)),
        detail = listOf(
            Field("Host ID", "host_id", FieldKind.Uid, link = Link("app.profile", "uid")),
            Field("Beans earned", "beans_earned", FieldKind.Count),
            Field("Movements", "movements", FieldKind.Count),
            Field("Last earned", "last_earned_at", FieldKind.Date),
        ),
        actions = listOf(WorkAction("host.profile", "Open profile", kind = ActionKind.Navigate,
            gate = { true }, target = Link("app.profile", "{item:host_id}"))),
    ),
    WorkModule(
        id = "agency.subs", title = "Sub-agencies", group = Group.Mine,
        summary = "Sub-agencies under this agency and the commission owed to each.",
        crm = "/agency-dashboard (sub-agencies), /agencies/[id] (subs tab)",
        gate = agencyViewer,
        source = Source.Api("/api/partners/agencies/{param:agency_id}/sub-agencies", limitParam = null),
        params = listOf(agencyParam()),
        subtitle = listOf(Field("Owed by parent", "owed_by_parent", FieldKind.Money)),
        detail = listOf(Field("Name", "name"), Field("Partner ID", "id"), Field("Status", "status", FieldKind.Status),
            Field("Owed by parent", "owed_by_parent", FieldKind.Money)),
    ),
    WorkModule(
        id = "agency.reports", title = "Reports on my hosts", group = Group.Mine,
        summary = "Reports filed against your hosts and what was done.",
        crm = "/agency-dashboard (HostReports)",
        gate = agencyViewer,
        source = Source.Api("/api/partners/agencies/{param:agency_id}/host-reports"),
        params = listOf(agencyParam()),
        titlePaths = listOf("reason", "targetType", "id"),
        nameUidPaths = listOf("targetUid"),
        subtitle = listOf(Field("Host", "targetUid"), Field("Filed", "createdAt", FieldKind.Date)),
        detail = listOf(
            Field("Reported host", "targetUid", FieldKind.Uid, link = Link("app.profile", "uid")),
            Field("Reason", "reason"), Field("Description", "description", FieldKind.LongText),
            Field("Status", "status", FieldKind.Status), Field("Action taken", "actionTaken"),
            Field("Filed", "createdAt", FieldKind.Date), Field("Beans deducted", "deductBeans", FieldKind.Count),
        ),
        // Who filed a report is not the agency's to know (inventory flag 2).
        hide = setOf("reporterUid", "reporterName", "reviewedBy", "reviewedByName"),
    ),
    WorkModule(
        id = "agency.appeals", title = "Appeals for my hosts", group = Group.Mine,
        summary = "Ban, suspension and report appeals raised for your hosts.",
        crm = "/agency-dashboard (appeals)",
        gate = agencyViewer,
        source = Source.Api("/api/partners/agencies/{param:agency_id}/appeals"),
        params = listOf(agencyParam()),
        titlePaths = listOf("kind", "id"),
        nameUidPaths = listOf("subjectUid"),
        subtitle = listOf(Field("Host", "subjectUid"), Field("Raised", "createdAt", FieldKind.Date)),
        detail = listOf(
            Field("Host", "subjectUid", FieldKind.Uid, link = Link("app.profile", "uid")),
            Field("Kind", "kind"), Field("Status", "status", FieldKind.Status),
            Field("Statement", "statement", FieldKind.LongText), Field("Decision", "decisionReason", FieldKind.LongText),
            Field("Raised", "createdAt", FieldKind.Date),
        ),
        hide = setOf("originalDecidedBy", "decidedBy", "raisedByUid"),
    ),
    WorkModule(
        id = "agency.subPayouts", title = "Sub-agency payouts", group = Group.Mine,
        summary = "Two-leg payouts between a main agency and its sub-agencies that are still open.",
        crm = "/agency-dashboard, /agencies/[id], /agencies",
        gate = { c -> c.isAgencyPartner || c.isInternal },
        source = Source.Api("/api/partner-ops/subagency-payouts/open"),
        titlePaths = listOf("sub_name", "id"),
        subtitle = listOf(Field("Amount", "amount_minor", FieldKind.Money), Field("Main agency", "parent_name")),
        detail = listOf(
            Field("Sub-agency", "sub_name"), Field("Main agency", "parent_name"),
            Field("Amount", "amount_minor", FieldKind.Money), Field("Status", "status", FieldKind.Status),
            Field("Leg 1 (Zipper → main agency)", "leg1", FieldKind.Json),
            Field("Leg 2 (main agency → sub-agency)", "leg2", FieldKind.Json),
            Field("Reason", "reason", FieldKind.LongText), Field("Raised", "created_at", FieldKind.Date),
        ),
        actions = listOf(WorkAction("subpayout.confirm", "Confirm leg 2", "/api/partner-ops/subagency-payouts/{item:id}/confirm-leg",
            gate = { c -> c.has(Perm.PROCESS_PAYOUT) }, showFor = statusIn("parent_paid"),
            inputs = listOf(reason()), confirm = "Confirm the main agency paid the sub-agency and close this payout?")),
    ),

    // ── Coin seller ───────────────────────────────────────────────────────────
    WorkModule(
        id = "seller.statement", title = "Seller statement", group = Group.Mine,
        summary = "Coins bought, lent, sold and on hand, credit standing, and the ledger.",
        crm = "/seller-dashboard (statement), /partners (seller tab), /sellers/[id]",
        gate = sellerViewer,
        source = Source.Api("/api/partners/sellers/{param:seller_id}/statement", arrayKey = "entries"),
        params = listOf(sellerParam()),
        header = listOf(
            Field("Seller", "name"), Field("Seller ID", "seller_id"),
            Field("Coins on hand", "coins_on_hand", FieldKind.Count),
            Field("Coins purchased", "coins_purchased", FieldKind.Count),
            Field("Coins lent", "coins_lent", FieldKind.Count), Field("Coins sold", "coins_sold", FieldKind.Count),
            Field("Cash paid", "cash_paid_minor", FieldKind.Money),
            Field("Credit outstanding", "credit_outstanding", FieldKind.Count),
            Field("Credit standing", "credit_standing", FieldKind.Status),
            Field("Credit due", "credit_due_at", FieldKind.Date),
        ),
        titlePaths = listOf("action"), statusPath = null,
        subtitle = listOf(Field("When", "at", FieldKind.Date), Field("Coins", "amount", FieldKind.Count)),
        detail = listOf(Field("Action", "action"), Field("When", "at", FieldKind.Date),
            Field("Amount", "amount", FieldKind.Count), Field("Balance after", "balance_after", FieldKind.Count),
            Field("Reason", "reason", FieldKind.LongText), Field("Card", "card_id")),
        hide = setOf("actor", "idempotency_key"),
        pageActions = listOf(
            WorkAction("seller.canTake", "Can I buy inventory?", "/api/partners/sellers/{param:seller_id}/can-take-inventory",
                method = "GET", gate = sellerViewer),
            WorkAction("seller.buy", "Buy coin inventory", "/api/partner-ops/sellers/{param:seller_id}/coin-purchases",
                gate = { c -> c.isSellerPartner || c.has(Perm.COIN_OPERATIONS) },
                inputs = listOf(
                    Input("coins", "Coins", InputType.Int, min = 1),
                    Input("amount_paid_minor", "Amount you paid Zipper (₹)", InputType.Rupees, min = 0,
                        help = "Must match the wholesale price; the server checks it."),
                    Input("payment_ref", "Payment reference (UTR / TxID)", minLen = 1, maxLen = 200),
                    Input("evidence_url", "Link to the payment proof (optional)", required = false, maxLen = 2000),
                    reason(),
                ),
                confirm = "File this coin purchase? Zipper verifies the payment; coins arrive only after an Owner signs and credits it."),
        ),
    ),
    WorkModule(
        id = "seller.history", title = "Seller history", group = Group.Mine,
        summary = "Every purchase, loan, repayment, recovery, write-off and sale, with totals.",
        crm = "/seller-dashboard (history), /sellers/[id] (transactions)",
        gate = sellerViewer,
        source = Source.Api("/api/partners/sellers/{param:seller_id}/history", arrayKey = "rows"),
        params = listOf(sellerParam(),
            Input("since", "From (optional)", InputType.DateTime, required = false, asQuery = true),
            Input("until", "To (optional)", InputType.DateTime, required = false, asQuery = true)),
        header = listOf(Field("Seller", "name"), Field("Totals", "totals", FieldKind.Json), Field("Note", "note", FieldKind.LongText)),
        titlePaths = listOf("what", "kind"), statusPath = "card_stage",
        subtitle = listOf(Field("When", "at", FieldKind.Date), Field("Coins", "coins", FieldKind.Count),
            Field("Amount", "amount_minor", FieldKind.Money)),
        detail = listOf(Field("What", "what"), Field("Kind", "kind"), Field("When", "at", FieldKind.Date),
            Field("Coins", "coins", FieldKind.Count), Field("Amount", "amount_minor", FieldKind.Money),
            Field("Counterparty", "counterparty"), Field("Reference", "reference"),
            Field("Settled", "settled", FieldKind.Bool), Field("Reason", "reason", FieldKind.LongText),
            Field("Proof", "proof_url", FieldKind.Url)),
        actions = listOf(WorkAction("history.proof", "Open payment proof", kind = ActionKind.OpenUrl,
            gate = { true }, urlPath = "proof_url", showFor = { i, _ -> stat(i, "proof_url").startsWith("https://") })),
    ),
    WorkModule(
        id = "seller.business", title = "My coin business", group = Group.Mine,
        summary = "Coins in stock, what you paid and sold for, your margin and credit — borrow coins or buy from another seller.",
        crm = "/seller-dashboard (SellerBusinessPanel), /sellers/[id] (business panel)",
        gate = sellerViewer,
        source = Source.Api("/api/partner-ops/sellers/{param:seller_id}/profit", arrayKey = "__none__", limitParam = null),
        params = listOf(sellerParam()),
        header = listOf(
            Field("Coins in stock", "inventory_coins", FieldKind.Count),
            Field("Tier", "tier"),
            Field("Coins bought", "purchased_coins", FieldKind.Count),
            Field("Paid for them", "purchase_cost_minor", FieldKind.Money),
            Field("Average cost per lakh coins", "avg_cost_inr_per_lakh", FieldKind.Rupees),
            Field("Coins sold", "coins_sold", FieldKind.Count),
            Field("Your buyers paid", "revenue_minor", FieldKind.Money),
            Field("Average sale per lakh coins", "avg_sale_inr_per_lakh", FieldKind.Rupees),
            Field("Cost of the coins sold", "cost_of_sold_minor", FieldKind.Money),
            Field("Gross profit", "gross_profit_minor", FieldKind.Money),
            Field("Credit limit (coins)", "credit_limit", FieldKind.Count),
            Field("You owe now (coins)", "credit_outstanding", FieldKind.Count),
            Field("You can still borrow (coins)", "borrow_headroom", FieldKind.Count),
            Field("Borrowed in total (coins)", "borrowed_coins_total", FieldKind.Count),
            Field("Used for yourself (coins)", "self_use_coins", FieldKind.Count),
        ),
        // The server's own definitions (`PROFIT_DEFINITIONS`), in short.
        note = "Gross profit = what your buyers paid − what the coins you sold cost you (your average purchase price). " +
            "Borrowed coins cost nothing until repaid. Using coins for yourself is not a sale. " +
            "You cannot sell or recharge coins to yourself: buy stock from Zipper (Seller statement → Buy coin inventory), " +
            "from another seller, or borrow and repay by the date you choose.",
        pageActions = listOf(
            WorkAction("seller.borrow", "Borrow coins (repay later)", "/api/partner-ops/sellers/{param:seller_id}/borrow-requests",
                gate = sellerFiler,
                inputs = listOf(
                    Input("coins", "Coins to borrow", InputType.Int, min = 1,
                        help = "Up to \"You can still borrow\" above. Zipper sets your credit limit."),
                    Input("days", "Days until you repay", InputType.Int, min = 1, max = 30, default = "14"),
                    reason(label = "Why you need them"),
                ),
                confirm = "Ask Zipper to lend you these coins? It must fit your credit limit; an Owner approves it and you repay by the date you chose."),
            sellerRepayment(),
            sellerTradeFiling(),
            WorkAction("seller.selfUse", "Use my coins in the app", "/api/partner-ops/sellers/{param:seller_id}/self-use",
                gate = { c -> c.isSellerPartner },
                inputs = listOf(Input("coins", "Coins", InputType.Int, min = 1), reason(label = "Why")),
                fixed = mapOf("client_request_id" to "{uuid}"),
                confirm = "Move these coins into your own app wallet as diamonds for your own calls and gifts? It is not a sale, " +
                    "and Zipper must have switched it on."),
            WorkAction("seller.tier", "Set tier (wholesale price)", "/api/partner-ops/sellers/{param:seller_id}/tier",
                gate = sellerTerms,
                inputs = listOf(Input("tier", "Tier id (blank = the published price)", required = false, maxLen = 32), reason()),
                confirm = "Put this seller on this tier? It decides the wholesale price their purchases are checked against."),
            WorkAction("seller.creditLimit", "Set credit limit", "/api/partner-ops/sellers/{param:seller_id}/credit-limit",
                gate = sellerTerms,
                inputs = listOf(Input("coins", "Most this seller may owe (coins)", InputType.Int, min = 0), reason()),
                confirm = "Set this seller's credit limit? Nobody lends past it; 0 closes borrowing."),
        ),
    ),
    WorkModule(
        id = "seller.trades", title = "Trades with other sellers", group = Group.Mine,
        summary = "Coins you bought from or sold to another seller, and where each trade stands.",
        crm = "/seller-dashboard (SellerBusinessPanel: trades)",
        gate = { c -> c.isSellerPartner },
        source = Source.Api("/api/partner-ops/seller-trades", limitParam = null),
        params = listOf(Input("seller_id", "Seller ID", default = "{seller}", minLen = 1, maxLen = 64, asQuery = true,
            help = "Your own seller record is filled in.")),
        filters = listOf(Filter("status", "Status", sellerTradeStatuses)),
        titlePaths = listOf("trade_line", "id"), statusPath = "trade_state",
        subtitle = listOf(Field("Coins", "coins", FieldKind.Count), Field("Paid", "amount_paid_minor", FieldKind.Money),
            Field("Filed", "created_at", FieldKind.Date)),
        detail = sellerTradeDetail,
        hide = sellerTradeHide,
        rowTransform = ::sellerTradeRow,
        searchPaths = listOf("buyer_name", "seller_name", "payment_ref"),
        note = "A trade moves coins only when an Owner approves it. If someone filed a trade buying from you and did not pay, " +
            "report it here before it is approved.",
        actions = listOf(
            WorkAction("trade.dispute", "I was not paid", "/api/partner-ops/seller-trades/{item:id}/dispute", danger = true,
                gate = { c -> c.isSellerPartner },
                showFor = { i, c -> stat(i) == "pending" && i["disputed"] != true && stat(i, "seller_id") == c.sellerId },
                inputs = listOf(reason(label = "What happened").copy(default = "I have not received this payment.")),
                confirm = "Tell Zipper you were not paid for this trade? It stops the approval until Zipper checks."),
        ),
        pageActions = listOf(sellerTradeFiling()),
    ),
    WorkModule(
        id = "partner.cards", title = "Money cards", group = Group.Mine,
        summary = "Coin purchases, loans and payouts raised for your record, and where each one is.",
        crm = "/seller-dashboard (cards), /board",
        gate = { c -> c.isExternal && c.partnerIds.isNotEmpty() },
        source = Source.Api("/api/cards"),
        titlePaths = listOf("title", "type"), statusPath = "stage",
        subtitle = listOf(Field("Amount", "amount", FieldKind.Count), Field("Raised", "created_at", FieldKind.Date)),
        detail = cardDetail,
    ),
    WorkModule(
        id = "partner.records", title = "My partner records", group = Group.Mine,
        summary = "Every live agency / seller record of this login, each with its own status, credit and balances.",
        crm = "/profile, /agency-pending, /seller-pending",
        gate = { c -> c.isExternal },
        source = Source.Api("/api/partner-ops/partners"),
        subtitle = listOf(Field("Kind", "kind"), Field("Status", "status", FieldKind.Status),
            Field("Revoked for", "revocation_reason"), Field("Since", "created_at", FieldKind.Date)),
        detail = partnerDetail,
        detailPath = "/api/partner-ops/partners/{id}",
        hide = setOf("approved_by", "rejected_by", "created_by", "deactivated_by", "reactivated_by", "revoked_by", "activated_by"),
        // `GET /partner-ops/partners` answers a partner with the records on its
        // session — the approved, active ones (`security._partner_login`). A
        // revoked or suspended second record therefore never hides a live one.
        note = "One row per live record, each with its own status. A record waiting on your phone and email is under Contact verification; " +
            "a revoked or suspended record is not reachable from this login and never hides a live one.",
    ),
    WorkModule(
        id = "partner.verification", title = "Contact verification", group = Group.Mine,
        summary = "Whether your phone and email are verified, and which approved roles wait on them.",
        crm = "/agency-pending, /seller-pending (ContactVerificationPanel)",
        gate = { c -> c.isExternal },
        source = Source.Api("/api/partner-ops/me/verification", arrayKey = "waiting", limitParam = null),
        header = listOf(Field("Complete", "verification.complete", FieldKind.Bool),
            Field("Missing", "verification.missing", FieldKind.Json),
            Field("Phone", "verification.phone", FieldKind.Json), Field("Email", "verification.email", FieldKind.Json),
            Field("Requirement", "requirement")),
        titlePaths = listOf("name", "kind", "id"), statusPath = null,
        pageActions = listOf(WorkAction("verification.check", "Check again and start my roles",
            "/api/partner-ops/me/verification/check", gate = { c -> c.isExternal },
            confirm = "Re-read your verified contacts and start any approved role that was waiting on them?")),
    ),
)

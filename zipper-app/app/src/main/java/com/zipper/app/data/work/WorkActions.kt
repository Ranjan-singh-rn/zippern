package com.zipper.app.data.work

import com.zipper.app.util.jsonPath
import com.zipper.app.util.jsonText

/*
 * Reusable inputs and action builders. Every builder names the route and the
 * body exactly as the CRM sends them (see the outputs/inventory markdown files for the
 * source of each), and gates the BUTTON on the same dependency the route
 * declares. The server re-checks all of it.
 */

internal fun reason(min: Int = 3, max: Int = 1000, label: String = "Reason", help: String = "") =
    Input("reason", label, InputType.LongText, minLen = min, maxLen = max, help = help)

internal fun noteInput(min: Int = 3, max: Int = 1000, label: String = "Note", required: Boolean = true, help: String = "") =
    Input("note", label, InputType.LongText, required = required, minLen = if (required) min else 0, maxLen = max, help = help)

internal fun paymentRef() = Input("payment_ref", "Payment reference (UTR / bank ref)", minLen = 1, maxLen = 200)

internal fun choice(key: String, label: String, vararg options: Pair<String, String>, default: String = "", help: String = "") =
    Input(key, label, InputType.Choice, options = options.toList(), default = default.ifEmpty { options.first().first }, help = help)

internal fun yesNo(key: String, label: String, yes: String = "Approve", no: String = "Refuse") =
    Input(key, label, InputType.Choice, options = listOf("true" to yes, "false" to no), default = "true")

internal fun stat(item: Item, path: String = "status"): String = item.jsonPath(path).jsonText().orEmpty()

internal fun statusIn(vararg s: String): (Item, Caps) -> Boolean = { item, _ -> stat(item) in s }

// ── Money cards (/api/cards + the per-type execute routes) ──────────────────

internal object CardActions {

    private fun stage(item: Item) = stat(item, "stage")
    private fun type(item: Item) = stat(item, "type")
    private fun team(item: Item) = item.jsonPath("team").jsonText()
    private fun raisedByMe(item: Item, c: Caps) = item.jsonPath("requested_by.uid").jsonText() == c.uid

    val review = WorkAction(
        id = "card.review", label = "Start review", path = "/api/cards/{item:id}/review",
        gate = { c -> c.requireWrite },
        showFor = { i, c -> stage(i) == "requested" && c.canVerifyCard(team(i)) && !raisedByMe(i, c) },
        confirm = "Mark this card as under review? You will be recorded as the reviewer.",
    )

    val verify = WorkAction(
        id = "card.verify", label = "Verify", path = "/api/cards/{item:id}/verify",
        gate = { c -> c.requireWrite },
        showFor = { i, c -> stage(i) in setOf("requested", "under_review") && c.canVerifyCard(team(i)) && !raisedByMe(i, c) },
        inputs = listOf(noteInput(help = "What you checked. The owners read this before signing.")),
        confirm = "Verify this card and hand it to the owners for signature?",
    )

    val sign = WorkAction(
        id = "card.sign", label = "Sign", path = "/api/cards/{item:id}/sign",
        gate = { c -> c.isOwner && c.has(Perm.APPROVE_REQUESTS) },
        showFor = { i, c ->
            stage(i) == "awaiting_signoff" && !raisedByMe(i, c) &&
                i.jsonPath("verified_by.uid").jsonText() != c.uid && i.jsonPath("subject.id").jsonText() != c.uid
        },
        inputs = listOf(noteInput(required = false, label = "Signature note (optional)")),
        confirm = "Sign this card? Signing approves the movement; it is executed as a separate step.",
    )

    val reject = WorkAction(
        id = "card.reject", label = "Reject", path = "/api/cards/{item:id}/reject", danger = true,
        gate = { c -> c.requireWrite },
        showFor = { i, c ->
            when (stage(i)) {
                "requested", "under_review" -> true
                "awaiting_signoff" -> c.isOwner
                "approved" -> c.isOwner && i.jsonPath("execution_claimed_at") == null
                else -> false
            }
        },
        inputs = listOf(reason()),
        confirm = "Reject this card? It cannot be signed or executed afterwards.",
    )

    private fun execute(
        id: String, label: String, path: String, types: Set<String>, perm: String?, withRef: Boolean,
        help: String,
    ) = WorkAction(
        id = id, label = label, path = path, danger = true,
        gate = { c -> c.isOwner && (perm == null || c.has(perm)) },
        showFor = { i, _ -> stage(i) == "approved" && type(i) in types },
        inputs = if (withRef) listOf(paymentRef()) else emptyList(),
        confirm = help,
    )

    val executes: List<WorkAction> = listOf(
        execute("card.exec.balance", "Execute", "/api/users/balance-cards/{item:id}/execute",
            setOf("balance_credit", "balance_debit"), Perm.ADJUST_BALANCE, false,
            "Move the balance now? This changes the person's wallet and writes the ledger."),
        execute("card.exec.coin", "Credit coins", "/api/partner-ops/coin-purchases/{item:id}/execute",
            setOf("seller_coin_purchase"), Perm.COIN_OPERATIONS, false,
            "Credit these coins to the seller's inventory now?"),
        execute("card.exec.lend", "Issue loan", "/api/partner-ops/lending/{item:id}/execute",
            setOf("lending_issue"), Perm.COIN_OPERATIONS, false,
            "Issue this loan now? Coins are credited and the debt recorded."),
        execute("card.exec.repay", "Record repayment", "/api/partner-ops/repayments/{item:id}/execute",
            setOf("lending_repay"), Perm.COIN_OPERATIONS, false,
            "Record this repayment against the seller's debt?"),
        execute("card.exec.recover", "Recover", "/api/partner-ops/recoveries/{item:id}/execute",
            setOf("lending_recover"), Perm.COIN_OPERATIONS, false,
            "Recover from the seller's stock now? Whatever the balance cannot cover stays owed."),
        execute("card.exec.writeoff", "Write off", "/api/partner-ops/write-offs/{item:id}/execute",
            setOf("bad_debt_write_off", "lending_write_off"), Perm.COIN_OPERATIONS, false,
            "Book this loss now?"),
        execute("card.exec.commission", "Pay commission", "/api/partner-ops/commission-payouts/{item:id}/execute",
            setOf("commission_payout"), Perm.PROCESS_PAYOUT, true,
            "Record the commission as paid with this bank reference?"),
        execute("card.exec.withdrawal", "Pay host", "/api/partner-ops/host-withdrawals/{item:id}/execute",
            setOf("host_withdrawal"), Perm.PROCESS_PAYOUT, true,
            "Pay this host and debit their beans? Once started it cannot be rejected."),
        execute("card.exec.subagency", "Pay main agency (leg 1)", "/api/partner-ops/subagency-payouts/{item:id}/execute",
            setOf("subagency_payout"), Perm.PROCESS_PAYOUT, true,
            "Record leg 1 (Zipper pays the main agency) with this reference?"),
        execute("card.exec.expense", "Mark paid", "/api/expenses/{item:id}/pay",
            setOf("operating_expense"), null, true,
            "Record this expense as paid with this reference?"),
        WorkAction(
            id = "card.exec.capital", label = "Settle", path = "/api/capital/{item:id}/settle", danger = true,
            gate = { c -> c.isOwner },
            showFor = { i, _ -> stage(i) == "approved" && type(i) in setOf("owner_capital_in", "owner_drawings") },
            confirm = "Confirm the transfer happened and settle this capital movement?",
        ),
    )

    val all: List<WorkAction> = listOf(review, verify, sign, reject) + executes
}

// ── Partner records (/api/partner-ops/partners/…) ───────────────────────────

internal object PartnerActions {
    private fun kind(i: Item) = stat(i, "kind")
    private val approver: (Caps) -> Boolean = { c -> c.hasAny(Perm.APPROVE_KYC, Perm.APPROVE_SELLER) }

    val all: List<WorkAction> = listOf(
        WorkAction("partner.approve", "Approve", "/api/partner-ops/partners/{item:id}/approve",
            gate = approver, showFor = statusIn("pending", "awaiting_verification", "suspended"),
            inputs = listOf(reason()),
            confirm = "Approve this application? Without both contacts verified only an Owner may approve, and the role then waits for verification."),
        WorkAction("partner.activate", "Start role", "/api/partner-ops/partners/{item:id}/activate",
            gate = approver, showFor = statusIn("awaiting_verification"),
            confirm = "Start this Owner-approved role now that its contacts are verified?"),
        WorkAction("partner.reject", "Reject", "/api/partner-ops/partners/{item:id}/reject", danger = true,
            gate = approver, showFor = statusIn("pending"),
            inputs = listOf(reason(help = "The applicant sees this reason.")),
            confirm = "Reject this application? The applicant is told the reason."),
        WorkAction("partner.deactivate", "Suspend", "/api/partner-ops/partners/{item:id}/deactivate", danger = true,
            gate = approver, showFor = statusIn("approved"),
            inputs = listOf(reason()),
            confirm = "Suspend this partner? Their money is frozen until an Owner decides."),
        WorkAction("partner.reactivate", "Reactivate / restore", "/api/partner-ops/partners/{item:id}/reactivate",
            gate = approver, showFor = statusIn("suspended", "revoked"),
            inputs = listOf(reason()),
            confirm = "Lift the suspension (or, as Owner, restore the revoked role)? A money freeze is not released by this."),
        WorkAction("partner.revoke", "Revoke role", "/api/partner-ops/partners/{item:id}/revoke", danger = true,
            gate = approver, showFor = statusIn("approved", "suspended", "awaiting_verification", "revoked"),
            inputs = listOf(
                reason(),
                Input("transfer_to", "Move sub-agencies and hosts to agency id (optional)", required = false, maxLen = 128,
                    help = "Only an Owner may revoke a record that still has dependents."),
            ),
            confirm = "Revoke this role? The record, its money and its history are kept; money is frozen."),
        WorkAction("partner.changes", "Decide proposed changes", "/api/partner-ops/partners/{item:id}/pending-changes/decide",
            gate = { c -> c.has(Perm.APPROVE_KYC) },
            inputs = listOf(yesNo("approve", "Decision", "Apply the changes", "Refuse the changes"), reason()),
            confirm = "Decide the proposed bank / identity change? The person who proposed it cannot decide it."),
        WorkAction("partner.van", "Issue virtual account", "/api/partner-ops/partners/{item:id}/virtual-account",
            gate = { c -> c.has(Perm.APPROVE_SELLER) && c.requireTeamAdmin },
            showFor = { i, _ -> kind(i) == "seller" && stat(i) == "approved" },
            inputs = listOf(reason()), confirm = "Issue a permanent virtual account for this seller?"),
        WorkAction("partner.lend", "Lend coins", "/api/partner-ops/sellers/{item:id}/lending",
            gate = { c -> c.has(Perm.COIN_OPERATIONS) },
            showFor = { i, _ -> kind(i) == "seller" },
            inputs = listOf(
                Input("coins", "Coins", InputType.Int, min = 1),
                Input("due_at", "Due date", InputType.DateTime, help = "YYYY-MM-DD"),
                Input("terms", "Terms", InputType.LongText, required = false, maxLen = 2000),
                reason(),
            ),
            confirm = "Raise a lending card? Nothing moves until it is verified, signed and executed."),
        WorkAction("partner.repay", "Record repayment", "/api/partner-ops/sellers/{item:id}/repayments",
            gate = { c -> c.has(Perm.COIN_OPERATIONS) },
            showFor = { i, _ -> kind(i) == "seller" },
            inputs = listOf(Input("coins", "Coins repaid", InputType.Int, min = 1),
                Input("payment_ref", "Payment reference", required = false, maxLen = 200), reason()),
            confirm = "Raise a repayment card?"),
        WorkAction("partner.recover", "Recover from stock", "/api/partner-ops/sellers/{item:id}/recoveries",
            gate = { c -> c.has(Perm.COIN_OPERATIONS) },
            showFor = { i, _ -> kind(i) == "seller" },
            inputs = listOf(Input("coins", "Coins to recover", InputType.Int, min = 1),
                Input("penalty_coins", "Penalty coins", InputType.Int, required = false, min = 0), reason()),
            confirm = "Raise a recovery card?"),
        WorkAction("partner.writeoff", "Write off debt", "/api/partner-ops/partners/{item:id}/write-off", danger = true,
            gate = { c -> c.has(Perm.COIN_OPERATIONS) },
            showFor = { i, _ -> kind(i) == "seller" },
            inputs = listOf(Input("coins", "Coins to write off", InputType.Int, min = 1), reason()),
            confirm = "Raise a bad-debt write-off card?"),
        WorkAction("partner.commission", "Pay commission", "/api/partner-ops/agencies/{item:id}/commission-payouts",
            gate = { c -> c.has(Perm.PROCESS_PAYOUT) },
            showFor = { i, _ -> kind(i) in setOf("agency", "sub_agency") && stat(i) == "approved" },
            inputs = listOf(Input("amount_minor", "Amount (₹)", InputType.Rupees, min = 1), reason()),
            confirm = "Raise a commission payout card? It cannot exceed the outstanding commission."),
        WorkAction("partner.preview", "Commission for a period", "/api/partner-ops/agencies/{item:id}/commission-preview",
            method = "GET",
            gate = { c -> c.requireInternal },
            showFor = { i, _ -> kind(i) in setOf("agency", "sub_agency") },
            inputs = listOf(Input("period", "Period (e.g. 2026-W42)", minLen = 1, maxLen = 64, asQuery = true)),
            help = "Read-only: what the server would compute. Nothing is credited."),
        WorkAction("partner.grant", "Add second capability", "/api/partner-ops/partners/{item:id}/grant-capability",
            gate = { c -> approver(c) && c.requireTeamAdmin },
            showFor = statusIn("approved"),
            inputs = listOf(choice("kind", "Capability", "agency" to "Agency", "seller" to "Coin Seller"),
                Input("name", "Business name", minLen = 1, maxLen = 200),
                Input("phone", "Phone (optional)", required = false, maxLen = 40), reason()),
            confirm = "File a second-capability application for this partner's login?"),
        WorkAction("partner.documents", "Documents", "/api/documents/{item:kind}/{item:id}", method = "GET",
            gate = { c -> c.isInternal && (c.readsAll || c.has(Perm.VIEW_AGENCIES) || c.has(Perm.VIEW_SELLERS)) },
            showFor = { i, _ -> kind(i) in setOf("agency", "seller") },
            help = "Signed links valid for 15 minutes."),
    )
}

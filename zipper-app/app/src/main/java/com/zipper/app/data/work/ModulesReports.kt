package com.zipper.app.data.work

/*
 * Business reports. Every one is the server's own report envelope
 * (`Report.as_dict`: period, rates, columns, rows, totals, warnings), rendered
 * from its columns — the app computes no figure. Access is the route's:
 * business financials for owner / observer / team admins, throughput for a
 * member's own team, the dashboard shaped by role on the server.
 */

private fun range() = listOf(
    Input("since", "From (optional)", InputType.DateTime, required = false, asQuery = true),
    Input("until", "To (optional)", InputType.DateTime, required = false, asQuery = true),
)

private val envelopeHeader = listOf(
    Field("Report", "title"), Field("From", "period.since", FieldKind.Date), Field("To", "period.until", FieldKind.Date),
    Field("Totals", "totals", FieldKind.Json), Field("Warnings", "warnings", FieldKind.Json),
    Field("Rates used", "rates", FieldKind.Json), Field("Generated", "generated_at", FieldKind.Date),
)

/** owner, observer or any team admin (`_require_business_financials`). */
private val businessFinancials: (Caps) -> Boolean = { c -> c.isInternal && (c.readsAll || c.isTeamAdmin) }

private fun report(
    id: String, title: String, path: String, crm: String, summary: String,
    gate: (Caps) -> Boolean = businessFinancials,
    params: List<Input> = range(),
    filters: List<Filter> = emptyList(),
) = WorkModule(
    id = id, title = title, group = Group.Reports, summary = summary, crm = crm, gate = gate,
    source = Source.Api(path, arrayKey = "rows", limitParam = null),
    params = params, filters = filters, header = envelopeHeader,
    columnsPath = "columns", titlePaths = emptyList(), statusPath = null, idPath = "__row",
)

internal val reportModules: List<WorkModule> = listOf(
    WorkModule(
        id = "reports.dashboard", title = "Business dashboard", group = Group.Reports,
        summary = "Cash, liabilities, queues and overdue work — shaped to your role by the server.",
        crm = "/ (staff dashboard), /analytics",
        gate = { c -> c.isInternal },
        source = Source.Api("/api/reports/dashboard", arrayKey = "rows", limitParam = null),
        header = listOf(Field("Sections", "sections", FieldKind.Json), Field("Warnings", "warnings", FieldKind.Json)),
        columnsPath = "columns", titlePaths = emptyList(), statusPath = null, idPath = "__row",
    ),
    report("reports.cash", "Cash position", "/api/reports/cash-position", "/finance/cash, /finance, /reports",
        "Cash in and out by channel."),
    report("reports.revenue", "Revenue", "/api/reports/revenue", "/finance/profit, /reports",
        "Revenue by day, week or month and channel.",
        filters = listOf(Filter("group_by", "Group by", listOf("day" to "Day", "week" to "Week", "month" to "Month")))),
    report("reports.payouts", "Payouts", "/api/reports/payouts", "/finance/payouts, /finance/withdrawals",
        "Executed payouts by card type."),
    report("reports.margin", "Margin", "/api/reports/margin", "/finance/profit, /reports",
        "Revenue less payouts and commission."),
    report("reports.channels", "Channels", "/api/reports/channels", "/finance/profit, /reports",
        "Receipts and attributed payouts per payment channel."),
    report("reports.liabilities", "Liabilities", "/api/reports/liabilities", "/finance/liabilities, /finance",
        "What is owed right now.", params = emptyList()),
    report("reports.partners", "Partner summary", "/api/reports/partners/summary", "/finance/reports, /reports",
        "Commission (agencies) or coins (sellers) per partner.",
        filters = listOf(Filter("kind", "Partners", listOf("agency" to "Agencies", "seller" to "Coin sellers")))),
    report("reports.agencyStatement", "Agency statement (report)", "/api/reports/agencies/{param:agency_id}/statement",
        "/agencies/[id]", "One agency's commission over a period.",
        params = listOf(Input("agency_id", "Agency ID", minLen = 1)) + range()),
    report("reports.sellerStatement", "Seller statement (report)", "/api/reports/sellers/{param:seller_id}/statement",
        "/sellers/[id]", "One seller's coins and cash over a period.",
        params = listOf(Input("seller_id", "Seller ID", minLen = 1)) + range()),
    report("reports.throughput", "Team throughput", "/api/reports/team-throughput", "/throughput, /reports",
        "How fast each team moves its cards.",
        gate = { c -> c.isInternal },
        filters = listOf(Filter("team", "Team", listOf("" to "My team / all", "app" to "App", "ops" to "Operations",
            "finance" to "Finance", "tech" to "Tech", "support" to "Support", "marketing" to "Marketing")))),
    report("reports.auditSummary", "Audit summary", "/api/reports/audit-summary", "/reports",
        "Who did what, how often.", gate = { c -> c.isInternal && (c.readsAll || c.isTeamAdmin) }),
    report("reports.chanceRevenue", "Chance revenue", "/api/reports/chance-revenue", "/chance/money",
        "Gross gaming revenue by mechanic and country."),
    report("reports.chanceMargin", "Chance margin", "/api/reports/chance-margin", "/chance/money",
        "Diamond value against the bean cost it creates."),
    report("reports.cannibalisation", "Cannibalisation", "/api/reports/cannibalisation", "/chance/money",
        "Whether games take spending away from hosts."),
    WorkModule(
        id = "reports.weekly", title = "Weekly business report", group = Group.Reports,
        summary = "The stored weekly report for an ISO week, with every revision.",
        crm = "/reports/weekly",
        gate = businessFinancials,
        source = Source.Api("/api/reports/weekly-business/{param:week}", arrayKey = "revisions", limitParam = null),
        params = listOf(Input("week", "ISO week (e.g. 2026-W42)", minLen = 7, maxLen = 10)),
        header = listOf(Field("Week", "week"), Field("Note", "note", FieldKind.LongText)),
        idPath = "id", titlePaths = listOf("week_label", "id"), statusPath = null,
        subtitle = listOf(Field("Revision", "revision", FieldKind.Count), Field("Generated", "generated_at", FieldKind.Date)),
        detail = listOf(Field("Week", "week_label"), Field("Revision", "revision", FieldKind.Count),
            Field("Generated", "generated_at", FieldKind.Date), Field("Period", "period", FieldKind.Json),
            Field("Sections", "sections", FieldKind.Json)),
        pageActions = listOf(WorkAction("weekly.rerun", "Re-run this week", "/api/reports/jobs/weekly-business",
            gate = { c -> c.requireTeamAdmin && c.requireWrite },
            inputs = listOf(Input("week", "ISO week", minLen = 7, maxLen = 10, default = "{param:week}"),
                yesNo("force", "Store a new revision", "Yes", "No").copy(default = "false")),
            confirm = "Re-build and email the weekly business report?")),
    ),
    // M-5: the hold between a week closing and its beans becoming withdrawable,
    // published in one place for the CRM, the app and the Function.
    WorkModule(
        id = "reports.payoutPolicy", title = "Payout policy", group = Group.Reports,
        summary = "How long a closed week is held before hosts can withdraw it (an open Owner decision).",
        crm = "/finance/payouts (policy)",
        gate = { c -> c.isInternal },
        source = Source.Api("/api/reports/payout-policy", arrayKey = "__none__", limitParam = null),
        header = listOf(Field("Weeks in arrears", "release_arrears_weeks", FieldKind.Count),
            Field("Current behaviour", "current_behaviour", FieldKind.LongText),
            Field("Setting", "setting"), Field("Owner decision pending", "owner_decision_pending", FieldKind.Bool),
            Field("Applies to", "applies_to"), Field("Note", "note", FieldKind.LongText)),
    ),
    WorkModule(
        id = "reports.definitions", title = "Report definitions", group = Group.Reports,
        summary = "What each figure means, the units and the rate fallbacks.",
        crm = "/reports (definitions)",
        gate = { c -> c.isInternal },
        source = Source.Api("/api/reports/definitions", arrayKey = "__none__", limitParam = null),
        header = listOf(Field("Definitions", "definitions", FieldKind.Json), Field("Units", "units", FieldKind.Json),
            Field("Window", "window", FieldKind.Json), Field("Rate fallbacks", "rate_fallbacks", FieldKind.Json)),
    ),
)

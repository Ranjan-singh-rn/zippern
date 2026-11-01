package com.zipper.app.data.work

/*
 * Chance games (internal) and the configuration screens.
 *
 * Chance: the register, exposure, the responsible-play queue and player
 * freezes, with the CRM's suspend / resume / freeze / review routes. Proposing
 * a new odds table stays on the CRM: it is a structured probability table the
 * server validates to the ppm, and is signed as a card by an Owner.
 *
 * Configuration: shown read-only here (see the parity report). Every one of
 * these documents moves money or the whole app at once — economy rates,
 * packs, payment credentials, app control — and the CRM edits them through
 * structured editors and, for non-owners, an approval request.
 */

private val chanceReader: (Caps) -> Boolean = { c -> c.isInternal && !c.isObserver }

internal val chanceModules: List<WorkModule> = listOf(
    WorkModule(
        id = "chance.mechanics", title = "Chance mechanics", group = Group.Config,
        summary = "Every game mechanic, whether it is live, suspended or unconfigured.",
        crm = "/chance, /chance/configure (read), /chance/exposure",
        gate = chanceReader,
        source = Source.Api("/api/chance/mechanics", limitParam = null),
        titlePaths = listOf("name", "id"), statusPath = null,
        subtitle = listOf(Field("Live", "live", FieldKind.Bool), Field("Suspended", "suspended", FieldKind.Json)),
        detail = listOf(Field("Name", "name"), Field("Mechanic ID", "id"), Field("Kind", "kind"),
            Field("Live", "live", FieldKind.Bool), Field("Configured", "configured", FieldKind.Bool),
            Field("Suspended", "suspended", FieldKind.Json), Field("Live configuration", "live_config", FieldKind.Json)),
        actions = listOf(
            WorkAction("chance.exposure", "Exposure", "/api/chance/mechanics/{item:id}/exposure", method = "GET", gate = chanceReader),
            WorkAction("chance.rtp", "Return to player", "/api/chance/mechanics/{item:id}/rtp", method = "GET", gate = chanceReader,
                inputs = listOf(Input("days", "Days", InputType.Int, required = false, min = 1, max = 365, default = "7", asQuery = true))),
            WorkAction("chance.suspend", "Suspend", "/api/chance/mechanics/{item:id}/suspend", danger = true,
                gate = { c -> c.requireTeamAdmin && c.requireWrite }, inputs = listOf(reason(8, 1000)),
                confirm = "Stop this mechanic now? It pays nothing and accepts nothing until an Owner resumes it."),
            WorkAction("chance.resume", "Resume", "/api/chance/mechanics/{item:id}/resume",
                gate = { c -> c.isOwner && c.requireWrite }, inputs = listOf(reason(8, 1000)),
                confirm = "Restart this suspended mechanic?"),
        ),
    ),
    WorkModule(
        id = "chance.protection", title = "Responsible-play queue", group = Group.Config,
        summary = "Players flagged for review, and the decision on each.",
        crm = "/chance/protection",
        gate = chanceReader,
        source = Source.Api("/api/chance/protection/flags"),
        titlePaths = listOf("reason", "kind", "id"), nameUidPaths = listOf("player_uid"),
        subtitle = listOf(Field("Player", "player_uid"), Field("Raised", "created_at", FieldKind.Date)),
        actions = listOf(
            WorkAction("flag.review", "Decide", "/api/chance/protection/flags/{item:id}/review",
                gate = { c -> c.requireTeamAdmin && c.requireWrite },
                inputs = listOf(choice("decision", "Decision", "no_action" to "No action — ordinary play",
                    "contacted_player" to "Contacted the player", "limit_imposed" to "Impose limits",
                    "play_suspended" to "Suspend play", "escalated" to "Escalate"),
                    reason(8, 1000),
                    Input("daily_limit", "Daily loss limit (diamonds)", InputType.Int, required = false, min = 0,
                        showIf = { it["decision"] == "limit_imposed" }),
                    Input("weekly_limit", "Weekly loss limit (diamonds)", InputType.Int, required = false, min = 0,
                        showIf = { it["decision"] == "limit_imposed" }),
                    Input("suspend_days", "Suspend for days", InputType.Int, min = 1,
                        showIf = { it["decision"] == "play_suspended" })),
                confirm = "Record this decision on the flag?"),
            WorkAction("flag.freeze", "Freeze player", "/api/chance/players/{item:player_uid}/freeze", danger = true,
                gate = { c -> c.requireTeamAdmin && c.requireWrite }, inputs = listOf(reason(8, 1000)),
                confirm = "Freeze this player's game play pending review?"),
            WorkAction("flag.unfreeze", "Unfreeze player", "/api/chance/players/{item:player_uid}/unfreeze",
                gate = { c -> c.requireTeamAdmin && c.requireWrite }, inputs = listOf(reason(8, 1000)),
                confirm = "End this player's freeze?"),
        ),
    ),
    WorkModule(
        id = "chance.exceptions", title = "Chance exceptions", group = Group.Config,
        summary = "Rounds and settlements the server flagged as exceptions.",
        crm = "/chance/monitoring",
        gate = chanceReader,
        source = Source.Api("/api/chance/exceptions", limitParam = null),
        params = listOf(Input("hours", "Hours", InputType.Int, required = false, min = 1, max = 720, default = "24", asQuery = true)),
        titlePaths = listOf("kind", "id"), statusPath = null,
    ),

    // ── Configuration (read-only on mobile; see the file header) ──────────────
    configDoc("config.economy", "Economy configuration", "appConfig", "economy", "/economy, /economy/config",
        { c -> c.isInternal && !c.isObserver && (c.isOwner || c.role in setOf("finance_admin", "finance_member", "ops_admin") || c.role.startsWith("tech_")) }),
    configDoc("config.control", "App control", "appConfig", "control", "/tech/appcontrol",
        { c -> c.isInternal && !c.isObserver && (c.isOwner || c.role.startsWith("tech_")) }),
    configDoc("config.dailyRewards", "Daily rewards", "appConfig", "dailyRewards", "/app-config/daily-rewards",
        { c -> c.isOwner }),
    configDoc("config.profileOptions", "Profile options", "appConfig", "profileOptions", "/app-config/profile-options",
        { c -> c.isOwner }),
    WorkModule(
        id = "config.gifts", title = "Gift catalogue", group = Group.Config,
        summary = "Gifts, their diamond cost and the host's earning rate.",
        crm = "/gifts, /tech/content (gifts)",
        gate = { c -> c.isInternal && !c.isObserver },
        source = Source.Firestore("gifts", orderBy = null),
        titlePaths = listOf("name", "id"), statusPath = null,
        subtitle = listOf(Field("Diamonds", "diamondCost", FieldKind.Count), Field("Active", "isActive", FieldKind.Bool)),
        detail = listOf(Field("Name", "name"), Field("Category", "category"), Field("Diamond cost", "diamondCost", FieldKind.Count),
            Field("Earning rate", "earningRate"), Field("Active", "isActive", FieldKind.Bool), Field("Order", "sortOrder", FieldKind.Count)),
        actions = listOf(WorkAction("gift.toggle", "Switch on / off", kind = ActionKind.FirestoreUpdate,
            gate = { c -> c.requireWrite && (c.isOwner || c.role.startsWith("tech_") || c.role.startsWith("app_") || c.role.startsWith("ops_")) },
            inputs = listOf(yesNo("isActive", "Shown in the app", "Active", "Hidden")),
            confirm = "Change whether this gift is offered in the app?")),
    ),
    WorkModule(
        id = "config.paymentMethods", title = "Payment methods by country", group = Group.Config,
        summary = "Which payment rails the app offers in each country.",
        crm = "/tech/payments",
        gate = { c -> c.isInternal && !c.isObserver },
        source = Source.Firestore("paymentConfig", orderBy = null),
        titlePaths = listOf("id"), statusPath = null,
        detail = listOf(Field("Country", "id"), Field("Methods", "methods", FieldKind.Json), Field("Updated", "updatedAt", FieldKind.Date)),
    ),
)

private fun configDoc(id: String, title: String, collection: String, doc: String, crm: String, gate: (Caps) -> Boolean) =
    WorkModule(
        id = id, title = title, group = Group.Config,
        summary = "Read-only on mobile — edited in the CRM, where changes go through approval.",
        crm = crm, gate = gate,
        source = Source.Firestore(collection, where = listOf(Triple("__name__", "==", doc)), orderBy = null),
        titlePaths = listOf("id"), statusPath = null,
        note = "Read-only here. Edit in the CRM: owner saves directly, others file an approval request.",
    )

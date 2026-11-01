package com.zipper.app.data.work

import com.zipper.app.util.jsonText

/*
 * B3 / §13 (B-21) — "Sessions / sign out everywhere", for EVERY login that
 * holds an API session: staff, Owners and partners alike. Both routes act on
 * the session's own uid (`own_session_uid`) and take no id from the request,
 * which is why they are on the partner allowlist (`PARTNER_REACHABLE`) and why
 * this screen is offered to everyone the hub knows.
 *
 * The list is fingerprints only — a short id, client, address, user agent,
 * when — never a token. Revoking is effective on the next request of each
 * revoked session; quick login on the phone is NOT touched (§13).
 */

/** What a session row shows. Pure; `WorkParityTest` runs it on sample rows. */
object SessionRows {

    fun clientLabel(client: String?): String = when (client?.trim()?.lowercase().orEmpty()) {
        "android" -> "Zipper app (Android)"
        "crm" -> "CRM (browser)"
        "", "unknown" -> "Unknown client"
        else -> client.orEmpty().trim()
    }

    /** A user agent cut to something a phone can show; blank stays blank. */
    fun shortAgent(userAgent: String?): String {
        val ua = userAgent?.trim().orEmpty()
        return if (ua.length <= 60) ua else ua.take(57) + "…"
    }

    fun transform(item: Item): Item {
        val current = item["current"] == true
        val client = clientLabel(item["client"].jsonText())
        val mfa = when (item["mfa_verified"]) {
            true -> "two-step verified"
            false -> "two-step pending"
            else -> ""
        }
        return item + mapOf(
            "title" to (if (current) "$client — this device" else client),
            "where" to listOfNotNull(item["ip"].jsonText()?.takeIf { it.isNotBlank() }, shortAgent(item["user_agent"].jsonText()).takeIf { it.isNotBlank() })
                .joinToString(" · ").ifBlank { "—" },
            "state" to listOfNotNull(if (current) "current" else null, mfa.takeIf { it.isNotBlank() },
                if (item["renewed"] == true) "renewed" else null).joinToString(", ").ifBlank { "live" },
        )
    }
}

internal val sessionModules: List<WorkModule> = listOf(
    WorkModule(
        id = "sessions", title = "Sessions & sign out everywhere", group = Group.Mine,
        summary = "Every live sign-in of your work account — the CRM, this phone — and a way to end the ones you do not recognise.",
        crm = "/profile (sessions)",
        // Every session `/auth/me` names as staff or partner (`is_internal` / `is_external`).
        gate = { c -> c.isInternal || c.isExternal },
        source = Source.Api("/api/auth/sessions", arrayKey = "sessions", limitParam = null),
        header = listOf(Field("Live sessions", "count", FieldKind.Count)),
        rowTransform = SessionRows::transform,
        titlePaths = listOf("title"), statusPath = "state",
        subtitle = listOf(Field("Where", "where"), Field("Signed in", "issued_at", FieldKind.Date),
            Field("Last active", "last_active_at", FieldKind.Date)),
        detail = listOf(Field("Client", "title"), Field("Session", "id"), Field("State", "state"),
            Field("Address", "ip"), Field("Device / browser", "user_agent", FieldKind.LongText),
            Field("Signed in", "issued_at", FieldKind.Date), Field("Last active", "last_active_at", FieldKind.Date),
            Field("Expires", "expires_at", FieldKind.Date), Field("Two-step verified", "mfa_verified", FieldKind.Bool),
            Field("Renewed", "renewed", FieldKind.Bool)),
        // The route admits every session; the button is offered to a writer
        // (`can_write`) or a partner — the read-only Observer is offered reads only.
        pageActions = listOf(
            WorkAction("sessions.revokeOthers", "Sign out everywhere else", "/api/auth/sessions/revoke-all", danger = true,
                gate = { c -> c.canWrite || c.isExternal },
                fixed = mapOf("include_current" to false),
                confirm = "End every other live session of your work account? This device stays signed in. Quick login on your phone is not affected."),
            WorkAction("sessions.revokeAll", "Sign out everywhere, this device too", "/api/auth/sessions/revoke-all", danger = true,
                gate = { c -> c.canWrite || c.isExternal },
                fixed = mapOf("include_current" to true),
                confirm = "End every live session, including this one? The app signs in to the work server again automatically " +
                    "when you next open a work screen; an Owner enters a two-step code again."),
        ),
        note = "Fingerprints only — never a token. A session you do not recognise is the one to end; tell the Observer if it was not you.",
    ),
)

package com.zipper.app.ui.screens.partner

import com.zipper.app.data.repository.PartnerFunctions

/**
 * WHAT THE PARTNER HUB SHOWS, FROM WHAT THE SERVER SAID (C1, C2 — B04).
 *
 * ── THE BUG THIS EXISTS TO MAKE IMPOSSIBLE ──────────────────────────────────
 *
 * A revoked role used to look exactly like a role never applied for. The API
 * left revoked records out of what a person "holds", so the hub listed nothing
 * for them, and the four choices offered "Join as Agency" to somebody whose
 * Agency had just been revoked — a fresh application that, once approved,
 * created a brand-new record beside the revoked one and stepped around the
 * revocation entirely.
 *
 * The API now returns revoked roles (C1). This turns them into what the person
 * should see:
 *
 *   held roles      "Coin Seller · approved" — live roles only;
 *   revoked roles   "Agency · Revoked", the reason, and EITHER the open
 *                   reinstatement request's status OR "Request reinstatement",
 *                   never both;
 *   the choices     a revoked kind is never a first-time application. Its row
 *                   stays visible and greyed with the server's sentence, even if
 *                   a server that lagged behind still listed it as an option.
 *
 * Restoring is not decided here or anywhere in the app: the request goes to a
 * reviewer, who recommends, and the Owner decides (C2).
 *
 * Pure — no Android, no Compose — so `PartnerHubRowsTest` proves it on the JVM.
 */
object PartnerHubRows {

    /** The four kinds, in the order the hub lists them. */
    val KINDS = listOf("host", "agency", "sub_agency", "seller")

    const val REVOKED = "revoked"

    /**
     * Decision 15 (RC): approved by the Owner, NOT started — the account does
     * not yet hold BOTH a verified phone and a verified email. Shown as a
     * waiting role with the verification steps, never as a role that works.
     */
    const val AWAITING = "awaiting_verification"

    fun label(kind: String): String = when (kind) {
        "agency" -> "Agency"
        "sub_agency" -> "Sub-agency"
        "seller" -> "Coin Seller"
        "host" -> "Host"
        else -> kind
    }

    /** C1's REVOKED_REFUSAL, for when the server sent no sentence of its own. */
    fun revokedRefusal(kind: String): String =
        "Your ${label(kind)} role was revoked. Request reinstatement instead of applying again."

    /** What the hub offers for one revoked role. Exactly one of these, never two. */
    sealed interface Reinstatement {
        /**
         * Nothing open: offer "Request reinstatement". [lastDeclined] when the
         * latest request was decided against, with the Owner's [note] if any.
         */
        data class CanRequest(val lastDeclined: Boolean, val note: String) : Reinstatement

        /** A request is open. Say where it is; offer nothing to tap. */
        data class Open(val status: String, val label: String) : Reinstatement

        /** Already given back; the eligibility read is a moment behind. */
        data object Restored : Reinstatement
    }

    data class RevokedRow(
        val kind: String,
        val recordId: String,
        /** "Agency · Revoked". */
        val title: String,
        val reason: String,
        val reinstatement: Reinstatement,
    )

    data class Choice(val kind: String, val canApply: Boolean, val blockedReason: String?)

    /** Decision 15 (RC): "Agency · approved, waiting for verified contacts". */
    data class AwaitingRow(val kind: String, val title: String)

    data class Model(
        val held: List<String>,
        val revoked: List<RevokedRow>,
        val choices: List<Choice>,
        /** Decision 15 (RC): approved roles that have not started. */
        val awaiting: List<AwaitingRow> = emptyList(),
    ) {
        fun choice(kind: String): Choice? = choices.firstOrNull { it.kind == kind }
    }

    /** Is anything revoked at all? Worth a second read (the requests) only then. */
    fun hasRevoked(elig: PartnerFunctions.Eligibility): Boolean =
        elig.revoked.isNotEmpty() ||
            elig.held.any { it.status == REVOKED } ||
            elig.hostStatus == REVOKED

    /** Decision 15 (RC): is any approved role waiting for verified contacts? Worth a check then. */
    fun hasAwaiting(elig: PartnerFunctions.Eligibility): Boolean =
        elig.held.any { it.status == AWAITING } ||
            elig.pendingHostApplicationStatus == AWAITING

    fun build(
        elig: PartnerFunctions.Eligibility,
        /** `myRoleAppeals`, newest first. Optional: fills in a request the eligibility read did not carry. */
        appeals: List<PartnerFunctions.RoleAppeal> = emptyList(),
    ): Model {
        // ── Every revoked role, once per kind ─────────────────────────────
        // The server's own list first; then any revoked record or Host it did
        // not name, so a partial answer still never reads as "never applied".
        val revoked = LinkedHashMap<String, PartnerFunctions.RevokedRole>()
        elig.revoked.forEach { r -> if (r.kind.isNotBlank() && r.kind !in revoked) revoked[r.kind] = r }
        elig.held.filter { it.status == REVOKED && it.kind.isNotBlank() }.forEach { p ->
            if (p.kind !in revoked) {
                revoked[p.kind] = PartnerFunctions.RevokedRole(
                    kind = p.kind, recordId = p.id, revokedAt = p.revokedAt,
                    reason = p.revokedReason, appealId = "", appealStatus = "",
                )
            }
        }
        if (elig.hostStatus == REVOKED && "host" !in revoked) {
            revoked["host"] = PartnerFunctions.RevokedRole(
                kind = "host", recordId = "", revokedAt = elig.hostRevokedAt,
                reason = "", appealId = "", appealStatus = "",
            )
        }

        // ── What they hold now: live roles only ───────────────────────────
        val held = buildList {
            // Decision 15 (RC): a waiting role is not "held" in any way that
            // works; it is listed under `awaiting` instead.
            elig.held.filter { it.status != REVOKED && it.status != AWAITING }
                .forEach { add("${label(it.kind)} · ${it.status}") }
            if (elig.isHost) {
                add(
                    "Host" + when (elig.hostAgencyKind) {
                        "sub_agency" -> " · under a sub-agency"
                        "agency" -> " · under an agency"
                        else -> ""
                    },
                )
            }
        }

        // ── Each revoked role: its open request, or the way to make one ───
        val rows = revoked.values.map { r ->
            val latest = appeals.firstOrNull { it.kind == r.kind }
            val status = r.appealStatus.ifBlank { latest?.status.orEmpty() }.trim()
            RevokedRow(
                kind = r.kind,
                recordId = r.recordId,
                title = "${label(r.kind)} · Revoked",
                reason = r.reason,
                reinstatement = reinstatementFor(status, latest?.decisionNote.orEmpty()),
            )
        }

        // ── The four choices. A revoked kind is never a first-time application.
        val choices = KINDS.map { kind ->
            if (kind in revoked) {
                Choice(kind, canApply = false, blockedReason = elig.blocked[kind] ?: revokedRefusal(kind))
            } else {
                Choice(kind, canApply = kind in elig.options, blockedReason = elig.blocked[kind])
            }
        }

        // ── Decision 15 (RC): approved, waiting for BOTH verified contacts ──
        val awaiting = buildList {
            elig.held.filter { it.status == AWAITING && it.kind.isNotBlank() }.forEach {
                add(AwaitingRow(it.kind, "${label(it.kind)} · approved, waiting for verified contacts"))
            }
            if (elig.pendingHostApplicationStatus == AWAITING) {
                add(AwaitingRow("host", "Host · approved, waiting for verified contacts"))
            }
        }

        return Model(held = held, revoked = rows, choices = choices, awaiting = awaiting)
    }

    /**
     * The request's status → what is shown. A status this build does not know
     * is shown as it is and offers nothing: the server holds one open request
     * per role and kind, and claiming there is none would invite a duplicate.
     */
    fun reinstatementFor(status: String, note: String): Reinstatement = when (status) {
        "" -> Reinstatement.CanRequest(lastDeclined = false, note = "")
        "kept_revoked" -> Reinstatement.CanRequest(lastDeclined = true, note = note)
        "pending" -> Reinstatement.Open(status, "Reinstatement requested · waiting for a reviewer")
        "recommended" -> Reinstatement.Open(status, "Reinstatement requested · reviewed, waiting for the Owner's decision")
        "restored" -> Reinstatement.Restored
        else -> Reinstatement.Open(status, "Reinstatement request · $status")
    }
}

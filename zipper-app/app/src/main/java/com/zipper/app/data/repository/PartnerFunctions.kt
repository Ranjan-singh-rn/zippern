package com.zipper.app.data.repository

import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.FirebaseFunctionsException
import com.zipper.app.util.ActivationRequirement
import com.zipper.app.util.ContactRequirement
import com.zipper.app.util.ServerRefusals
import com.zipper.app.util.WriteOutcome
import kotlinx.coroutines.tasks.await
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Applying for a partner role, and filing a recharge — through the server.
 *
 * ── WHY NOTHING HERE WRITES FIRESTORE ───────────────────────────────────────
 *
 * Which roles a person may hold, which agency a sub-agency or a host may hang
 * under, whether a parent is a main agency, one agency-family record per
 * human, who owns an application — every one of those is a rule the API
 * applies against its own records. The app's job is to show the choices the
 * server offers and send back what the person chose. So each call here goes to
 * a Cloud Function callable that verifies the signed-in user and forwards the
 * uid off the TOKEN to the API (`functions/src/index.ts` § 13b). Nothing in
 * `data` can name a different applicant; the server ignores it if it tries.
 *
 * Same shape as [HostFunctions] — sealed [Result], one private `call`.
 */
@Singleton
class PartnerFunctions @Inject constructor(
    private val functions: FirebaseFunctions,
    /** Phase 1A (SESSION-001): the active session id travels with every callable. */
    private val sessionManager: com.zipper.app.util.SessionManager,
) {

    sealed interface Result<out T> {
        data class Ok<T>(val value: T) : Result<T>
        /**
         * [code] is the Functions error code; `failed-precondition` carries a
         * sentence from the API written for the applicant ("You already hold
         * an Agency…"), which [userMessage] is.
         */
        data class Failed(
            val code: String,
            val userMessage: String,
            /**
             * Approved contact rule: set when the server refused because the
             * account holds no verified phone or email (`CONTACT_REQUIRED`), so
             * the screen can say what is missing and open verification.
             */
            val contact: ContactRequirement? = null,
            /**
             * Decision 15 (RC): set when the server refused because a role can
             * START only with BOTH contacts verified
             * (`CONTACT_VERIFICATION_REQUIRED`).
             */
            val activation: ActivationRequirement? = null,
            /**
             * RF-30: the call ended with no answer about whether it happened —
             * the bridge's `OUTCOME_UNKNOWN`, a deadline, or a connection lost
             * in flight ([WriteOutcome.unknown]). A caller that WROTE looks
             * before saying it failed; a read ignores it.
             */
            val outcomeUnknown: Boolean = false,
        ) : Result<Nothing>
    }

    // ── What may I apply for? ────────────────────────────────────────────────

    /**
     * A role on the API's authoritative records.
     *
     * C1: [status] may now be `revoked` — revoked records are returned so the
     * hub can show them as revoked rather than as never applied (B04). The two
     * revocation fields are blank for every other status.
     */
    data class HeldRole(
        val kind: String,
        val status: String,
        val id: String,
        val name: String,
        val revokedAt: String = "",
        val revokedReason: String = "",
    )

    /**
     * C1: a role this person held and had revoked, with the reinstatement
     * request (C2) that is open for it, or the latest one. [appealId] and
     * [appealStatus] are blank when none was ever filed. [recordId] is the
     * partner record — for a Host, the uid.
     */
    data class RevokedRole(
        val kind: String,
        val recordId: String,
        val revokedAt: String,
        val reason: String,
        val appealId: String,
        /** `pending`, `recommended`, `restored`, `kept_revoked`, or "". */
        val appealStatus: String,
    )

    data class Eligibility(
        /** `host`, `agency`, `sub_agency`, `seller` — the ones that may be added. */
        val options: List<String>,
        /** kind → the sentence to show beside a greyed-out choice. */
        val blocked: Map<String, String>,
        val held: List<HeldRole>,
        /** A LIVE Host. A revoked Host is not one — see [hostStatus]. */
        val isHost: Boolean,
        val hostAgencyKind: String,
        val pendingHostApplicationId: String,
        /**
         * Decision 15 (RC): `pending`, or `awaiting_verification` when the
         * Owner approved it and it waits for BOTH verified contacts.
         */
        val pendingHostApplicationStatus: String = "",
        /**
         * The caller is a ZIPPER staff identity (Owner, Observer, department
         * admin/member) per the API's authoritative staff records. Staff hold
         * no partner role: `options` is then empty and the hub says why.
         */
        val isInternal: Boolean = false,
        /** C1: every revoked role, each with its reinstatement request if any. */
        val revoked: List<RevokedRole> = emptyList(),
        /**
         * C1: `held.host.status` — `active`, `revoked`, `suspended` (§5: the
         * Host role paused, still held), or "" when there is no Host record.
         */
        val hostStatus: String = "",
        val hostRevokedAt: String = "",
        /**
         * Approved contact rule: the server's `contact` block — whether a
         * verified contact is still required before any application. Null from
         * a server that does not send it.
         */
        val contact: ContactRequirement? = null,
        /**
         * Decision 15 (RC): the server's `activation` block — an approved role
         * starts only with BOTH contacts verified. Null from an older server.
         */
        val activation: ActivationRequirement? = null,
        /**
         * RC (confirmed role rule): kind → the ONE parent it may be added under.
         * A Sub-agency of main Agency X may be a Host only directly under X; a
         * Host under Y may be a Sub-agency only under Y. The server re-checks.
         */
        val parentFor: Map<String, String> = emptyMap(),
    )

    suspend fun eligibility(): Result<Eligibility> =
        call("partnerEligibility", emptyMap()) { m -> parseEligibility(m) }

    // ── Which agencies may I join? ───────────────────────────────────────────

    data class ParentOption(
        val id: String,
        val name: String,
        /** `agency` or `sub_agency`. */
        val kind: String,
        val parentName: String,
    )

    /**
     * Approved, active agencies: main only for a sub-agency; main and sub for a
     * host. The server re-validates the chosen id on submission regardless —
     * this list is for the picker, not the decision.
     */
    suspend fun parents(forKind: String): Result<List<ParentOption>> =
        call("partnerParents", mapOf("forKind" to forKind)) { m ->
            (m["parents"] as? List<*>).orEmpty().mapNotNull { p ->
                (p as? Map<*, *>)?.let {
                    ParentOption(
                        id = it["id"]?.toString().orEmpty(),
                        name = it["name"]?.toString().orEmpty(),
                        kind = it["kind"]?.toString().orEmpty(),
                        parentName = it["parent_name"]?.toString().orEmpty(),
                    )
                }
            }.filter { it.id.isNotBlank() }
        }

    // ── My applications ──────────────────────────────────────────────────────

    data class Application(
        val id: String,
        val kind: String,
        val status: String,
        val name: String,
        val parentId: String,
        val rejectionReason: String,
        val revocationReason: String,
    )

    suspend fun myApplications(): Result<List<Application>> =
        call("myPartnerApplications", emptyMap()) { m ->
            (m["applications"] as? List<*>).orEmpty().mapNotNull { a ->
                (a as? Map<*, *>)?.let {
                    Application(
                        id = it["id"]?.toString().orEmpty(),
                        kind = it["kind"]?.toString().orEmpty(),
                        status = it["status"]?.toString().orEmpty(),
                        name = it["name"]?.toString().orEmpty(),
                        parentId = it["parent_id"]?.toString().orEmpty(),
                        rejectionReason = it["rejection_reason"]?.toString().orEmpty(),
                        revocationReason = it["revocation_reason"]?.toString().orEmpty(),
                    )
                }
            }
        }

    // ── Applying ─────────────────────────────────────────────────────────────

    data class Filed(val id: String, val kind: String, val status: String)

    /**
     * Apply as `agency`, `sub_agency` or `seller`. [form] is the field map the
     * API validates (`backend/app/services/partner_applications.py`); document
     * URLs are already uploaded by [PartnerRepository]. [parentId] is required
     * for a sub-agency and ignored otherwise.
     */
    suspend fun submitPartnerApplication(
        kind: String,
        form: Map<String, Any>,
        parentId: String?,
    ): Result<Filed> =
        call(
            "submitPartnerApplication",
            buildMap {
                put("kind", kind)
                put("form", form)
                if (!parentId.isNullOrBlank()) put("parentId", parentId)
            },
        ) { m -> Filed(m["id"].toString(), m["kind"].toString(), m["status"].toString()) }

    /** Apply as a Host under [parentId] — a main agency or a sub-agency. */
    suspend fun submitHostApplication(form: Map<String, Any>, parentId: String): Result<Filed> =
        call("submitHostApplication", mapOf("form" to form, "parentId" to parentId)) { m ->
            Filed(m["id"].toString(), "host", m["status"].toString())
        }

    // ── Asking for a revoked role back (C2) ──────────────────────────────────

    /**
     * A reinstatement request for a revoked role, as the API returns it to the
     * person who filed it. [decisionNote] is the Owner's note once decided.
     */
    data class RoleAppeal(
        val id: String,
        val kind: String,
        val recordId: String,
        /** `pending`, `recommended`, `restored` or `kept_revoked`. */
        val status: String,
        val statement: String,
        val createdAt: String,
        val decisionNote: String,
    )

    /**
     * Ask for a revoked role back. Files a request a reviewer recommends on and
     * the Owner decides; it restores nothing by itself. Idempotent on the
     * server: one already open for this kind is returned rather than doubled.
     * [statement] must be 20–2,000 characters — see [RoleAppealStatement],
     * which the caller checks first and which is checked again here, so no
     * caller can spend a round trip on a statement the server will refuse.
     */
    suspend fun submitRoleAppeal(kind: String, statement: String): Result<RoleAppeal> {
        RoleAppealStatement.problem(statement)?.let { return Result.Failed("invalid-argument", it) }
        return call("submitRoleAppeal", mapOf("kind" to kind, "statement" to statement)) { m ->
            parseRoleAppeal(m["appeal"] as? Map<*, *> ?: emptyMap<Any, Any>())
        }
    }

    /** This person's reinstatement requests, newest first. */
    suspend fun myRoleAppeals(): Result<List<RoleAppeal>> =
        call("myRoleAppeals", emptyMap()) { m ->
            (m["appeals"] as? List<*>).orEmpty().mapNotNull { a ->
                (a as? Map<*, *>)?.let { parseRoleAppeal(it) }
            }
        }

    // ── Decision 15 (RC): an approved role waiting for BOTH contacts ───────

    /** One approved role that has not started yet. [kind] is `agency`, `sub_agency`, `seller` or `host`. */
    data class WaitingRole(val id: String, val kind: String, val name: String)

    data class VerificationState(
        val requirement: ActivationRequirement,
        val waiting: List<WaitingRole>,
        /** From `checkPartnerActivation`: the roles that started on this check. */
        val started: List<WaitingRole> = emptyList(),
        /**
         * From `checkPartnerActivation`: the server's sentence for each waiting
         * role it could NOT start (`started[].refusal`), distinct, in order.
         * E2E round 2 (QA #51): these used to be dropped, so an invited host who
         * verified a different email was told "Your role is starting." for ever.
         */
        val refusals: List<String> = emptyList(),
    )

    /** What is verified on this account, and which approved roles wait for it. */
    suspend fun verificationState(): Result<VerificationState> =
        call("partnerVerificationState", emptyMap()) { m -> parseVerificationState(m) }

    /**
     * Ask the server to re-read both contacts and start every approved role
     * they now allow. It decides; this only asks. Safe to call repeatedly.
     */
    suspend fun checkActivation(): Result<VerificationState> =
        call("checkPartnerActivation", emptyMap()) { m -> parseVerificationState(m) }

    /**
     * The phone or email this person tried to verify belongs to ANOTHER Zipper
     * account. Staff are told; nothing is merged. The answer is the same
     * whether or not a holder exists.
     */
    suspend fun reportContactConflict(contact: String, value: String): Result<Unit> =
        call("reportContactConflict", mapOf("contact" to contact, "value" to value)) { _ -> Unit }

    // ── Recharge through a Coin Seller ───────────────────────────────────────

    data class RechargeFiled(val id: String, val status: String)

    /**
     * "I paid this seller." Creates a PENDING request; Zipper staff verify the
     * payment before any diamond moves. [amountMinor] is paise/cents.
     *
     * RF-30: [requestId] is one id per recharge FORM, the same on every retry
     * of it (8–64 of `A-Z a-z 0-9 _ -`). The API answers a repeat from this
     * buyer with the request it already filed, so a send whose answer was lost
     * can be sent again without filing twice.
     */
    suspend fun submitRechargeRequest(
        sellerId: String,
        diamonds: Int,
        amountMinor: Long,
        currency: String,
        paymentMethod: String,
        reference: String,
        proofUrl: String,
        requestId: String,
    ): Result<RechargeFiled> =
        call(
            "submitRechargeRequest",
            mapOf(
                "sellerId" to sellerId,
                "diamonds" to diamonds,
                "amountMinor" to amountMinor,
                "currency" to currency,
                "paymentMethod" to paymentMethod,
                "reference" to reference,
                "proofUrl" to proofUrl,
                "requestId" to requestId,
            ),
        ) { m -> RechargeFiled(m["id"].toString(), m["status"].toString()) }

    // ── Plumbing ─────────────────────────────────────────────────────────────

    @Suppress("UNCHECKED_CAST")
    private suspend fun <T> call(
        name: String,
        payload: Map<String, Any>,
        parse: (Map<String, Any?>) -> T,
    ): Result<T> = try {
        val res = functions.getHttpsCallable(name).call(sessionManager.withSession(payload)).await()
        val map = res.data as? Map<String, Any?> ?: emptyMap()
        Result.Ok(parse(map))
    } catch (e: FirebaseFunctionsException) {
        // P0-1: a session refusal also signs this device out (SessionViewModel).
        ServerRefusals.report(e)
        Result.Failed(
            e.code.name,
            e.message ?: "Something went wrong.",
            // Approved contact rule: the machine-readable "verify a contact".
            ContactRequirement.fromRefusal(e.details, e.message),
            // Decision 15 (RC): "a role starts only with BOTH contacts verified".
            ActivationRequirement.fromRefusal(e.details, e.message),
            // RF-30: no answer about whether a write happened.
            outcomeUnknown = WriteOutcome.unknown(
                e.code.name, ServerRefusals.detailCodeOf(e), e.cause is java.io.IOException,
            ),
        )
    } catch (e: Exception) {
        // RF-30: nothing came back that says what happened (the answer may
        // have been lost after a write) — a writer looks before saying so.
        Result.Failed("unavailable", "Could not reach the server. Check your connection.", outcomeUnknown = true)
    }

    /*
     * ── THE PARSERS, WHERE A TEST CAN REACH THEM ─────────────────────────────
     *
     * Pure functions of the callable's response map, in the companion so
     * `PartnerHubRowsTest` can feed them the exact shape the API sends (C1)
     * without a FirebaseFunctions instance.
     */
    companion object {

        fun parseEligibility(m: Map<String, Any?>): Eligibility {
            val held = m["held"] as? Map<*, *> ?: emptyMap<Any, Any>()
            val partners = (held["partners"] as? List<*>).orEmpty().mapNotNull { p ->
                (p as? Map<*, *>)?.let {
                    HeldRole(
                        kind = it["kind"]?.toString().orEmpty(),
                        status = it["status"]?.toString().orEmpty(),
                        id = it["id"]?.toString().orEmpty(),
                        name = it["name"]?.toString().orEmpty(),
                        revokedAt = it["revoked_at"]?.toString().orEmpty(),
                        revokedReason = it["revoked_reason"]?.toString().orEmpty(),
                    )
                }
            }
            val host = held["host"] as? Map<*, *>
            val hostStatus = host?.get("status")?.toString().orEmpty()
            val pending = held["pending_host_application"] as? Map<*, *>
            val revoked = (m["revoked"] as? List<*>).orEmpty().mapNotNull { r ->
                (r as? Map<*, *>)?.let {
                    val appeal = it["appeal"] as? Map<*, *>
                    RevokedRole(
                        kind = it["kind"]?.toString().orEmpty(),
                        recordId = it["record_id"]?.toString().orEmpty(),
                        revokedAt = it["revoked_at"]?.toString().orEmpty(),
                        reason = it["reason"]?.toString().orEmpty(),
                        appealId = appeal?.get("id")?.toString().orEmpty(),
                        appealStatus = appeal?.get("status")?.toString().orEmpty(),
                    )
                }
            }.filter { it.kind.isNotBlank() }
            return Eligibility(
                options = (m["options"] as? List<*>).orEmpty().map { it.toString() },
                blocked = (m["blocked"] as? Map<*, *>).orEmpty()
                    .entries.associate { (k, v) -> k.toString() to v.toString() },
                held = partners,
                // C1/B04: `held.host` is present for a REVOKED Host too, so the
                // record's presence is no longer the answer. A revoked Host is
                // not a Host — it is a revoked role, shown as one.
                isHost = host != null && hostStatus != "revoked",
                hostAgencyKind = host?.get("parent_kind")?.toString().orEmpty(),
                pendingHostApplicationId = pending?.get("id")?.toString().orEmpty(),
                pendingHostApplicationStatus = pending?.get("status")?.toString().orEmpty(),
                isInternal = held["internal"]?.toString().orEmpty().isNotBlank(),
                revoked = revoked,
                hostStatus = hostStatus,
                hostRevokedAt = host?.get("revoked_at")?.toString().orEmpty(),
                contact = ContactRequirement.fromEligibility(m["contact"]),
                activation = ActivationRequirement.fromEligibility(m["activation"]),
                parentFor = (m["parent_for"] as? Map<*, *>).orEmpty()
                    .entries.associate { (k, v) -> k.toString() to v.toString() },
            )
        }

        /** `partnerVerificationState` / `checkPartnerActivation`, as the API returns them. */
        fun parseVerificationState(m: Map<String, Any?>): VerificationState {
            fun roles(raw: Any?): List<WaitingRole> = (raw as? List<*>).orEmpty().mapNotNull { r ->
                (r as? Map<*, *>)?.let {
                    WaitingRole(
                        id = it["id"]?.toString().orEmpty(),
                        kind = it["kind"]?.toString().orEmpty(),
                        name = it["name"]?.toString().orEmpty(),
                    )
                }
            }
            val started = (m["started"] as? List<*>).orEmpty().mapNotNull { r ->
                (r as? Map<*, *>)?.takeIf { it["activated"] == true }?.let {
                    WaitingRole(
                        id = it["id"]?.toString().orEmpty(),
                        kind = it["kind"]?.toString().orEmpty(),
                        name = "",
                    )
                }
            }
            val refusals = (m["started"] as? List<*>).orEmpty().mapNotNull { r ->
                (r as? Map<*, *>)?.takeIf { it["activated"] != true }
                    ?.get("refusal")?.toString()?.trim()?.takeIf { it.isNotEmpty() }
            }.distinct()
            return VerificationState(
                requirement = ActivationRequirement.fromVerification(m["verification"])
                    ?: ActivationRequirement(complete = false, missing = listOf("phone", "email"), emailUnproved = false),
                waiting = roles(m["waiting"]),
                started = started,
                refusals = refusals,
            )
        }

        fun parseRoleAppeal(a: Map<*, *>): RoleAppeal {
            val decision = a["decision"] as? Map<*, *>
            return RoleAppeal(
                // The API's public shape names it `id`; `_id` is the Mongo key,
                // accepted too rather than showing a request with no id.
                id = (a["id"] ?: a["_id"])?.toString().orEmpty(),
                kind = a["kind"]?.toString().orEmpty(),
                recordId = a["record_id"]?.toString().orEmpty(),
                status = a["status"]?.toString().orEmpty(),
                statement = a["statement"]?.toString().orEmpty(),
                createdAt = a["created_at"]?.toString().orEmpty(),
                decisionNote = decision?.get("note")?.toString().orEmpty(),
            )
        }
    }
}

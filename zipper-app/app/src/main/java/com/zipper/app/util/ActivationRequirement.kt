package com.zipper.app.util

/**
 * Decision 15 (RC) — "approval is not activation".
 *
 * Applying for a partner role needs ONE verified contact ([ContactRequirement],
 * the approved contact rule, unchanged). The role STARTS only when the account
 * holds BOTH a verified phone number and a verified email address. The Owner
 * may approve before that; the role then WAITS (`awaiting_verification`),
 * grants nothing, and starts by itself once both are verified.
 *
 * The SERVER decides (backend `contact_verification.py`, Functions
 * `contactProof.ts`) from the Firebase Auth record and its own ledger — never
 * from a typed contact. It says so in two shapes, both read here:
 *
 *   * the eligibility answer's `activation` block, before the form is filled
 *     in, so the person knows up front;
 *   * a refusal's `HttpsError.details` with `code: CONTACT_VERIFICATION_REQUIRED`.
 *
 * Pure — no Android, no Firebase — so `ActivationRequirementTest` runs it.
 */
data class ActivationRequirement(
    /** True when both contacts are verified; nothing to do. */
    val complete: Boolean,
    /** What is still missing: "phone", "email". */
    val missing: List<String>,
    /** The account has an email address that is not proved yet. */
    val emailUnproved: Boolean,
    /** The server's sentence, when it sent one. */
    val message: String = "",
) {
    /** The note shown before applying, or "" when nothing is missing. */
    val beforeApplying: String
        get() = if (complete) "" else
            "An approved role starts only once BOTH your phone number and your email address are " +
                "verified on this account. ${stillNeeded()}"

    /** The line under a role that is approved and waiting. */
    val waitingLine: String
        get() = when {
            complete -> "Both contacts are verified. Your role is starting."
            missing.isEmpty() ->
                "Approved — it starts once both your phone number and your email address are verified."
            else ->
                "Approved — it starts once ${missingWords()} ${if (missing.size == 1) "is" else "are"} verified."
        }

    /** The verification flows to offer, in a useful order (email first when only confirming). */
    val actions: List<VerifyAction>
        get() = buildList {
            if ("email" in missing && emailUnproved) add(VerifyAction.EMAIL)
            if ("phone" in missing) add(VerifyAction.PHONE)
            if ("email" in missing && VerifyAction.EMAIL !in this) add(VerifyAction.EMAIL)
        }

    private fun stillNeeded(): String =
        if (missing.isEmpty()) "" else "Still needed: ${missingWords()}."

    private fun missingWords(): String = missing.map {
        if (it == "phone") "your phone number" else "your email address"
    }.joinToString(" and ")

    companion object {
        const val CODE = "CONTACT_VERIFICATION_REQUIRED"

        /** From the eligibility answer's `activation` block; null from an older server. */
        fun fromEligibility(block: Any?): ActivationRequirement? {
            val b = block as? Map<*, *> ?: return null
            return ActivationRequirement(
                complete = b["complete"] == true,
                missing = missingOf(b["missing"]),
                emailUnproved = b["emailUnproved"] == true,
            )
        }

        /** From a refused callable's `details`, or null when it is not this rule. */
        fun fromRefusal(details: Any?, message: String?): ActivationRequirement? {
            val d = details as? Map<*, *> ?: return null
            if (d["code"]?.toString() != CODE) return null
            return ActivationRequirement(
                complete = false,
                missing = missingOf(d["missing"]).ifEmpty { listOf("phone", "email") },
                emailUnproved = d["emailUnproved"] == true,
                message = message.orEmpty(),
            )
        }

        /** From `partnerVerificationState` / `checkPartnerActivation`'s `verification` block. */
        fun fromVerification(block: Any?): ActivationRequirement? {
            val b = block as? Map<*, *> ?: return null
            val email = b["email"] as? Map<*, *>
            return ActivationRequirement(
                complete = b["complete"] == true,
                missing = missingOf(b["missing"]),
                emailUnproved = email?.get("unproved") == true,
            )
        }

        private fun missingOf(raw: Any?): List<String> =
            (raw as? List<*>).orEmpty().map { it.toString() }.filter { it == "phone" || it == "email" }.distinct()
    }
}

package com.zipper.app.util

/**
 * Approved contact rule — "before any partner application, at least one
 * eligible, VERIFIED contact; if there is none, say what is missing and take the
 * person to phone or email verification".
 *
 * The SERVER decides (backend `partner_applications.ContactRequired`, from the
 * Firebase Auth record — never a typed contact). It says so in two places, in
 * the same machine-readable shape:
 *
 *   * the eligibility answer's `contact` block, before the form is filled in;
 *   * a refused submission's `HttpsError.details` (`code: CONTACT_REQUIRED`),
 *     forwarded by `functions/src/index.ts → apiRefusalToHttpsError`.
 *
 * This is the app's reading of it: whether verification is required, which
 * contacts would satisfy it, and what to say. Pure — no Android, no Firebase —
 * so `ContactRequirementTest` runs it.
 *
 * One verified contact is enough for every partner application
 * (`requirement == "one_of"`). Redeeming an agency's Host invitation, which
 * needs BOTH, is not decided here and is not changed by this.
 */
data class ContactRequirement(
    val required: Boolean,
    /** Contacts that would satisfy the rule: "phone", "email". */
    val missing: List<String>,
    /** The account HAS an email address that only needs confirming. */
    val emailUnverified: Boolean,
    /** The server's sentence, when it sent one. */
    val message: String = "",
) {
    /** What to show, in the applicant's words. */
    val explanation: String
        get() = if (emailUnverified) {
            "To apply, verify your email address or add a phone number. Your account has an " +
                "email address that has not been confirmed yet."
        } else {
            "To apply, verify a phone number or an email address on your account. One " +
                "verified contact is enough."
        }

    /** The verification flows to offer, the most useful first. */
    val actions: List<VerifyAction>
        get() {
            val offered = mutableListOf<VerifyAction>()
            if (emailUnverified && "email" in missing) offered += VerifyAction.EMAIL
            if ("phone" in missing) offered += VerifyAction.PHONE
            if ("email" in missing && VerifyAction.EMAIL !in offered) offered += VerifyAction.EMAIL
            return offered
        }

    companion object {
        const val CODE = "CONTACT_REQUIRED"

        /**
         * From a refused callable's `details` (a map), or null when the refusal
         * is not the contact rule — an ordinary refusal stays a sentence.
         */
        fun fromRefusal(details: Any?, message: String?): ContactRequirement? {
            val d = details as? Map<*, *> ?: return null
            if (d["code"]?.toString() != CODE) return null
            return ContactRequirement(
                required = true,
                missing = missingOf(d["missing"]),
                emailUnverified = d["emailUnverified"] == true,
                message = message.orEmpty(),
            )
        }

        /** From the eligibility answer's `contact` block; null when absent (an older server). */
        fun fromEligibility(block: Any?): ContactRequirement? {
            val b = block as? Map<*, *> ?: return null
            return ContactRequirement(
                required = b["required"] == true,
                missing = missingOf(b["missing"]),
                emailUnverified = b["emailUnverified"] == true,
                message = b["message"]?.toString().orEmpty(),
            )
        }

        private fun missingOf(raw: Any?): List<String> {
            val listed = (raw as? List<*>).orEmpty().map { it.toString() }.filter { it == "phone" || it == "email" }
            // A refusal with no list still means "either would do".
            return listed.ifEmpty { listOf("phone", "email") }
        }
    }
}

/** A verification flow the app can open: SecureAccount (phone) or SecureEmail (email). */
enum class VerifyAction { PHONE, EMAIL }

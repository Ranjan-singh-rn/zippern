package com.zipper.app.util

/**
 * UGP — what the app may conclude about an account's contacts, in one place.
 *
 * ── TWO DIFFERENT QUESTIONS ─────────────────────────────────────────────────
 *
 * "Is there a VERIFIED contact?" is answered from the Firebase Auth record:
 * a phone number (only ever put there by an SMS code) or an email Firebase has
 * seen confirmed. That is exactly the rule the server enforces — backend
 * `partner_applications.is_unverified_guest`, Functions `guestRefusal` — so the
 * UI hides what the server would refuse, and never the other way round. The
 * server remains the rule; this is the reflection of it (brief A: "the UI
 * reflects eligibility, the backend enforces it independently").
 *
 * "Is the contact BOUND?" additionally needs `users/{uid}` to record it. A
 * phone is linked on the device first and bound by the server second; if the
 * second step failed (a dropped connection) the Auth record has the number and
 * the account does not. Reading only the Auth record hid "Add your phone
 * number" in exactly that state — the one place the retry lives — so Settings
 * asks this question instead and keeps the row until the bind has happened.
 *
 * Pure on purpose: no Android, no Firebase, unit-tested in
 * `ContactRulesTest`.
 */
object ContactRules {

    /** Auth holds a phone, or an email Firebase has confirmed. */
    fun hasVerifiedContact(
        authPhone: String?,
        authEmail: String?,
        authEmailVerified: Boolean,
    ): Boolean = !authPhone.isNullOrBlank() || (!authEmail.isNullOrBlank() && authEmailVerified)

    /**
     * "Become a partner" is offered to every non-staff account.
     *
     * Approved contact rule: an account WITHOUT a verified contact used to see
     * no card at all, which explained nothing and led nowhere. It now sees the
     * card — saying a verified phone or email comes first ([partnerEntryNeedsContact])
     * — and the hub explains what is missing and opens phone or email
     * verification. The server still refuses an application without one.
     *
     * `crmRole` is non-blank only for ZIPPER staff (stamped by `syncMyRoles`);
     * staff are never partners. The contact parameters are kept so every caller
     * passes the Auth record the same way; the card's wording reads them.
     */
    @Suppress("UNUSED_PARAMETER")
    fun partnerEntryVisible(
        crmRole: String,
        authPhone: String?,
        authEmail: String?,
        authEmailVerified: Boolean,
    ): Boolean = crmRole.isBlank()

    /** The partner card should say a verified contact is needed before applying. */
    fun partnerEntryNeedsContact(
        authPhone: String?,
        authEmail: String?,
        authEmailVerified: Boolean,
    ): Boolean = !hasVerifiedContact(authPhone, authEmail, authEmailVerified)

    /** The phone is on the Auth record AND recorded on `users/{uid}`. */
    fun phoneBound(authPhone: String?, docPhone: String?): Boolean =
        !authPhone.isNullOrBlank() && !docPhone.isNullOrBlank()

    /** A confirmed email on the Auth record AND recorded on `users/{uid}`. */
    fun emailBound(authEmail: String?, authEmailVerified: Boolean, docEmail: String?): Boolean =
        !authEmail.isNullOrBlank() && authEmailVerified && !docEmail.isNullOrBlank()
}

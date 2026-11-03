package com.zipper.app.util

/**
 * QA #51 — what an invited host is told when the agency code is theirs but the
 * Host role still needs a contact verified.
 *
 * The server (`checkReferralCode` / `activateHost`) matches the invitation with
 * the contacts this account has VERIFIED and nothing typed. A new phone sign-up
 * has a verified number and no e-mail, so the role cannot start yet (both are
 * required) — but the code is right, and the old screen said "Details don't
 * match the agency record for this code". These sentences say instead which
 * contact is missing and which address or number the agency registered
 * (masked by the server), and where to add it.
 *
 * Pure: no Android, so it runs in a plain JVM unit test.
 */
object ReferralContacts {

    /** "your email address (i•••@example.com)" — the contact and, when known, the registered value. */
    fun describe(missing: List<String>, hint: Map<String, String>): String {
        val parts = missing.distinct().mapNotNull { contact ->
            val what = when (contact) {
                "email" -> "email address"
                "phone" -> "phone number"
                else -> null
            } ?: return@mapNotNull null
            val registered = hint[contact].orEmpty().trim()
            if (registered.isNotEmpty()) "the $what your agency registered ($registered)" else "your $what"
        }
        return when (parts.size) {
            0 -> ""
            1 -> parts[0]
            else -> parts.joinToString(" and ")
        }
    }

    /** Where the person adds the contact: the e-mail and the phone are both added in Settings. */
    private const val WHERE = "Me → Settings"

    /** The line under the code field for a code that is valid but waiting on a contact. */
    fun validLine(agencyName: String, missing: List<String>, hint: Map<String, String>): String {
        val joining = if (agencyName.isNotBlank()) " — joining $agencyName" else ""
        val what = describe(missing, hint)
        return if (what.isEmpty()) {
            "Valid code$joining. You'll be registered as a host."
        } else {
            "Valid code$joining. Your Host role starts once you verify $what — " +
                "add it after sign-up in $WHERE."
        }
    }

    /** The dialog after the profile is saved and the invitation was claimed. */
    fun awaitingNotice(missing: List<String>, hint: Map<String, String>): String {
        val what = describe(missing, hint).ifEmpty { "your phone number and email address" }
        return "Your agency code is accepted and the invitation is now linked to this account. " +
            "Your Host role starts by itself once you verify $what. Add it in $WHERE — " +
            "nothing else is needed, and you do not need the code again."
    }
}

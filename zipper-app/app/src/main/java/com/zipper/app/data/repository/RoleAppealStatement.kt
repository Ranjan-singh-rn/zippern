package com.zipper.app.data.repository

/**
 * WHETHER A REINSTATEMENT REQUEST HAS ENOUGH IN IT TO SEND (C2).
 *
 * The server accepts a statement of 20 to 2,000 characters for
 * `submitRoleAppeal`, trimmed. The same bounds are applied here so the Send
 * button is never live for a statement the server will refuse, and so the
 * screen can say what is still needed while the person types — the lesson of
 * [AppealStatement], whose minimum used to live only in an error string nobody
 * could reach.
 *
 * Kept separate from [AppealStatement] on purpose: that is the rule for a ban
 * or suspension appeal and has no upper bound; this is the rule for a revoked
 * ROLE, and the two must be free to change apart. Imports nothing, so
 * `PartnerHubRowsTest` proves it on the JVM.
 */
object RoleAppealStatement {

    const val MIN = 20
    const val MAX = 2000

    /** Trimmed, because the server trims. */
    fun length(raw: String): Int = raw.trim().length

    fun isSendable(raw: String): Boolean = length(raw) in MIN..MAX

    /** What is wrong with it, or null when it may be sent. */
    fun problem(raw: String): String? = when {
        length(raw) < MIN -> TOO_SHORT
        length(raw) > MAX -> TOO_LONG
        else -> null
    }

    const val TOO_SHORT: String =
        "Tell us why the role should be restored, in at least $MIN characters. " +
            "This is what the reviewer reads."

    const val TOO_LONG: String = "Please keep it to $MAX characters or fewer."
}

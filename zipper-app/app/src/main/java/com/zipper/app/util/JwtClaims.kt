package com.zipper.app.util

/**
 * Reading one string claim out of a JWT's payload — never trusting it for
 * anything but a hint.
 *
 * QA #55: when Firebase refuses a Google sign-in because the login is disabled,
 * the e-mail in Google's ID token is what tells `quickLoginRestriction` which
 * account was tried. The server compares it with the Auth record of the account
 * whose quick-login key this phone proved it holds; a wrong value only means
 * "other account" and nothing is disclosed. No signature is checked here and
 * none needs to be.
 *
 * Pure (no Android, no JSON library) so it runs in a plain JVM unit test —
 * the same approach as [CustomTokens].
 */
object JwtClaims {
    /** The string value of [claim] in the payload, or "" when absent or unreadable. */
    fun string(token: String?, claim: String): String = try {
        val parts = token.orEmpty().trim().split('.')
        if (parts.size != 3 || claim.isBlank()) "" else {
            val payload = String(java.util.Base64.getUrlDecoder().decode(parts[1]), Charsets.UTF_8)
            Regex("\"" + Regex.escape(claim) + "\"\\s*:\\s*\"([^\"]*)\"")
                .find(payload)?.groupValues?.get(1).orEmpty()
        }
    } catch (_: Exception) {
        ""
    }
}

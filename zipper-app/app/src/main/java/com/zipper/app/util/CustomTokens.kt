package com.zipper.app.util

/**
 * Reading a Firebase custom token, without trusting it for anything but a guard.
 *
 * A custom token is a JWT minted by the Admin SDK; its payload carries the uid it
 * signs in as. The app reads that claim for ONE purpose: before continuing the
 * current session from a same-uid token the server handed back after a contact
 * bind (UGP D21, `AuthRepository.adoptSameUidSession`), it checks the token really
 * is for the account already signed in — so no response, however malformed, can
 * move the device into a different account. Firebase verifies the signature when
 * the token is used; nothing here does or needs to.
 *
 * Pure (no Android, no JSON library) so it runs in a plain JVM unit test.
 */
object CustomTokens {
    private val UID_CLAIM = Regex("\"uid\"\\s*:\\s*\"([^\"]*)\"")

    /** The `uid` claim, or "" when the token is not a readable three-part JWT. */
    fun uidOf(token: String): String = try {
        val parts = token.trim().split('.')
        if (parts.size != 3) "" else {
            val payload = String(java.util.Base64.getUrlDecoder().decode(parts[1]), Charsets.UTF_8)
            UID_CLAIM.find(payload)?.groupValues?.get(1).orEmpty()
        }
    } catch (_: Exception) {
        ""
    }

    /**
     * QA #30 — may the device continue its session from [token]?
     *
     * Only when somebody is signed in and the token names exactly that uid. The
     * server now hands a same-uid token to EVERY session that binds an e-mail
     * (Firebase expires the account's refresh tokens when the address changes),
     * so this is the one check standing between that answer and a different
     * account: a phone user adding an e-mail must carry on as themselves.
     */
    fun adoptable(token: String, currentUid: String?): Boolean {
        val current = currentUid?.trim().orEmpty()
        if (current.isEmpty()) return false
        return uidOf(token) == current
    }
}

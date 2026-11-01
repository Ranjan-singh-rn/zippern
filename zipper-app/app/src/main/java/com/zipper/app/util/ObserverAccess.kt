package com.zipper.app.util

/**
 * Spec §8 / B3: the Observer account is CRM-only and is refused on every
 * mobile path. Three servers say so with one word — `resolveIdentity`'s
 * decision `observer_denied`, `startMobileSession`'s `details.code
 * OBSERVER_DENIED`, and the backend's `/api/auth/signin` `detail.code
 * observer_denied` — and the app answers all three with one sentence.
 */
object ObserverAccess {

    /** What the person is told, on the login screen, whichever server refused. */
    const val DENIED_MESSAGE = "This account cannot use the app."

    /** The refusal's own name, in any of the spellings the servers use. */
    fun isDenied(code: String?): Boolean =
        code?.trim()?.equals("OBSERVER_DENIED", ignoreCase = true) == true
}

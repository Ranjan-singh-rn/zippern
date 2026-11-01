package com.zipper.app.data.repository

/**
 * WHERE A SIGN-IN LANDS, AND WHAT IS NOT ALLOWED TO CHANGE THAT.
 *
 * ── THE LOOP THIS EXISTS TO MAKE IMPOSSIBLE (C7 — B01, B02) ─────────────────
 *
 * A partner, a Host or a member of staff missing one contact detail was sent to
 * Set Up Profile on EVERY sign-in, with a profile that was already complete.
 * `gateIdentity` returned `NeedsContactDetails` before `isProfileComplete` was
 * ever read, the view model mapped that straight to profile setup, and profile
 * setup — a fresh view model, the contact fields hidden, typed contacts
 * discarded by `saveUserProfile` — had no way to satisfy it. They filled the
 * form in again, submitted, and were sent back the next time. The same early
 * return skipped `generateSession` and `setGuest`, so these accounts never held
 * a mobile session at all.
 *
 * A missing contact is now a REQUIREMENT that is recorded, not a ROUTE that is
 * taken. The session is started exactly as on any other sign-in, the
 * requirement is stored in SessionManager, and the one question that decides
 * the destination is the one [SignInRouting.decide] answers: is the profile
 * finished? The verified way to add the missing contact is the "Add your phone
 * number / Add your email" row in Settings, which binds by OTP or by code.
 *
 * Nothing in this file imports Android or Firebase, so `SignInRoutingTest`
 * proves every branch on the JVM.
 */
object SignInRouting {

    enum class Route { Main, ProfileSetup }

    /**
     * Where a successful sign-in goes.
     *
     * [requiresPhone] and [requiresEmail] are taken — and deliberately NOT
     * consulted — so that every call site states the requirement it holds, and
     * so the test can pin the invariant in one line: a complete profile is
     * never sent to setup because a contact is missing. Profile setup cannot
     * bind a contact, so routing there for one is a loop by construction.
     */
    @Suppress("UNUSED_PARAMETER")
    fun decide(isProfileComplete: Boolean, requiresPhone: Boolean, requiresEmail: Boolean): Route =
        if (isProfileComplete) Route.Main else Route.ProfileSetup

    /**
     * RF-27: does the sign-in gate's answer let this sign-in carry on? Only an
     * explicit `allow`. `gateIdentity` handles every refusal it knows first; an
     * answer this build does not recognise is not permission — the same rule
     * `SplashGate.decide` applies on a cold start.
     */
    fun gateLetsThrough(decision: String?): Boolean = decision?.trim() == "allow"

    /** RF-27: the sentence for a gate answer this build does not recognise. */
    const val UNKNOWN_GATE_ANSWER =
        "We couldn't verify your account right now. Please update the app or try again."

    /** The [AuthResult] the view model navigates on. */
    fun toResult(route: Route): AuthResult = when (route) {
        Route.Main -> AuthResult.Success
        Route.ProfileSetup -> AuthResult.ProfileIncomplete
    }

    /**
     * B12: did this result take the person INTO the account?
     *
     * The guest button resumes the saved quick-login account first, and every
     * result that lets that account be entered — Home, profile setup, or the
     * recover-or-start-fresh question — has to pass the device-binding check
     * before it is handed back. The check used to run for `Success` and
     * `ProfileIncomplete` only, so a partner account whose sign-in came back as
     * `NeedsContactDetails` walked past it. A ban, an error and a refusal open
     * nothing and are returned as they are.
     */
    fun entersAccount(result: AuthResult): Boolean =
        result is AuthResult.Success ||
            result is AuthResult.ProfileIncomplete ||
            result is AuthResult.DeletedRecoverable
}

/**
 * B11 — may an ordinary sign-out finish what it started?
 *
 * `signOut` ends with `sessionManager.clear()` and `auth.signOut()`, and it used
 * to run them unconditionally, seconds after it began: the quick-login mint, the
 * end of the server session and the push-token delete are all network calls in
 * between. Logout navigated to Login before any of that was done, so a person
 * who tapped "Continue as …" straight away was signed in — and then signed out
 * again by the tail of the sign-out they had already left behind.
 *
 * The tail now runs only when nothing has happened since: the same account is
 * still the one signed in, AND no sign-in has started in the meantime. The uid
 * alone is not enough — the quick re-sign-in is usually into the SAME account —
 * so `AuthRepository` counts sign-ins and the count is compared too.
 */
object SignOutGuard {
    fun mayFinish(
        startedUid: String?,
        currentUid: String?,
        startedSerial: Long,
        currentSerial: Long,
    ): Boolean = startedSerial == currentSerial && startedUid == currentUid
}

/**
 * B13 — what a Google sign-in that CREATED a uid does with the adoption answer.
 *
 * `adoptEmailAccount` asks whether this verified address already belongs to
 * exactly one other account. The answer used to be read as
 * `(result as? Ok)?.value`, so a failed CALL — no connection, a timeout, a
 * server error — read exactly like "no match": the app carried on, wrote a
 * users document for the new uid, and the person's real account was stranded
 * behind a permanent duplicate.
 *
 * Only the server's own "none" means "no match". Anything else that is not a
 * usable adoption is retried once and then FAILS CLOSED: signed out, nothing
 * deleted, nothing created, and the person is told to try again. The new login
 * left behind has no document, so the next attempt asks the question again
 * (`AuthRepository.signInWithGoogle` runs the check for any Google login that
 * has no users document yet, not only for a brand-new one).
 */
object GoogleAdoption {
    enum class Step { Adopt, KeepNew, Retry, FailClosed }

    /** The first call and one retry. */
    const val MAX_ATTEMPTS = 2

    /**
     * @param status the server's `status` when the call returned, or null when
     *   the call itself failed.
     * @param hasToken whether a custom token came back with it.
     * @param attempt 1 for the first call, 2 for the retry.
     * @param reason the server's `reason` with a `none` answer.
     * @param callerHasDocument whether this login already has a users document.
     * @param callerGoogleOnly whether Google is this login's ONLY provider.
     *
     * FX-08: `none` with `caller_not_fresh` for a GOOGLE-ONLY login that has NO
     * users document is not "no match". It is what a server without the FX-08
     * change says to the retry of an attempt that failed closed more than 15
     * minutes ago — and keeping the new login then wrote the duplicate account
     * B13 was meant to prevent (DUP-04). It is retried and then fails closed,
     * like a failed call; it never creates anything.
     *
     * A login with ANOTHER provider (a CRM password with Google connected; a
     * login left by a failed purge) is never adopted by the server, whose
     * `caller_not_fresh` then means "keep it" — so it is kept, exactly as
     * before, and gets its document from `ensureUserDocument`.
     */
    fun next(
        status: String?,
        hasToken: Boolean,
        attempt: Int,
        reason: String = "",
        callerHasDocument: Boolean = true,
        callerGoogleOnly: Boolean = true,
    ): Step = when {
        status == "adopted" && hasToken -> Step.Adopt
        status == "none" && reason == CALLER_NOT_FRESH && !callerHasDocument && callerGoogleOnly ->
            if (attempt < MAX_ATTEMPTS) Step.Retry else Step.FailClosed
        status == "none" -> Step.KeepNew
        attempt < MAX_ATTEMPTS -> Step.Retry
        else -> Step.FailClosed
    }

    /** The server's reason for a login it will not discard (functions/src/emailAdoption.ts). */
    const val CALLER_NOT_FRESH = "caller_not_fresh"

    const val COULD_NOT_CHECK =
        "We couldn't check whether this Google account already has a Zipper account, " +
            "so nothing was created. Check your connection and try again."
}

package com.zipper.app.ui.screens.auth

/**
 * TODO(APK 20 / spec §8 "Owner requires authenticator-app TOTP for CRM and
 * Android login paths") — OWNER TOTP ON THE APP SIGN-IN PATH. NOT IMPLEMENTED.
 *
 * ── Status ───────────────────────────────────────────────────────────────────
 *
 * Deliberately left as a documented plan, not code. The backend agent (B3) is
 * defining the mobile sequence; this file is the client-side placeholder so
 * the sign-in flow has one named place to grow the gate when that sequence is
 * reported, and so nothing is half-built against an API that may still move.
 * Nothing here is called from the sign-in flow today.
 *
 * What already exists and is NOT this:
 *   * the Work hub's "Two-step sign-in" module (`data/work/ModulesOps.kt`,
 *     `owner.mfa`) and `ApiClient`'s session upgrade — that gates the
 *     Owner's API SESSION (Work screens) once they are inside the app;
 *   * the CRM's Owner TOTP (rc2) — the web login.
 * This TODO is the gate on the APP LOGIN ITSELF: an Owner who signs in to the
 * Android app with Google / phone / email must present a TOTP code before the
 * app lets them past Splash into Main, exactly as the CRM does before its
 * dashboard.
 *
 * ── Planned call sequence (to be confirmed by the backend agent) ─────────────
 *
 *   0. Sign-in completes as today (`AuthRepository` → `resolveIdentity` →
 *      `startMobileSession`). The server answers with the role; an Owner is
 *      `crmRole == "owner"` (SplashGate / SessionManager already carry it).
 *
 *   1. GET  /api/auth/mfa/status            (ApiClient, mobile API session)
 *        → { enrolled, verified, recovery_codes_left, locked_until }
 *        - `enrolled == false` → the app CANNOT enrol (the setup key is
 *          shown on the CRM only, by design): show "Set up two-step sign-in
 *          on the CRM first", sign out. OWNER_DECISION_PENDING: allow
 *          enrolment from the app? Default no.
 *        - `verified == true` for this session → continue to Main.
 *        - `locked_until` in the future → show the lock, sign out.
 *
 *   2. POST /api/auth/mfa/verify  { code }  (6–8 digits from the authenticator)
 *        → a NEW API session (ApiClient.adopt) + `firestore_binding` for this
 *          Firebase sign-in (P1-A3b, `/api/auth/mfa/bind` → `bind/confirm`)
 *        - 401/403 with a reason → show it, allow retry; after the server's
 *          attempt limit it answers `locked_until`.
 *        - the Observer never reaches here: `observer_denied` at Splash
 *          (SplashGate.OBSERVER_DENIED_MESSAGE) and the server refuses the
 *          session.
 *
 *   3. POST /api/auth/mfa/verify  { recovery_code }   ("Use a recovery code")
 *        → same as 2; each code works once; `recovery_codes_left` decrements.
 *        POST /api/auth/mfa/recovery-codes → a fresh set (CRM-first; the app
 *        shows them once and never stores them). OWNER_DECISION_PENDING.
 *
 *   4. Failure to verify is a SIGN-OUT, never a bypass: `tearDownSession`
 *      and Login with the reason (ForcedSignOut.raise). No password-only path.
 *
 *   5. Re-verification policy (every launch vs per API session) and the
 *      Firestore-side enforcement (rules reading an MFA claim) are the
 *      backend agent's to specify; the client must not assume "verified once
 *      on this device" survives a cold start unless the server says so.
 *
 * ── Where it will plug in ────────────────────────────────────────────────────
 *
 *   SplashScreen, after the restriction/session checks and before
 *   `refreshRoles()` / navigation: `if (OwnerMfaGate.required(crmRole)) →
 *   OwnerMfaScreen` (to be written) → on success `onNavigateToMain()`.
 *   LoginScreen's sign-in results route through the same gate via
 *   `AuthViewModel.handleAuthResult`.
 *
 * Never log codes, recovery codes or the setup key (spec §12).
 */
object OwnerMfaGate {

    /** Marker for the pending decisions in the plan above. */
    const val OWNER_DECISION_PENDING = "OWNER_DECISION_PENDING"

    /** The backend routes the plan uses (backend/app/routers/auth.py). */
    const val STATUS_PATH = "/api/auth/mfa/status"
    const val VERIFY_PATH = "/api/auth/mfa/verify"
    const val RECOVERY_CODES_PATH = "/api/auth/mfa/recovery-codes"

    /**
     * Whether the app-login TOTP gate applies to this role. Owners only —
     * the Observer is refused outright, everyone else has no second factor
     * (spec §5.3). Pure and unused by the flow until the backend sequence is
     * confirmed; kept so the eventual wiring and its test have a name.
     */
    fun appliesTo(crmRole: String): Boolean = crmRole.trim().lowercase() == "owner"

    /**
     * NOT WIRED. Returns false — the gate does not block anyone yet. When the
     * backend agent confirms the mobile sequence, this becomes the decision
     * `SplashScreen` consults, and `appliesTo` the role check inside it.
     */
    @Suppress("UNUSED_PARAMETER")
    fun enforced(crmRole: String): Boolean = false
}

/**
 * Two-step sign-in on a backend that does not have it yet.
 *
 * Pure — no imports, no React, no Firebase — so `npm run test:mfaavail`
 * compiles and runs the shipped module.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * The CRM carries the Owner two-step sign-in (P1-A3) and the Observer's TOTP
 * step, but the backend revision serving production today has neither
 * `/auth/mfa/*` nor `/auth/observer/mfa/*`. The login page used to treat ANY
 * failure of `GET /auth/mfa/status` as "cannot finish signing in" and parked
 * every Owner on the `blocked` screen (audit C-3) — a deploy of this tree
 * ahead of the backend would have locked every Owner out.
 *
 * A 404 from the status route is not a failure of the sign-in: it is the
 * server saying the feature is not there. The page proceeds exactly as it did
 * before two-step sign-in existed, and SAYS SO on screen, so nobody mistakes
 * "the server has no second step" for "I passed the second step".
 *
 * Only 404 (and 405, which some proxies answer for an unknown method on a
 * known prefix) mean "not available". A 5xx, a network failure, a 401 or a
 * 403 are failures of this sign-in and stay blocked — degrading on those
 * would turn an outage of the MFA service into a way around it.
 */

/** The minimum an error must carry for the classification to read it. */
export interface StatusLike {
  status?: number
}

export type MfaStatusFailure = 'unavailable' | 'failed'

/** `unavailable` when the route does not exist on this server; else `failed`. */
export function classifyMfaStatusFailure(err: unknown): MfaStatusFailure {
  const status = (err as StatusLike | null)?.status
  if (status === 404 || status === 405) return 'unavailable'
  return 'failed'
}

/** True when the server has no two-step sign-in routes at all. */
export function mfaUnavailable(err: unknown): boolean {
  return classifyMfaStatusFailure(err) === 'unavailable'
}

/** Shown on the login screens when the server has no second step yet. */
export const OWNER_MFA_UNAVAILABLE_NOTICE =
  'Two-step sign-in is not available on this server yet. You are signed in with your ' +
  'password alone, as before. The authenticator step turns on by itself once the next ' +
  'backend release is live.'

export const OBSERVER_MFA_UNAVAILABLE_NOTICE =
  'The authenticator step is not available on this server yet. You are signed in with ' +
  'the emailed code alone, as before. It turns on by itself once the next backend ' +
  'release is live.'

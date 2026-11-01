/**
 * THE ACTIVE MOBILE SESSION, AS A SERVER-SIDE CONTROL.
 *
 * ── What it was ──────────────────────────────────────────────────────────────
 *
 * `users/{uid}.activeMobileSession.sessionId` was written by `startMobileSession`
 * and read by exactly two things: the Android splash, and a snapshot listener in
 * the app. Both are the client. Nothing on the server ever compared it before
 * permitting an action.
 *
 * So "one active device per account" was a convention the app chose to honour.
 * A modified client that ignored its own listener kept full access on the
 * displaced handset, bounded only by `notBanned()` in the security rules.
 *
 * ── Why Firebase token revocation cannot do this job ─────────────────────────
 *
 * The obvious fix — revoke the displaced device's refresh token — is not
 * available. `admin.auth().revokeRefreshTokens(uid)` is scoped to the ACCOUNT,
 * not to a device. Phone B has just signed in, so its refresh token was minted
 * seconds before the revocation and would be killed along with Phone A's. The
 * displacing device would log itself out.
 *
 * Revocation is therefore the right tool for a BAN and for a PERMANENT DELETION,
 * where every device must die, and the wrong tool for displacement, where one
 * must die and another must live. See `accounts.ts` and `backend/app/services/
 * users.py` for the ban path.
 *
 * ── What enforces it instead, in two layers ──────────────────────────────────
 *
 * 1. **This module**, in every callable that moves value or acts as the person.
 *    The client presents the session id it holds; the server compares it with
 *    the one on record and refuses `SESSION_DISPLACED` on a mismatch.
 *
 * 2. **`firestore.rules`**, for the direct writes the app makes without a
 *    callable — comments, likes, presence, chat. Those cannot present a session
 *    id, so the rules compare `request.auth.token.auth_time` against
 *    `users/{uid}.credentialsValidAfter`, which `startMobileSession` stamps. A
 *    token minted by an earlier sign-in carries an earlier `auth_time` and is
 *    refused; the displacing device's is equal or later and is not.
 *
 * ── The rollout tolerance, and when it ends ──────────────────────────────────
 *
 * `ENFORCE_MOBILE_SESSION` is read from the environment and defaults to FALSE.
 * While it is false, a caller that presents NO session id is allowed through and
 * the omission is logged; a caller that presents a WRONG one is refused either
 * way.
 *
 * The name is stated once and exactly here. This paragraph previously called it
 * `ENFORCE_PRESENTED_SESSION`, which is read by nothing — anyone who set that
 * would have seen no change in behaviour and reasonably concluded the control
 * was broken. `enforcingPresentedSession()` below is the FUNCTION's name; the
 * environment variable is `ENFORCE_MOBILE_SESSION`.
 *
 * That default is deliberate and it is temporary. Every build currently on the
 * estate calls these functions without a session id, so turning this on before
 * the app ships would sign out every user on the platform at once. Layer 2 above
 * has no such dependency and is live immediately.
 *
 * Set `ENFORCE_MOBILE_SESSION=true` once the Android build that sends the id is
 * the minimum supported version — step 7 of the rollout in
 * docs/workstream-0/PHASE-B-DEPLOYMENT-READINESS.md. It is NOT set anywhere
 * today, in any environment.
 */

import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'

/**
 * Resolved on first use, never at module load.
 *
 * `admin.firestore()` throws unless `initializeApp` has already run, so calling
 * it at module scope makes this file unimportable outside a deployed function —
 * including from `test/mobileSession.test.js`, which exists to exercise the
 * decision below without a Firebase app at all. The same reason
 * `publicSeller.ts` and `phone.ts` import nothing.
 */
function store(): admin.firestore.Firestore {
  return admin.firestore()
}

/** The error code the client branches on. Never reuse it for anything else. */
export const SESSION_DISPLACED = 'SESSION_DISPLACED'

/** The sentence the person sees. Not "session expired" — that is a different event. */
export const DISPLACED_MESSAGE = 'Your account was signed in on another device.'

/** Whether a caller presenting no session id is refused. See the note above. */
export function enforcingPresentedSession(): boolean {
  return String(process.env.ENFORCE_MOBILE_SESSION ?? '').toLowerCase() === 'true'
}

/**
 * The session id a caller presented, from wherever a callable carries it.
 *
 * Accepted on the data payload as `sessionId`. Returns `''` when absent, which
 * the caller distinguishes from a wrong one.
 */
export function presentedSessionId(data: unknown): string {
  const raw = (data as { sessionId?: unknown } | null | undefined)?.sessionId
  return typeof raw === 'string' ? raw.trim().slice(0, 128) : ''
}

/**
 * Decide, without touching Firestore, whether a presented id may proceed.
 *
 * Split out from the read so `test/mobileSession.test.js` can exercise every
 * branch without an initialised Firebase app. `recorded` is what the user
 * document holds; `presented` is what the caller sent.
 */
export function sessionVerdict(
  recorded: string,
  presented: string,
  enforcing: boolean,
): 'ok' | 'displaced' | 'missing_tolerated' | 'missing_refused' {
  if (presented === '') {
    return enforcing ? 'missing_refused' : 'missing_tolerated'
  }
  if (recorded === '') {
    /*
     * No session on record at all. This is an account that has not called
     * `startMobileSession` since the field existed, or one that signed out
     * cleanly and is now replaying an old id. Neither may proceed on a
     * presented id that matches nothing.
     */
    return 'displaced'
  }
  return recorded === presented ? 'ok' : 'displaced'
}

/**
 * Refuse unless this caller still holds the account's active mobile session.
 *
 * Throws an `HttpsError` carrying `SESSION_DISPLACED` in its details, so the
 * Android client can tell displacement from an ordinary permission failure and
 * show the right sentence.
 *
 * Costs one document read, and only on callables that opt in.
 */
/**
 * Phase 1A (SESSION-002): the next `credentialsValidAfter`, MONOTONIC.
 *
 * `startMobileSession` used to write the caller's `auth_time` unconditionally.
 * A displaced phone holding an OLDER token could call it and LOWER the cut-off
 * to its own `auth_time` — re-admitting itself and every other stale token, and
 * undoing a revocation stamped by suspension or a deletion request.
 *
 * Now: a caller whose credential predates the current cut-off is refused (it
 * must sign in again), and the stored value only ever moves forward.
 */
export function nextValidAfter(
  prior: unknown,
  callerAuthTime: unknown,
  nowSec: number,
): { ok: true; value: number } | { ok: false } {
  const p = Number(prior)
  const priorOk = Number.isFinite(p) && p > 0 ? p : 0
  const c = Number(callerAuthTime)
  const caller = Number.isFinite(c) && c > 0 ? c : nowSec - 5
  if (priorOk > 0 && caller < priorOk) return { ok: false }
  return { ok: true, value: Math.max(priorOk, caller) }
}

/**
 * Phase 1A (SESSION-003): why this account may not perform protected operations, or ''.
 *
 * C9 (B25): SUSPENSION BEFORE BAN. A suspension writes `isBanned: true` too
 * (the app's one gate), so checking `isBanned` first labelled every suspended
 * account `banned` — and the label is what the app routes on. The order is the
 * backend's `restriction_of`: `accountState` when it names a moderation state,
 * then `isSuspended`, then `isBanned`. Every one of these still refuses; only
 * the label changes.
 */
export function restrictionVerdict(get: (field: string) => unknown): string {
  const state = String(get('accountState') ?? 'active')
  if (state === 'suspended' || state === 'banned') return state
  if (get('isSuspended') === true) return 'suspended'
  if (get('isBanned') === true) return 'banned'
  if (get('isDeleted') === true) return 'deletion_requested'
  if (['recovery_pending', 'permanently_deactivated'].includes(state)) return state
  return ''
}

export const ACCOUNT_RESTRICTED = 'ACCOUNT_RESTRICTED'

/**
 * How far ahead of this server's clock an `auth_time` may be before it counts
 * as "in the future". Firebase Auth and Cloud Functions keep separate clocks.
 * Same value as `accounts.ts` (which imports this module, so it cannot be
 * imported from there).
 */
export const CUTOFF_CLOCK_SKEW_SECONDS = 60

/**
 * P0-1 (N4): does the sign-in behind this token predate the account's cut-off?
 *
 * `credentialsValidAfter` is stamped by `startMobileSession` with the new
 * device's own `auth_time`, and moved forward by suspension and deletion. A
 * token whose `auth_time` is older belongs to a sign-in the account has moved
 * past: the displaced phone, or a stolen token. The rules' `sessionCurrent()`
 * has always refused such a token's direct writes; this is the same test for
 * the callables.
 *
 * No cut-off recorded → nothing to compare (an account that never started a
 * mobile session). A cut-off recorded and NO usable `auth_time` → refused:
 * an ID token always carries one, so its absence is not a reason to wave the
 * call through. Equal passes: that is the device that set the cut-off.
 */
export function signInPredatesCutoff(
  validAfterRaw: unknown,
  authTimeRaw: unknown,
  nowSec: number,
): boolean {
  const validAfter = Number(validAfterRaw ?? 0)
  if (!Number.isFinite(validAfter) || validAfter <= 0) return false
  const authTime = typeof authTimeRaw === 'number' ? authTimeRaw : Number.NaN
  if (!Number.isFinite(authTime) || authTime <= 0) return true
  if (authTime > nowSec + CUTOFF_CLOCK_SKEW_SECONDS) return true
  return authTime < validAfter
}

/** The part of a decoded ID token the gate reads. */
export type SessionToken = { auth_time?: unknown; [claim: string]: unknown }

export async function assertActiveSession(
  uid: string,
  data: unknown,
  operation: string,
  // Required on purpose: every gated callable must hand over the token it was
  // called with, so a new call site cannot silently skip the cut-off check.
  token: SessionToken | undefined,
): Promise<void> {
  const presented = presentedSessionId(data)
  const enforcing = enforcingPresentedSession()

  // Phase 1A (SESSION-003): the account's restriction state is checked on EVERY
  // protected operation, whether or not a session id was presented. A
  // suspended account, or one with a deletion request, kept spending and
  // calling with its still-valid ID token; the rules stopped its direct
  // writes but these callables use the Admin SDK and never asked.
  const snap = await store().collection('users').doc(uid).get()
  const restricted = restrictionVerdict((f) => snap.get(f))
  if (restricted) {
    functions.logger.warn('restricted account refused', { uid, operation, restricted })
    throw new functions.https.HttpsError(
      'permission-denied',
      'This account is restricted and cannot do that right now.',
      { code: ACCOUNT_RESTRICTED, state: restricted },
    )
  }

  // P0-1 (N4): a sign-in older than the account's cut-off is refused whether
  // or not a session id is presented. Leaving the id out used to be enough to
  // keep a displaced device working while `ENFORCE_MOBILE_SESSION` is off.
  if (signInPredatesCutoff(
    snap.get('credentialsValidAfter'), token?.auth_time, Math.floor(Date.now() / 1000),
  )) {
    functions.logger.warn('stale sign-in refused', {
      uid,
      operation,
      // Whether a time was present, never the token itself.
      hasAuthTime: typeof token?.auth_time === 'number',
    })
    throw new functions.https.HttpsError(
      'permission-denied',
      DISPLACED_MESSAGE,
      { code: SESSION_DISPLACED },
    )
  }

  if (presented === '' && !enforcing) {
    functions.logger.info('mobile session not presented', { uid, operation })
    return
  }

  const recorded = String(
    (snap.get('activeMobileSession') as Record<string, unknown> | undefined)?.sessionId ?? '',
  )

  const verdict = sessionVerdict(recorded, presented, enforcing)
  if (verdict === 'ok' || verdict === 'missing_tolerated') return

  functions.logger.warn('mobile session refused', {
    uid,
    operation,
    verdict,
    // Fingerprints only. A session id is a credential and is never logged.
    presentedLen: presented.length,
    hasRecorded: recorded !== '',
  })

  throw new functions.https.HttpsError(
    'permission-denied',
    DISPLACED_MESSAGE,
    { code: SESSION_DISPLACED },
  )
}

/**
 * Phase 1A (SESSION-002, Quick Login): may this caller mint a quick sign-in
 * credential? Returns '' to allow, or the reason it is refused.
 *
 * A displaced device used to be able to mint a fresh credential on its way out
 * and tap straight back in — "one device at a time, whoever taps last wins".
 * For an ordinary (provider-backed) account that is now refused: a device whose
 * token predates the session cut-off, or that presents a session id that is no
 * longer the active one, gets nothing; nor does a banned or suspended account.
 *
 * GUESTS ARE DELIBERATELY UNCHANGED. A guest's anonymous credential cannot be
 * re-obtained by any other means, so refusing the mint on displacement would
 * destroy the guest account. How a displaced guest recovers is an open product
 * decision (see the Phase 1A report); until it is made, guest behaviour is
 * preserved exactly.
 */
export function quickLoginMintRefusal(p: {
  token: Record<string, unknown> | undefined
  get: (field: string) => unknown
  presented: string
}): '' | 'restricted' | 'displaced' {
  const firebase = (p.token?.firebase ?? {}) as Record<string, unknown>
  const provider = String(firebase.sign_in_provider ?? '')
  const hasPhone = String(p.token?.phone_number ?? '').trim() !== ''
  const hasEmail = String(p.token?.email ?? '').trim() !== ''
  const isGuest = provider === 'anonymous' || (!hasPhone && !hasEmail)
  if (isGuest) return ''

  const restricted = restrictionVerdict(p.get)
  if (restricted === 'banned' || restricted === 'suspended') return 'restricted'

  const validAfter = Number(p.get('credentialsValidAfter') ?? 0)
  const authTime = Number(p.token?.auth_time ?? 0)
  if (validAfter > 0 && authTime > 0 && authTime < validAfter) return 'displaced'

  const recorded = String(
    ((p.get('activeMobileSession') ?? {}) as Record<string, unknown>).sessionId ?? '',
  )
  if (p.presented !== '' && recorded !== '' && p.presented !== recorded) return 'displaced'
  return ''
}

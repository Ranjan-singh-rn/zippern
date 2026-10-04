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
 * `ENFORCE_PRESENTED_SESSION` is read from the environment and defaults to
 * FALSE. While it is false, a caller that presents NO session id is allowed
 * through and the omission is logged; a caller that presents a WRONG one is
 * refused either way.
 *
 * That is deliberate and it is temporary. Every build currently on the estate
 * calls these functions without a session id, so turning this on before the app
 * ships would sign out every user on the platform at once. Layer 2 above has no
 * such dependency and is live immediately.
 *
 * Set `ENFORCE_MOBILE_SESSION=true` once the Android build that sends the id is
 * the minimum supported version.
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
export async function assertActiveSession(
  uid: string,
  data: unknown,
  operation: string,
): Promise<void> {
  const presented = presentedSessionId(data)
  const enforcing = enforcingPresentedSession()

  if (presented === '' && !enforcing) {
    functions.logger.info('mobile session not presented', { uid, operation })
    return
  }

  const snap = await store().collection('users').doc(uid).get()
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

/**
 * Is this browser holding a session, or is it signed out?
 *
 * One question, asked on every render of the CRM shell, and the only thing that
 * may send somebody to /login. It lives here — no React, no imports, no browser
 * — because it has now been got wrong twice in production, and both times the
 * symptom was a signed-in person being thrown out of the application.
 *
 * **What went wrong the first time.** The observer holds no Firestore record at
 * all; that absence *is* the read-only guarantee. Reading "no crmUser" as
 * "signed out" bounced the observer off every page the instant they signed in.
 *
 * **What went wrong the second time.** An owner refreshing the page. The API
 * session lives in localStorage and resolves in milliseconds; the Firebase
 * session lives in IndexedDB and takes longer. For that window the facts are
 * `crmUser: null, apiRole: 'owner'` — neither the observer case nor the
 * both-absent case the guards covered — so it fell through to /login. And
 * because Firebase *had* by then restored the session, /login recognised the
 * user and showed the superadmin security gate. One race, reported as two
 * separate bugs: "it sends me to login" and "it sends me to verification".
 *
 * The lesson both times is the same, and it is the rule this module encodes:
 *
 *   **`crmUser === null` is not evidence of being signed out.**
 *
 * It is the same value for "no staff record exists", "the record has not
 * arrived yet" and "the read failed". Only the first is a reason to evict
 * anybody. So the caller passes what it actually knows, and this decides.
 */

/** Every fact the decision may use. Nothing else is in scope. */
export interface SessionFacts {
  /** A Firestore `crmUsers/{uid}` record is loaded for this session. */
  hasCrmUser: boolean
  /**
   * The role the business API recognises, or null if no API identity has been
   * resolved. `'observer'` is the one role that never has a Firestore record.
   */
  apiRole: string | null
  /** An API session token is present in storage right now. */
  hasSessionToken: boolean
  /**
   * The `crmUsers/{uid}` read FAILED, as opposed to reporting no such document.
   * Distinct from `hasCrmUser: false`, and the distinction is the whole point:
   * absent means no access, unread means we could not find out.
   */
  crmProfileUnread: boolean
}

export type Gate =
  /** Render the application. */
  | 'allow'
  /** Genuinely signed out — send to /login. */
  | 'login'

/**
 * Decide. Returns `'login'` only when every source has answered and all of them
 * said no.
 */
export function sessionGate(f: SessionFacts): Gate {
  // The observer, whose whole design is an API identity and no Firestore one.
  if (f.apiRole === 'observer') return 'allow'

  // A loaded profile settles it.
  if (f.hasCrmUser) return 'allow'

  // From here `hasCrmUser` is false, and the three reasons it can be false are
  // separated. Each of these is a different way of saying "we do not yet know
  // that this person is signed out", and none of them is a reason to evict.

  // The API recognises this session. Firestore has simply not caught up.
  if (f.apiRole) return 'allow'

  // A token is in storage and the identity call has not returned. Deciding now
  // decides before the answer arrives.
  if (f.hasSessionToken) return 'allow'

  // The read failed. Unknown is not absent. Screens render their own
  // "could not be read" state, which is honest; /login would be an assertion.
  if (f.crmProfileUnread) return 'allow'

  // Every source answered, and every answer was no.
  return 'login'
}

/**
 * The facts that make `sessionGate` return `'login'`, spelled out for the spec
 * and for anyone changing this file. If a change makes any *other* combination
 * return `'login'`, that change evicts somebody who is signed in.
 */
export const ONLY_SIGNED_OUT: SessionFacts = {
  hasCrmUser: false,
  apiRole: null,
  hasSessionToken: false,
  crmProfileUnread: false,
}

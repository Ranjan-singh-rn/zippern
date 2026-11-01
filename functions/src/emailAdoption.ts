/**
 * GOOGLE SIGN-IN FOR AN EMAIL THAT ALREADY HAS AN ACCOUNT — the decision.
 *
 * The bug (2026-10-08): a guest added `x@gmail.com` with an email link, signed
 * out, then tapped "Continue with Google" with that same Gmail. Firebase made a
 * NEW uid for the Google credential, the app saw `isNewUser` and sent the person
 * to Setup Profile — a second, empty account, with the real one stranded.
 *
 * The fix: right after a Google sign-in creates a new uid, the server checks
 * whether exactly one other live account already holds that email as a
 * VERIFIED address. If so the new, empty uid is removed, Google is linked onto
 * the existing account, and the client is signed into that account instead.
 *
 * ── WHY THIS IS SAFE FOR EMAIL AND NOT FOR PHONE ─────────────────────────────
 *
 * The existing account's email was proved by mailbox control (an email link
 * before UGP-C, a one-time code since). Google proves mailbox control of the
 * same address, so the person passing Google here has shown exactly what the
 * account's owner showed when binding it. (This used to add: "and could already
 * sign in with Continue with Email". That button is gone — see FLOW-MAP D3 for
 * the open question of whether adoption should ask first.) A phone number is
 * different — numbers are recycled — and
 * `bindVerifiedIdentity` deliberately refuses to transfer on OTP alone. This
 * module never touches phones.
 *
 * Pure, so every branch is a test; `adoptEmailAccount` in identity.ts gathers
 * the inputs and performs the writes.
 */

export const ADOPTION_WINDOW_MS = 15 * 60 * 1000

export interface AdoptionCandidate {
  uid: string
  /** The email on the candidate's Firebase Auth record, lower-cased. */
  authEmail: string
  /** Auth's own `emailVerified` — set by a provider sign-in, an email link (legacy) or the one-time code. */
  authEmailVerified: boolean
  disabled: boolean
  /** `users/{uid}.accountState`. */
  accountState: string
}

export interface AdoptionInput {
  callerUid: string
  /** `token.firebase.sign_in_provider`. */
  signInProvider: string
  /** `token.email`, lower-cased. */
  email: string
  /** `token.email_verified`. */
  emailVerified: boolean
  /** Provider ids on the caller's Auth record. */
  callerProviders: string[]
  /** Age of the caller's Auth record. */
  callerAgeMs: number
  /** Does the caller's account hold anything worth keeping (a finished profile, a balance). */
  callerHasData: boolean
  /**
   * FX-08: does `users/{callerUid}` exist at all? A Google-only login with NO
   * users document is what a fail-closed first attempt leaves behind; it is
   * nobody's account, however old. Omitted = treated as `true` (has one), so a
   * caller that does not say keeps the old, stricter behaviour.
   */
  callerHasDocument?: boolean
  candidates: AdoptionCandidate[]
}

export type AdoptionReason =
  | 'not_google'
  | 'email_unverified'
  | 'caller_not_fresh'
  | 'caller_has_data'
  | 'no_holder'
  | 'ambiguous'

export type AdoptionDecision =
  | { action: 'adopt'; targetUid: string }
  | { action: 'none'; reason: AdoptionReason }

export function decideEmailAdoption(input: AdoptionInput): AdoptionDecision {
  const { callerUid, signInProvider, email, emailVerified, callerProviders, callerAgeMs,
    callerHasData, candidates } = input

  if (signInProvider !== 'google.com') return { action: 'none', reason: 'not_google' }
  if (email === '' || !emailVerified) return { action: 'none', reason: 'email_unverified' }

  // Only a uid that Google itself has JUST created, with nothing else on it, is
  // ever discarded. Anything older or richer is somebody's account.
  //
  // FX-08: "older" is measured only for a login that HAS a users document. A
  // Google-only login with no document at all is the one a failed first
  // attempt left behind (the app failed closed and created nothing); answering
  // its retry with `caller_not_fresh` after 15 minutes made the app keep it — a
  // second account beside the one holding the same verified email (DUP-04).
  const onlyGoogle = callerProviders.length === 1 && callerProviders[0] === 'google.com'
  const documentless = input.callerHasDocument === false
  if (!onlyGoogle || (callerAgeMs > ADOPTION_WINDOW_MS && !documentless)) {
    return { action: 'none', reason: 'caller_not_fresh' }
  }
  if (callerHasData) return { action: 'none', reason: 'caller_has_data' }

  const holders = candidates.filter((c) =>
    c.uid !== callerUid &&
    c.authEmail === email &&
    c.authEmailVerified &&
    !c.disabled &&
    c.accountState !== 'permanently_deactivated',
  )
  if (holders.length === 0) return { action: 'none', reason: 'no_holder' }
  // Two live accounts on one verified address is a data problem, not a login
  // decision. Leave everything as it is.
  if (holders.length > 1) return { action: 'none', reason: 'ambiguous' }
  return { action: 'adopt', targetUid: holders[0].uid }
}

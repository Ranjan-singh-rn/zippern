/**
 * Who may become a host — the decision, with no Firestore in it.
 *
 * ── WHY IT IS A SEPARATE FILE ───────────────────────────────────────────────
 *
 * `hosts.ts` calls `admin.firestore()` at module load, so requiring it from a
 * test needs an initialised Firebase app and a credential. That is why the two
 * other rules worth testing in this codebase — `crmRoles.ts` and
 * `guestBinding.ts` — live in files that import nothing: a rule that cannot be
 * required cannot be tested, and this one guards money.
 *
 * ── WHAT IT GUARDS ─────────────────────────────────────────────────────────
 *
 * Until recently a referral code could only be redeemed during first-run profile
 * setup, so every caller was an account seconds old: not banned, not suspended,
 * not attached to an agency. Opening the same redemption to an account that
 * already exists — the point of the Join an Agency screen, since most people an
 * agency invites already have the app — makes those states reachable for the
 * first time.
 *
 * A banned account that became a host would land on an agency roster and in a
 * weekly payout report. Unwinding that is far harder than refusing it.
 */

/** A user document, as a Firestore snapshot or anything that answers `get`. */
export interface FieldReader {
  get(field: string): unknown
}

/**
 * Why this account may not become a host, or '' when there is no reason.
 *
 * Returns the SENTENCE rather than a boolean, because the three states read
 * completely differently to whoever is holding the phone: a suspension ends, a
 * ban does not, and a pending deletion is undone by restoring the account. One
 * flat "not allowed" would send a suspended person to support asking about a
 * ban nobody gave them.
 *
 * Deliberately NOT a copy of the restriction policy. `resolveIdentity` owns what
 * a restricted account is told at sign-in and what happens next; this only
 * refuses to add host status on top of a state that already refuses. The fields
 * it reads are the ones the moderation service writes, so a state that holds a
 * payout also stops the activation that would have produced one.
 *
 * Every test is `=== true`, never truthiness. `isBanned: 'false'` — a string, as
 * a bad client write or a CSV import can produce — is truthy, and a loose check
 * would refuse an innocent account with nothing on screen to explain it.
 */
export function restrictionOn(snap: FieldReader): string {
  if (snap.get('isBanned') === true) {
    return 'This account has been banned and cannot become a host.'
  }
  if (snap.get('isSuspended') === true || snap.get('accountState') === 'suspended') {
    return 'This account is suspended. You can become a host once the suspension ends.'
  }
  if (snap.get('isDeleted') === true || snap.get('accountState') === 'permanently_deactivated') {
    return 'This account is scheduled for deletion. Restore it first, then try again.'
  }
  return ''
}

/**
 * Is this caller already a host of some OTHER agency?
 *
 * Without this, a host attached to agency A who redeems a code from agency B is
 * moved silently: `agencyId` is overwritten, the agreed rate is replaced, and a
 * roster row appears under B while the one under A stays behind. Both agencies
 * then show the same host, and commission — stamped from the agency recorded at
 * the moment of payment — follows whichever write landed last.
 *
 * The same agency is allowed: that is a re-invitation, and it repairs a missing
 * roster row rather than moving anybody.
 */
export function heldByAnotherAgency(
  snap: FieldReader,
  applicationAgencyId: string,
): boolean {
  const held = String(snap.get('agencyId') ?? '').trim()
  return snap.get('isHost') === true && held !== '' && held !== applicationAgencyId.trim()
}

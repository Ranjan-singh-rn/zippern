/**
 * The two refusals `activateHost` was missing, and why they are server-side.
 *
 * ── WHY THESE EXIST ─────────────────────────────────────────────────────────
 *
 * Until now a referral code could only be redeemed during first-run profile
 * setup, so every caller was a brand-new account seconds old: not a host, not
 * banned, not attached to an agency. Opening the same redemption to an account
 * that already exists — which is the point of the Join an Agency screen, since
 * most people an agency invites already have the app — makes two states
 * reachable that the function never had to consider.
 *
 *   * A RESTRICTED account. A ban or suspension applied between opening the
 *     screen and pressing the button would otherwise be stepped around, and the
 *     result is not cosmetic: a banned account would land on an agency roster
 *     and in a weekly payout report, and the money half is far harder to unwind
 *     than a refusal.
 *
 *   * An account ALREADY attached to another agency. Overwriting `agencyId`
 *     moves the host silently — the agreed rate is replaced, a roster row
 *     appears under the new agency while the old one stays behind, both
 *     agencies then show the same host, and commission is stamped from whichever
 *     write landed last.
 *
 * Neither can be a client-side check. The screen is a convenience; the function
 * is the only thing standing between a referral code and a host record.
 *
 * `restrictionOn` returns the SENTENCE rather than a boolean, and that is tested
 * here too: the four states read completely differently to the person holding
 * the phone, and a single "not allowed" would send a suspended user to support
 * asking about a ban they have not been given.
 *
 * Run:  node --test test/hostGuards.test.js
 */

const { test, describe } = require('node:test')
const { expect } = require('./expect')

const { restrictionOn, heldByAnotherAgency } = require('../lib/hostEligibility')

/** A user document, as `tx.get(userRef)` hands it over. */
const snap = (fields) => ({ get: (key) => fields[key] })

describe('restrictionOn — who may not become a host', () => {
  test('an ordinary account has no reason against it', () => {
    expect(restrictionOn(snap({ isHost: false }))).toBe('')
  })

  test('a banned account is refused, and told it is banned', () => {
    const why = restrictionOn(snap({ isBanned: true }))
    expect(why).not.toBe('')
    expect(why).toContain('banned')
  })

  test('a suspended account is told the suspension ends', () => {
    /*
     * The distinction that matters. A suspension is temporary and a ban is not,
     * so telling a suspended person they are banned sends them to support about
     * a decision nobody made. `isSuspended` and `accountState` are both checked
     * because the moderation code writes both.
     */
    for (const fields of [{ isSuspended: true }, { accountState: 'suspended' }]) {
      const why = restrictionOn(snap(fields))
      expect(why).toContain('suspended')
      expect(why).not.toContain('banned')
    }
  })

  test('an account inside its deletion window is told to restore it first', () => {
    for (const fields of [
      { isDeleted: true },
      { accountState: 'permanently_deactivated' },
    ]) {
      const why = restrictionOn(snap(fields))
      expect(why).not.toBe('')
      expect(why).toContain('deletion')
    }
  })

  test('a ban outranks a suspension in the message', () => {
    // Both flags set is a real state — `ban_user` leaves `isSuspended` behind in
    // some histories — and the stronger one is the true one.
    const why = restrictionOn(snap({ isBanned: true, isSuspended: true }))
    expect(why).toContain('banned')
  })

  test('every refusal is a sentence somebody can act on', () => {
    for (const fields of [
      { isBanned: true },
      { isSuspended: true },
      { isDeleted: true },
    ]) {
      const why = restrictionOn(snap(fields))
      // Not a code, not a boolean: it goes straight onto the screen.
      expect(why.length > 20).toBe(true)
      expect(why.endsWith('.')).toBe(true)
    }
  })

  test('a missing field is not a restriction', () => {
    // A user document written before these fields existed must not be read as
    // restricted — that would refuse every long-standing account.
    expect(restrictionOn(snap({}))).toBe('')
    expect(restrictionOn(snap({ isBanned: false, isSuspended: false }))).toBe('')
  })

  test('a truthy-but-not-true value is not a restriction', () => {
    /*
     * Strict `=== true`, deliberately. `isBanned: 'false'` — a string, as a bad
     * client write or a CSV import can produce — is truthy, and a loose check
     * would refuse an innocent account with no way for them to see why.
     */
    expect(restrictionOn(snap({ isBanned: 'false' }))).toBe('')
    expect(restrictionOn(snap({ isSuspended: 1 }))).toBe('')
  })
})

describe('heldByAnotherAgency — one host, one agency', () => {
  test('a non-host is not held by anybody', () => {
    expect(heldByAnotherAgency(snap({ isHost: false, agencyId: 'a' }), 'b')).toBe(false)
  })

  test('a host of the SAME agency may redeem again', () => {
    /*
     * Allowed on purpose. A re-invitation from the agency they are already with
     * repairs a missing `agencyHosts` roster row — the row the weekly payout
     * report iterates, and which every host activated before it existed is
     * missing. Refusing here would close the only self-service repair.
     */
    expect(heldByAnotherAgency(snap({ isHost: true, agencyId: 'a' }), 'a')).toBe(false)
  })

  test('a host of a DIFFERENT agency is refused', () => {
    expect(heldByAnotherAgency(snap({ isHost: true, agencyId: 'a' }), 'b')).toBe(true)
  })

  test('a host with no agency recorded is not blocked', () => {
    // Granted by staff with no agency, or activated before `agencyId` was
    // written. There is no relationship to protect, so there is nothing to
    // refuse — and refusing would strand them with no way to join one.
    expect(heldByAnotherAgency(snap({ isHost: true, agencyId: '' }), 'b')).toBe(false)
    expect(heldByAnotherAgency(snap({ isHost: true }), 'b')).toBe(false)
  })

  test('whitespace is not a different agency', () => {
    expect(heldByAnotherAgency(snap({ isHost: true, agencyId: ' a ' }), 'a')).toBe(false)
    expect(heldByAnotherAgency(snap({ isHost: true, agencyId: 'a' }), ' a ')).toBe(false)
  })

  test('isHost must be exactly true', () => {
    // Same reasoning as `restrictionOn`: a truthy string from a bad write must
    // not block somebody who is not actually a host.
    expect(heldByAnotherAgency(snap({ isHost: 'true', agencyId: 'a' }), 'b')).toBe(false)
  })
})

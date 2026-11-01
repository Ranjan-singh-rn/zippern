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

const {
  restrictionOn, heldByAnotherAgency,
  hostRoleRevoked, hostOfSameAgency, activeHostRefusal,
  HOST_REVOKED_REFUSAL, ROLE_REVOKED, NOT_A_HOST,
} = require('../lib/hostEligibility')

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

  test('a SUSPENSION is labelled suspended, in the shape suspend_user writes (C9, B25)', () => {
    /*
     * C9 reverses what this asserted ("a ban outranks a suspension"). Both flags
     * set is exactly what `suspend_user` writes — `isBanned` is the app's one
     * gate and is true for a suspension too — so reading the ban first told
     * every suspended person they were banned. Suspension is checked first, as
     * in the backend's `restriction_of`.
     */
    const real = { accountState: 'suspended', isBanned: true, isSuspended: true }
    expect(restrictionOn(snap(real))).toContain('suspended')
    expect(restrictionOn(snap(real))).not.toContain('banned')
    // A document from before `accountState` existed: both flags, no state.
    expect(restrictionOn(snap({ isBanned: true, isSuspended: true }))).toContain('suspended')
  })

  test('a BAN with a stale isSuspended left behind is still a ban', () => {
    // `ban_user` now clears `isSuspended`, but older histories kept it. The
    // state names the ban, and the state wins.
    const why = restrictionOn(snap({ accountState: 'banned', isBanned: true, isSuspended: true }))
    expect(why).toContain('banned')
    // And the shape `ban_user` writes today.
    expect(restrictionOn(snap({ accountState: 'banned', isBanned: true, isSuspended: false })))
      .toContain('banned')
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

// ── GOV phase: C1 (B04), B09, B41 ────────────────────────────────────────────

/** A Firestore Timestamp, as the Admin SDK hands one over. */
const at = (ms) => ({ toMillis: () => ms })
const T1 = 1_800_000_000_000

describe('hostRoleRevoked — a revocation stands until a later restore (C1, B04)', () => {
  test('never a host, never revoked', () => {
    expect(hostRoleRevoked(snap({}))).toBe(false)
    expect(hostRoleRevoked(snap({ isHost: true, hostActivatedAt: at(T1) }))).toBe(false)
  })

  test('the shape revoke_host writes is revoked', () => {
    // `isHost: false` + `hostRemovedAt` + the `_stamp(actor, "hostRevoked")` fields.
    expect(hostRoleRevoked(snap({
      isHost: false, hostRemovedAt: at(T1), hostRevokedAt: at(T1), hostRevokedBy: 'ops',
      hostActivatedAt: at(T1 - 86_400_000),
    }))).toBe(true)
    // Either stamp alone is enough.
    expect(hostRoleRevoked(snap({ hostRemovedAt: at(T1) }))).toBe(true)
    expect(hostRoleRevoked(snap({ hostRevokedAt: at(T1) }))).toBe(true)
  })

  test('a LATER restore lifts it; restore_host never clears the revocation stamps', () => {
    expect(hostRoleRevoked(snap({
      isHost: true, hostRevokedAt: at(T1), hostRemovedAt: at(T1), hostRestoredAt: at(T1 + 1000),
    }))).toBe(false)
  })

  test('a restore BEFORE a second revocation does not', () => {
    expect(hostRoleRevoked(snap({
      isHost: false, hostRestoredAt: at(T1), hostRevokedAt: at(T1 + 1000), hostRemovedAt: at(T1 + 1000),
    }))).toBe(true)
  })

  test('a later grant or activation counts as the role coming back', () => {
    // The authoritative `isHost: true` from grant_host / activateHost after an
    // old revocation must not be read as revoked.
    expect(hostRoleRevoked(snap({ isHost: true, hostRevokedAt: at(T1), hostGrantedAt: at(T1 + 5) }))).toBe(false)
    expect(hostRoleRevoked(snap({ isHost: true, hostRemovedAt: at(T1), hostActivatedAt: at(T1 + 5) }))).toBe(false)
  })

  test('Dates and ISO strings are read too; an unreadable restore lifts nothing', () => {
    expect(hostRoleRevoked(snap({ hostRevokedAt: new Date(T1), hostRestoredAt: new Date(T1 + 1) }))).toBe(false)
    expect(hostRoleRevoked(snap({ hostRevokedAt: new Date(T1).toISOString() }))).toBe(true)
    expect(hostRoleRevoked(snap({ hostRevokedAt: at(T1), hostRestoredAt: 'not a date' }))).toBe(true)
  })

  test('the refusal is C1\'s sentence, word for word', () => {
    expect(HOST_REVOKED_REFUSAL).toBe('Your Host role was revoked. Request reinstatement instead of applying again.')
    expect(ROLE_REVOKED).toBe('ROLE_REVOKED')
  })
})

describe('hostOfSameAgency — a duplicate invitation is not an activation (B09)', () => {
  test('a host of this agency', () => {
    expect(hostOfSameAgency(snap({ isHost: true, agencyId: 'AG1' }), 'AG1')).toBe(true)
    expect(hostOfSameAgency(snap({ isHost: true, agencyId: ' AG1 ' }), 'AG1')).toBe(true)
  })
  test('not a host, another agency, or no agency recorded', () => {
    expect(hostOfSameAgency(snap({ isHost: false, agencyId: 'AG1' }), 'AG1')).toBe(false)
    expect(hostOfSameAgency(snap({ isHost: true, agencyId: 'AG2' }), 'AG1')).toBe(false)
    expect(hostOfSameAgency(snap({ isHost: true, agencyId: '' }), 'AG1')).toBe(false)
    expect(hostOfSameAgency(snap({ isHost: true, agencyId: '' }), '')).toBe(false)
    expect(hostOfSameAgency(snap({ isHost: 'true', agencyId: 'AG1' }), 'AG1')).toBe(false)
  })
})

describe('activeHostRefusal — only a current, unrestricted Host acts as one (B41)', () => {
  test('a current host may', () => {
    expect(activeHostRefusal(snap({ isHost: true, agencyId: 'AG1' }))).toBe(null)
  })
  test('a revoked host may not, and is told to request reinstatement', () => {
    const r = activeHostRefusal(snap({ isHost: false, hostRevokedAt: at(T1), hostRemovedAt: at(T1) }))
    expect(r.code).toBe(ROLE_REVOKED)
    expect(r.message).toBe(HOST_REVOKED_REFUSAL)
  })
  test('somebody who is not a host may not', () => {
    expect(activeHostRefusal(snap({})).code).toBe(NOT_A_HOST)
    expect(activeHostRefusal(snap({ isHost: 'true' })).code).toBe(NOT_A_HOST)
  })
  test('a restricted host may not — the real suspension shape and a ban', () => {
    for (const fields of [
      { isHost: true, accountState: 'suspended', isBanned: true, isSuspended: true },
      { isHost: true, accountState: 'banned', isBanned: true },
      { isHost: true, isDeleted: true },
    ]) {
      expect(activeHostRefusal(snap(fields)).code).toBe('ACCOUNT_RESTRICTED')
    }
  })
})

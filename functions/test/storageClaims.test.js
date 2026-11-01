/**
 * The escalation this module exists to make impossible.
 *
 * Partner `crmUsers` documents are written by the CLIENT. So the question
 * these tests answer is not "does the mapping work" but "is there any document
 * a browser could write that comes back out of here as an internal role".
 *
 * The first describe block is the security property. Everything after it is
 * the lifecycle: creation, role change, agency transfer, deactivation,
 * reactivation, deletion, and keeping hands off a uid the API owns.
 *
 * Run:  node --test test/storageClaims.test.js
 */

const { test, describe } = require('node:test')
const { expect } = require('./expect')

const {
  decideClaim,
  isApiOwnedRole,
  partnerClaimFrom,
  sameClaim,
} = require('../lib/storageClaims')

/** An active agency document, as the signup form writes it. */
const agency = (over = {}) => ({ role: 'agency', agencyId: 'AG7', isActive: true, ...over })
const seller = (over = {}) => ({ role: 'seller', agencyId: '', isActive: true, ...over })

describe('privilege escalation is structurally impossible', () => {
  // Every internal role, in both vocabularies: the backend `Role` spelling and
  // the `crmUsers` spelling. A browser can put any string in a document it
  // writes, so the test is that NONE of these produces a claim.
  const INTERNAL = [
    'owner', 'superadmin', 'observer',
    'app_admin', 'app_member', 'ops_admin', 'ops_member',
    'finance_admin', 'finance_member', 'tech_admin', 'tech_member',
    'support_admin', 'support_member', 'marketing_admin', 'marketing_member',
    // Legacy spellings that still exist on older documents.
    'admin', 'ops', 'tech', 'finance', 'support',
    // And the machine credential, which must never be a token role.
    'system',
  ]

  for (const role of INTERNAL) {
    test(`a client-written role '${role}' earns no claim`, () => {
      expect(partnerClaimFrom({ role, agencyId: 'AG7', isActive: true })).toBe(null)
    })
  }

  test('and none of them can be reached through decideClaim either', () => {
    for (const role of INTERNAL) {
      const action = decideClaim({ role, agencyId: 'AG7', isActive: true }, {})
      // Either nothing happens, or the claim is cleared. Never `set`.
      expect(action.kind === 'set').toBe(false)
    }
  })

  test('case and whitespace tricks do not smuggle a role through', () => {
    for (const role of ['AGENCY', 'Agency', 'agency ', ' agency', 'agency\n', 'aGeNcY']) {
      const claim = partnerClaimFrom({ role, isActive: true })
      // Trimmed variants are accepted; re-cased ones are not. Either way the
      // only value that can come out is 'agency'.
      if (claim) expect(claim.role).toBe('agency')
    }
    expect(partnerClaimFrom({ role: 'AGENCY', isActive: true })).toBe(null)
  })

  test('prototype keys cannot be used as a role', () => {
    for (const role of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(partnerClaimFrom({ role, isActive: true })).toBe(null)
    }
  })

  test('non-string roles earn nothing', () => {
    for (const role of [null, undefined, 0, 1, true, {}, [], ['agency']]) {
      expect(partnerClaimFrom({ role, isActive: true })).toBe(null)
    }
  })

  test('only two role strings exist that produce a claim at all', () => {
    const produced = []
    for (const role of [...INTERNAL, 'agency', 'seller', '', 'host', 'user', 'guest']) {
      const c = partnerClaimFrom({ role, isActive: true })
      if (c) produced.push(c.role)
    }
    expect(produced).toEqual(['agency', 'seller'])
  })
})

describe('the partner claim itself', () => {
  test('an agency carries its agencyId', () => {
    expect(partnerClaimFrom(agency())).toEqual({ role: 'agency', aid: 'AG7' })
  })

  test('a seller carries an empty aid rather than undefined', () => {
    expect(partnerClaimFrom(seller())).toEqual({ role: 'seller', aid: '' })
  })

  test('a missing agencyId is empty, never undefined', () => {
    const c = partnerClaimFrom({ role: 'agency', isActive: true })
    expect(c.aid).toBe('')
  })

  test('a sub-agency carries its OWN id, because that is what the document holds', () => {
    // The parent writes the child's crmUsers document with the child's own
    // agency id — see createSubAgencyAccount. Nothing here merges the two.
    expect(partnerClaimFrom(agency({ agencyId: 'SUB-9' })).aid).toBe('SUB-9')
  })

  test('a PENDING agency still gets its claim', () => {
    // It has to: an agency sits at status 'pending' from signup until approval,
    // and uploading its KYC is what the approval is waiting for. Gating on
    // approval would deadlock onboarding.
    expect(partnerClaimFrom(agency({ status: 'pending' }))).toEqual({ role: 'agency', aid: 'AG7' })
  })
})

describe('the lifecycle', () => {
  test('creation: a new agency is granted', () => {
    expect(decideClaim(agency(), {})).toEqual({ kind: 'set', claim: { role: 'agency', aid: 'AG7' } })
  })

  test('no-op: an unchanged document does not rewrite the claim', () => {
    const action = decideClaim(agency(), { role: 'agency', aid: 'AG7' })
    expect(action.kind).toBe('none')
  })

  test('agency transfer: aid is replaced', () => {
    expect(decideClaim(agency({ agencyId: 'AG9' }), { role: 'agency', aid: 'AG7' }))
      .toEqual({ kind: 'set', claim: { role: 'agency', aid: 'AG9' } })
  })

  test('role change: agency becomes seller', () => {
    expect(decideClaim(seller(), { role: 'agency', aid: 'AG7' }))
      .toEqual({ kind: 'set', claim: { role: 'seller', aid: '' } })
  })

  test('deactivation: isActive false clears the claim', () => {
    expect(decideClaim(agency({ isActive: false }), { role: 'agency', aid: 'AG7' }))
      .toEqual({ kind: 'clear' })
  })

  test('reactivation: the claim comes back', () => {
    expect(decideClaim(agency({ isActive: true }), {}))
      .toEqual({ kind: 'set', claim: { role: 'agency', aid: 'AG7' } })
  })

  test('deletion: a removed document clears the claim', () => {
    expect(decideClaim(null, { role: 'agency', aid: 'AG7' })).toEqual({ kind: 'clear' })
  })

  test('deletion with no claim is a no-op, not a pointless write', () => {
    expect(decideClaim(null, {}).kind).toBe('none')
  })

  test('absent isActive reads as active — documents predate the field', () => {
    expect(decideClaim({ role: 'agency', agencyId: 'AG7' }, {}).kind).toBe('set')
  })
})

describe('the API owns staff uids, and this trigger keeps off them', () => {
  const staffClaim = { role: 'finance_admin' }

  test('a crmUsers edit does not clear a staff claim', () => {
    // The case that would have hurt: a member of staff edits their phone
    // number on /profile, the trigger fires, sees role 'superadmin' is not a
    // partner role, and — without this guard — clears their Storage access.
    expect(decideClaim({ role: 'superadmin', isActive: true }, staffClaim).kind).toBe('none')
  })

  test('an owner claim is left alone', () => {
    expect(decideClaim({ role: 'superadmin', isActive: true }, { role: 'owner' }).kind).toBe('none')
  })

  test('an observer claim is left alone even with no crmUsers document', () => {
    // An observer deliberately has NO crmUsers document (crm_directory
    // NOT_MIRRORED), so this trigger sees a deletion it must not act on.
    expect(decideClaim(null, { role: 'observer' }).kind).toBe('none')
  })

  test('a staff deactivation is the API’s job, not this trigger’s', () => {
    expect(decideClaim({ role: 'ops_admin', isActive: false }, { role: 'ops_admin' }).kind)
      .toBe('none')
  })

  test('isApiOwnedRole is true for internal roles and false for partners', () => {
    expect(isApiOwnedRole('owner')).toBe(true)
    expect(isApiOwnedRole('observer')).toBe(true)
    expect(isApiOwnedRole('finance_member')).toBe(true)
    expect(isApiOwnedRole('agency')).toBe(false)
    expect(isApiOwnedRole('seller')).toBe(false)
    expect(isApiOwnedRole('')).toBe(false)
  })

  test('an empty existing claim is not "API owned" — that would freeze new partners out', () => {
    expect(decideClaim(agency(), {}).kind).toBe('set')
    expect(decideClaim(agency(), null).kind).toBe('set')
  })
})

describe('sameClaim', () => {
  test('null equals null', () => { expect(sameClaim(null, null)).toBe(true) })
  test('null never equals a claim', () => {
    expect(sameClaim(null, { role: 'agency', aid: '' })).toBe(false)
    expect(sameClaim({ role: 'agency', aid: '' }, null)).toBe(false)
  })
  test('aid is part of the identity', () => {
    expect(sameClaim({ role: 'agency', aid: 'A' }, { role: 'agency', aid: 'B' })).toBe(false)
  })
})

// ── Revoking ONE capability of a dual-role login ─────────────────────────────
//
// Since revocation, `crmUsers.isActive` stays true while ANY capability is
// live — revoking the Agency from an Agency + Coin Seller human must leave the
// seller working. So the agency claim has to be withdrawn by the per-
// capability `roleStatus`, not by `isActive`. These are the cases.
describe('a revoked capability loses its claim; the other one keeps working', () => {
  test('Agency + Seller, agency revoked → seller claim, no agency scope', () => {
    const doc = agency({ roles: ['agency', 'seller'], roleStatus: { agency: 'revoked', seller: 'approved' } })
    expect(partnerClaimFrom(doc)).toEqual({ role: 'seller', aid: '' })
  })
  test('Agency + Seller, seller revoked → agency claim unchanged', () => {
    const doc = agency({ roles: ['agency', 'seller'], roleStatus: { agency: 'approved', seller: 'revoked' } })
    expect(partnerClaimFrom(doc)).toEqual({ role: 'agency', aid: 'AG7' })
  })
  test('Agency only, revoked → no partner claim at all', () => {
    expect(partnerClaimFrom(agency({ roleStatus: { agency: 'revoked' } }))).toBeNull()
  })
  test('Seller only, revoked → no partner claim', () => {
    expect(partnerClaimFrom(seller({ roleStatus: { seller: 'revoked' } }))).toBeNull()
  })
  test('both revoked → no partner claim', () => {
    expect(partnerClaimFrom(agency({ roles: ['agency', 'seller'],
      roleStatus: { agency: 'revoked', seller: 'rejected' } }))).toBeNull()
  })
  test('a suspended agency loses the claim too; a pending one keeps it (KYC upload)', () => {
    expect(partnerClaimFrom(agency({ roleStatus: { agency: 'suspended' } }))).toBeNull()
    expect(partnerClaimFrom(agency({ roleStatus: { agency: 'pending' } }))).toEqual({ role: 'agency', aid: 'AG7' })
  })
  test('decideClaim clears the agency claim after revocation', () => {
    const doc = agency({ roleStatus: { agency: 'revoked' } })
    expect(decideClaim(doc, { role: 'agency', aid: 'AG7' }).kind).toBe('clear')
  })
  test('decideClaim swaps agency → seller for Agency + Seller', () => {
    const doc = agency({ roles: ['agency', 'seller'], roleStatus: { agency: 'revoked', seller: 'approved' } })
    expect(decideClaim(doc, { role: 'agency', aid: 'AG7' }))
      .toEqual({ kind: 'set', claim: { role: 'seller', aid: '' } })
  })
  test('documents with no roleStatus behave exactly as before', () => {
    expect(partnerClaimFrom(agency())).toEqual({ role: 'agency', aid: 'AG7' })
    expect(partnerClaimFrom(seller())).toEqual({ role: 'seller', aid: '' })
    expect(partnerClaimFrom(agency({ isActive: false }))).toBeNull()
  })
})

describe('Phase 1A — revoked/unknown per-role status keeps no Storage claim', () => {
  const { partnerClaimFrom: claimOf } = require('../lib/storageClaims')
  test('a revoked agency role yields no agency claim even with legacy role=agency', () => {
    const c = claimOf({ role: 'agency', agencyId: 'AG1', isActive: true, roleStatus: { agency: 'revoked' } })
    expect(c).toBe(null)
  })
  test('an unknown status (e.g. "disabled") is treated as withdrawn', () => {
    const c = claimOf({ role: 'agency', agencyId: 'AG1', isActive: true, roleStatus: { agency: 'disabled' } })
    expect(c).toBe(null)
  })
  test('an approved agency still gets its scoped claim', () => {
    const c = claimOf({ role: 'agency', agencyId: 'AG1', isActive: true, roleStatus: { agency: 'approved' } })
    expect(c && c.role).toBe('agency')
    expect(c && c.aid).toBe('AG1')
  })
  test('revoking agency on a dual login falls back to the live seller capability only', () => {
    const c = claimOf({ role: 'agency', roles: ['agency', 'seller'], agencyId: 'AG1', isActive: true,
      roleStatus: { agency: 'revoked', seller: 'approved' } })
    expect(c && c.role).toBe('seller')
  })
})

/**
 * One authoritative role source, and the twelve roles it stopped losing.
 *
 * `syncMyRoles` used to match a `verifiedIdentities` join against a six-value
 * list — `['superadmin','admin','ops','tech','finance','support']`. That list
 * predated the split of each department into admin and member tiers, so nine of
 * the twelve real department roles matched NOTHING. `ops_admin` opened the app
 * as an ordinary user with no badge, while `resolveIdentity` — reading the same
 * person's `crmUsers/{uid}` document — reported `ops_admin` on the same call.
 *
 * The table below is therefore the point of these tests: every role the CRM can
 * store, asserted to produce something. A role that maps to nothing here is a
 * real person whose authority is invisible in the app.
 *
 * Run:  node --test test/crmRoles.test.js
 */

const { test, describe } = require('node:test')
const { expect } = require('./expect')

const {
  deriveRoleFlags,
  normaliseCrmRole,
  DEPARTMENT_ROLES,
  PARTNER_ROLES,
  OWNER_ROLE,
} = require('../lib/crmRoles')

/** A present, active document — the ordinary case. */
const live = (role, roles) => deriveRoleFlags(role, roles, true, true)

describe('the owner', () => {
  test('superadmin is the owner, and is official', () => {
    const f = live(OWNER_ROLE)
    expect(f.crmRole).toBe('superadmin')
    expect(f.isOfficial).toBe(true)
    expect(f.isAgent).toBe(false)
    expect(f.isSeller).toBe(false)
  })

  test("there is no 'owner' role string — it would be meaningless, not an owner", () => {
    const f = live('owner')
    // Deliberate: `crm_directory.CRM_ROLE` maps Role.OWNER to 'superadmin', so
    // 'owner' is not a value `crmUsers` ever holds. It must not be quietly
    // treated as one either, or two spellings of owner would both half-work.
    expect(f.isOfficial).toBe(false)
  })
})

describe('all twelve department roles', () => {
  // The regression that mattered. Nine of these produced nothing before.
  for (const role of DEPARTMENT_ROLES) {
    test(`${role} is carried through and is official`, () => {
      const f = live(role)
      expect(f.crmRole).toBe(role)
      expect(f.isOfficial).toBe(true)
      expect(f.isAgent).toBe(false)
      expect(f.isSeller).toBe(false)
      expect(f.held).toEqual([role])
    })
  }

  test('there are exactly twelve of them', () => {
    expect(DEPARTMENT_ROLES.size).toBe(12)
  })

  test('every one covers six departments in two tiers', () => {
    const teams = new Set()
    for (const role of DEPARTMENT_ROLES) teams.add(role.split('_')[0])
    expect([...teams].sort()).toEqual(
      ['app', 'finance', 'marketing', 'ops', 'support', 'tech'],
    )
  })
})

describe('partners are external, never staff', () => {
  test('an agency gets isAgent and NO crmRole', () => {
    const f = live('agency')
    // crmRole stays empty on purpose: the app renders crmRole as a staff badge,
    // so putting 'agency' there would label an external partner as a member of
    // the team — the opposite of what the record says.
    expect(f.crmRole).toBe('')
    expect(f.isAgent).toBe(true)
    expect(f.isOfficial).toBe(false)
  })

  test('a coin seller gets isSeller and NO crmRole', () => {
    const f = live('seller')
    expect(f.crmRole).toBe('')
    expect(f.isSeller).toBe(true)
    expect(f.isOfficial).toBe(false)
  })

  test('one login holding BOTH capabilities keeps both', () => {
    // `roles` exists for exactly this: an agency that also sells coins. Reading
    // only `role` would silently withdraw whichever was not the first.
    const f = live('agency', ['agency', 'seller'])
    expect(f.isAgent).toBe(true)
    expect(f.isSeller).toBe(true)
    expect(f.isOfficial).toBe(false)
  })

  test('there are exactly two partner roles', () => {
    expect(PARTNER_ROLES.size).toBe(2)
  })
})

describe('the observer never reaches the app', () => {
  test('observer yields nothing at all', () => {
    const f = live('observer')
    expect(f.crmRole).toBe('')
    expect(f.isOfficial).toBe(false)
    expect(f.isAgent).toBe(false)
    expect(f.isSeller).toBe(false)
    expect(f.held).toEqual([])
  })
})

describe('absent, inactive and malformed', () => {
  test('no document means no role — which is how a role gets revoked', () => {
    // The old version was additive and never removed anything, because its
    // source could not be trusted to mean "no role": a query that returned
    // nothing might mean demoted, or might mean the phone number changed.
    // Reading by uid removes the ambiguity, so absence is now an answer.
    const f = deriveRoleFlags('superadmin', undefined, true, false)
    expect(f.crmRole).toBe('')
    expect(f.isOfficial).toBe(false)
  })

  test('isActive false means no role', () => {
    const f = deriveRoleFlags('ops_admin', undefined, false, true)
    expect(f.crmRole).toBe('')
    expect(f.isOfficial).toBe(false)
  })

  test('an empty role string yields nothing', () => {
    expect(live('').crmRole).toBe('')
    expect(live('').isOfficial).toBe(false)
  })

  test('null and undefined do not throw', () => {
    expect(live(null).crmRole).toBe('')
    expect(live(undefined).crmRole).toBe('')
  })

  test('whitespace is trimmed, not treated as a distinct role', () => {
    expect(live('  ops_admin  ').crmRole).toBe('ops_admin')
  })

  test('an empty roles ARRAY falls back to the single role', () => {
    // Firestore can hold `roles: []`. Trusting it verbatim would strip the
    // capability the account was created with.
    const f = live('agency', [])
    expect(f.isAgent).toBe(true)
  })

  test('a non-array roles value is ignored, not crashed on', () => {
    const f = live('seller', 'seller')
    expect(f.isSeller).toBe(true)
  })

  test('an unknown role is carried but is NOT official', () => {
    // Forward compatibility without privilege: a thirteenth department added in
    // the CRM shows its name rather than nothing, but does not acquire the
    // official badge until this file is told about it.
    const f = live('legal_admin')
    expect(f.crmRole).toBe('legal_admin')
    expect(f.isOfficial).toBe(false)
  })
})

describe('legacy role strings still resolve', () => {
  // Normalised on CRM sign-in — but somebody who only ever opens the app would
  // never be normalised at all, so the mapping has to exist on this side too.
  const cases = [
    ['admin', 'app_admin'],
    ['ops', 'ops_member'],
    ['tech', 'tech_member'],
    ['finance', 'finance_member'],
    ['support', 'support_member'],
  ]
  for (const [old, now] of cases) {
    test(`${old} → ${now}`, () => {
      expect(normaliseCrmRole(old)).toBe(now)
      const f = live(old)
      expect(f.crmRole).toBe(now)
      expect(f.isOfficial).toBe(true)
    })
  }

  test('a current role is left exactly as it is', () => {
    expect(normaliseCrmRole('marketing_member')).toBe('marketing_member')
  })
})

describe('no role is ever flattened to admin or team', () => {
  test('nothing maps to a bare "admin" or "team"', () => {
    // The vocabulary is the CRM's. Two generic tiers would erase the department
    // structure every permission check depends on.
    for (const role of [...DEPARTMENT_ROLES, OWNER_ROLE, ...PARTNER_ROLES]) {
      const out = live(role).crmRole
      expect(out === 'admin').toBe(false)
      expect(out === 'team').toBe(false)
    }
  })
})

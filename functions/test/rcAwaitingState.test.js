/**
 * Decision 15 (RC) — an Owner-approved role WAITING for both verified contacts
 * (`awaiting_verification`) holds nothing anywhere the Functions derive
 * authority from:
 *
 *   * `deriveRoleFlags` — no `isAgent` / `isSeller` tile in the app;
 *   * `partnerClaimFrom` — no Storage claim (no partner uploads);
 *   * `hostBlockedBy`   — but it still COUNTS as a held agency role for the
 *     role table: an approved-but-waiting agency may not become a Host.
 *
 * Pure functions from the compiled lib; no Firestore, no network.
 *
 * Run:  node --test test/rcAwaitingState.test.js
 */

const { test, describe } = require('node:test')
const { expect } = require('./expect')
const { deriveRoleFlags, hostBlockedBy } = require('../lib/crmRoles')
const { partnerClaimFrom } = require('../lib/storageClaims')

describe('awaiting_verification grants nothing', () => {
  test('no app tile for a waiting agency or seller', () => {
    const a = deriveRoleFlags('agency', ['agency'], true, true, { agency: 'awaiting_verification' }, 'awaiting_verification')
    expect([a.isAgent, a.isSeller]).toEqual([false, false])
    const s = deriveRoleFlags('seller', ['seller'], true, true, { seller: 'awaiting_verification' }, 'awaiting_verification')
    expect([s.isAgent, s.isSeller]).toEqual([false, false])
    // A legacy-shaped login whose only status says waiting.
    const legacy = deriveRoleFlags('agency', [], true, true, undefined, 'awaiting_verification')
    expect(legacy.isAgent).toBe(false)
  })

  test('a dual login keeps its STARTED role and gains nothing from the waiting one', () => {
    const d = deriveRoleFlags('agency', ['agency', 'seller'], true, true,
      { agency: 'approved', seller: 'awaiting_verification' }, 'approved')
    expect([d.isAgent, d.isSeller]).toEqual([true, false])
  })

  test('no Storage claim while waiting; the claim returns once started', () => {
    expect(partnerClaimFrom({ role: 'agency', agencyId: 'AG1', isActive: true,
      roleStatus: { agency: 'awaiting_verification' } })).toBe(null)
    expect(partnerClaimFrom({ role: 'seller', isActive: true,
      roleStatus: { seller: 'awaiting_verification' } })).toBe(null)
    expect(partnerClaimFrom({ role: 'agency', agencyId: 'AG1', isActive: true,
      roleStatus: { agency: 'approved' } })).toEqual({ role: 'agency', aid: 'AG1' })
  })

  test('a waiting agency still counts for the role table (no Agency + Host)', () => {
    expect(hostBlockedBy({ role: 'agency', roleStatus: { agency: 'awaiting_verification' } }))
      .toBe('An Agency or Sub-agency cannot also be a Host.')
  })
})

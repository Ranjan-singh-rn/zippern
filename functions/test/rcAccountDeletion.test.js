/**
 * RC (confirmed) — self-deletion and permanent deletion of a partner.
 *
 *   * "Block self-deletion while partner responsibilities remain unresolved."
 *     A current Host, money on hold for the Owner's review, earnings released
 *     and not withdrawn, or a withdrawal still being paid — each refuses
 *     `requestAccountDeletion` and `purgeMyAccountNow` (machine-readable
 *     `PARTNER_RESPONSIBILITIES`), and holds the account in the nightly sweep.
 *   * "Permanent deletion must clear active role flags, mark roster
 *     memberships inactive, and remove active profiles and dashboards while
 *     preserving required audit and financial records."
 *
 * The shipped callables and trigger over the fake Firestore; Auth and Storage
 * are recording stubs.
 *
 * Run:  node --test test/rcAccountDeletion.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const admin = require('firebase-admin')
const { installFakeFirestore, Timestamp } = require('./fakeFirestore')

const db = installFakeFirestore()
const auth = { users: new Set(), deleted: [] }
Object.defineProperty(admin, 'auth', {
  configurable: true, writable: true,
  value: () => ({
    getUser: async (uid) => {
      if (!auth.users.has(uid)) throw Object.assign(new Error('no user'), { code: 'auth/user-not-found' })
      return { uid, providerData: [] }
    },
    deleteUser: async (uid) => { auth.users.delete(uid); auth.deleted.push(uid) },
    revokeRefreshTokens: async () => undefined,
    createCustomToken: async (uid) => `t-${uid}`,
  }),
})
Object.defineProperty(admin, 'storage', {
  configurable: true, writable: true,
  value: () => ({ bucket: () => ({ deleteFiles: async () => undefined }) }),
})

const ACC = require('../lib/accounts')
const PROFILES = require('../lib/profiles')

const nowSec = () => Math.floor(Date.now() / 1000)
const DAY_MS = 24 * 60 * 60 * 1000
async function refusal(p) { try { await p } catch (e) { return e } return null }

function pending(uid, extra = {}) {
  const requestedAt = nowSec() - 3600
  db.seed(`users/${uid}`, {
    name: 'Asha', accountState: 'recovery_pending', isDeleted: true,
    deletionRequestedAt: Timestamp.fromMillis(requestedAt * 1000),
    deletionDueAt: Timestamp.fromMillis(Date.now() + 59 * DAY_MS),
    credentialsValidAfter: requestedAt + 1, phoneKey: '919800000000', email: 'asha@example.com',
    ...extra,
  })
  auth.users.add(uid)
}
const purgeNow = (uid) => ACC.purgeMyAccountNow.run({ auth: { uid, token: { auth_time: nowSec() - 60 } }, data: {} })

beforeEach(() => { db._docs.clear(); auth.users.clear(); auth.deleted = [] })

describe('deletionBlockersOf — pure', () => {
  test('a current Host, held money, unpaid earnings and an open withdrawal each block', () => {
    expect(ACC.deletionBlockersOf({ isHost: true })).toEqual(['host_role'])
    expect(ACC.deletionBlockersOf({ payoutHold: true })).toEqual(['money_frozen'])
    expect(ACC.deletionBlockersOf({ beansAvailable: 5 })).toEqual(['unpaid_earnings'])
    expect(ACC.deletionBlockersOf({}, 1)).toEqual(['open_withdrawal'])
  })
  test('an ordinary account is not blocked', () => {
    expect(ACC.deletionBlockersOf({ beans: 0, beansAvailable: 0, isHost: false })).toEqual([])
  })
})

describe('self-deletion is refused while partner responsibilities are unsettled', () => {
  test('purge now: a held account is refused and nothing is deleted', async () => {
    pending('U1', { payoutHold: true })
    const e = await refusal(purgeNow('U1'))
    expect(e && e.details && e.details.code).toBe('PARTNER_RESPONSIBILITIES')
    expect(e && e.details && e.details.blockers).toEqual(['money_frozen'])
    expect(db.read('users/U1').accountState).toBe('recovery_pending')
    expect(auth.deleted).toEqual([])
  })
  test('purge now: an open withdrawal is refused', async () => {
    pending('U2', {})
    db.seed('withdrawalRequests/W1', { hostUid: 'U2', status: 'pending', beans: 100 })
    const e = await refusal(purgeNow('U2'))
    expect(e && e.details && e.details.blockers).toEqual(['open_withdrawal'])
  })
  test('the nightly sweep HOLDS such an account instead of purging it', async () => {
    pending('U3', { isHost: true, agencyId: 'AG1', deletionDueAt: Timestamp.fromMillis(Date.now() - 1000) })
    await ACC.purgeDeletedAccounts.run({})
    const u = db.read('users/U3')
    expect(u.accountState).toBe('recovery_pending')
    expect(u.deletionHeld && u.deletionHeld.reason).toBe('partner_responsibilities')
    expect(u.deletionHeld && u.deletionHeld.blockers).toEqual(['host_role'])
    expect(auth.deleted).toEqual([])
  })
})

describe('a permanent deletion clears active role state and keeps the records', () => {
  test('role flags off, partner login closed, public seller listing removed, history kept', async () => {
    pending('U4', { isHost: false, isVerifiedHost: true, isSeller: true, isAgent: true, agencyId: 'AG1',
      crmRole: 'agency' })
    db.seed('crmUsers/U4', { uid: 'U4', role: 'agency', status: 'rejected', roleStatus: { agency: 'rejected' }, isActive: true })
    db.seed('sellers/S4', { ownerUid: 'U4', status: 'revoked' })
    db.seed('publicSellers/S4', { displayName: 'Coins' })
    db.seed('users/U4/beanTransactions/T1', { type: 'release', amount: 10 })
    const r = await purgeNow('U4')
    expect(r.purged).toBe(true)
    const u = db.read('users/U4')
    expect([u.isHost, u.isVerifiedHost, u.isSeller, u.isAgent, u.crmRole]).toEqual([false, false, false, false, ''])
    expect(u.agencyId).toBe('AG1')                    // history kept
    expect(db.read('crmUsers/U4').isActive).toBe(false)
    expect(db.read('publicSellers/S4')).toBe(undefined)
    expect(db.read('sellers/S4').status).toBe('revoked')   // the business record is kept
  })

  test('the public profile is not re-created from the purged document', async () => {
    db.seed('publicProfiles/U5', { name: 'Old' })
    const before = { name: 'Asha', accountState: 'recovery_pending', isDeleted: true }
    const after = { name: '', accountState: 'permanently_deactivated', isDeleted: true }
    const change = {
      before: { exists: true, data: () => before },
      after: { exists: true, data: () => after },
    }
    await PROFILES.syncPublicProfile.run(change, { params: { uid: 'U5' } })
    expect(db.read('publicProfiles/U5')).toBe(undefined)
  })
})

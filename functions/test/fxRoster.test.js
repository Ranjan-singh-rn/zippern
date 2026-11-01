/**
 * FX-10 (RF-15 / DUP-08) — the agency roster follows the Host role.
 *
 *   * a roster row says whether it is CURRENT (`active: false`, with when and
 *     why, once the role ends) — `roster.ts`;
 *   * the account purge marks the purged account's row inactive in the same
 *     write as the user document (it used to leave it, so the weekly payout
 *     report and the agency screens went on counting a purged account);
 *   * an activation (or the re-entry repair) writes a CURRENT row;
 *   * the weekly payout report skips an inactive row and does not count it;
 *   * the public profile shows "verified Host" only while the account IS a
 *     Host — `revoke_host` leaves `isVerifiedHost` behind.
 *
 * REAL: lib/roster, lib/profiles (`project`), lib/accounts (purge) over the
 * shared fake Firestore; the payout report is checked at the source (it calls
 * the commission API, which is not run here).
 *
 * ZIPPER_FUNCTIONS_LIB=<dir> loads another compiled `lib` (the pre-fix build).
 *
 * Run:  node --test test/fxRoster.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const { expect } = require('./expect')
const admin = require('firebase-admin')
const { installFakeFirestore, Timestamp } = require('./fakeFirestore')

const db = installFakeFirestore()

// Auth and Storage: recording stubs, as in accountLifecycle.test.js.
const auth = { users: new Set(), deleted: [] }
Object.defineProperty(admin, 'auth', {
  configurable: true,
  writable: true,
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
  configurable: true,
  writable: true,
  value: () => ({ bucket: () => ({ deleteFiles: async () => undefined }) }),
})

const LIB = process.env.ZIPPER_FUNCTIONS_LIB || path.join(__dirname, '..', 'lib')
const load = (name) => {
  try { return require(path.join(LIB, name)) } catch { return {} }
}
const roster = load('roster')
const { project } = load('profiles')
const ACC = load('accounts')

const nowSec = () => Math.floor(Date.now() / 1000)
const DAY_MS = 24 * 60 * 60 * 1000

function seedPendingDeletion(uid, extra = {}) {
  const requestedAt = nowSec() - 3600
  db.seed(`users/${uid}`, {
    name: 'Asha',
    accountState: 'recovery_pending',
    isDeleted: true,
    deletionRequestedAt: Timestamp.fromMillis(requestedAt * 1000),
    deletionDueAt: Timestamp.fromMillis(Date.now() + 59 * DAY_MS),
    credentialsValidAfter: requestedAt + 1,
    phoneKey: '919800000000',
    email: 'asha@example.com',
    ...extra,
  })
  auth.users.add(uid)
}
const purgeNow = (uid) =>
  ACC.purgeMyAccountNow.run({ auth: { uid, token: { auth_time: nowSec() - 60 } }, data: {} })

beforeEach(() => {
  db._docs.clear()
  auth.users.clear()
  auth.deleted = []
})

describe('roster.ts — is a row current?', () => {
  test('a row with no `active` field (written before the marker) is current', () => {
    expect(roster.rosterRowIsCurrent({ uid: 'H' })).toBe(true)
    expect(roster.rosterRowIsCurrent(undefined)).toBe(true)
  })
  test('`active: false` is not current; `active: true` is', () => {
    expect(roster.rosterRowIsCurrent({ active: false })).toBe(false)
    expect(roster.rosterRowIsCurrent({ active: true })).toBe(true)
  })
  test('the removal fields say when and why', () => {
    expect(roster.rosterRemovalFields('purged', 'T')).toEqual({ active: false, removedAt: 'T', removedReason: 'purged' })
  })
})

describe('the account purge marks the roster row inactive', () => {
  // RC (confirmed): "block self-deletion while partner responsibilities remain
  // unresolved" — a CURRENT Host cannot purge their own account; the Host
  // role is ended first (which marks the roster row itself). The purge still
  // marks a row left current by older data, which is what FX-10 pins.
  test('a CURRENT Host cannot purge their own account (the Host role is ended first)', async () => {
    seedPendingDeletion('UH', { isHost: true, agencyId: 'AG1' })
    db.seed('agencies/AG1/agencyHosts/UH', { uid: 'UH', name: 'Asha', agencyId: 'AG1' })
    let err = null
    try { await purgeNow('UH') } catch (e) { err = e }
    expect(err && err.code).toBe('failed-precondition')
    expect(err && err.details && err.details.code).toBe('PARTNER_RESPONSIBILITIES')
    expect(db.read('users/UH').accountState).toBe('recovery_pending')
    expect(db.read('agencies/AG1/agencyHosts/UH').active).toBe(undefined)
  })

  test('a purged former Host stops counting on the agency roster, in the same write', async () => {
    seedPendingDeletion('U', { isHost: false, agencyId: 'AG1' })
    db.seed('agencies/AG1/agencyHosts/U', { uid: 'U', name: 'Asha', agencyId: 'AG1' })
    db.seed('agencies/AG1/agencyHosts/OTHER', { uid: 'OTHER', name: 'Other', agencyId: 'AG1' })
    const r = await purgeNow('U')
    expect(r.purged).toBe(true)
    const row = db.read('agencies/AG1/agencyHosts/U')
    expect(row.active).toBe(false)
    expect(row.removedReason).toBe('purged')
    expect(row.removedAt != null).toBe(true)
    expect(db.read('agencies/AG1/agencyHosts/OTHER').active).toBe(undefined)
    expect(db.read('users/U').accountState).toBe('permanently_deactivated')
  })

  test('an account with no agency (or no row) purges exactly as before, inventing no row', async () => {
    seedPendingDeletion('V')
    const r = await purgeNow('V')
    expect(r.purged).toBe(true)
    expect(db.count('agencies')).toBe(0)
  })

  test('a row already marked revoked keeps its revocation (a purge does not overwrite why)', async () => {
    seedPendingDeletion('W', { isHost: false, agencyId: 'AG1' })
    db.seed('agencies/AG1/agencyHosts/W', { uid: 'W', agencyId: 'AG1', active: false, removedReason: 'revoked' })
    await purgeNow('W')
    expect(db.read('agencies/AG1/agencyHosts/W').removedReason).toBe('revoked')
  })
})

describe('the public profile', () => {
  test('a revoked Host is not shown as a verified Host', () => {
    const p = project('U', { isHost: false, isVerifiedHost: true }, false)
    expect(p.isHost).toBe(false)
    expect(p.isVerifiedHost).toBe(false)
  })
  test('a current verified Host still is', () => {
    expect(project('U', { isHost: true, isVerifiedHost: true }, false).isVerifiedHost).toBe(true)
  })
  test('a current, unverified Host is not', () => {
    expect(project('U', { isHost: true, isVerifiedHost: false }, false).isVerifiedHost).toBe(false)
  })
})

describe('the writers and the payout report, at the source', () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')

  test('an activation writes a CURRENT row (and clears a removal)', () => {
    const hosts = src('hosts.ts')
    const fn = hosts.slice(hosts.indexOf('function writeAgencyMembership('), hosts.indexOf('export const activateHost'))
    expect(fn.includes('[ROSTER_ACTIVE]: true')).toBe(true)
    expect(fn.includes('[ROSTER_REMOVED_AT]: admin.firestore.FieldValue.delete()')).toBe(true)
    expect(fn.includes('[ROSTER_REMOVED_REASON]: admin.firestore.FieldValue.delete()')).toBe(true)
  })

  test('the weekly payout report skips an inactive row BEFORE reading its earnings, and does not count it', () => {
    const index = src('index.ts')
    const loop = index.slice(index.indexOf("collection('agencyHosts').get()"))
    const skip = loop.indexOf('if (!rosterRowIsCurrent(host)) continue')
    const earnings = loop.indexOf("collection('beanTransactions')")
    expect(skip > 0).toBe(true)
    expect(skip < earnings).toBe(true)
    expect(index.includes('hostCount: hostsSnap.docs.filter((d) => rosterRowIsCurrent(d.data())).length,')).toBe(true)
  })
})

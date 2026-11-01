/**
 * SESSION-001/002/003 (Phase 1A).
 *
 *   * `credentialsValidAfter` is monotonic: an older token cannot lower it by
 *     calling `startMobileSession` and re-admit itself.
 *   * Every protected callable refuses a suspended / banned / deleting account,
 *     whether or not a session id was presented.
 *   * A displaced session id is refused when presented (staged rollout:
 *     a MISSING id is still tolerated until ENFORCE_MOBILE_SESSION=true).
 *   * A deletion request moves the cut-off past now and revokes refresh tokens,
 *     so the restricted account cannot keep operating on a live token.
 *
 * Run:  node --test test/sessionPhase1a.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const admin = require('firebase-admin')

const { installFakeFirestore } = require('./fakeFirestore')
const db = installFakeFirestore()

let revoked = []
Object.defineProperty(admin, 'auth', {
  configurable: true, writable: true,
  value: () => ({
    revokeRefreshTokens: async (uid) => { revoked.push(uid) },
    getUser: async (uid) => ({ uid, providerData: [] }),
    createCustomToken: async (uid) => `t-${uid}`,
  }),
})

const MS = require('../lib/mobileSession')
const ID = require('../lib/identity')
const ACC = require('../lib/accounts')

async function refusal(p) { try { await p } catch (e) { return e } return null }

describe('nextValidAfter — monotonic cut-off', () => {
  test('a newer sign-in moves it forward', () => {
    expect(MS.nextValidAfter(1000, 1500, 2000)).toEqual({ ok: true, value: 1500 })
  })
  test('an OLDER token cannot lower it — it is refused', () => {
    expect(MS.nextValidAfter(1500, 1000, 2000)).toEqual({ ok: false })
  })
  test('equal auth_time (the device that set it) is accepted and unchanged', () => {
    expect(MS.nextValidAfter(1500, 1500, 2000)).toEqual({ ok: true, value: 1500 })
  })
  test('no prior value: the caller\'s auth_time', () => {
    expect(MS.nextValidAfter(undefined, 1500, 2000)).toEqual({ ok: true, value: 1500 })
  })
})

describe('restrictionVerdict', () => {
  const v = (doc) => MS.restrictionVerdict((f) => doc[f])
  test('active account', () => expect(v({})).toBe(''))
  // C9 (B25) reverses what this asserted (`'banned'`): suspension is checked
  // before ban, so the shape `suspend_user` writes is labelled suspended.
  test('suspended', () => expect(v({ isSuspended: true, isBanned: true })).toBe('suspended'))
  test('suspended — the real document shape a suspension writes', () =>
    expect(v({ accountState: 'suspended', isBanned: true, isSuspended: true })).toBe('suspended'))
  test('banned — the shape a ban writes, and one that left a stale isSuspended', () => {
    expect(v({ accountState: 'banned', isBanned: true, isSuspended: false })).toBe('banned')
    expect(v({ accountState: 'banned', isBanned: true, isSuspended: true })).toBe('banned')
    expect(v({ isBanned: true })).toBe('banned')
  })
  test('suspended by state only', () => expect(v({ accountState: 'suspended' })).toBe('suspended'))
  test('deletion requested', () => expect(v({ isDeleted: true, accountState: 'recovery_pending' })).toBe('deletion_requested'))
})

describe('assertActiveSession — protected operations', () => {
  beforeEach(() => { db._docs.clear(); delete process.env.ENFORCE_MOBILE_SESSION })

  test('a suspended account is refused even with no session id presented', async () => {
    db.seed('users/U', { isSuspended: true, isBanned: true })
    const e = await refusal(MS.assertActiveSession('U', {}, 'settleGift'))
    expect(e && e.code).toBe('permission-denied')
  })
  test('an account with a pending deletion is refused', async () => {
    db.seed('users/U', { isDeleted: true, accountState: 'recovery_pending' })
    const e = await refusal(MS.assertActiveSession('U', { sessionId: 'S1' }, 'convertBeans'))
    expect(e && e.code).toBe('permission-denied')
  })
  test('a displaced session id is refused', async () => {
    db.seed('users/U', { activeMobileSession: { sessionId: 'NEW' } })
    const e = await refusal(MS.assertActiveSession('U', { sessionId: 'OLD' }, 'startCall'))
    expect(e && e.code).toBe('permission-denied')
  })
  test('the current session passes', async () => {
    db.seed('users/U', { activeMobileSession: { sessionId: 'NEW' } })
    await MS.assertActiveSession('U', { sessionId: 'NEW' }, 'startCall')
  })
  test('staged rollout: a MISSING id is tolerated until enforcement is switched on', async () => {
    db.seed('users/U', { activeMobileSession: { sessionId: 'NEW' } })
    await MS.assertActiveSession('U', {}, 'startCall')
    process.env.ENFORCE_MOBILE_SESSION = 'true'
    const e = await refusal(MS.assertActiveSession('U', {}, 'startCall'))
    expect(e && e.code).toBe('permission-denied')
  })
})

describe('startMobileSession — executed', () => {
  beforeEach(() => { db._docs.clear() })
  const start = (uid, authTime, deviceId = 'D') =>
    ID.startMobileSession.run({ deviceId }, { auth: { uid, token: { auth_time: authTime } } })

  test('a newer device takes the session and moves the cut-off forward', async () => {
    db.seed('users/U', { credentialsValidAfter: 1000 })
    const r = await start('U', 2000, 'B')
    expect(typeof r.sessionId).toBe('string')
    expect(db.read('users/U').credentialsValidAfter).toBe(2000)
  })
  test('a displaced device with an OLDER token cannot take it back or lower the cut-off', async () => {
    db.seed('users/U', { credentialsValidAfter: 2000, activeMobileSession: { sessionId: 'B-SESSION' } })
    const e = await refusal(start('U', 1000, 'A'))
    expect(e && e.code).toBe('permission-denied')
    expect(db.read('users/U').credentialsValidAfter).toBe(2000)
    expect(db.read('users/U').activeMobileSession.sessionId).toBe('B-SESSION')
  })
  test('a suspended account cannot start a session', async () => {
    db.seed('users/U', { isSuspended: true, isBanned: true })
    const e = await refusal(start('U', 3000))
    expect(e && e.code).toBe('permission-denied')
  })
  test('C9 (B25): the refusal labels the real suspension shape `suspended`', async () => {
    db.seed('users/U', { accountState: 'suspended', isSuspended: true, isBanned: true })
    const e = await refusal(start('U', 3000))
    expect(e && e.details && e.details.state).toBe('suspended')
  })
})

describe('C6 (B31) — startMobileSession refuses an unnamed or a barred device', () => {
  beforeEach(() => { db._docs.clear() })
  const start = (data) =>
    ID.startMobileSession.run(data, { auth: { uid: 'U', token: { auth_time: 3000 } } })

  for (const [label, data] of [
    ['no device id at all', {}],
    ['an empty device id', { deviceId: '' }],
    ['a blank device id', { deviceId: '   ' }],
  ]) {
    test(`${label} → failed-precondition DEVICE_BARRED, and no session is written`, async () => {
      db.seed('users/U', { name: 'u', credentialsValidAfter: 1000 })
      const e = await refusal(start(data))
      expect(e && e.code).toBe('failed-precondition')
      expect(e.details && e.details.code).toBe('DEVICE_BARRED')
      const doc = db.read('users/U')
      expect(doc.activeMobileSession).toBe(undefined)
      expect(doc.credentialsValidAfter).toBe(1000)
    })
  }

  test('a barred device → DEVICE_BARRED with the ban\'s reason; nothing recorded', async () => {
    db.seed('users/U', { name: 'u', credentialsValidAfter: 1000 })
    db.seed('bannedDevices/D-BARRED', { isActive: true, reason: 'Device of a banned account.' })
    const e = await refusal(start({ deviceId: 'D-BARRED' }))
    expect(e && e.code).toBe('failed-precondition')
    expect(e.details.code).toBe('DEVICE_BARRED')
    expect(e.message).toBe('Device of a banned account.')
    expect(db.read('users/U').activeMobileSession).toBe(undefined)
    expect(db.has('users/U/devices/D-BARRED')).toBe(false)
  })

  test('the same source resolveIdentity reads: a record with no isActive bars too', async () => {
    db.seed('users/U', { name: 'u' })
    db.seed('bannedDevices/D-LEGACY', { reason: 'Manual ban.' })
    const e = await refusal(start({ deviceId: 'D-LEGACY' }))
    expect(e && e.details.code).toBe('DEVICE_BARRED')
    const r = await ID.resolveIdentity.run({ deviceId: 'D-LEGACY' },
      { auth: { uid: 'U', token: { phone_number: '+919800000001', firebase: { sign_in_provider: 'phone' } } } })
    expect(r.decision).toBe('device_banned')
  })

  test('a lifted device ban (isActive: false) and a clean device both start a session', async () => {
    db.seed('users/U', { name: 'u', credentialsValidAfter: 1000 })
    db.seed('bannedDevices/D-LIFTED', { isActive: false, reason: 'lifted' })
    const r = await start({ deviceId: 'D-LIFTED' })
    expect(typeof r.sessionId).toBe('string')
    expect(db.read('users/U').activeMobileSession.deviceId).toBe('D-LIFTED')
    const clean = await start({ deviceId: 'D-CLEAN' })
    expect(db.read('users/U').activeMobileSession.sessionId).toBe(clean.sessionId)
  })
})

describe('requestAccountDeletion — the account stops operating', () => {
  beforeEach(() => { db._docs.clear(); revoked = [] })
  test('cut-off moves past now, never backwards, and refresh tokens are revoked', async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    db.seed('users/U', { name: 'x', credentialsValidAfter: 100, activeMobileSession: { sessionId: 'S-U' } })
    // A realistic request (B1 / N3): a real ID token always carries the time of
    // its sign-in (`auth_time`), and the app sends its active session id.
    const r = await ACC.requestAccountDeletion.run({
      auth: { uid: 'U', token: { auth_time: nowSec - 30 } },
      data: { sessionId: 'S-U' },
    })
    expect(r.requested).toBe(true)
    const doc = db.read('users/U')
    expect(doc.credentialsValidAfter > nowSec).toBe(true)
    expect(revoked).toEqual(['U'])
    // And the callables refuse it immediately.
    const e = await refusal(MS.assertActiveSession('U', {}, 'settleGift'))
    expect(e && e.code).toBe('permission-denied')
  })
})

describe('mintQuickLoginToken — no way back in for a displaced or restricted session', () => {
  const crypto = require('node:crypto')
  const QL = require('../lib/quickLogin')
  const pub = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
    .publicKey.export({ type: 'spki', format: 'pem' })
  const PHONE = { phone_number: '+919800000001', firebase: { sign_in_provider: 'phone' } }
  const mint = (token, data = {}) =>
    QL.mintQuickLoginToken.run({ deviceId: 'D-A', publicKey: pub, ...data }, { auth: { uid: 'U', token } })
  beforeEach(() => { db._docs.clear() })

  test('a displaced provider session (old auth_time) is refused', async () => {
    db.seed('users/U', { name: 'u', credentialsValidAfter: 2000 })
    const e = await refusal(mint({ ...PHONE, auth_time: 1500 }))
    expect(e && e.code).toBe('permission-denied')
    expect(e.details.code).toBe('SESSION_DISPLACED')
  })
  test('a provider session presenting a replaced session id is refused', async () => {
    db.seed('users/U', { name: 'u', activeMobileSession: { sessionId: 'NEW' } })
    const e = await refusal(mint({ ...PHONE, auth_time: 3000 }, { sessionId: 'OLD' }))
    expect(e && e.details.code).toBe('SESSION_DISPLACED')
  })
  test('a suspended or banned provider account is refused', async () => {
    db.seed('users/U', { name: 'u', isSuspended: true, isBanned: true })
    const e = await refusal(mint({ ...PHONE, auth_time: 3000 }))
    expect(e && e.details.code).toBe('ACCOUNT_RESTRICTED')
  })
  test('the CURRENT provider session can still mint (ordinary sign-out)', async () => {
    db.seed('users/U', { name: 'u', credentialsValidAfter: 2000, activeMobileSession: { sessionId: 'NOW' } })
    const r = await mint({ ...PHONE, auth_time: 2000 }, { sessionId: 'NOW' })
    expect(typeof r.token).toBe('string')
  })
  test('GUEST behaviour is preserved even when displaced (open product decision)', async () => {
    db.seed('users/U', { name: 'g', credentialsValidAfter: 2000, activeMobileSession: { sessionId: 'NEW' } })
    const r = await mint({ firebase: { sign_in_provider: 'anonymous' }, auth_time: 1500 }, { sessionId: 'OLD' })
    expect(typeof r.token).toBe('string')
  })
})

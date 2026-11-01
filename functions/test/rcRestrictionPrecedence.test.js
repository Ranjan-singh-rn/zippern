/**
 * RF-27 — one restriction precedence for every reader.
 *
 * `resolveIdentity` decided banned / suspended from `isBanned` and
 * `isSuspended` alone, while every other reader (the backend's
 * `restriction_of`, `restrictionVerdict` here, quick login, the app's listener)
 * reads `accountState` first. For documents whose fields disagree, the
 * sign-in gate showed the wrong screen — and in one shape barred the handset
 * for a mere suspension. It now uses `restrictionVerdict`.
 *
 * The shipped callable (lib/, as deployed) over the fake Firestore; Auth is a
 * stub. Run:  node --test test/rcRestrictionPrecedence.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const admin = require('firebase-admin')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore()
Object.defineProperty(admin, 'auth', {
  configurable: true, writable: true,
  value: () => ({
    getUser: async (uid) => ({ uid, providerData: [{ providerId: 'phone' }] }),
    createCustomToken: async (uid) => `token-${uid}`,
  }),
})

const ID = require('../lib/identity')
const MS = require('../lib/mobileSession')

const ctx = (uid) => ({ auth: { uid, token: { auth_time: 2000, phone_number: '+919800000700', firebase: { sign_in_provider: 'phone' } } } })
const resolve = (uid, deviceId = 'DEV-1') => ID.resolveIdentity.run({ deviceId }, ctx(uid))
const user = (uid, over) => db.seed(`users/${uid}`, { name: 'U', isProfileComplete: true, phoneNumber: '+919800000700', ...over })
const barred = (deviceId) => {
  const d = db.read(`bannedDevices/${deviceId}`)
  return !!d && d.isActive !== false
}

beforeEach(() => { db._docs.clear() })

describe('the sign-in gate agrees with restrictionVerdict', () => {
  test('C1: accountState suspended with both flags false is SUSPENDED (was: allowed in)', async () => {
    user('C1', { accountState: 'suspended', isSuspended: false, isBanned: false })
    const r = await resolve('C1')
    expect(r.decision).toBe('suspended')
    expect(barred('DEV-1')).toBe(false)
  })
  test('C3: accountState banned with both flags false is BANNED, and the handset is barred (was: allowed in)', async () => {
    user('C3', { accountState: 'banned', isSuspended: false, isBanned: false, banReason: 'Fraud' })
    const r = await resolve('C3')
    expect(r.decision).toBe('banned')
    expect(barred('DEV-1')).toBe(true)
  })
  test('C7: a suspension with a stale isBanned is SUSPENDED and bars NO handset (was: banned + barred)', async () => {
    user('C7', { accountState: 'suspended', isBanned: true, isSuspended: false })
    const r = await resolve('C7')
    expect(r.decision).toBe('suspended')
    expect(barred('DEV-1')).toBe(false)
  })
  test('C8: a ban with a leftover isSuspended is BANNED and bars the handset (was: suspended)', async () => {
    user('C8', { accountState: 'banned', isBanned: true, isSuspended: true })
    const r = await resolve('C8')
    expect(r.decision).toBe('banned')
    expect(barred('DEV-1')).toBe(true)
  })
  test('C5b: recovery_pending without isDeleted offers RECOVERY (was: allowed in)', async () => {
    user('C5b', { accountState: 'recovery_pending' })
    const r = await resolve('C5b')
    expect(r.decision).toBe('deleted_recoverable')
  })
  test('C5b: permanently_deactivated without isDeleted is a PERMANENT deletion', async () => {
    user('C5c', { accountState: 'permanently_deactivated' })
    const r = await resolve('C5c')
    expect(r.decision).toBe('deleted_permanent')
  })
})

describe('the consistent shapes are unchanged', () => {
  test('a plain ban (isBanned, accountState banned) is banned and bars the handset', async () => {
    user('B', { accountState: 'banned', isBanned: true })
    expect((await resolve('B')).decision).toBe('banned')
    expect(barred('DEV-1')).toBe(true)
  })
  test('a plain suspension (suspension writes isBanned too, C9) is suspended, handset clean', async () => {
    user('S', { accountState: 'suspended', isSuspended: true, isBanned: true })
    const r = await resolve('S')
    expect(r.decision).toBe('suspended')
    expect(barred('DEV-1')).toBe(false)
  })
  test('legacy isBanned-only (no accountState) is still banned', async () => {
    user('L', { isBanned: true })
    expect((await resolve('L')).decision).toBe('banned')
  })
  test('an ordinary account is allowed', async () => {
    user('OK', { accountState: 'active' })
    expect((await resolve('OK')).decision).toBe('allow')
  })
  test('deletion by isDeleted keeps working', async () => {
    user('D', { isDeleted: true, accountState: 'recovery_pending' })
    expect((await resolve('D')).decision).toBe('deleted_recoverable')
  })
})

describe('every shape: the gate and restrictionVerdict give the same label', () => {
  const shapes = [
    { accountState: 'suspended' }, { accountState: 'banned' }, { isSuspended: true }, { isBanned: true },
    { accountState: 'suspended', isBanned: true }, { accountState: 'banned', isSuspended: true },
    { accountState: 'active', isBanned: true }, { accountState: 'active', isSuspended: true, isBanned: true },
  ]
  shapes.forEach((shape, i) => {
    test(`shape ${i + 1}: ${JSON.stringify(shape)}`, async () => {
      user(`X${i}`, shape)
      const label = MS.restrictionVerdict((f) => shape[f])
      const r = await resolve(`X${i}`, `DEV-X${i}`)
      expect(r.decision).toBe(label)
    })
  })
})

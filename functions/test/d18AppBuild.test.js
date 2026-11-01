/**
 * D18 — the sign-in gate records which build an account runs, and nothing else.
 *
 * `resolveIdentity` runs on every cold start and every sign-in. With the
 * installed `versionCode` the app now sends, it keeps
 * `appBuildReports/{uid} = { versionCode, seenAt }` so the adoption of a release can
 * be COUNTED before the restrictive rules ship. It must never change the
 * gate's decision, must keep nothing personal, and must stay out of reach of
 * every client (no rule matches `appBuildReports`; the catch-all denies).
 *
 * The shipped callable (lib/, as deployed) over the fake Firestore; Auth is a
 * stub. Run:  node --test test/d18AppBuild.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const fs = require('node:fs')
const path = require('node:path')
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

const ctx = (uid) => ({ auth: { uid, token: { auth_time: 2000, phone_number: '+919800000701', firebase: { sign_in_provider: 'phone' } } } })
const gate = (uid, data) => ID.resolveIdentity.run({ deviceId: 'DEV-1', ...data }, ctx(uid))
const user = (uid, over) => db.seed(`users/${uid}`, { name: 'U', isProfileComplete: true, phoneNumber: '+919800000701', ...over })

beforeEach(() => { db._docs.clear() })

describe('appBuildRecord — what counts as a report', () => {
  test('a positive integer versionCode is kept', () => {
    expect(ID.appBuildRecord(19)).toEqual({ versionCode: 19 })
    expect(ID.appBuildRecord('19')).toEqual({ versionCode: 19 })
  })
  for (const bad of [undefined, null, '', 0, -3, 1.5, 'abc', 1_000_001, NaN, {}, [19]]) {
    test(`${JSON.stringify(bad)} is not a report`, () => {
      expect(ID.appBuildRecord(bad)).toBe(null)
    })
  }
})

describe('the gate records the build, and only the build', () => {
  test('an ordinary account on build 19: recorded, allowed', async () => {
    user('A', { accountState: 'active' })
    const r = await gate('A', { appVersionCode: 19 })
    expect(r.decision).toBe('allow')
    const rec = db.read('appBuildReports/A')
    expect(rec.versionCode).toBe(19)
    expect(Object.keys(rec).sort()).toEqual(['seenAt', 'versionCode'])   // nothing personal
    expect(!!rec.seenAt).toBe(true)
  })

  test('a restricted account is recorded too — it is who the appeal cutoff affects — and still refused', async () => {
    user('S', { accountState: 'suspended', isSuspended: true })
    user('B', { accountState: 'banned', isBanned: true })
    expect((await gate('S', { appVersionCode: 19 })).decision).toBe('suspended')
    expect((await gate('B', { appVersionCode: 14 })).decision).toBe('banned')
    expect(db.read('appBuildReports/S').versionCode).toBe(19)
    expect(db.read('appBuildReports/B').versionCode).toBe(14)
  })

  test('a later launch on a newer build replaces the record', async () => {
    user('U', { accountState: 'active' })
    await gate('U', { appVersionCode: 18 })
    await gate('U', { appVersionCode: 19 })
    expect(db.read('appBuildReports/U').versionCode).toBe(19)
  })

  test('an older build that sends nothing leaves nothing (it is counted as unreported)', async () => {
    user('O', { accountState: 'active' })
    expect((await gate('O', {})).decision).toBe('allow')
    expect(db.has('appBuildReports/O')).toBe(false)
  })

  test('an unusable report leaves nothing and changes nothing', async () => {
    user('X', { accountState: 'active' })
    expect((await gate('X', { appVersionCode: 'nineteen' })).decision).toBe('allow')
    expect(db.has('appBuildReports/X')).toBe(false)
  })

  test('a uid with no account is not recorded', async () => {
    await gate('NOBODY', { appVersionCode: 19 })
    expect(db.has('appBuildReports/NOBODY')).toBe(false)
  })

  test('nothing is written to users/{uid} — no trigger or listener fires for it', async () => {
    user('T', { accountState: 'active' })
    const before = JSON.stringify(Object.keys(db.read('users/T')).sort())
    await gate('T', { appVersionCode: 19 })
    expect(JSON.stringify(Object.keys(db.read('users/T')).sort())).toBe(before)
  })
})

describe('no client can read or write appBuildReports', () => {
  const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'firestore.rules'), 'utf8')
  test('no rule names the collection', () => {
    expect(/match\s+\/appBuildReports/.test(RULES)).toBe(false)
  })
  test('the catch-all denies everything unmatched', () => {
    expect(/match \/\{document=\*\*\} \{\s*allow read, write: if false;\s*\}/.test(RULES)).toBe(true)
  })
})

/**
 * B3 (spec §8) — the Observer has NO Android access, and the server is what
 * makes that true.
 *
 *   * `startMobileSession` refuses a token carrying the observer's address
 *     with `permission-denied` / `OBSERVER_DENIED`, before any document is
 *     written — a client that skips `resolveIdentity` gains nothing.
 *   * `resolveIdentity` still answers `observer_denied` (the first door).
 *   * The same token for anybody else starts a session exactly as before.
 *
 * Run:  node --test test/observerMobileDenial.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const admin = require('firebase-admin')

const { installFakeFirestore } = require('./fakeFirestore')
const db = installFakeFirestore()

Object.defineProperty(admin, 'auth', {
  configurable: true, writable: true,
  value: () => ({
    revokeRefreshTokens: async () => undefined,
    getUser: async (uid) => ({ uid, providerData: [] }),
    createCustomToken: async (uid) => `t-${uid}`,
  }),
})

const ID = require('../lib/identity')

const OBSERVER = (process.env.OBSERVER_EMAIL || '314zipper@gmail.com').toLowerCase()

async function refusal(p) { try { await p } catch (e) { return e } return null }

const start = (uid, token, deviceId = 'D') =>
  ID.startMobileSession.run({ deviceId }, { auth: { uid, token } })

describe('startMobileSession — the observer is refused on the token', () => {
  beforeEach(() => { db._docs.clear() })

  test('the observer address → permission-denied OBSERVER_DENIED, nothing written', async () => {
    const e = await refusal(start('fresh-google-uid', { email: OBSERVER, auth_time: 3000 }))
    expect(e && e.code).toBe('permission-denied')
    expect(e && e.details && e.details.code).toBe(ID.OBSERVER_DENIED)
    expect(e.details.reason).toBe('observer')
    expect(db.read('users/fresh-google-uid')).toBe(undefined)
  })

  test('…whatever the spelling of the address', async () => {
    const e = await refusal(start('u2', { email: `  ${OBSERVER.toUpperCase()} `, auth_time: 3000 }))
    expect(e && e.details && e.details.code).toBe(ID.OBSERVER_DENIED)
  })

  test('the refusal is the same constant the backend and resolveIdentity use', () => {
    expect(ID.OBSERVER_DENIED).toBe('OBSERVER_DENIED')
    expect(ID.isObserverEmail(OBSERVER)).toBe(true)
    expect(ID.isObserverEmail('someone@else.test')).toBe(false)
  })

  test('anybody else with an email still starts a session', async () => {
    db.seed('users/U', { credentialsValidAfter: 1000 })
    const r = await start('U', { email: 'owner@zipper.test', auth_time: 2000 })
    expect(typeof r.sessionId).toBe('string')
    expect(db.read('users/U').credentialsValidAfter).toBe(2000)
  })

  test('a phone sign-in (no email on the token) is unaffected', async () => {
    db.seed('users/P', { credentialsValidAfter: 1000 })
    const r = await start('P', { phone_number: '+919800000001', auth_time: 2500 })
    expect(typeof r.sessionId).toBe('string')
  })
})

describe('resolveIdentity — still the first door', () => {
  beforeEach(() => { db._docs.clear() })

  test('the observer address decides observer_denied before any document exists', async () => {
    const r = await ID.resolveIdentity.run({ deviceId: 'D' }, { auth: { uid: 'g1', token: { email: OBSERVER } } })
    expect(r.decision).toBe('observer_denied')
    expect(db.read('users/g1')).toBe(undefined)
  })
})

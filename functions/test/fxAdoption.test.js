/**
 * FX-08 — Google adoption is retryable: a Google-only login that has NO users
 * document is adopted whatever its age (RF-10 / DUP-04, reproduced as R4).
 *
 * The bug: a first Google sign-in whose adoption check failed (network) fails
 * closed and leaves its new Firebase uid behind with no document. A retry more
 * than 15 minutes later was answered `none / caller_not_fresh`, and the app kept
 * the new uid — a second account beside the one that already holds the same
 * verified email. The freshness window exists so that an account which is
 * somebody's is never discarded; a Google-only login with no users document
 * and nothing on it is nobody's account, whatever its age.
 *
 * Both halves are executed: the pure decision, and the `adoptEmailAccount`
 * callable over the fake Firestore with a scripted Firebase Auth.
 *
 * ZIPPER_FUNCTIONS_LIB=<dir> loads another compiled `lib` (the pre-fix build).
 *
 * Run:  node --test test/fxAdoption.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const path = require('node:path')
const { expect } = require('./expect')
const admin = require('firebase-admin')

const { installFakeFirestore } = require('./fakeFirestore')
const db = installFakeFirestore()

// ── A scripted Firebase Auth ────────────────────────────────────────────────
const AUTH = new Map()
const deleted = []
const linked = []
const minted = []
const authFn = () => ({
  getUser: async (uid) => {
    const r = AUTH.get(uid)
    if (!r) { const e = new Error('There is no user record'); e.code = 'auth/user-not-found'; throw e }
    return r
  },
  deleteUser: async (uid) => { deleted.push(uid); AUTH.delete(uid) },
  updateUser: async (uid, patch) => { linked.push({ uid, patch }) },
  createCustomToken: async (uid) => { minted.push(uid); return `custom-token-for-${uid}` },
  revokeRefreshTokens: async () => undefined,
})
Object.defineProperty(admin, 'auth', { value: authFn, configurable: true, writable: true })

const LIB = process.env.ZIPPER_FUNCTIONS_LIB || path.join(__dirname, '..', 'lib')
const { decideEmailAdoption, ADOPTION_WINDOW_MS } = require(path.join(LIB, 'emailAdoption'))
const index = require(path.join(LIB, 'index'))

const MIN = 60 * 1000
function googleLogin(uid, ageMs) {
  AUTH.set(uid, {
    uid, email: 'x@gmail.com', emailVerified: true, disabled: false,
    metadata: { creationTime: new Date(Date.now() - ageMs).toUTCString() },
    providerData: [{ providerId: 'google.com', uid: `g-${uid}`, displayName: 'X', photoURL: '' }],
  })
}
function holder(uid) {
  AUTH.set(uid, {
    uid, email: 'x@gmail.com', emailVerified: true, disabled: false,
    metadata: { creationTime: new Date(Date.now() - 300 * 24 * 60 * MIN).toUTCString() },
    providerData: [],
  })
}
const ctx = (uid) => ({
  auth: { uid, token: { email: 'x@gmail.com', email_verified: true, firebase: { sign_in_provider: 'google.com' } } },
})

beforeEach(() => {
  AUTH.clear(); deleted.length = 0; linked.length = 0; minted.length = 0
})

describe('the decision', () => {
  const holderRow = { uid: 'E', authEmail: 'x@gmail.com', authEmailVerified: true, disabled: false, accountState: 'active' }
  const input = (over = {}) => ({
    callerUid: 'N', signInProvider: 'google.com', email: 'x@gmail.com', emailVerified: true,
    callerProviders: ['google.com'], callerAgeMs: 16 * MIN, callerHasData: false,
    candidates: [holderRow], ...over,
  })

  test('a Google-only login older than the window with NO document is adopted', () => {
    const d = decideEmailAdoption(input({ callerHasDocument: false }))
    expect(d.action).toBe('adopt')
    expect(d.targetUid).toBe('E')
  })
  test('…but one WITH a document is not (somebody\'s account)', () => {
    expect(decideEmailAdoption(input({ callerHasDocument: true })).reason).toBe('caller_not_fresh')
  })
  test('…and unknown is treated as having one (callers that do not say)', () => {
    expect(decideEmailAdoption(input()).reason).toBe('caller_not_fresh')
  })
  test('a login with another provider is never adopted, document or not', () => {
    expect(decideEmailAdoption(input({ callerHasDocument: false, callerProviders: ['google.com', 'phone'] })).reason)
      .toBe('caller_not_fresh')
  })
  test('no holder → a legitimately new account (none / no_holder)', () => {
    expect(decideEmailAdoption(input({ callerHasDocument: false, candidates: [] })).reason).toBe('no_holder')
  })
  test('the window itself is unchanged', () => {
    expect(ADOPTION_WINDOW_MS).toBe(15 * MIN)
  })
})

describe('adoptEmailAccount, executed', () => {
  async function seedHolder() {
    holder('E')
    await db.collection('users').doc('E').set({ email: 'x@gmail.com', accountState: 'active', isProfileComplete: true })
  }

  test('the 16-minute retry after a fail-closed is ADOPTED into the existing account', async () => {
    await seedHolder()
    googleLogin('N', 16 * MIN)          // left behind by the failed first attempt; no users doc
    const r = await index.adoptEmailAccount.run({}, ctx('N'))
    expect(r.status).toBe('adopted')
    expect(r.uid).toBe('E')
    expect(deleted.includes('N')).toBe(true)
    expect((await db.collection('users').doc('N').get()).exists).toBe(false)
    expect(minted.includes('E')).toBe(true)
  })

  test('a fresh login is adopted exactly as before', async () => {
    await seedHolder()
    googleLogin('N2', 2 * MIN)
    const r = await index.adoptEmailAccount.run({}, ctx('N2'))
    expect(r.status).toBe('adopted')
  })

  test('an OLD Google login that HAS a users document is never discarded', async () => {
    await seedHolder()
    googleLogin('OLD', 90 * MIN)
    await db.collection('users').doc('OLD').set({ email: '', isProfileComplete: false })
    const r = await index.adoptEmailAccount.run({}, ctx('OLD'))
    expect(r.status).toBe('none')
    expect(r.reason).toBe('caller_not_fresh')
    expect(deleted.length).toBe(0)
  })

  test('no other account holds the address → none / no_holder (a real new account)', async () => {
    googleLogin('SOLO', 30 * MIN)
    const r = await index.adoptEmailAccount.run({}, ctx('SOLO'))
    expect(r.status).toBe('none')
    expect(r.reason).toBe('no_holder')
    expect(deleted.length).toBe(0)
  })

  test('two holders → ambiguous, nothing deleted', async () => {
    await seedHolder()
    holder('E2')
    await db.collection('users').doc('E2').set({ email: 'x@gmail.com', accountState: 'active' })
    googleLogin('AMB', 20 * MIN)
    const r = await index.adoptEmailAccount.run({}, ctx('AMB'))
    expect(r.reason).toBe('ambiguous')
    expect(deleted.length).toBe(0)
  })
})

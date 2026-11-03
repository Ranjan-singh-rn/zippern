/**
 * QA #55 (3 Nov 2026) — "A banned person signing in by phone only sees 'The
 * user account has been disabled by an administrator.'"
 *
 * A ban switches the Firebase login off, so Firebase refuses the sign-in before
 * any of our code runs, and with no session nothing of ours could be asked why.
 * `quickLoginRestriction` answers the app — WITHOUT a session — when the device
 * proves it holds the account's quick-login key (a signature over a fresh
 * challenge) AND the account is the one the person just tried (the phone number
 * or e-mail). Executed here: the shipped callable from lib/, real EC P-256
 * signatures, the in-memory Firestore.
 *
 *   * the original failure: a banned account's own phone now gets the ban,
 *     its reason and its appeal state — not a raw Firebase error;
 *   * nothing is weakened: no session, no custom token, no rotation, the
 *     credential kept (it is the appeal's proof), the login still disabled;
 *   * nobody else learns anything: a bad signature, a replayed challenge, the
 *     key of ANOTHER account, or no phone/e-mail at all get a neutral answer.
 *
 * Run:  node --test test/qa55BannedSignIn.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const crypto = require('node:crypto')
const admin = require('firebase-admin')

const { installFakeFirestore, Timestamp } = require('./fakeFirestore')
let db = installFakeFirestore()

const QL = require('../lib/quickLogin')
const P = require('../lib/quickLoginPolicy')

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const keypair = () => crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
const sign = (priv, challenge) =>
  crypto.sign('sha256', Buffer.from(challenge, 'utf8'), { key: priv, dsaEncoding: 'der' }).toString('base64')

// Auth records by uid, and what was asked of Auth.
let records = new Map()
let authCalls = []
function installAuth() {
  Object.defineProperty(admin, 'auth', {
    configurable: true, writable: true,
    value: () => ({
      getUser: async (uid) => {
        authCalls.push(['getUser', uid])
        if (!records.has(uid)) throw new Error('auth/user-not-found')
        return { uid, providerData: [], ...records.get(uid) }
      },
      createCustomToken: async (uid) => { authCalls.push(['createCustomToken', uid]); return `custom-${uid}` },
      updateUser: async (uid, patch) => { authCalls.push(['updateUser', uid, patch]) },
      revokeRefreshTokens: async (uid) => { authCalls.push(['revokeRefreshTokens', uid]) },
    }),
  })
}

const PHONE = '+919990010002'
const SECRET = 's'.repeat(43)

function seed({ uid = 'U2', account = {}, record = { phoneNumber: PHONE, disabled: true } } = {}) {
  const keys = keypair()
  db.seed(`quickLoginTokens/${sha(SECRET)}`, {
    version: P.CREDENTIAL_VERSION, uid, deviceId: 'dev-A', publicKey: keys.publicKey,
    createdAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + 30 * 86400e3),
    lastUsedAt: null, revokedAt: null,
  })
  db.seed(`users/${uid}`, { name: 'QA User Two', ...account })
  records.set(uid, record)
  return keys
}

async function ask(keys, extra = {}, { tamper = false } = {}) {
  const c = await QL.quickLoginChallenge.run({}, {})
  const signature = sign(keys.privateKey, tamper ? c.challenge + 'x' : c.challenge)
  return QL.quickLoginRestriction.run(
    { token: SECRET, challengeId: c.challengeId, signature, deviceId: 'dev-A', ...extra }, {})
}

async function refusal(fn) {
  try { await fn(); throw new Error('expected a refusal') } catch (e) {
    if (!e.code) throw e
    return e
  }
}

const BANNED = { accountState: 'banned', isBanned: true, banReason: 'Repeated harassment in party rooms (report R-1042).' }

beforeEach(() => {
  db = installFakeFirestore()
  records = new Map()
  authCalls = []
  installAuth()
})

describe('QA #55 — the banned person\'s own phone is told why, and how to appeal', () => {
  test('banned: outcome, reason, account and appeal state — not a raw Firebase error', async () => {
    const keys = seed({ account: BANNED })
    const r = await ask(keys, { phone: PHONE })
    expect(r.outcome).toBe('banned')
    expect(r.reason).toBe(BANNED.banReason)
    expect(r.message).toBe(BANNED.banReason)
    expect(r.uid).toBe('U2')
    expect(r.canAppeal).toBe(true)
    expect(r.appeal != null).toBe(true)
  })

  test('the phone number may be spelled differently — digits are compared', async () => {
    const keys = seed({ account: BANNED })
    const r = await ask(keys, { phone: '+91 99900 10002' })
    expect(r.outcome).toBe('banned')
  })

  test('a Google sign-in is matched by its e-mail', async () => {
    const keys = seed({ account: BANNED, record: { email: 'qa.user2@zipper.test', disabled: true } })
    const r = await ask(keys, { email: 'QA.User2@zipper.test' })
    expect(r.outcome).toBe('banned')
  })

  test('suspended: the end of the suspension travels with it', async () => {
    const end = Date.now() + 86400e3
    const keys = seed({ account: { accountState: 'suspended', isSuspended: true, isBanned: true,
      banReason: 'Spam in chat', suspendedUntil: Timestamp.fromMillis(end) } })
    const r = await ask(keys, { phone: PHONE })
    expect(r.outcome).toBe('suspended')
    expect(r.suspendedUntilMs).toBe(end)
  })
})

describe('QA #55 — ban enforcement is not weakened', () => {
  test('no session, no custom token, no rotation, the login is not touched', async () => {
    const keys = seed({ account: BANNED })
    await ask(keys, { phone: PHONE })
    expect(authCalls.some(([k]) => k === 'createCustomToken')).toBe(false)
    expect(authCalls.some(([k]) => k === 'updateUser' || k === 'revokeRefreshTokens')).toBe(false)
    // The credential is KEPT: it is the only proof the appeal can be filed with.
    expect(db.has(`quickLoginTokens/${sha(SECRET)}`)).toBe(true)
    expect(db.count('quickLoginTokens')).toBe(1)
  })

  test('an account that is NOT restricted gets no session either — just "not restricted"', async () => {
    const keys = seed({ account: {}, record: { phoneNumber: PHONE } })
    const r = await ask(keys, { phone: PHONE })
    expect(r).toEqual({ outcome: 'not_restricted' })
    expect(authCalls.some(([k]) => k === 'createCustomToken')).toBe(false)
    expect(db.has(`quickLoginTokens/${sha(SECRET)}`)).toBe(true)
  })
})

describe('QA #55 — nobody else learns anything', () => {
  test('a bad signature is refused neutrally, before the account is read', async () => {
    const keys = seed({ account: BANNED })
    const e = await refusal(() => ask(keys, { phone: PHONE }, { tamper: true }))
    expect(e.code).toBe('permission-denied')
    expect(String(e.message).includes('harassment')).toBe(false)
    expect(authCalls.some(([k]) => k === 'getUser')).toBe(false)
  })

  test('a challenge cannot be replayed', async () => {
    const keys = seed({ account: BANNED })
    const c = await QL.quickLoginChallenge.run({}, {})
    const signature = sign(keys.privateKey, c.challenge)
    const args = { token: SECRET, challengeId: c.challengeId, signature, deviceId: 'dev-A', phone: PHONE }
    expect((await QL.quickLoginRestriction.run(args, {})).outcome).toBe('banned')
    const e = await refusal(() => QL.quickLoginRestriction.run(args, {}))
    expect(e.code).toBe('permission-denied')
  })

  test('the key of ANOTHER account answers "other_account" — no reason, no uid', async () => {
    const keys = seed({ account: BANNED })
    const r = await ask(keys, { phone: '+919990012345' })
    expect(r).toEqual({ outcome: 'other_account' })
  })

  test('without the phone or e-mail that was tried, nothing is said about the account', async () => {
    const keys = seed({ account: BANNED })
    expect(await ask(keys, {})).toEqual({ outcome: 'other_account' })
  })

  test('an unknown or short credential is refused', async () => {
    seed({ account: BANNED })
    const c = await QL.quickLoginChallenge.run({}, {})
    const e1 = await refusal(() => QL.quickLoginRestriction.run({ token: 'short', challengeId: c.challengeId, signature: 'x' }, {}))
    expect(e1.code).toBe('permission-denied')
    const e2 = await refusal(() => QL.quickLoginRestriction.run(
      { token: 'z'.repeat(43), challengeId: c.challengeId, signature: 'x', phone: PHONE }, {}))
    expect(e2.code).toBe('permission-denied')
  })

  test('a barred handset is told it is the handset', async () => {
    const keys = seed({ account: BANNED })
    db.seed('bannedDevices/dev-A', { isActive: true, reason: 'fraud ring' })
    const r = await ask(keys, { phone: PHONE })
    expect(r.outcome).toBe('device_banned')
    expect(r.uid).toBe(undefined)
  })
})

describe('QA #55 — the pure identity match', () => {
  test('phone digits or e-mail, case-insensitive; nothing tried is no match', () => {
    expect(QL.sameSignInIdentity({ phoneNumber: '+919990010002' }, { phone: '+91 99900 10002' })).toBe(true)
    expect(QL.sameSignInIdentity({ email: 'A@B.C' }, { email: 'a@b.c' })).toBe(true)
    expect(QL.sameSignInIdentity({ phoneNumber: '+919990010002' }, { phone: '+919990010003' })).toBe(false)
    expect(QL.sameSignInIdentity({ phoneNumber: '+919990010002' }, {})).toBe(false)
    expect(QL.sameSignInIdentity(null, { phone: '+919990010002' })).toBe(false)
  })
})

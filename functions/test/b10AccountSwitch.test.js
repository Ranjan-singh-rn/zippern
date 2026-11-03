/**
 * B10 (4 Nov 2026) — the account switcher, on the server.
 *
 * Several accounts on one handset share its Keystore key; each has its own quick-login credential. What the
 * switcher needs from the server, executed here with the shipped callables (lib/), real EC P-256 signatures and
 * the in-memory Firestore:
 *
 *   * several accounts per device: minting for one account never retires another's credential, and redeeming one
 *     (a switch) never touches another's;
 *   * at most MAX_ACCOUNTS_PER_DEVICE per device KEY: the least recently used is retired at mint;
 *   * `forgetQuickLogin` — "Remove from this device" for an account that is not signed in: the same proof as a
 *     redemption deletes exactly that credential, and anything unprovable deletes nothing and learns nothing;
 *     no session, no custom token, ever.
 *
 * Run:  node --test test/b10AccountSwitch.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const crypto = require('node:crypto')

const { installFakeFirestore, Timestamp } = require('./fakeFirestore')
let db = installFakeFirestore()

const QL = require('../lib/quickLogin')
const P = require('../lib/quickLoginPolicy')
const RL = require('../lib/rateLimit')
const admin = require('firebase-admin')

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const keypair = () => crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
const sign = (priv, challenge) =>
  crypto.sign('sha256', Buffer.from(challenge, 'utf8'), { key: priv, dsaEncoding: 'der' }).toString('base64')
const ctx = (uid) => ({ auth: { uid, token: {} } })

let customTokens = []
function installAuth() {
  Object.defineProperty(admin, 'auth', {
    configurable: true, writable: true,
    value: () => ({
      createCustomToken: async (uid) => { customTokens.push(uid); return `custom-token-for-${uid}` },
      getUser: async (uid) => ({ uid, providerData: [] }),
    }),
  })
}

async function proof(priv) {
  const c = await QL.quickLoginChallenge.run({}, {})
  return { challengeId: c.challengeId, signature: sign(priv, c.challenge) }
}

async function mint(uid, key, deviceId = 'dev-A') {
  if (!db.has(`users/${uid}`)) db.seed(`users/${uid}`, { name: `User ${uid}`, isProfileComplete: true })
  return QL.mintQuickLoginToken.run({ deviceId, publicKey: key.publicKey }, ctx(uid))
}

const forget = (args) => QL.forgetQuickLogin.run(args, {})
const redeem = (args) => QL.redeemQuickLogin.run(args, {})

beforeEach(() => {
  db = installFakeFirestore()
  customTokens = []
  installAuth()
})

describe('several accounts on one device', () => {
  test('minting for a second account keeps the first one\'s credential', async () => {
    const key = keypair()
    const a = await mint('UA', key)
    const b = await mint('UB', key)
    expect(db.has(`quickLoginTokens/${sha(a.token)}`)).toBe(true)
    expect(db.has(`quickLoginTokens/${sha(b.token)}`)).toBe(true)
    expect(db.count('quickLoginTokens')).toBe(2)
  })

  test('switching (redeeming B) leaves A\'s credential alone, and A still redeems afterwards', async () => {
    const key = keypair()
    const a = await mint('UA', key)
    const b = await mint('UB', key)
    let p = await proof(key.privateKey)
    const toB = await redeem({ token: b.token, ...p, deviceId: 'dev-A' })
    expect(toB.outcome).toBe('allow')
    expect(toB.uid).toBe('UB')
    expect(db.has(`quickLoginTokens/${sha(a.token)}`)).toBe(true)
    p = await proof(key.privateKey)
    const backToA = await redeem({ token: a.token, ...p, deviceId: 'dev-A' })
    expect(backToA.outcome).toBe('allow')
    expect(backToA.uid).toBe('UA')
  })

  test('a SUSPENDED account in the list is refused on its own — the other accounts are untouched', async () => {
    const key = keypair()
    const a = await mint('UA', key)
    const b = await mint('UB', key)
    db.seed('users/UB', {
      name: 'User UB', accountState: 'suspended', isSuspended: true, banReason: 'Spam',
      suspendedUntil: Timestamp.fromMillis(Date.now() + 86400e3),
    })
    const p = await proof(key.privateKey)
    const r = await redeem({ token: b.token, ...p, deviceId: 'dev-A' })
    expect(r.outcome).toBe('suspended')
    expect(r.customToken === undefined || r.customToken === null || r.customToken === '').toBe(true)
    expect(customTokens).toEqual([])
    expect(db.has(`quickLoginTokens/${sha(a.token)}`)).toBe(true)
  })

  test('at most five accounts per device key — the least recently used is retired at mint', async () => {
    const key = keypair()
    const pem = key.publicKey.trim()
    // Five accounts already remembered, the first used longest ago.
    for (let i = 0; i < 5; i += 1) {
      db.seed(`quickLoginTokens/old${i}`, {
        version: P.CREDENTIAL_VERSION, uid: `U${i}`, deviceId: 'dev-A', publicKey: pem,
        createdAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + (10 + i) * 86400e3),
        lastUsedAt: null, revokedAt: null,
      })
    }
    const sixth = await mint('U5', key)
    expect(db.count('quickLoginTokens')).toBe(QL.MAX_ACCOUNTS_PER_DEVICE)
    expect(db.has('quickLoginTokens/old0')).toBe(false)
    for (let i = 1; i < 5; i += 1) expect(db.has(`quickLoginTokens/old${i}`)).toBe(true)
    expect(db.has(`quickLoginTokens/${sha(sixth.token)}`)).toBe(true)
  })

  test('another handset\'s credentials do not count against this one', async () => {
    const mine = keypair()
    const theirs = keypair()
    for (let i = 0; i < 5; i += 1) await mint(`T${i}`, theirs, 'dev-B')
    await mint('M0', mine)
    expect(db.count('quickLoginTokens')).toBe(6)
  })

  test('credentialsBeyondLimit — pure: newest kept, the new one always kept', () => {
    const docs = [
      { id: 'a', expiresAtMs: 1 }, { id: 'b', expiresAtMs: 5 }, { id: 'c', expiresAtMs: 3 },
      { id: 'new', expiresAtMs: 0 },
    ]
    expect(QL.credentialsBeyondLimit(docs, 'new', 3).sort()).toEqual(['a'])
    expect(QL.credentialsBeyondLimit(docs, 'new', 1).sort()).toEqual(['a', 'b', 'c'])
    expect(QL.credentialsBeyondLimit(docs, 'new', 5)).toEqual([])
  })
})

describe('forgetQuickLogin — "Remove from this device"', () => {
  test('with the proof, deletes exactly that credential — and opens no session', async () => {
    const key = keypair()
    const a = await mint('UA', key)
    const b = await mint('UB', key)
    const p = await proof(key.privateKey)
    const r = await forget({ token: a.token, ...p, deviceId: 'dev-A' })
    expect(r).toEqual({ removed: true })
    expect(db.has(`quickLoginTokens/${sha(a.token)}`)).toBe(false)
    expect(db.has(`quickLoginTokens/${sha(b.token)}`)).toBe(true)
    expect(customTokens).toEqual([])
    const ev = db.all('authEvents').find((e) => e.event === 'QUICK_LOGIN_REVOKED' && e.reason === 'removed_from_device')
    expect(!!ev).toBe(true)
    expect(ev.uid).toBe('UA')
    // Never the secret, a signature or a challenge in the record.
    expect(JSON.stringify(ev).includes(a.token)).toBe(false)
  })

  test('the removed credential can no longer sign anybody in', async () => {
    const key = keypair()
    const a = await mint('UA', key)
    await forget({ token: a.token, ...(await proof(key.privateKey)), deviceId: 'dev-A' })
    let refused = null
    try { await redeem({ token: a.token, ...(await proof(key.privateKey)), deviceId: 'dev-A' }) } catch (e) { refused = e }
    expect(refused !== null).toBe(true)
    expect(customTokens).toEqual([])
  })

  test('a signature from ANOTHER key removes nothing', async () => {
    const key = keypair()
    const a = await mint('UA', key)
    const r = await forget({ token: a.token, ...(await proof(keypair().privateKey)), deviceId: 'dev-A' })
    expect(r).toEqual({ removed: false })
    expect(db.has(`quickLoginTokens/${sha(a.token)}`)).toBe(true)
  })

  test('a replayed challenge removes nothing', async () => {
    const key = keypair()
    const a = await mint('UA', key)
    const b = await mint('UB', key)
    const p = await proof(key.privateKey)
    expect((await forget({ token: a.token, ...p, deviceId: 'dev-A' })).removed).toBe(true)
    expect((await forget({ token: b.token, ...p, deviceId: 'dev-A' })).removed).toBe(false)
    expect(db.has(`quickLoginTokens/${sha(b.token)}`)).toBe(true)
  })

  test('an unknown or short secret gets the same neutral answer', async () => {
    const key = keypair()
    await mint('UA', key)
    expect(await forget({ token: 'short', ...(await proof(key.privateKey)), deviceId: 'dev-A' })).toEqual({ removed: false })
    expect(await forget({ token: 'x'.repeat(43), ...(await proof(key.privateKey)), deviceId: 'dev-A' })).toEqual({ removed: false })
    expect(db.count('quickLoginTokens')).toBe(1)
  })

  test('a legacy record (no key) cannot be proved, so it is not removed here', async () => {
    const secret = 'L'.repeat(43)
    db.seed(`quickLoginTokens/${sha(secret)}`, { uid: 'UL', deviceId: 'dev-A' })
    const r = await forget({ token: secret, ...(await proof(keypair().privateKey)), deviceId: 'dev-A' })
    expect(r).toEqual({ removed: false })
  })

  test('it is budgeted like the other unauthenticated callables', () => {
    expect(RL.RATE_LIMIT_POLICIES.forgetQuickLogin.perDevice).toEqual({ limit: 10, windowMs: 600_000 })
    expect(RL.RATE_LIMIT_POLICIES.forgetQuickLogin.perIp).toEqual({ limit: 60, windowMs: 600_000 })
  })
})

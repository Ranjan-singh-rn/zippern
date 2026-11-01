/**
 * QUICK LOGIN IS SINGLE-USE UNDER CONTENTION THAT RETRIES, NOT ONLY IN SEQUENCE.
 *
 * ── THE DEFECT THIS PINS SHUT ────────────────────────────────────────────────
 *
 * The Mac release validation ran `redeemQuickLogin` against the real Firestore
 * emulator: 2 simultaneous redemptions of one credential (each with its own
 * challenge) BOTH returned `allow`; 5 returned 5. The rotation transaction set
 * a variable OUTSIDE its callback (`consumed = true`). Under contention Firestore
 * rolls an attempt back and runs the callback again; the retry found the
 * credential gone and returned without writing — but `consumed` was still true
 * from the rolled-back attempt, so every loser minted a custom token and handed
 * out a replacement secret that was never stored.
 *
 * `quickLoginRuntime.test.js` could not see it: the default fake serialises
 * transactions and never retries. These tests run the SHIPPED handlers (lib/)
 * over the fake in its optimistic mode — every attempt validates what it read
 * at commit and is rolled back and re-run if that changed — and over forced
 * commit failures, so the retry path itself is exercised.
 *
 * The invariant: a credential document is consumed by at most ONE committed
 * transaction, and only that redemption mints a session or hands out the
 * replacement credential.
 *
 * Run:  node --test test/quickLoginContention.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const crypto = require('node:crypto')

const { installFakeFirestore, Timestamp } = require('./fakeFirestore')
let db = installFakeFirestore({ transactions: 'optimistic' })

const QL = require('../lib/quickLogin')
const P = require('../lib/quickLoginPolicy')

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

function keypair() {
  return crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
}
const sign = (priv, challenge) =>
  crypto.sign('sha256', Buffer.from(challenge, 'utf8'), { key: priv, dsaEncoding: 'der' }).toString('base64')

function seedAccount(uid = 'u1') {
  const keys = keypair()
  const secret = crypto.randomBytes(32).toString('base64url')
  db.seed(`quickLoginTokens/${sha(secret)}`, {
    version: P.CREDENTIAL_VERSION, uid, deviceId: 'dev-A', publicKey: keys.publicKey,
    createdAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + 30 * 86400e3),
    lastUsedAt: null, revokedAt: null,
  })
  db.seed(`users/${uid}`, { name: 'Rahul', photoUrl: 'p.jpg', isProfileComplete: true, accountState: 'active' })
  return { uid, secret, keys }
}

async function signed(priv) {
  const c = await QL.quickLoginChallenge.run({}, {})
  return { challengeId: c.challengeId, signature: sign(priv, c.challenge) }
}
const redeem = (args) => QL.redeemQuickLogin.run({ deviceId: 'dev-A', ...args }, {})

/** N redemptions of one secret, each with its own fresh, correctly signed challenge, fired together. */
async function race(n, acct) {
  const challenges = []
  for (let i = 0; i < n; i++) challenges.push(await signed(acct.keys.privateKey))
  return Promise.allSettled(challenges.map((c) => redeem({ token: acct.secret, ...c })))
}
const winners = (rs) => rs.filter((r) => r.status === 'fulfilled' && r.value.outcome === 'allow')
const losers = (rs) => rs.filter((r) => r.status === 'rejected')
const codeOf = (r) => `${r.reason.code}/${r.reason.details && r.reason.details.code}`
const credentialsOf = (uid) => db.all('quickLoginTokens').filter((c) => c.uid === uid)

beforeEach(() => { db = installFakeFirestore({ transactions: 'optimistic' }) })

describe('the optimistic fake really retries (otherwise nothing below means anything)', () => {
  test('two overlapping transactions on one document: both commit, one after a rollback', async () => {
    db.seed('counters/c', { n: 0 })
    const ref = db.collection('counters').doc('c')
    const bump = () => db.runTransaction(async (tx) => {
      const s = await tx.get(ref)
      tx.set(ref, { n: Number(s.get('n')) + 1 })
    })
    await Promise.all([bump(), bump()])
    expect(db.read('counters/c').n).toBe(2)            // no lost update
    expect(db.transactionAborts >= 1).toBe(true)        // and a rollback + re-run happened
  })
})

describe('concurrent redemptions of ONE credential', () => {
  for (const n of [2, 5]) {
    test(`${n} at once → exactly one session, one rotated credential, every loser aborted/concurrent`, async () => {
      const acct = seedAccount()
      const rs = await race(n, acct)
      const won = winners(rs)
      expect(won.length).toBe(1)
      expect(losers(rs).length).toBe(n - 1)
      for (const l of losers(rs)) expect(codeOf(l)).toBe('aborted/concurrent')
      // Exactly one custom token was minted — no second session from a loser.
      expect(db.mintedTokens.length).toBe(1)
      // Exactly one credential remains, and it is the one the winner was given.
      const live = credentialsOf(acct.uid)
      expect(live.length).toBe(1)
      expect(live[0].id).toBe(sha(won[0].value.token))
      expect(db.has(`quickLoginTokens/${sha(acct.secret)}`)).toBe(false)
      // The race really was contended — a rolled-back attempt was re-run.
      expect(db.transactionAborts >= 1).toBe(true)
    })
  }

  test('the losers hand out nothing: no token, no customToken', async () => {
    const acct = seedAccount()
    const rs = await race(3, acct)
    for (const l of losers(rs)) {
      expect(l.reason.token).toBe(undefined)
      expect(l.reason.customToken).toBe(undefined)
    }
  })
})

describe('sequential reuse', () => {
  test('a spent secret is refused; the replacement it was rotated to works, once', async () => {
    const acct = seedAccount()
    const first = await redeem({ token: acct.secret, ...(await signed(acct.keys.privateKey)) })
    expect(first.outcome).toBe('allow')

    let refusal = null
    try { await redeem({ token: acct.secret, ...(await signed(acct.keys.privateKey)) }) } catch (e) { refusal = e }
    expect(refusal && refusal.code).toBe('permission-denied')
    expect(refusal.details && refusal.details.code).toBe('refused')

    const second = await redeem({ token: first.token, ...(await signed(acct.keys.privateKey)) })
    expect(second.outcome).toBe('allow')
    expect(second.token === first.token).toBe(false)
    expect(credentialsOf(acct.uid).length).toBe(1)
    expect(db.mintedTokens.length).toBe(2)
  })
})

describe('failure and retry', () => {
  test('a rotation whose first commit fails is retried and succeeds — one session, one credential', async () => {
    const acct = seedAccount()
    db.failCommitsTouching('quickLoginTokens/', 1)
    const r = await redeem({ token: acct.secret, ...(await signed(acct.keys.privateKey)) })
    expect(r.outcome).toBe('allow')
    expect(db.transactionAborts).toBe(1)
    expect(credentialsOf(acct.uid).map((c) => c.id)).toEqual([sha(r.token)])
    expect(db.mintedTokens.length).toBe(1)
  })

  test('a rotation that never commits refuses as aborted/concurrent and consumes NOTHING', async () => {
    const acct = seedAccount()
    db.failCommitsTouching('quickLoginTokens/', 5)        // every attempt the SDK would make
    let err = null
    try { await redeem({ token: acct.secret, ...(await signed(acct.keys.privateKey)) }) } catch (e) { err = e }
    expect(err && `${err.code}/${err.details && err.details.code}`).toBe('aborted/concurrent')
    expect(db.mintedTokens.length).toBe(0)                // no session
    expect(db.has(`quickLoginTokens/${sha(acct.secret)}`)).toBe(true)   // credential still live
    expect(credentialsOf(acct.uid).length).toBe(1)        // and no orphan replacement

    // …so the device simply tries again, and it works.
    const again = await redeem({ token: acct.secret, ...(await signed(acct.keys.privateKey)) })
    expect(again.outcome).toBe('allow')
    expect(credentialsOf(acct.uid).map((c) => c.id)).toEqual([sha(again.token)])
  })

  test('a race in which the winner\'s first commit also fails still yields exactly one session', async () => {
    const acct = seedAccount()
    db.failCommitsTouching('quickLoginTokens/', 1)
    const rs = await race(2, acct)
    expect(winners(rs).length).toBe(1)
    expect(db.mintedTokens.length).toBe(1)
    expect(credentialsOf(acct.uid).length).toBe(1)
  })
})

describe('the ordinary single redemption is unchanged', () => {
  test('allow, a custom token, a rotated credential bound to the same device key', async () => {
    const acct = seedAccount()
    const r = await redeem({ token: acct.secret, ...(await signed(acct.keys.privateKey)) })
    expect(r.outcome).toBe('allow')
    expect(r.customToken).toBe(`custom-token-for-${acct.uid}`)
    const live = credentialsOf(acct.uid)
    expect(live.length).toBe(1)
    expect(live[0].publicKey).toBe(acct.keys.publicKey)
    expect(live[0].version).toBe(P.CREDENTIAL_VERSION)
  })

  test('an expired credential is still refused (and destroyed), with no session', async () => {
    const acct = seedAccount()
    db.seed(`quickLoginTokens/${sha(acct.secret)}`, {
      ...db.read(`quickLoginTokens/${sha(acct.secret)}`), expiresAt: Timestamp.fromMillis(Date.now() - 1000),
    })
    let err = null
    try { await redeem({ token: acct.secret, ...(await signed(acct.keys.privateKey)) }) } catch (e) { err = e }
    expect(err && err.code).toBe('permission-denied')
    expect(db.mintedTokens.length).toBe(0)
  })

  test('a signature from another key is refused, with no session and nothing consumed', async () => {
    const acct = seedAccount()
    const other = keypair()
    let err = null
    try { await redeem({ token: acct.secret, ...(await signed(other.privateKey)) }) } catch (e) { err = e }
    expect(err && err.code).toBe('permission-denied')
    expect(db.mintedTokens.length).toBe(0)
    expect(db.has(`quickLoginTokens/${sha(acct.secret)}`)).toBe(true)
  })
})

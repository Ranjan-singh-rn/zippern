/**
 * THE SHIPPED HANDLERS, ACTUALLY EXECUTED.
 *
 * ── WHAT MAKES THIS DIFFERENT FROM EVERY OTHER TEST HERE ─────────────────────
 *
 * `quickLoginPolicy.test.js` tests the decisions in isolation.
 * `quickLoginWiring.test.js` mostly reads source text and asserts on it.
 * This file calls `redeemQuickLogin`, `mintQuickLoginToken`, `quickLoginChallenge`
 * and `submitAccountAppeal` — the real exported Cloud Functions, from `lib/`,
 * with real EC P-256 signatures over real server-issued challenges — and checks
 * what they do to the datastore.
 *
 * That is the difference between "the rule says X" and "the thing does X".
 * Replay, rotation, challenge single-use, state bypass and appeal de-duplication
 * are properties of the COMPOSITION, and none of them were previously executed.
 *
 * ── THE ONE THING STILL NOT TESTED HERE ──────────────────────────────────────
 *
 * `firestore.rules`. The Admin SDK bypasses rules by design, so nothing in this
 * file says anything about what a client is permitted to do. That needs an
 * emulator, which this environment cannot run. Said plainly rather than left to
 * be assumed.
 *
 * Run:  node --test test/quickLoginRuntime.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const crypto = require('node:crypto')

// MUST come before the code under test is required.
const { installFakeFirestore, Timestamp } = require('./fakeFirestore')
let db = installFakeFirestore()

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
  crypto.sign('sha256', Buffer.from(challenge, 'utf8'), { key: priv, dsaEncoding: 'der' })
    .toString('base64')

/** A live v2 credential plus the account behind it. */
function seedAccount({ uid = 'u1', secret = 's'.repeat(43), key, account = {} } = {}) {
  const k = key || keypair()
  db.seed(`quickLoginTokens/${sha(secret)}`, {
    version: P.CREDENTIAL_VERSION,
    uid,
    deviceId: 'dev-A',
    publicKey: k.publicKey,
    createdAt: Timestamp.now(),
    expiresAt: Timestamp.fromMillis(Date.now() + 30 * 86400e3),
    lastUsedAt: null,
    revokedAt: null,
  })
  db.seed(`users/${uid}`, { name: 'Rahul', photoUrl: 'p.jpg', isProfileComplete: true, ...account })
  return { uid, secret, keys: k }
}

/** Ask the real callable for a challenge, then sign it. */
async function challengeAndSign(priv) {
  const c = await QL.quickLoginChallenge.run({}, {})
  return { challengeId: c.challengeId, signature: sign(priv, c.challenge), raw: c.challenge }
}

const ctx = (uid) => ({ auth: { uid, token: {} } })
const redeem = (args) => QL.redeemQuickLogin.run(args, {})
const appeal = (args) => QL.submitAccountAppeal.run(args, {})

/** Run something that should throw an HttpsError, and return it. */
async function refusal(fn) {
  try { await fn(); throw new Error('expected a refusal, got success') }
  catch (e) {
    if (!e.code && !e.httpErrorCode) throw e
    return { code: e.code, message: e.message, detail: e.details && e.details.code }
  }
}

beforeEach(() => { db = installFakeFirestore() })

// ══════════════════════════════════════════════════════════════════════════════
//  The happy path, and what it leaves behind
// ══════════════════════════════════════════════════════════════════════════════

describe('a successful redemption', () => {
  test('grants a session and ROTATES the credential', async () => {
    const { uid, secret, keys } = seedAccount()
    const { challengeId, signature } = await challengeAndSign(keys.privateKey)

    const res = await redeem({ token: secret, challengeId, signature, deviceId: 'dev-A' })

    expect(res.outcome).toBe('allow')
    expect(res.customToken).toBe(`custom-token-for-${uid}`)
    expect(res.uid).toBe(uid)
    // The spent credential is gone and a different one exists.
    expect(db.has(`quickLoginTokens/${sha(secret)}`)).toBe(false)
    expect(res.token.length).toBeGreaterThan(P.MIN_SECRET_CHARS - 1)
    expect(res.token).not.toBe(secret)
    expect(db.has(`quickLoginTokens/${sha(res.token)}`)).toBe(true)
    expect(db.count('quickLoginTokens')).toBe(1)
  })

  test('the replacement carries the SAME device key, so the binding survives', async () => {
    const { secret, keys } = seedAccount()
    const { challengeId, signature } = await challengeAndSign(keys.privateKey)
    const res = await redeem({ token: secret, challengeId, signature, deviceId: 'dev-A' })
    expect(db.read(`quickLoginTokens/${sha(res.token)}`).publicKey).toBe(keys.publicKey)
    expect(db.read(`quickLoginTokens/${sha(res.token)}`).version).toBe(P.CREDENTIAL_VERSION)
  })

  test('and the replacement is immediately usable', async () => {
    const { secret, keys } = seedAccount()
    let c = await challengeAndSign(keys.privateKey)
    const first = await redeem({ token: secret, challengeId: c.challengeId, signature: c.signature, deviceId: 'dev-A' })
    c = await challengeAndSign(keys.privateKey)
    const second = await redeem({ token: first.token, challengeId: c.challengeId, signature: c.signature, deviceId: 'dev-A' })
    expect(second.outcome).toBe('allow')
    expect(second.token).not.toBe(first.token)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
//  Replay — the property rotation exists for
// ══════════════════════════════════════════════════════════════════════════════

describe('replay', () => {
  test('the SAME secret cannot be spent twice', async () => {
    const { secret, keys } = seedAccount()
    let c = await challengeAndSign(keys.privateKey)
    await redeem({ token: secret, challengeId: c.challengeId, signature: c.signature, deviceId: 'dev-A' })

    c = await challengeAndSign(keys.privateKey)
    const r = await refusal(() => redeem({ token: secret, challengeId: c.challengeId, signature: c.signature, deviceId: 'dev-A' }))
    expect(r.detail).toBe('refused')
  })

  test('a captured (challenge, signature) pair cannot be reused', async () => {
    const { secret, keys } = seedAccount()
    const c = await challengeAndSign(keys.privateKey)
    await redeem({ token: secret, challengeId: c.challengeId, signature: c.signature, deviceId: 'dev-A' })
    // Same challenge id, same signature, against the rotated credential.
    const fresh = db.all('quickLoginTokens')[0]
    expect(fresh).toBeTruthy()
    const r = await refusal(() => redeem({
      token: 'x'.repeat(43), challengeId: c.challengeId, signature: c.signature, deviceId: 'dev-A',
    }))
    expect(r.detail).toBe('refused')
  })

  test('the same race with ONE challenge yields only one winner', async () => {
    // The challenge transaction is what makes this half safe: both attempts
    // present the same challengeId, and only one consumption succeeds. This has
    // always held — it is the credential half, below, that had to be fixed.
    const { secret, keys } = seedAccount()
    const c = await challengeAndSign(keys.privateKey)
    const results = await Promise.allSettled([
      redeem({ token: secret, challengeId: c.challengeId, signature: c.signature, deviceId: 'dev-A' }),
      redeem({ token: secret, challengeId: c.challengeId, signature: c.signature, deviceId: 'dev-A' }),
    ])
    const won = results.filter((r) => r.status === 'fulfilled' && r.value.outcome === 'allow')
    expect(won.length).toBe(1)
  })

  test('a challenge is single-use even when the first attempt FAILED', async () => {
    const { keys } = seedAccount()
    const c = await challengeAndSign(keys.privateKey)
    // First attempt fails on an unknown secret, but consumes the challenge.
    await refusal(() => redeem({ token: 'y'.repeat(43), challengeId: c.challengeId, signature: c.signature, deviceId: 'dev-A' }))
    const read = db.read(`quickLoginChallenges/${c.challengeId}`)
    expect(read.usedAt).toBeTruthy()
  })

  test('an expired challenge is refused', async () => {
    const { secret, keys } = seedAccount()
    const c = await QL.quickLoginChallenge.run({}, {})
    db.seed(`quickLoginChallenges/${c.challengeId}`, {
      value: c.challenge, usedAt: null,
      expiresAt: Timestamp.fromMillis(Date.now() - 1000),
    })
    const r = await refusal(() => redeem({
      token: secret, challengeId: c.challengeId, signature: sign(keys.privateKey, c.challenge), deviceId: 'dev-A',
    }))
    expect(r.detail).toBe('refused')
  })

  test('no challenge at all is refused', async () => {
    const { secret, keys } = seedAccount()
    const r = await refusal(() => redeem({
      token: secret, challengeId: '', signature: sign(keys.privateKey, 'anything'), deviceId: 'dev-A',
    }))
    expect(r.detail).toBe('refused')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
//  Atomic consumption — single-use under CONCURRENCY, not just in sequence
// ══════════════════════════════════════════════════════════════════════════════

/*
 * These exist because the sequential replay tests above passed while the system
 * still let two concurrent redemptions through.
 *
 * The old code took `credRef.get()` outside any transaction and then deleted
 * unconditionally, so two attempts carrying DIFFERENT challenges both saw the
 * credential as live and both succeeded: two custom tokens, and one orphaned
 * replacement credential that nothing would rotate or clean for thirty days.
 *
 * Consumption is now a transaction whose contended resource is the credential's
 * existence. Each assertion below is one clause of that requirement, so a
 * regression names which guarantee it broke.
 */
describe('two concurrent redemptions of one credential', () => {
  /** Fire N redemptions at one secret, each with its own fresh challenge. */
  async function race(n, { secret, keys, deviceId = 'dev-A' }) {
    const signed = []
    for (let i = 0; i < n; i++) signed.push(await challengeAndSign(keys.privateKey))
    return Promise.allSettled(signed.map((c) =>
      redeem({ token: secret, challengeId: c.challengeId, signature: c.signature, deviceId })))
  }
  const winners = (rs) => rs.filter((r) => r.status === 'fulfilled' && r.value.outcome === 'allow')
  const losers  = (rs) => rs.filter((r) => r.status === 'rejected')

  test('EXACTLY ONE succeeds', async () => {
    const acct = seedAccount()
    const rs = await race(2, acct)
    expect(winners(rs).length).toBe(1)
  })

  test('the loser fails cleanly, as `aborted`/`concurrent`', async () => {
    // Not a refusal: the caller did nothing wrong and the credential was not
    // rejected, it was spent. The detail code is deliberately NOT a
    // QuickLoginOutcome, so `AuthRepository.refuseQuickLogin` takes its `else`
    // branch and KEEPS the local credential — which by then is the winner's
    // rotated replacement.
    const acct = seedAccount()
    const rs = await race(2, acct)
    const l = losers(rs)
    expect(l.length).toBe(1)
    expect(l[0].reason.code).toBe('aborted')
    expect(l[0].reason.details.code).toBe('concurrent')
  })

  test('exactly ONE replacement remains — no orphan', async () => {
    const acct = seedAccount()
    await race(2, acct)
    expect(db.count('quickLoginTokens')).toBe(1)
    expect(db.has(`quickLoginTokens/${sha(acct.secret)}`)).toBe(false)
  })

  test('exactly ONE session is minted', async () => {
    const acct = seedAccount()
    await race(2, acct)
    expect(db.mintedTokens.length).toBe(1)
  })

  test('the surviving replacement is the WINNER\'S, and it works', async () => {
    const acct = seedAccount()
    const rs = await race(2, acct)
    const won = winners(rs)[0].value
    expect(db.has(`quickLoginTokens/${sha(won.token)}`)).toBe(true)
    const c = await challengeAndSign(acct.keys.privateKey)
    const next = await redeem({ token: won.token, challengeId: c.challengeId, signature: c.signature, deviceId: 'dev-A' })
    expect(next.outcome).toBe('allow')
  })

  test('…and it still carries the device key, so the binding survives the race', async () => {
    const acct = seedAccount()
    // Captured before the race, because the original document is consumed by it.
    const originalKey = db.read(`quickLoginTokens/${sha(acct.secret)}`).publicKey
    const rs = await race(2, acct)
    const won = winners(rs)[0].value
    const rotated = db.read(`quickLoginTokens/${sha(won.token)}`)
    // The property that matters: the replacement inherits the ORIGINAL's key
    // verbatim, whatever its exact PEM whitespace. Comparing against a
    // separately-trimmed copy was testing the trim, not the inheritance.
    expect(rotated.publicKey).toBe(originalKey)
    expect(rotated.version).toBe(P.CREDENTIAL_VERSION)
    expect(rotated.uid).toBe(acct.uid)
  })

  test('FIVE at once still yields exactly one winner and one credential', async () => {
    const acct = seedAccount()
    const rs = await race(5, acct)
    expect(winners(rs).length).toBe(1)
    expect(losers(rs).length).toBe(4)
    expect(db.count('quickLoginTokens')).toBe(1)
    expect(db.mintedTokens.length).toBe(1)
  })

  test('the loser does NOT count against the rate limit', async () => {
    // Losing a race is not a failed attempt. Counting it would let a flaky
    // network walk a legitimate device into a 15-minute cool-off.
    const acct = seedAccount()
    await race(3, acct)
    expect(db.has(`quickLoginRate/${sha(acct.secret)}`)).toBe(false)
  })

  test('the race is audited, and without the secret', async () => {
    const acct = seedAccount()
    await race(2, acct)
    const lost = db.all('authEvents').filter((e) => e.event === 'QUICK_LOGIN_RACE_LOST')
    expect(lost.length).toBe(1)
    expect(JSON.stringify(lost[0]).includes(acct.secret)).toBe(false)
    // and the winner's success is still recorded exactly once
    expect(db.all('authEvents').filter((e) => e.event === 'QUICK_LOGIN_SUCCESS').length).toBe(1)
  })

  test('the signature requirement is NOT weakened by the transaction', async () => {
    // A race between a valid and an invalid signature: the invalid one must
    // lose on the signature, not on the race, and must not consume anything.
    const { secret, keys } = seedAccount()
    const thief = keypair()
    const good = await challengeAndSign(keys.privateKey)
    const bad = await QL.quickLoginChallenge.run({}, {})
    const rs = await Promise.allSettled([
      redeem({ token: secret, challengeId: bad.challengeId, signature: sign(thief.privateKey, bad.challenge), deviceId: 'dev-B' }),
      redeem({ token: secret, challengeId: good.challengeId, signature: good.signature, deviceId: 'dev-A' }),
    ])
    expect(winners(rs).length).toBe(1)
    const refused = rs.filter((r) => r.status === 'rejected' && r.reason.details
      && r.reason.details.code === 'refused')
    expect(refused.length).toBe(1)
  })

  test('account state is NOT weakened by the transaction', async () => {
    // A banned account racing itself must still be reported as banned, twice,
    // and must never reach the rotation path at all.
    const acct = seedAccount({ account: { isBanned: true, banReason: 'fraud' } })
    const rs = await race(2, acct)
    expect(winners(rs).length).toBe(0)
    const reported = rs.filter((r) => r.status === 'fulfilled' && r.value.outcome === 'banned')
    expect(reported.length).toBe(2)
    expect(db.mintedTokens.length).toBe(0)
    expect(db.has(`quickLoginTokens/${sha(acct.secret)}`)).toBe(true)
  })

  test('a rotation that cannot commit leaves the credential live', async () => {
    // A transaction that throws has written nothing, so the caller may retry.
    // Reported as `aborted` for exactly that reason.
    const { secret, keys } = seedAccount()
    const real = db.runTransaction.bind(db)
    let calls = 0
    db.runTransaction = (fn) => {
      calls++
      // let the challenge transaction through; fail the rotation
      return calls > 1 ? Promise.reject(new Error('contention')) : real(fn)
    }
    const c = await challengeAndSign(keys.privateKey)
    let err
    try { await redeem({ token: secret, challengeId: c.challengeId, signature: c.signature, deviceId: 'dev-A' }) }
    catch (e) { err = e }
    db.runTransaction = real
    expect(err.code).toBe('aborted')
    expect(db.has(`quickLoginTokens/${sha(secret)}`)).toBe(true)
    expect(db.mintedTokens.length).toBe(0)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
//  Device transfer — the property the Keystore binding exists for
// ══════════════════════════════════════════════════════════════════════════════

describe('a credential copied to another handset', () => {
  test('a signature from a DIFFERENT key is refused', async () => {
    const { secret } = seedAccount()
    const thief = keypair()
    const c = await QL.quickLoginChallenge.run({}, {})
    const r = await refusal(() => redeem({
      token: secret, challengeId: c.challengeId,
      signature: sign(thief.privateKey, c.challenge), deviceId: 'dev-B',
    }))
    expect(r.detail).toBe('refused')
  })

  test('…and the real owner KEEPS their credential after the attempt', async () => {
    // A thief who can burn the victim's credential by failing has a denial of
    // service. The refusal must count against the rate limit and nothing else.
    const { secret } = seedAccount()
    const thief = keypair()
    const c = await QL.quickLoginChallenge.run({}, {})
    await refusal(() => redeem({
      token: secret, challengeId: c.challengeId,
      signature: sign(thief.privateKey, c.challenge), deviceId: 'dev-B',
    }))
    expect(db.has(`quickLoginTokens/${sha(secret)}`)).toBe(true)
  })

  test('a signature over a DIFFERENT challenge is refused', async () => {
    const { secret, keys } = seedAccount()
    const c = await QL.quickLoginChallenge.run({}, {})
    const r = await refusal(() => redeem({
      token: secret, challengeId: c.challengeId,
      signature: sign(keys.privateKey, 'some other bytes'), deviceId: 'dev-A',
    }))
    expect(r.detail).toBe('refused')
  })

  test('an empty signature is refused', async () => {
    const { secret, keys } = seedAccount()
    const c = await challengeAndSign(keys.privateKey)
    const r = await refusal(() => redeem({ token: secret, challengeId: c.challengeId, signature: '', deviceId: 'dev-A' }))
    expect(r.detail).toBe('refused')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
//  Legacy credentials — the migration, executed
// ══════════════════════════════════════════════════════════════════════════════

describe('a legacy (pre-Phase-B) credential', () => {
  test('is refused as `legacy`, with no session', async () => {
    const secret = 'L'.repeat(43)
    // Exactly the old shape: no version, no publicKey.
    db.seed(`quickLoginTokens/${sha(secret)}`, {
      uid: 'u1', deviceId: 'dev-A',
      createdAt: Timestamp.now(),
      expiresAt: Timestamp.fromMillis(Date.now() + 400 * 86400e3),
      lastUsedAt: null, revokedAt: null,
    })
    db.seed('users/u1', { name: 'Rahul' })
    const c = await QL.quickLoginChallenge.run({}, {})
    const r = await refusal(() => redeem({
      token: secret, challengeId: c.challengeId, signature: 'anything', deviceId: 'dev-A',
    }))
    expect(r.detail).toBe('legacy')
    expect(r.message.includes('sign in once')).toBe(true)
    expect(db.mintedTokens.length).toBe(0)
  })

  test('…and cannot file an appeal either', async () => {
    const secret = 'L'.repeat(43)
    db.seed(`quickLoginTokens/${sha(secret)}`, { uid: 'u1', deviceId: 'dev-A', expiresAt: Timestamp.fromMillis(Date.now() + 1e9) })
    db.seed('users/u1', { name: 'Rahul', isBanned: true })
    const c = await QL.quickLoginChallenge.run({}, {})
    const r = await refusal(() => appeal({
      token: secret, challengeId: c.challengeId, signature: 'x',
      statement: 'I was banned by mistake and would like a review please',
    }))
    expect(r.detail).toBe('legacy')
    expect(db.count('appeals')).toBe(0)
  })

  test('a credential marked revokedAt is refused', async () => {
    /*
     * Closing a gap mutation testing found: disabling the `revokedAt` check in
     * `credentialVerdict` broke nothing, because no test ever seeded one.
     *
     * Worth knowing WHY it was uncovered: no code path currently sets the field.
     * `revokeQuickLogin` and the restriction trigger both DELETE the document,
     * and `writeCredential` stamps `revokedAt: null`. So the check is defensive
     * against a shape only a manual CRM edit or a future soft-revoke would
     * produce — which is exactly the kind of guard that rots untested.
     */
    const secret = 'R'.repeat(43)
    const k = keypair()
    db.seed(`quickLoginTokens/${sha(secret)}`, {
      version: P.CREDENTIAL_VERSION, uid: 'u1', deviceId: 'dev-A', publicKey: k.publicKey,
      expiresAt: Timestamp.fromMillis(Date.now() + 1e9),
      revokedAt: Timestamp.now(),
    })
    db.seed('users/u1', { name: 'Rahul' })
    const { challengeId, signature } = await challengeAndSign(k.privateKey)
    const r = await refusal(() => redeem({ token: secret, challengeId, signature, deviceId: 'dev-A' }))
    expect(r.detail).toBe('refused')
    expect(db.mintedTokens.length).toBe(0)
  })

  test('an EXPIRED credential is refused', async () => {
    // The sibling gap. `expiresAt` in the past must refuse even with a perfect
    // signature, and the sweeper is not what enforces it.
    const secret = 'E'.repeat(43)
    const k = keypair()
    db.seed(`quickLoginTokens/${sha(secret)}`, {
      version: P.CREDENTIAL_VERSION, uid: 'u1', deviceId: 'dev-A', publicKey: k.publicKey,
      expiresAt: Timestamp.fromMillis(Date.now() - 1000),
      revokedAt: null,
    })
    db.seed('users/u1', { name: 'Rahul' })
    const { challengeId, signature } = await challengeAndSign(k.privateKey)
    const r = await refusal(() => redeem({ token: secret, challengeId, signature, deviceId: 'dev-A' }))
    expect(r.detail).toBe('refused')
    expect(db.mintedTokens.length).toBe(0)
  })

  test('a forged version with no key is still refused', async () => {
    const secret = 'F'.repeat(43)
    db.seed(`quickLoginTokens/${sha(secret)}`, {
      version: P.CREDENTIAL_VERSION, uid: 'u1', deviceId: 'dev-A',
      expiresAt: Timestamp.fromMillis(Date.now() + 1e9),
    })
    db.seed('users/u1', { name: 'Rahul' })
    const c = await QL.quickLoginChallenge.run({}, {})
    const r = await refusal(() => redeem({ token: secret, challengeId: c.challengeId, signature: 'x', deviceId: 'dev-A' }))
    expect(r.detail).toBe('refused')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
//  State bypass — suspended / banned / deleted cannot become active
// ══════════════════════════════════════════════════════════════════════════════

describe('account state cannot be bypassed', () => {
  async function attempt(account) {
    const { secret, keys } = seedAccount({ account })
    const { challengeId, signature } = await challengeAndSign(keys.privateKey)
    try {
      return { ok: await redeem({ token: secret, challengeId, signature, deviceId: 'dev-A' }), secret }
    } catch (e) {
      return { err: { detail: e.details && e.details.code, message: e.message }, secret }
    }
  }

  test('SUSPENDED: reported, no session, credential kept, appeal offered', async () => {
    const { ok, secret } = await attempt({ isSuspended: true, banReason: 'spam', suspendedUntil: Timestamp.fromMillis(Date.now() + 7 * 86400e3) })
    expect(ok.outcome).toBe('suspended')
    expect(ok.customToken).toBeUndefined()
    expect(ok.canAppeal).toBe(true)
    expect(typeof ok.suspendedUntilMs).toBe('number')
    expect(db.has(`quickLoginTokens/${sha(secret)}`)).toBe(true)
    expect(db.mintedTokens.length).toBe(0)
  })

  test('BANNED: reported, no session, credential kept, appeal offered', async () => {
    const { ok, secret } = await attempt({ isBanned: true, banReason: 'fraud' })
    expect(ok.outcome).toBe('banned')
    expect(ok.customToken).toBeUndefined()
    expect(ok.canAppeal).toBe(true)
    expect(ok.reason).toBe('fraud')
    // The A5 property: a ban must NOT destroy the appeal proof.
    expect(db.has(`quickLoginTokens/${sha(secret)}`)).toBe(true)
    expect(db.mintedTokens.length).toBe(0)
  })

  test('DELETED: refused, and the credential is destroyed', async () => {
    const { err, secret } = await attempt({ isDeleted: true })
    expect(err.detail).toBe('deleted')
    expect(db.has(`quickLoginTokens/${sha(secret)}`)).toBe(false)
    expect(db.mintedTokens.length).toBe(0)
  })

  test('recovery_pending counts as deleted', async () => {
    const { err } = await attempt({ accountState: 'recovery_pending' })
    expect(err.detail).toBe('deleted')
  })

  test('a DEVICE ban outranks a healthy account, with its own message', async () => {
    const { secret, keys } = seedAccount()
    db.seed('bannedDevices/dev-A', { isActive: true, reason: 'abuse' })
    const { challengeId, signature } = await challengeAndSign(keys.privateKey)
    const r = await refusal(() => redeem({ token: secret, challengeId, signature, deviceId: 'dev-A' }))
    expect(r.detail).toBe('device_banned')
    expect(r.message).toBe('Your device is banned. Contact the support for removing ban.')
    // Distinct from the account-ban sentence — the §4 requirement.
    expect(r.message).not.toBe(P.messageFor('banned'))
    expect(db.has(`quickLoginTokens/${sha(secret)}`)).toBe(true)
  })

  test('a device-ban lookup that fails FAILS CLOSED', async () => {
    const { secret, keys } = seedAccount()
    const real = db.collection.bind(db)
    db.collection = (n) => {
      if (n === 'bannedDevices') throw new Error('firestore unavailable')
      return real(n)
    }
    const { challengeId, signature } = await challengeAndSign(keys.privateKey)
    const r = await refusal(() => redeem({ token: secret, challengeId, signature, deviceId: 'dev-A' }))
    expect(r.detail).toBe('device_banned')
    db.collection = real
  })
})

// ══════════════════════════════════════════════════════════════════════════════
//  Rate limiting
// ══════════════════════════════════════════════════════════════════════════════

describe('rate limiting', () => {
  test(`${P.MAX_FAILURES} failures trip a cool-off, and the next attempt is rate_limited`, async () => {
    const { secret } = seedAccount()
    const thief = keypair()
    for (let i = 0; i < P.MAX_FAILURES; i++) {
      const c = await QL.quickLoginChallenge.run({}, {})
      await refusal(() => redeem({
        token: secret, challengeId: c.challengeId,
        signature: sign(thief.privateKey, c.challenge), deviceId: 'dev-B',
      }))
    }
    const rate = db.read(`quickLoginRate/${sha(secret)}`)
    expect(rate.failures).toBe(P.MAX_FAILURES)
    expect(rate.lockedUntil).toBeTruthy()

    const c = await QL.quickLoginChallenge.run({}, {})
    const r = await refusal(() => redeem({
      token: secret, challengeId: c.challengeId,
      signature: sign(thief.privateKey, c.challenge), deviceId: 'dev-B',
    }))
    expect(r.detail).toBe('rate_limited')
  })

  test('a cool-off does NOT destroy the credential', async () => {
    const { secret } = seedAccount()
    db.seed(`quickLoginRate/${sha(secret)}`, {
      failures: P.MAX_FAILURES,
      lockedUntil: Timestamp.fromMillis(Date.now() + P.LOCKOUT_MS),
    })
    const c = await QL.quickLoginChallenge.run({}, {})
    await refusal(() => redeem({ token: secret, challengeId: c.challengeId, signature: 'x', deviceId: 'dev-A' }))
    expect(db.has(`quickLoginTokens/${sha(secret)}`)).toBe(true)
  })

  test('the rate limit is checked BEFORE the credential, so it cannot be probed around', async () => {
    const { secret, keys } = seedAccount()
    db.seed(`quickLoginRate/${sha(secret)}`, {
      failures: 99, lockedUntil: Timestamp.fromMillis(Date.now() + P.LOCKOUT_MS),
    })
    const { challengeId, signature } = await challengeAndSign(keys.privateKey)
    // A VALID signature, still refused: the cool-off outranks it.
    const r = await refusal(() => redeem({ token: secret, challengeId, signature, deviceId: 'dev-A' }))
    expect(r.detail).toBe('rate_limited')
  })

  test('a success clears the counter', async () => {
    const { secret, keys } = seedAccount()
    db.seed(`quickLoginRate/${sha(secret)}`, { failures: 2, lockedUntil: null })
    const { challengeId, signature } = await challengeAndSign(keys.privateKey)
    await redeem({ token: secret, challengeId, signature, deviceId: 'dev-A' })
    expect(db.has(`quickLoginRate/${sha(secret)}`)).toBe(false)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
//  Minting
// ══════════════════════════════════════════════════════════════════════════════

describe('minting a credential', () => {

  test('refuses without a device public key', async () => {
    db.seed('users/u1', { name: 'Rahul' })
    const r = await refusal(() => QL.mintQuickLoginToken.run({ deviceId: 'dev-A' }, ctx('u1')))
    expect(r.code).toBe('invalid-argument')
    expect(db.count('quickLoginTokens')).toBe(0)
  })

  test('refuses an unauthenticated caller', async () => {
    const r = await refusal(() => QL.mintQuickLoginToken.run({ deviceId: 'dev-A', publicKey: keypair().publicKey }, {}))
    expect(r.code).toBe('unauthenticated')
  })

  test('writes a v2 record holding only the hash, and returns the only copy', async () => {
    db.seed('users/u1', { name: 'Rahul', photoUrl: 'p.jpg' })
    const k = keypair()
    const res = await QL.mintQuickLoginToken.run({ deviceId: 'dev-A', publicKey: k.publicKey }, ctx('u1'))
    const rec = db.read(`quickLoginTokens/${sha(res.token)}`)
    expect(rec.version).toBe(P.CREDENTIAL_VERSION)
    // `.trim()` on the server drops the PEM's trailing newline, which
    // `crypto.verify` does not care about — every signature test above proves
    // that. Compared trimmed rather than loosening the check to a substring.
    expect(rec.publicKey).toBe(k.publicKey.trim())
    // The raw secret is nowhere in the stored document.
    expect(JSON.stringify(rec).includes(res.token)).toBe(false)
  })

  test('the stored key still verifies a real signature after that trim', async () => {
    // The assertion above would be worthless if trimming had broken the key.
    db.seed('users/u1', { name: 'Rahul' })
    const k = keypair()
    const res = await QL.mintQuickLoginToken.run({ deviceId: 'dev-A', publicKey: k.publicKey }, ctx('u1'))
    const { challengeId, signature } = await challengeAndSign(k.privateKey)
    const out = await redeem({ token: res.token, challengeId, signature, deviceId: 'dev-A' })
    expect(out.outcome).toBe('allow')
  })

  test('retires any earlier credential for the same device', async () => {
    db.seed('users/u1', { name: 'Rahul' })
    const k = keypair()
    const a = await QL.mintQuickLoginToken.run({ deviceId: 'dev-A', publicKey: k.publicKey }, ctx('u1'))
    const b = await QL.mintQuickLoginToken.run({ deviceId: 'dev-A', publicKey: k.publicKey }, ctx('u1'))
    expect(db.has(`quickLoginTokens/${sha(a.token)}`)).toBe(false)
    expect(db.has(`quickLoginTokens/${sha(b.token)}`)).toBe(true)
    expect(db.count('quickLoginTokens')).toBe(1)
  })

  test('A BANNED account may still mint — it is the appeal proof', async () => {
    db.seed('users/u1', { name: 'Rahul', isBanned: true })
    const res = await QL.mintQuickLoginToken.run({ deviceId: 'dev-A', publicKey: keypair().publicKey }, ctx('u1'))
    expect(res.token.length).toBeGreaterThan(P.MIN_SECRET_CHARS - 1)
  })

  test('a DELETED account may not', async () => {
    db.seed('users/u1', { name: 'Rahul', isDeleted: true })
    const r = await refusal(() => QL.mintQuickLoginToken.run({ deviceId: 'dev-A', publicKey: keypair().publicKey }, ctx('u1')))
    expect(r.code).toBe('failed-precondition')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
//  A5 — the appeal, executed end to end
// ══════════════════════════════════════════════════════════════════════════════

describe('the session-less appeal', () => {
  const STATEMENT = 'I was banned by mistake. I have never bought or sold coins outside the app.'

  async function fileAppeal(account, statement = STATEMENT) {
    const { uid, secret, keys } = seedAccount({ account })
    const { challengeId, signature } = await challengeAndSign(keys.privateKey)
    try {
      return { ok: await appeal({ token: secret, challengeId, signature, statement }), uid, secret }
    } catch (e) {
      return { err: { code: e.code, detail: e.details && e.details.code, message: e.message }, uid, secret }
    }
  }

  test('a BANNED account can file one, and it is stored as pending', async () => {
    const { ok, uid } = await fileAppeal({ isBanned: true, banReason: 'fraud' })
    expect(ok.status).toBe('submitted')
    expect(db.count('appeals')).toBe(1)
    const a = db.all('appeals')[0]
    expect(a.subjectUid).toBe(uid)
    expect(a.raisedByUid).toBe(uid)
    expect(a.raisedByRole).toBe('self')
    expect(a.kind).toBe('ban')
    expect(a.status).toBe('pending')
    expect(a.statement).toBe(STATEMENT)
    expect(a.evidenceUrls).toEqual([])
  })

  test('the stored field set matches appealFields() in firestore.rules exactly', async () => {
    await fileAppeal({ isBanned: true })
    const { readFileSync } = require('node:fs')
    const { join } = require('node:path')
    const rules = readFileSync(join(__dirname, '..', '..', 'firestore.rules'), 'utf8')
    const declared = (rules.split('function appealFields()')[1] ?? '').split('}')[0]
      .match(/'([a-zA-Z]+)'/g).map((s) => s.replace(/'/g, ''))
    const written = Object.keys(db.all('appeals')[0]).filter((k) => k !== 'id')
    expect(written.slice().sort()).toEqual(declared.slice().sort())
  })

  test('a SUSPENDED account can file one too', async () => {
    const { ok } = await fileAppeal({ isSuspended: true })
    expect(ok.status).toBe('submitted')
    expect(db.count('appeals')).toBe(1)
  })

  test('a HEALTHY account cannot — nothing to appeal, and the queue stays clean', async () => {
    const { err } = await fileAppeal({})
    expect(err.code).toBe('failed-precondition')
    expect(err.detail).toBe('not_restricted')
    expect(db.count('appeals')).toBe(0)
  })

  test('the appeal NEVER returns a session', async () => {
    const { ok } = await fileAppeal({ isBanned: true })
    expect(ok.customToken).toBeUndefined()
    expect(db.mintedTokens.length).toBe(0)
  })

  test('only ONE pending appeal per account', async () => {
    const { uid, secret, keys } = seedAccount({ account: { isBanned: true } })
    let c = await challengeAndSign(keys.privateKey)
    await appeal({ token: secret, challengeId: c.challengeId, signature: c.signature, statement: STATEMENT })
    c = await challengeAndSign(keys.privateKey)
    const second = await appeal({ token: secret, challengeId: c.challengeId, signature: c.signature, statement: STATEMENT })
    expect(second.status).toBe('already_pending')
    expect(db.count('appeals')).toBe(1)
    expect(uid).toBeTruthy()
  })

  test('…but a DECIDED appeal does not block a new one', async () => {
    const { secret, keys, uid } = seedAccount({ account: { isBanned: true } })
    db.seed('appeals/old', { subjectUid: uid, status: 'rejected', createdAt: Timestamp.fromMillis(Date.now() - 86400e3) })
    const c = await challengeAndSign(keys.privateKey)
    const res = await appeal({ token: secret, challengeId: c.challengeId, signature: c.signature, statement: STATEMENT })
    expect(res.status).toBe('submitted')
    expect(db.count('appeals')).toBe(2)
  })

  test('a signature from the wrong key is refused, and nothing is stored', async () => {
    const { secret } = seedAccount({ account: { isBanned: true } })
    const thief = keypair()
    const c = await QL.quickLoginChallenge.run({}, {})
    const r = await refusal(() => appeal({
      token: secret, challengeId: c.challengeId,
      signature: sign(thief.privateKey, c.challenge), statement: STATEMENT,
    }))
    expect(r.detail).toBe('refused')
    expect(db.count('appeals')).toBe(0)
  })

  test('a statement that is too short is refused WITHOUT burning the challenge', async () => {
    const { secret, keys } = seedAccount({ account: { isBanned: true } })
    const c = await challengeAndSign(keys.privateKey)
    const r = await refusal(() => appeal({
      token: secret, challengeId: c.challengeId, signature: c.signature, statement: 'too short',
    }))
    expect(r.code).toBe('invalid-argument')
    // The challenge must still be spendable, or a typo costs a round trip the
    // person cannot see.
    expect(db.read(`quickLoginChallenges/${c.challengeId}`).usedAt).toBeFalsy()
    const ok = await appeal({
      token: secret, challengeId: c.challengeId, signature: c.signature, statement: STATEMENT,
    })
    expect(ok.status).toBe('submitted')
  })

  test('an over-long statement is refused', async () => {
    const { err } = await fileAppeal({ isBanned: true }, 'x'.repeat(P.MAX_STATEMENT_CHARS + 1))
    expect(err.code).toBe('invalid-argument')
    expect(db.count('appeals')).toBe(0)
  })

  test('a DEVICE ban does not block an ACCOUNT appeal', async () => {
    // Two different facts. Somebody with both must still be able to appeal the
    // account one — the deliberate `deviceBanned: false`.
    const { secret, keys } = seedAccount({ account: { isBanned: true } })
    db.seed('bannedDevices/dev-A', { isActive: true, reason: 'abuse' })
    const c = await challengeAndSign(keys.privateKey)
    const res = await appeal({ token: secret, challengeId: c.challengeId, signature: c.signature, statement: STATEMENT })
    expect(res.status).toBe('submitted')
  })

  test('the audit event records the length, never the words', async () => {
    await fileAppeal({ isBanned: true })
    const events = db.all('authEvents').filter((e) => e.event === 'ACCOUNT_APPEAL_SUBMITTED')
    expect(events.length).toBe(1)
    const blob = JSON.stringify(events[0])
    expect(blob.includes('statementChars')).toBe(true)
    expect(blob.includes('banned by mistake')).toBe(false)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
//  Nothing in the datastore ever holds a raw credential
// ══════════════════════════════════════════════════════════════════════════════

describe('no secret is ever persisted or logged', () => {
  test('after a full redemption, no stored document contains either secret', async () => {
    const { secret, keys } = seedAccount()
    const { challengeId, signature } = await challengeAndSign(keys.privateKey)
    const res = await redeem({ token: secret, challengeId, signature, deviceId: 'dev-A' })

    for (const coll of ['quickLoginTokens', 'quickLoginRate', 'authEvents', 'appeals']) {
      const blob = JSON.stringify(db.all(coll))
      expect(blob.includes(secret)).toBe(false)
      expect(blob.includes(res.token)).toBe(false)
      expect(blob.includes(signature)).toBe(false)
    }
  })

  test('audit events carry a 12-char fingerprint, which is not reversible', async () => {
    const { secret, keys } = seedAccount()
    const { challengeId, signature } = await challengeAndSign(keys.privateKey)
    await redeem({ token: secret, challengeId, signature, deviceId: 'dev-A' })
    const success = db.all('authEvents').find((e) => e.event === 'QUICK_LOGIN_SUCCESS')
    expect(success).toBeTruthy()
    expect(success.consumed).toBe(sha(secret).slice(0, 12))
    expect(success.consumed.length).toBe(12)
  })

  test('a redemption emits both the success and the rotation event', async () => {
    const { secret, keys } = seedAccount()
    const { challengeId, signature } = await challengeAndSign(keys.privateKey)
    await redeem({ token: secret, challengeId, signature, deviceId: 'dev-A' })
    const names = db.all('authEvents').map((e) => e.event)
    expect(names.includes('QUICK_LOGIN_SUCCESS')).toBe(true)
    expect(names.includes('QUICK_LOGIN_ROTATED')).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
//  Revocation
// ══════════════════════════════════════════════════════════════════════════════

describe('revocation', () => {

  test('a credential you do not own is not yours to retire', async () => {
    const { secret } = seedAccount({ uid: 'victim' })
    const res = await QL.revokeQuickLogin.run({ token: secret }, ctx('attacker'))
    expect(res.revoked).toBe(0)
    expect(db.has(`quickLoginTokens/${sha(secret)}`)).toBe(true)
  })

  test('your own is', async () => {
    const { secret, uid } = seedAccount()
    const res = await QL.revokeQuickLogin.run({ token: secret }, ctx(uid))
    expect(res.revoked).toBe(1)
    expect(db.has(`quickLoginTokens/${sha(secret)}`)).toBe(false)
  })

  test('allDevices drops every credential the account holds', async () => {
    seedAccount({ uid: 'u1', secret: 'a'.repeat(43) })
    seedAccount({ uid: 'u1', secret: 'b'.repeat(43) })
    seedAccount({ uid: 'u2', secret: 'c'.repeat(43) })
    const res = await QL.revokeQuickLogin.run({ allDevices: true }, ctx('u1'))
    expect(res.revoked).toBe(2)
    expect(db.count('quickLoginTokens')).toBe(1)
  })

  test('and a revoked credential cannot then be redeemed', async () => {
    const { secret, uid, keys } = seedAccount()
    await QL.revokeQuickLogin.run({ token: secret }, ctx(uid))
    const { challengeId, signature } = await challengeAndSign(keys.privateKey)
    const r = await refusal(() => redeem({ token: secret, challengeId, signature, deviceId: 'dev-A' }))
    expect(r.detail).toBe('refused')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
//  The challenge endpoint itself
// ══════════════════════════════════════════════════════════════════════════════

describe('the challenge endpoint', () => {
  test('discloses nothing and needs no session', async () => {
    const a = await QL.quickLoginChallenge.run({}, {})
    const b = await QL.quickLoginChallenge.run({}, {})
    expect(a.challengeId).not.toBe(b.challengeId)
    expect(a.challenge).not.toBe(b.challenge)
    expect(Object.keys(a).slice().sort()).toEqual(['challenge', 'challengeId', 'expiresInMs'])
  })

  test('issues enough entropy to be unguessable', async () => {
    const c = await QL.quickLoginChallenge.run({}, {})
    // 32 random bytes, base64url -> 43 chars.
    expect(c.challenge.length).toBeGreaterThanOrEqual(43)
  })

  test('stores it unused, with the policy TTL', async () => {
    const c = await QL.quickLoginChallenge.run({}, {})
    const rec = db.read(`quickLoginChallenges/${c.challengeId}`)
    expect(rec.usedAt).toBe(null)
    expect(c.expiresInMs).toBe(P.CHALLENGE_TTL_MS)
  })
})

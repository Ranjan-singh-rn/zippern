/**
 * FX-13 (RF-19 / DUP-09) — one pending self-appeal per restriction, whichever
 * path or device files it.
 *
 * The bug: the device-key path read "is one pending?" and then `add`ed — so
 * two devices (or the app and this path) at the same moment both read "none"
 * and both added one. Now the appeal is placed at the restriction's
 * deterministic id (`appealIds.ts`) inside one transaction.
 *
 * REAL: `submitAccountAppeal` over the shared fake Firestore (whose
 * transactions are serialised — enough to show that two overlapping filings
 * cannot both create), and the pure id helpers.
 *
 * ZIPPER_FUNCTIONS_LIB=<dir> loads another compiled `lib` (the pre-fix build).
 *
 * Run:  node --test test/fxAppealDedupe.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const crypto = require('node:crypto')
const path = require('node:path')
const { expect } = require('./expect')
const { installFakeFirestore, Timestamp } = require('./fakeFirestore')

let db = installFakeFirestore()
const LIB = process.env.ZIPPER_FUNCTIONS_LIB || path.join(__dirname, '..', 'lib')
const QL = require(path.join(LIB, 'quickLogin'))
const P = require(path.join(LIB, 'quickLoginPolicy'))
const ids = (() => { try { return require(path.join(LIB, 'appealIds')) } catch { return {} } })()

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const keypair = () => crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
const sign = (priv, challenge) =>
  crypto.sign('sha256', Buffer.from(challenge, 'utf8'), { key: priv, dsaEncoding: 'der' }).toString('base64')

function seedAccount({ uid = 'u1', secret = 's'.repeat(43), account = {} } = {}) {
  const k = keypair()
  db.seed(`quickLoginTokens/${sha(secret)}`, {
    version: P.CREDENTIAL_VERSION, uid, deviceId: 'dev-A', publicKey: k.publicKey,
    createdAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + 30 * 86400e3),
    lastUsedAt: null, revokedAt: null,
  })
  db.seed(`users/${uid}`, { name: 'Rahul', isProfileComplete: true, ...account })
  return { uid, secret, keys: k }
}
async function signed(priv) {
  const c = await QL.quickLoginChallenge.run({}, {})
  return { challengeId: c.challengeId, signature: sign(priv, c.challenge) }
}
const appeal = (args) => QL.submitAccountAppeal.run(args, {})
const STATEMENT = 'I was banned by mistake. I have never bought or sold coins outside the app.'
const BANNED_AT = Timestamp.fromMillis(1760000000000)

beforeEach(() => { db = installFakeFirestore() })

describe('the id', () => {
  test('a restriction is keyed by its kind and when it was imposed', () => {
    expect(ids.restrictionKeyOf({ isBanned: true, bannedAt: BANNED_AT })).toBe('ban-1760000000000')
    expect(ids.restrictionKeyOf({ isSuspended: true, isBanned: true, suspendedAt: BANNED_AT })).toBe('suspension-1760000000000')
    expect(ids.restrictionKeyOf({ isBanned: true })).toBe('ban')
  })
  test('slot 1 is the bare id; later slots are suffixed', () => {
    expect(ids.selfAppealId('u1', 'ban-1', 1)).toBe('self_u1_ban-1')
    expect(ids.selfAppealId('u1', 'ban-1', 3)).toBe('self_u1_ban-1_3')
  })
})

/**
 * The race, made to happen: the first two "is one pending?" reads both return
 * before either filing writes — as they do in production, where each read is
 * a network round trip. The fake answers instantly, so without this barrier
 * the second filing would simply see the first one's write.
 */
function raceThePendingReads() {
  const Q = Object.getPrototypeOf(db.collection('_q').where('a', '==', 1)).constructor
  const original = Q.prototype.get
  const parked = []
  let armed = 2
  Q.prototype.get = async function patchedGet() {
    const pendingAppeals = this._collection === 'appeals'
      && this._filters.some((f) => f.field === 'status' && f.value === 'pending')
    if (!pendingAppeals || armed === 0) return original.call(this)
    armed -= 1
    const result = await original.call(this)
    await new Promise((resolve) => {
      parked.push(resolve)
      if (parked.length === 2) parked.forEach((r) => r())
    })
    return result
  }
  return () => { Q.prototype.get = original }
}

describe('submitAccountAppeal', () => {
  test('two filings at the same moment → ONE pending appeal', async () => {
    const { secret, keys } = seedAccount({ account: { isBanned: true, bannedAt: BANNED_AT } })
    const [a, b] = await Promise.all([signed(keys.privateKey), signed(keys.privateKey)])
    const restore = raceThePendingReads()
    let results
    try {
      results = await Promise.all([
        appeal({ token: secret, ...a, statement: STATEMENT }),
        appeal({ token: secret, ...b, statement: STATEMENT }),
      ])
    } finally {
      restore()
    }
    expect(results.map((r) => r.status).sort()).toEqual(['already_pending', 'submitted'])
    expect(db.count('appeals')).toBe(1)
  })

  test('the appeal is stored at the restriction\'s id', async () => {
    const { secret, keys, uid } = seedAccount({ account: { isBanned: true, bannedAt: BANNED_AT } })
    const r = await appeal({ token: secret, ...(await signed(keys.privateKey)), statement: STATEMENT })
    expect(r.appealId).toBe(`self_${uid}_ban-1760000000000`)
    expect(db.read(`appeals/self_${uid}_ban-1760000000000`).status).toBe('pending')
  })

  test('an appeal the APP already placed at that id is found, not duplicated', async () => {
    const { secret, keys, uid } = seedAccount({ account: { isBanned: true, bannedAt: BANNED_AT } })
    db.seed(`appeals/self_${uid}_ban-1760000000000`, { subjectUid: uid, raisedByUid: uid, status: 'pending', kind: 'ban' })
    const r = await appeal({ token: secret, ...(await signed(keys.privateKey)), statement: STATEMENT })
    expect(r.status).toBe('already_pending')
    expect(db.count('appeals')).toBe(1)
  })

  test('after a DECIDED appeal for the same restriction, a new one takes the next slot (unchanged: allowed)', async () => {
    const { secret, keys, uid } = seedAccount({ account: { isBanned: true, bannedAt: BANNED_AT } })
    db.seed(`appeals/self_${uid}_ban-1760000000000`, { subjectUid: uid, status: 'rejected', kind: 'ban' })
    const r = await appeal({ token: secret, ...(await signed(keys.privateKey)), statement: STATEMENT })
    expect(r.status).toBe('submitted')
    expect(r.appealId).toBe(`self_${uid}_ban-1760000000000_2`)
    expect(db.read(`appeals/self_${uid}_ban-1760000000000`).status).toBe('rejected')
  })

  test('two different people stay two appeals', async () => {
    const one = seedAccount({ uid: 'p1', secret: 'a'.repeat(43), account: { isBanned: true, bannedAt: BANNED_AT } })
    const two = seedAccount({ uid: 'p2', secret: 'b'.repeat(43), account: { isBanned: true, bannedAt: BANNED_AT } })
    await appeal({ token: one.secret, ...(await signed(one.keys.privateKey)), statement: STATEMENT })
    await appeal({ token: two.secret, ...(await signed(two.keys.privateKey)), statement: STATEMENT })
    expect(db.count('appeals')).toBe(2)
  })
})

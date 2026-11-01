/**
 * CROSS-SYSTEM — the shipped Cloud Functions against the LOCAL Firestore and
 * Auth emulators (no fakes for the datastore or Auth).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * `functions/test/fakeFirestore.js` says what it cannot do: "It does not model
 * real contention. `runTransaction` below serialises through a promise chain
 * … not Firestore's optimistic retry." The single-use guarantees of quick
 * login and the RF-27 sign-in gate were therefore only ever executed against
 * a datastore that cannot race. Here they run against the real emulator, with
 * real transactions, real Auth users and real custom tokens.
 *
 *   A. Quick login is single-use under REAL contention: N redemptions of one
 *      credential fired at once → exactly one session, exactly one rotated
 *      credential, every loser `aborted`/`concurrent` (the code the app keeps
 *      its credential on).
 *   B. RF-27 — the sign-in gate (`resolveIdentity`) reads `accountState`
 *      first, on a real Auth user and a real users document; a suspension
 *      never bars the handset, a ban does.
 *
 * Partner verification, invitations and Host transfers are decided by the
 * backend (Mongo + Firestore); see `host_transfer_contention.crosssys.py` for
 * the part of that which is a Firestore transaction.
 *
 * ── SAFETY ───────────────────────────────────────────────────────────────────
 *
 * Refuses to start unless BOTH emulator hosts are loopback, the project id is
 * a `demo-` id (which the emulator suite never connects to a real project),
 * and GOOGLE_APPLICATION_CREDENTIALS is unset. Run from the repository root:
 *
 *   firebase emulators:exec --only firestore,auth --project demo-zipper-crosssys \
 *       "node --require ./tests/crosssys/netguard.cjs tests/crosssys/functions.crosssys.test.cjs"
 *
 * (In-process, not `--test`: the network guard preloaded with `--require`
 * must be in the same process as the code it guards.)
 */

'use strict'

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/
const fsHost = process.env.FIRESTORE_EMULATOR_HOST || ''
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || ''
const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || ''
if (!LOOPBACK.test(fsHost) || !LOOPBACK.test(authHost) || !project.startsWith('demo-')
    || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('CROSSSYS REFUSED: needs FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST on loopback, '
    + `a demo- project and no GOOGLE_APPLICATION_CREDENTIALS (got firestore=${fsHost || '-'}, `
    + `auth=${authHost || '-'}, project=${project || '-'})`)
  process.exit(2)
}

const path = require('node:path')
const crypto = require('node:crypto')
const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const FUNCTIONS = path.join(__dirname, '..', '..', 'functions')
// The SAME firebase-admin instance the shipped code uses.
const admin = require(path.join(FUNCTIONS, 'node_modules', 'firebase-admin'))
require(path.join(FUNCTIONS, 'lib', 'index'))                    // admin.initializeApp(), as deployed
const QL = require(path.join(FUNCTIONS, 'lib', 'quickLogin'))
const P = require(path.join(FUNCTIONS, 'lib', 'quickLoginPolicy'))
const ID = require(path.join(FUNCTIONS, 'lib', 'identity'))
const MS = require(path.join(FUNCTIONS, 'lib', 'mobileSession'))

const db = admin.firestore()
const RUN = crypto.randomBytes(4).toString('hex')       // unique ids per run
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
let phoneSeq = 0
const nextPhone = () => `+9198${String(Date.now() % 1e6).padStart(6, '0')}${String(phoneSeq++).padStart(2, '0')}`

function keypair() {
  return crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
}
const sign = (priv, challenge) =>
  crypto.sign('sha256', Buffer.from(challenge, 'utf8'), { key: priv, dsaEncoding: 'der' }).toString('base64')

// ══════════════════════════════════════════════════════════════════════════════
describe('A. quick login is single-use under real contention', () => {
  async function seedCredential(uid) {
    const keys = keypair()
    const secret = crypto.randomBytes(32).toString('base64url')
    await db.doc(`quickLoginTokens/${sha(secret)}`).set({
      version: P.CREDENTIAL_VERSION,
      uid,
      deviceId: 'dev-A',
      publicKey: keys.publicKey,
      createdAt: admin.firestore.Timestamp.now(),
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 30 * 86400e3),
      lastUsedAt: null,
      revokedAt: null,
    })
    await db.doc(`users/${uid}`).set({ name: 'Rahul', isProfileComplete: true, accountState: 'active' })
    return { secret, keys }
  }
  async function signedChallenge(priv) {
    const c = await QL.quickLoginChallenge.run({}, {})
    return { challengeId: c.challengeId, signature: sign(priv, c.challenge) }
  }
  const credentialsOf = async (uid) => (await db.collection('quickLoginTokens').where('uid', '==', uid).get()).size

  for (const n of [2, 5]) {
    test(`${n} redemptions at once → exactly one session, one credential, losers aborted/concurrent`, async () => {
      const uid = `ql-${RUN}-${n}`
      const { secret, keys } = await seedCredential(uid)
      const signed = []
      for (let i = 0; i < n; i++) signed.push(await signedChallenge(keys.privateKey))
      const rs = await Promise.allSettled(signed.map((c) => QL.redeemQuickLogin.run(
        { token: secret, challengeId: c.challengeId, signature: c.signature, deviceId: 'dev-A' }, {})))
      const won = rs.filter((r) => r.status === 'fulfilled' && r.value.outcome === 'allow')
      const lost = rs.filter((r) => r.status === 'rejected')
      assert.equal(won.length, 1, `winners: ${won.length}; ${JSON.stringify(rs.map((r) => r.status === 'rejected'
        ? [r.reason.code, r.reason.details && r.reason.details.code] : r.value.outcome))}`)
      assert.equal(lost.length, n - 1)
      // A loser either raced inside the rotation (`aborted`/`concurrent` — the
      // app keeps its credential) or arrived after the credential was already
      // spent (`permission-denied`/`refused`, as a sequential replay). Both are
      // clean and neither grants anything; the split is printed, not assumed.
      const codes = lost.map((l) => `${l.reason.code}/${l.reason.details && l.reason.details.code}`)
      console.log(`    n=${n} losers: ${codes.join(', ')}`)
      for (const c of codes) assert.ok(c === 'aborted/concurrent' || c === 'permission-denied/refused', `loser ${c}`)
      assert.equal(typeof won[0].value.customToken, 'string')       // minted by the Auth emulator
      assert.ok(won[0].value.customToken.length > 20)
      assert.equal(await credentialsOf(uid), 1, 'exactly one live credential — no orphan')
      assert.equal((await db.doc(`quickLoginTokens/${sha(secret)}`).get()).exists, false, 'the spent one is gone')
      // The one live credential is the WINNER's replacement — not a loser's phantom.
      assert.equal((await db.doc(`quickLoginTokens/${sha(won[0].value.token)}`).get()).exists, true)

      // Sequential reuse after the race: the spent secret is refused…
      const again = await signedChallenge(keys.privateKey)
      const reuse = await QL.redeemQuickLogin.run(
        { token: secret, challengeId: again.challengeId, signature: again.signature, deviceId: 'dev-A' }, {})
        .then(() => null, (e) => e)
      assert.ok(reuse, 'the spent secret must not redeem again')
      assert.equal(`${reuse.code}/${reuse.details && reuse.details.code}`, 'permission-denied/refused')
      // …and the replacement the winner was given works, once.
      const next = await signedChallenge(keys.privateKey)
      const rotated = await QL.redeemQuickLogin.run(
        { token: won[0].value.token, challengeId: next.challengeId, signature: next.signature, deviceId: 'dev-A' }, {})
      assert.equal(rotated.outcome, 'allow')
      assert.equal(await credentialsOf(uid), 1)
    })
  }

  test('one challenge raced twice → at most one session', async () => {
    const uid = `ql-${RUN}-same`
    const { secret, keys } = await seedCredential(uid)
    const c = await signedChallenge(keys.privateKey)
    const args = { token: secret, challengeId: c.challengeId, signature: c.signature, deviceId: 'dev-A' }
    const rs = await Promise.allSettled([QL.redeemQuickLogin.run(args, {}), QL.redeemQuickLogin.run(args, {})])
    assert.equal(rs.filter((r) => r.status === 'fulfilled' && r.value.outcome === 'allow').length, 1)
    assert.equal(await credentialsOf(uid), 1)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
describe('B. RF-27 — the sign-in gate on a real Auth user and users document', () => {
  async function account(label, shape) {
    const uid = `id-${RUN}-${label}`
    const phone = nextPhone()
    await admin.auth().createUser({ uid, phoneNumber: phone })
    await db.doc(`users/${uid}`).set({ name: 'U', isProfileComplete: true, phoneNumber: phone, ...shape })
    return { uid, phone }
  }
  const gate = ({ uid, phone }, deviceId) => ID.resolveIdentity.run({ deviceId }, {
    auth: { uid, token: { auth_time: Math.floor(Date.now() / 1000), phone_number: phone,
      firebase: { sign_in_provider: 'phone' } } },
  })
  const barred = async (deviceId) => {
    const d = await db.doc(`bannedDevices/${deviceId}`).get()
    return d.exists && d.get('isActive') !== false
  }

  const cases = [
    ['c1', { accountState: 'suspended', isSuspended: false, isBanned: false }, 'suspended', false],
    ['c3', { accountState: 'banned', isSuspended: false, isBanned: false, banReason: 'Fraud' }, 'banned', true],
    ['c7', { accountState: 'suspended', isBanned: true, isSuspended: false }, 'suspended', false],
    ['c8', { accountState: 'banned', isBanned: true, isSuspended: true }, 'banned', true],
    ['c5b', { accountState: 'recovery_pending' }, 'deleted_recoverable', false],
    ['ok', { accountState: 'active' }, 'allow', false],
  ]
  for (const [label, shape, decision, bars] of cases) {
    test(`${label}: ${JSON.stringify(shape)} → ${decision}${bars ? ', handset barred' : ''}`, async () => {
      const acct = await account(label, shape)
      const device = `dev-${RUN}-${label}`
      const r = await gate(acct, device)
      assert.equal(r.decision, decision)
      assert.equal(await barred(device), bars)
      if (decision !== 'allow' && !decision.startsWith('deleted')) {
        // The gate and every other reader agree (restrictionVerdict).
        assert.equal(MS.restrictionVerdict((f) => shape[f]), decision)
      }
    })
  }

  test('a banned account signing in on one handset from several places at once bars it once', async () => {
    const acct = await account('race', { accountState: 'banned', isBanned: true })
    const device = `dev-${RUN}-race`
    const rs = await Promise.all([1, 2, 3, 4].map(() => gate(acct, device)))
    assert.deepEqual(rs.map((r) => r.decision), ['banned', 'banned', 'banned', 'banned'])
    const d = await db.doc(`bannedDevices/${device}`).get()
    assert.equal(d.get('isActive'), true)
    assert.deepEqual(d.get('sourceAccounts'), [acct.uid])
  })
})

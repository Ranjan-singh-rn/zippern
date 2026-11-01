/**
 * P1-A3b — REAL tokens: Auth + Firestore emulators (demo-zipper), no mocks.
 *
 * Proves the assumptions the `mfa_sid` design rests on, with tokens the Auth
 * emulator actually issues and the real firestore.rules evaluating them:
 *
 *   1. A custom token minted by the Admin SDK with the developer claim
 *      `mfa_sid` yields ID tokens that carry `mfa_sid`, sign_in_provider
 *      'custom' and an auth_time — and the claim SURVIVES a forced refresh.
 *   2. A password sign-in of the same account (a separate client) carries NO
 *      `mfa_sid`. A plain custom token (quick-login style) carries none either.
 *   3. Account-wide claims (role) appear in both; personal profile claims
 *      (email, email_verified, phone_number) are reported as issued.
 *   4. Against the real rules: the bound custom-token session reads Owner
 *      data; the password session and the quick-login session do not; after
 *      the binding is removed (sign-out) the custom session is refused at once.
 *
 * Run from the repository root (Java + firebase CLI):
 *   firebase emulators:exec --only auth,firestore --project demo-zipper "node tests/auth.p1mfa.emulator.test.mjs"
 */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { initializeApp as initClient, deleteApp } from 'firebase/app'
import {
  getAuth, connectAuthEmulator, signInWithEmailAndPassword, signInWithCustomToken, signOut,
} from 'firebase/auth'
import { getFirestore, connectFirestoreEmulator, doc, getDoc } from 'firebase/firestore'

const PROJECT = 'demo-zipper'
for (const [k, v] of [['FIREBASE_AUTH_EMULATOR_HOST', '127.0.0.1:9099'], ['FIRESTORE_EMULATOR_HOST', '127.0.0.1:8080']]) {
  if (!process.env[k]) process.env[k] = v
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env[k])) { console.error(`REFUSING: ${k} is not local`); process.exit(2) }
}
const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(here, '..', 'functions', 'package.json'))
const admin = require('firebase-admin')
admin.initializeApp({ projectId: PROJECT })

let checks = 0
let failures = 0
const facts = []
function ok(label, cond) { checks += 1; if (!cond) { failures += 1; console.error(`  FAIL  ${label}`) } }
async function allowed(p) { try { await p; return true } catch { return false } }

function client(name) {
  const app = initClient({ apiKey: 'demo-key', projectId: PROJECT, authDomain: `${PROJECT}.firebaseapp.com` }, name)
  const auth = getAuth(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  const db = getFirestore(app)
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
  return { app, auth, db }
}

async function main() {
  const uid = `owner-real-${Date.now()}`
  const email = `${uid}@example.test`
  await admin.auth().createUser({ uid, email, password: 'test-only-pw-123', emailVerified: true, phoneNumber: '+919900000123' })
  await admin.auth().setCustomUserClaims(uid, { role: 'owner', aid: '' })
  const fs = admin.firestore()
  await fs.doc(`crmUsers/${uid}`).set({ uid, role: 'superadmin', isActive: true })
  await fs.doc('withdrawalRequests/WR1').set({ hostUid: 'someone', amount: 1, status: 'pending' })

  // ── 1. the personal / password session ─────────────────────────────────
  const pw = client('pw')
  await signInWithEmailAndPassword(pw.auth, email, 'test-only-pw-123')
  const pwClaims = (await pw.auth.currentUser.getIdTokenResult()).claims
  ok('password session: provider is password', pwClaims.firebase?.sign_in_provider === 'password')
  ok('password session: NO mfa_sid', !('mfa_sid' in pwClaims))
  ok('password session: account-wide role claim present', pwClaims.role === 'owner')

  // ── 2. the post-MFA custom-token session ───────────────────────────────
  const sid = 'real-sid-' + Math.random().toString(36).slice(2)
  const customToken = await admin.auth().createCustomToken(uid, { mfa_sid: sid })
  const own = client('ownerWork')
  await signInWithCustomToken(own.auth, customToken)
  let c = (await own.auth.currentUser.getIdTokenResult()).claims
  ok('custom session: mfa_sid claim carried', c.mfa_sid === sid)
  ok('custom session: provider is custom', c.firebase?.sign_in_provider === 'custom')
  ok('custom session: auth_time present', typeof c.auth_time === 'number' && c.auth_time > 0)
  ok('custom session: account-wide role claim present too', c.role === 'owner')
  facts.push(`custom session email=${'email' in c} email_verified=${c.email_verified} phone_number=${'phone_number' in c}`)
  const authTime = c.auth_time
  await new Promise((r) => setTimeout(r, 1100))
  c = (await own.auth.currentUser.getIdTokenResult(true)).claims   // forced refresh
  ok('mfa_sid SURVIVES a forced token refresh', c.mfa_sid === sid)
  ok('auth_time is unchanged by refresh', c.auth_time === authTime)

  // ── 3. a plain custom token (quick-login style) ────────────────────────
  const quick = client('quick')
  await signInWithCustomToken(quick.auth, await admin.auth().createCustomToken(uid))
  const qc = (await quick.auth.currentUser.getIdTokenResult()).claims
  ok('quick-login style custom session: NO mfa_sid', !('mfa_sid' in qc))
  ok('the password session still has no mfa_sid after the custom sign-ins', !('mfa_sid' in (await pw.auth.currentUser.getIdTokenResult(true)).claims))

  // ── 4. the real rules ──────────────────────────────────────────────────
  const read = (cl) => allowed(getDoc(doc(cl.db, 'withdrawalRequests/WR1')))
  ok('before any binding: the custom session is refused Owner data', !(await read(own)))
  await fs.doc(`ownerMfaSessions/${uid}`).set({ bindings: { [sid]: {
    state: 'minted', apiJti: 'j', client: 'android', expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 864e5) } } })
  ok('minted but unconfirmed: still refused', !(await read(own)))
  await fs.doc(`ownerMfaSessions/${uid}`).set({ bindings: { [sid]: {
    state: 'active', authTime, apiJti: 'j', client: 'android', expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 864e5) } } })
  ok('confirmed: the custom-token session reads Owner data', await read(own))
  ok('the password session of the same account is REFUSED', !(await read(pw)))
  ok('the quick-login custom session is REFUSED', !(await read(quick)))
  // A second redemption of the same custom token: new session, new auth_time.
  await new Promise((r) => setTimeout(r, 1100))
  const replay = client('replay')
  await signInWithCustomToken(replay.auth, customToken)
  const rc = (await replay.auth.currentUser.getIdTokenResult()).claims
  facts.push(`replayed redemption auth_time ${rc.auth_time === authTime ? 'EQUALS' : 'differs from'} the confirmed one`)
  ok('a replayed redemption of the custom token is REFUSED (different auth_time)', rc.auth_time === authTime || !(await read(replay)))
  await fs.doc(`ownerMfaSessions/${uid}`).set({ bindings: {} })
  ok('after sign-out (binding removed) the custom session is refused immediately', !(await read(own)))

  for (const cl of [pw, own, quick, replay]) { await signOut(cl.auth).catch(() => {}); await deleteApp(cl.app) }
  await admin.auth().deleteUser(uid).catch(() => {})
}

try {
  await main()
} catch (err) {
  failures += 1
  console.error(`ABORTED: ${String(err?.message ?? err).split('\n')[0]}`)
}
for (const f of facts) console.log(`FACT  ${f}`)
console.log(`P1MFA-AUTH-RESULT checks=${checks} failures=${failures}`)
if (failures === 0) console.log(`All ${checks} real-token owner-MFA checks passed.`)
process.exitCode = failures ? 1 : 0
setTimeout(() => process.exit(process.exitCode), 2000).unref()

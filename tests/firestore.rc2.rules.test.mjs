/**
 * firestore.rules — RULES RELEASE CANDIDATE 2 (2026-11-01) regression tests
 * (Firestore emulator).
 *
 * Rules under test: the repository's top-level firestore.rules = DEPLOYED
 * (17b8ffee…) → Owner-MFA candidate (93453763…) → working-tree P1-A1/D/E
 * hunks → hotfix-1 hunks → the item-5 changes of RC2. The header block of
 * firestore.rules lists every change (A1…D11) with its dependency; the claims
 * below carry the same labels. ZIPPER_RULES_FILE points the same checks at
 * another file (DEPLOYED and hotfix-1 fail the "new" checks, as they should).
 *
 *   A   Owner MFA boundary — a password-only Owner holds no staff grant; a
 *       bound post-MFA session holds them all; ownerMfaSessions is deny-all.
 *   B   Hotfix-1 hunks present in RC2 — empty-over-empty contacts (A-1),
 *       calls/callHistory no client write (R-3), androidUpdate no client
 *       write (A-5), coinPurchaseRequests list scoping (R-2).
 *   C   Working-tree hunks — staffRoster + crmUsers read narrowing (C1),
 *       techTickets client writes refused / staff read (C2), feedback and
 *       support tickets update/delete refused, user create + read own (C3).
 *   D1  weeklyPayoutReports/{id}/hostPayouts: Finance/admin and the report's
 *       agency owner (own-agency query) only — not the host, not anyone
 *       else; no client write.
 *   D2  top-level hostPayouts: the agency update arm is closed.
 *   D3  salaryRequests: the actor key `approvedBy` accepted, own uid only;
 *       no other actor spelling (`approvedByUid`) is admitted.
 *   D4  users: banScope / banCategory / banEvidence / payoutHoldReason /
 *       payoutHoldAt / credentialsValidAfter refused for owner and staff.
 *   D5  users: gender is set once (owner arm).
 *   D6  notifications: addressee read only; no client write.
 *   D7  appConfig/paymentCredentials: staff, started CRM seller, started app
 *       seller with a verified contact — never a guest or ordinary user;
 *       every other appConfig document reads as before; luckyGifts (D10).
 *   D8  hostKyc: admins and the host only.
 *   D9  followers: the follower writes its own row; giftsReceived no create.
 *   D12 rateLimits: deny-all for every client (functions/src/rateLimit.ts).
 *   D13 partyRooms/{id}/private/{doc}: deny-all (the PIN secret of party.ts);
 *       the room, seats and listeners read as before.
 *   D14 §5 Host role suspension: `hostSuspended` (and its term / stamps) is
 *       server-only for the host and for staff, and a suspended verified Host
 *       cannot open a live room (`mayGoLive`); an unsuspended one still can.
 *   D15 appConfig/luckyGifts.enabled (the lucky-gift switch) is the Owner's:
 *       a Tech write to luckyGifts may not change it.
 *   E   C-1 still withheld: the live self-signup login write passes.
 *   S   static (no emulator): each RC2 match block exists exactly once in the
 *       rules text, and firestore.indexes.json (ZIPPER_INDEXES_FILE) declares
 *       staffRoster(role, isActive) and the four Work-hub (status ASC,
 *       createdAt DESC) indexes exactly once, with no duplicate definitions.
 *
 * Same harness as firestore.hotfix1.rules.test.mjs (ok/no thunks, classified
 * failures, one RC2-RESULT line). `demo-` project id: never a real project.
 *
 * Run from the repository root (needs Java + firebase CLI):
 *   firebase emulators:exec --only firestore --project demo-zipper "node tests/firestore.rc2.rules.test.mjs"
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { initializeTestEnvironment } from '@firebase/rules-unit-testing'
import {
  doc, setDoc, getDoc, updateDoc, deleteDoc, deleteField, collection, getDocs, query, where,
} from 'firebase/firestore'

const here = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = process.env.ZIPPER_RULES_FILE || join(here, '..', 'firestore.rules')
const RULES = readFileSync(RULES_PATH, 'utf8')
const RULES_SHA256 = createHash('sha256').update(RULES, 'utf8').digest('hex')
console.log(`rules under test: ${RULES_PATH}`)
// The exact bytes uploaded to the emulator below — the runner compares this
// with the file it meant to test.
console.log(`rules sha256: ${RULES_SHA256}`)
const INDEXES_PATH = process.env.ZIPPER_INDEXES_FILE || join(here, '..', 'firestore.indexes.json')
console.log(`indexes under test: ${INDEXES_PATH}`)

// ── The check harness ───────────────────────────────────────────────────────
const tally = { checks: 0, failures: 0, ok_denied: 0, ok_error: 0, no_allowed: 0, no_error: 0, static_failed: 0 }
const failed = []

/** A static (text) claim: no emulator involved. */
function fact(claim, holds, detail = '') {
  tally.checks += 1
  if (holds) return
  tally.failures += 1
  tally.static_failed += 1
  failed.push(`[static] ${claim}`)
  console.error(`  FAIL  [static] ${claim}${detail ? `\n        ${detail}` : ''}`)
}

function isPermissionDenied(err) {
  const code = String(err?.code ?? '').toLowerCase()
  const msg = String(err?.message ?? '').toLowerCase()
  return code === 'permission-denied' || code === 'permission_denied'
    || msg.includes('permission_denied') || msg.includes('permission denied')
}

/** Run one request: 'allowed', 'denied' (by the rules), or 'error' (anything else). */
async function outcomeOf(run) {
  try {
    await run()
    return { kind: 'allowed' }
  } catch (err) {
    return { kind: isPermissionDenied(err) ? 'denied' : 'error', err }
  }
}

async function expect(claim, run, shouldPass) {
  tally.checks += 1
  const o = await outcomeOf(run)
  const passed = shouldPass ? o.kind === 'allowed' : o.kind === 'denied'
  if (passed) return
  tally.failures += 1
  const tag = `${shouldPass ? 'ok' : 'no'}:${o.kind}`
  if (tag === 'ok:denied') tally.ok_denied += 1
  else if (tag === 'ok:error') tally.ok_error += 1
  else if (tag === 'no:allowed') tally.no_allowed += 1
  else tally.no_error += 1
  failed.push(`[${tag}] ${claim}`)
  const why = o.kind === 'allowed'
    ? 'the request was ALLOWED'
    : String(o.err?.message ?? o.err).split('\n')[0]
  console.error(`  FAIL  [${tag}] ${claim}\n        ${why}`)
}
const ok = (claim, run) => expect(claim, run, true)
const no = (claim, run) => expect(claim, run, false)

function printResult(aborted) {
  console.log(
    `RC2-RESULT checks=${tally.checks} failures=${tally.failures} ok_denied=${tally.ok_denied} ` +
    `ok_error=${tally.ok_error} no_allowed=${tally.no_allowed} no_error=${tally.no_error} ` +
    `static_failed=${tally.static_failed} aborted=${aborted ? 1 : 0} rules_sha256=${RULES_SHA256}`,
  )
}

// ── S — static: every RC2 block once; the indexes the release needs ─────────
function staticChecks() {
  console.log('S — static: RC2 match blocks exactly once; firestore.indexes.json declares the RC2 indexes once')
  // Comments out (no rule string in this file contains `//`), whitespace folded.
  const code = RULES.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ')
  const count = (re) => (code.match(re) || []).length
  for (const [what, n] of [
    ['notifications', 1], ['hostKyc', 1], ['staffRoster', 1], ['ownerMfaSessions', 1], ['feedbackTickets', 1],
    ['supportTickets', 1], ['techTickets', 1], ['salaryRequests', 1], ['weeklyPayoutReports', 1], ['appConfig', 1],
    ['calls', 1], ['callHistory', 1], ['coinPurchaseRequests', 1], ['followers', 1], ['giftsReceived', 1],
    // `private`: D13's partyRooms/{id}/private (the PIN secret) and, since Track B (4 Nov 2026, e6ce378),
    // gameMatches/{id}/private (game seeds and invite codes). Both deny-all — pinned one by one below.
    ['rateLimits', 1], ['private', 2], ['partyRooms', 1],
    ['hostPayouts', 2], // weeklyPayoutReports/{id}/hostPayouts (D1) + the legacy top-level path (D2)
  ]) {
    const got = count(new RegExp(`match /${what}/\\{`, 'g'))
    fact(`S: \`match /${what}/{…}\` appears exactly ${n}×`, got === n, `found ${got}`)
  }
  fact('S: D12 rateLimits is an explicit deny-all',
    count(/match \/rateLimits\/\{bucket\} \{ allow read, write: if false; \}/g) === 1)
  // Every `private` subcollection is an explicit deny-all, and each sits where it belongs: the first inside
  // partyRooms (D13), the second inside gameMatches (Track B) — by position, since partyRooms comes first in the file.
  const denyPrivate = / match \/private\/\{docId\} \{ allow read, write: if false; \}/g
  const denyAt = [...code.matchAll(denyPrivate)].map((m) => m.index)
  const partyAt = code.indexOf('match /partyRooms/{roomId} {')
  const gamesAt = code.indexOf('match /gameMatches/{matchId} {')
  fact('S: every `match /private/{…}` is an explicit deny-all', denyAt.length === count(/match \/private\/\{/g),
    `deny-all ${denyAt.length}, private blocks ${count(/match \/private\/\{/g)}`)
  fact('S: D13 partyRooms/{id}/private/{doc} is an explicit deny-all',
    partyAt >= 0 && gamesAt > partyAt && denyAt.some((i) => i > partyAt && i < gamesAt),
    `partyRooms at ${partyAt}, gameMatches at ${gamesAt}, deny-all private at ${denyAt.join(', ')}`)
  fact('S: Track B gameMatches/{id}/private/{doc} is an explicit deny-all',
    gamesAt >= 0 && denyAt.some((i) => i > gamesAt))
  fact('S: A1 the Owner MFA demotion is present (superadmin_mfa_pending)', code.includes("'superadmin_mfa_pending'"))

  let idx = null
  try { idx = JSON.parse(readFileSync(INDEXES_PATH, 'utf8')) } catch (err) {
    fact('S: firestore.indexes.json parses', false, String(err?.message ?? err))
    return
  }
  const key = (i) => JSON.stringify([i.collectionGroup, i.queryScope || 'COLLECTION',
    (i.fields || []).filter((f) => f.fieldPath !== '__name__').map((f) => [f.fieldPath, f.order || '', f.arrayConfig || ''])])
  const keys = (idx.indexes || []).map(key)
  const dups = keys.filter((k, i) => keys.indexOf(k) !== i)
  fact('S: firestore.indexes.json holds no duplicate composite index', dups.length === 0, dups.join(' | '))
  const want = [['staffRoster', [['role', 'ASCENDING', ''], ['isActive', 'ASCENDING', '']]]]
  for (const cg of ['salaryRequests', 'supportTickets', 'techTickets', 'hostApplications']) {
    want.push([cg, [['status', 'ASCENDING', ''], ['createdAt', 'DESCENDING', '']]])
  }
  for (const [cg, fields] of want) {
    const k = JSON.stringify([cg, 'COLLECTION', fields])
    const got = keys.filter((x) => x === k).length
    fact(`S: index ${cg}(${fields.map((f) => `${f[0]} ${f[1] === 'DESCENDING' ? 'DESC' : 'ASC'}`).join(', ')}) declared exactly once`,
      got === 1, `found ${got}`)
  }
}

staticChecks()
// ZIPPER_STATIC_ONLY=1: the S section alone, without an emulator (CI / sandbox).
if (process.env.ZIPPER_STATIC_ONLY === '1') {
  if (tally.failures === 0) console.log(`\nAll ${tally.checks} RC2 static checks passed (emulator checks NOT run).`)
  printResult(false)
  await new Promise((r) => setTimeout(r, 200))
  process.exit(tally.failures > 0 ? 1 : 0)
}

// ── The environment ─────────────────────────────────────────────────────────
const testEnv = await initializeTestEnvironment({
  projectId: 'demo-zipper',
  firestore: { rules: RULES, host: '127.0.0.1', port: 8080 },
})

async function seed(path, data) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), path), data)
  })
}

// P1-A3b — an Owner's authority holds only for a Firebase session made from
// the backend's post-MFA custom token: `mfa_sid` naming an ACTIVE, unexpired
// binding in ownerMfaSessions/{uid} for this session's auth_time, provider
// 'custom'. `owner` below is such a session; `ownerUnbound` is the same
// account on a password sign-in.
const OWNER_MFA_SID = 'test-owner-mfa-sid'
const OWNER_MFA_BOUND = { bindings: { [OWNER_MFA_SID]: {
  state: 'active', authTime: 0, expiresAt: new Date(Date.now() + 7 * 864e5) } } }
const OWNER_MFA_TOKEN = { mfa_sid: OWNER_MFA_SID, auth_time: 0, firebase: { sign_in_provider: 'custom' } }
// One handle per context.
const handles = new Map()
function fs(ctx) {
  if (!handles.has(ctx)) handles.set(ctx, ctx.firestore())
  return handles.get(ctx)
}
const D = (ctx, path) => doc(fs(ctx), path)
const rnd = () => Math.random().toString(36).slice(2)

async function main() {
  await testEnv.clearFirestore()

  // ── Who is who ──────────────────────────────────────────────────────────
  const staffDoc = (uid, role, extra = {}) => seed(`crmUsers/${uid}`, { uid, role, isActive: true, status: 'approved', ...extra })
  await staffDoc('uidOwner', 'superadmin')
  await seed('ownerMfaSessions/uidOwner', OWNER_MFA_BOUND)
  await staffDoc('uidTechAdmin', 'tech_admin', { dept: 'tech' })
  await staffDoc('uidTechMember', 'tech_member', { dept: 'tech' })
  await staffDoc('uidOpsAdmin', 'ops_admin', { dept: 'ops' })
  await staffDoc('uidOpsMember', 'ops_member', { dept: 'ops' })
  await staffDoc('uidFinAdmin', 'finance_admin', { dept: 'finance' })
  await staffDoc('uidFinMember', 'finance_member', { dept: 'finance' })
  await staffDoc('uidMktAdmin', 'marketing_admin', { dept: 'marketing' })
  await staffDoc('uidSupport', 'support_member', { dept: 'support' })
  await staffDoc('uidGone', 'ops_member', { isActive: false, dept: 'ops' })
  await seed('crmUsers/uidAgency', { uid: 'uidAgency', role: 'agency', isActive: true, status: 'approved', agencyId: 'AG1', roleStatus: { agency: 'approved' } })
  await seed('crmUsers/uidAgency2', { uid: 'uidAgency2', role: 'agency', isActive: true, status: 'approved', agencyId: 'AG2', roleStatus: { agency: 'approved' } })
  await seed('crmUsers/uidSeller', { uid: 'uidSeller', role: 'seller', isActive: true, status: 'approved', sellerId: 'SL1', roleStatus: { seller: 'approved' } })
  await seed('crmUsers/uidSeller2', { uid: 'uidSeller2', role: 'seller', isActive: true, status: 'approved', sellerId: 'SL2', roleStatus: { seller: 'approved' } })
  await seed('crmUsers/uidSellerPending', { uid: 'uidSellerPending', role: 'seller', isActive: true, status: 'pending', sellerId: 'SL_PEND', roleStatus: { seller: 'pending' } })
  // The document the LIVE CRM writes for a public self-signup: active, pending.
  await seed('crmUsers/uidPendingAg', { uid: 'uidPendingAg', role: 'agency', isActive: true, status: 'pending', agencyId: 'AG_PEND', createdBy: 'self_signup' })
  await seed('sellers/SL1', { crmUid: 'uidSeller', displayName: 's1', status: 'approved' })
  await seed('sellers/SL2', { crmUid: 'uidSeller2', displayName: 's2', status: 'approved' })
  await seed('sellers/SL_PEND', { crmUid: 'uidSellerPending', displayName: 'sp', status: 'pending' })
  // APP sellers (BuyCoinScreen): a legacy uid-keyed record, and an FX-05 record
  // named by the login document.
  await seed('users/uidAppSeller', { uid: 'uidAppSeller', name: 'as', isSeller: true, isProfileComplete: true })
  await seed('sellers/uidAppSeller', { crmUid: 'uidAppSeller', displayName: 'app seller', status: 'approved' })
  await seed('users/uidAppSellerNamed', { uid: 'uidAppSellerNamed', name: 'asn', isSeller: true, isProfileComplete: true })
  await seed('crmUsers/uidAppSellerNamed', { uid: 'uidAppSellerNamed', role: 'seller', isActive: true, status: 'approved', sellerId: 'SL_APP', roleStatus: { seller: 'approved' } })
  await seed('sellers/SL_APP', { crmUid: 'uidAppSellerNamed', displayName: 'named', status: 'approved' })
  await seed('users/uidHost', { uid: 'uidHost', name: 'h', isHost: true, isProfileComplete: true, agencyId: 'AG1' })
  await seed('users/uidHost2', { uid: 'uidHost2', name: 'h2', isHost: true, isProfileComplete: true, agencyId: 'AG2' })
  await seed('users/uidUser', { uid: 'uidUser', name: 'u', isProfileComplete: true })
  await seed('users/uidOther', { uid: 'uidOther', name: 'o', isProfileComplete: true })

  const ctx = (uid, extra = {}) => testEnv.authenticatedContext(uid, { email: `${uid}@example.test`, email_verified: true, ...extra })
  const owner = testEnv.authenticatedContext('uidOwner', { email: 'uidOwner@example.test', email_verified: true, ...OWNER_MFA_TOKEN })
  const ownerUnbound = testEnv.authenticatedContext('uidOwner', { email: 'uidOwner@example.test', email_verified: true, auth_time: 5000, firebase: { sign_in_provider: 'password' } })
  const techAdmin = ctx('uidTechAdmin'), techMember = ctx('uidTechMember')
  const opsAdmin = ctx('uidOpsAdmin'), opsMember = ctx('uidOpsMember')
  const finAdmin = ctx('uidFinAdmin'), finMember = ctx('uidFinMember')
  const mktAdmin = ctx('uidMktAdmin'), support = ctx('uidSupport'), gone = ctx('uidGone')
  const agency = ctx('uidAgency'), agency2 = ctx('uidAgency2')
  const seller = ctx('uidSeller'), seller2 = ctx('uidSeller2'), sellerPending = ctx('uidSellerPending')
  const pendingAg = ctx('uidPendingAg')
  // App users carry no CRM document (except the FX-05 app seller). `auth_time`
  // 2000 ≥ an absent `credentialsValidAfter` (0), so their session is current.
  const phoneCtx = (uid, n) => testEnv.authenticatedContext(uid, { phone_number: `+9198000000${n}`, auth_time: 2000, firebase: { sign_in_provider: 'phone' } })
  const host = phoneCtx('uidHost', '01'), host2 = phoneCtx('uidHost2', '04')
  const user = phoneCtx('uidUser', '02'), other = phoneCtx('uidOther', '03')
  const appSeller = phoneCtx('uidAppSeller', '05'), appSellerNamed = phoneCtx('uidAppSellerNamed', '06')
  // An app seller whose token carries NO contact identity (anonymous).
  const appSellerGuest = testEnv.authenticatedContext('uidAppSeller', { auth_time: 2000, firebase: { sign_in_provider: 'anonymous' } })
  const guest = testEnv.authenticatedContext('uidGuest', { auth_time: 2000, firebase: { sign_in_provider: 'anonymous' } })
  const nobody = testEnv.unauthenticatedContext()

  const TICKET = { title: 'Routed app ticket', description: 'An app user wrote this.', category: 'support',
    priority: 'medium', status: 'open', source: 'app', assignedTeam: 'tech', reportedBy: 'Support', labels: [], attachmentUrls: [] }

  // ══════════════════════════════════════════════════════════════════════════
  console.log('A — Owner MFA boundary (A1/A2/A3): password-only Owner holds no staff grant')
  // ══════════════════════════════════════════════════════════════════════════
  await seed('techTickets/T1', TICKET)
  await ok('A1: a BOUND post-MFA Owner session reads the team board', () => getDoc(D(owner, 'techTickets/T1')))
  await no('A1: the same Owner on a password sign-in (no binding) cannot', () => getDoc(D(ownerUnbound, 'techTickets/T1')))
  await no('A1: …nor list every seller\'s purchase requests', () => getDocs(collection(fs(ownerUnbound), 'coinPurchaseRequests')))
  await no('A1: …nor write appConfig/economy (hasPerm / isSuperAdmin refused)', () => setDoc(D(ownerUnbound, 'appConfig/economy'), { beanRate: 9 }))
  await ok('A1 (unchanged): the unbound Owner still reads its OWN crmUsers document (the MFA login screen)', () => getDoc(D(ownerUnbound, 'crmUsers/uidOwner')))
  await no('A2: the Owner cannot read its own MFA bindings', () => getDoc(D(owner, 'ownerMfaSessions/uidOwner')))
  await no('A2: …nor write them', () => setDoc(D(owner, 'ownerMfaSessions/uidOwner'), OWNER_MFA_BOUND))
  await no('A2: a tech admin cannot read anyone\'s bindings', () => getDoc(D(techAdmin, 'ownerMfaSessions/uidOwner')))
  await no('A3: the Owner cannot write gateAnswers on its own login (gate removed)', () => updateDoc(D(owner, 'crmUsers/uidOwner'), { gateAnswers: { q1: 'a' } }))
  await no('A3: …nor onto a member\'s login', () => updateDoc(D(owner, 'crmUsers/uidOpsMember'), { gateAnswers: { q1: 'a' } }))

  // ══════════════════════════════════════════════════════════════════════════
  console.log('B — hotfix-1 hunks carried into RC2 (A-1, R-3, A-5, R-2)')
  // ══════════════════════════════════════════════════════════════════════════
  const PROFILE = { name: 'Pat', gender: 'f', dob: 1, age: 30, city: 'Pune', country: 'IN', languages: ['en'],
    bio: '', isProfileComplete: true, isOnline: true, lastSeen: 1 }
  await seed('users/uidGuest', { uid: 'uidGuest', name: '', photoUrl: '', phoneNumber: '', isProfileComplete: false, createdAt: new Date(), lastSeen: 1 })
  await ok('B1 (A-1): a guest on a pre-19 build saves its profile with email: "" and phoneNumber: ""',
    () => setDoc(D(guest, 'users/uidGuest'), { ...PROFILE, email: '', phoneNumber: '' }, { merge: true }))
  await no('B1 (A-1): a guest still cannot write a typed email', () => setDoc(D(guest, 'users/uidGuest'), { email: 'typed@example.test' }, { merge: true }))
  await seed('users/uidHasBoth', { uid: 'uidHasBoth', name: 'b', email: 'old@example.test', phoneNumber: '+919800000021', isProfileComplete: true })
  const hasBoth = testEnv.authenticatedContext('uidHasBoth', { phone_number: '+919800000021', auth_time: 2000, firebase: { sign_in_provider: 'phone' } })
  await no('B1 (A-1): an existing email is not CLEARED by writing ""', () => updateDoc(D(hasBoth, 'users/uidHasBoth'), { email: '' }))

  await seed('calls/CALL1', { callerId: 'uidUser', receiverId: 'uidHost', status: 'active', startedAt: new Date(), perMinRateDiamonds: 10, tickIndex: 1 })
  await seed('callHistory/CH1', { callerUid: 'uidUser', receiverUid: 'uidHost', durationSeconds: 60, beansEarned: 5, timestamp: new Date() })
  for (const [who, c] of [['the owner', owner], ['an ops admin', opsAdmin], ['a marketing admin', mktAdmin], ['the caller', user], ['a guest', guest]]) {
    await no(`B2 (R-3): ${who} cannot edit the bill (calls)`, () => updateDoc(D(c, 'calls/CALL1'), { tickIndex: 99 }))
    await no(`B2 (R-3): ${who} cannot edit a call history row`, () => updateDoc(D(c, 'callHistory/CH1'), { beansEarned: 9999 }))
  }
  await ok('B2 (unchanged): the caller reads the call', () => getDoc(D(user, 'calls/CALL1')))
  await ok('B2 (unchanged): a staff member reads a history row', () => getDoc(D(opsMember, 'callHistory/CH1')))
  await ok('B2 (unchanged): a party posts in-call chat',
    () => setDoc(D(user, 'calls/CALL1/messages/m1'), { senderUid: 'uidUser', senderName: 'u', message: 'hi', timestamp: Date.now() }))

  await seed('appConfig/androidUpdate', { debug: { versionCode: 19, mandatory: false, minSupportedVersionCode: 19 } })
  const UPDATE_ORDER = { debug: { versionCode: 99, mandatory: true, url: 'https://example.invalid/evil.apk', sha256: 'f'.repeat(64) } }
  for (const [who, c] of [['a tech member', techMember], ['a tech admin', techAdmin], ['the owner', owner]]) {
    await no(`B3 (A-5): ${who} cannot write the update order`, () => setDoc(D(c, 'appConfig/androidUpdate'), UPDATE_ORDER))
  }
  await ok('B3 (unchanged): the update order is readable BEFORE sign-in', () => getDoc(D(nobody, 'appConfig/androidUpdate')))

  await seed('coinPurchaseRequests/P1', { sellerUid: 'SL1', coinsRequested: 100, status: 'pending' })
  await seed('coinPurchaseRequests/P2', { sellerUid: 'SL2', coinsRequested: 200, status: 'pending' })
  const cpr = (c) => collection(fs(c), 'coinPurchaseRequests')
  await ok('B4 (R-2): finance lists every request', () => getDocs(cpr(finMember)))
  await ok('B4 (R-2): a seller lists its own (filtered)', () => getDocs(query(cpr(seller), where('sellerUid', '==', 'SL1'))))
  await no('B4 (R-2): a seller cannot list every request', () => getDocs(cpr(seller)))
  await no('B4 (R-2): a seller cannot list another seller\'s', () => getDocs(query(cpr(seller), where('sellerUid', '==', 'SL2'))))
  await no('B4 (R-2): an agency cannot list purchase requests', () => getDocs(cpr(agency)))
  await no('B4 (R-2): a pending self-signup login cannot list them', () => getDocs(cpr(pendingAg)))

  // ══════════════════════════════════════════════════════════════════════════
  console.log('C — working-tree hunks: staffRoster + crmUsers narrowing (C1), tickets API form (C2, C3)')
  // ══════════════════════════════════════════════════════════════════════════
  await seed('staffRoster/uidOpsMember', { uid: 'uidOpsMember', name: 'Ops Member', role: 'ops_member', dept: 'ops', isActive: true })
  await ok('C1: a support member lists the roster', () => getDocs(collection(fs(support), 'staffRoster')))
  await ok('C1: a tech member reads a roster entry', () => getDoc(D(techMember, 'staffRoster/uidOpsMember')))
  for (const [who, c] of [['an agency', agency], ['a seller', seller], ['a user', user], ['a guest', guest], ['a signed-out caller', nobody], ['a deactivated login', gone], ['an unbound Owner', ownerUnbound]]) {
    await no(`C1: ${who} cannot read the roster`, () => getDocs(collection(fs(c), 'staffRoster')))
  }
  await no('C1: no client writes the roster (not even the Owner)', () => setDoc(D(owner, 'staffRoster/uidX'), { name: 'x', role: 'ops_admin' }))
  await ok('C1: a person reads their own crmUsers document', () => getDoc(D(opsMember, 'crmUsers/uidOpsMember')))
  await ok('C1: the Owner reads any crmUsers document', () => getDoc(D(owner, 'crmUsers/uidOpsMember')))
  await ok('C1: an ops ADMIN reads an ops MEMBER (same department)', () => getDoc(D(opsAdmin, 'crmUsers/uidOpsMember')))
  await no('C1: a tech admin cannot read an ops member (other department)', () => getDoc(D(techAdmin, 'crmUsers/uidOpsMember')))
  await no('C1: an ops member cannot read a colleague\'s contact details', () => getDoc(D(opsMember, 'crmUsers/uidTechMember')))
  await no('C1: an ops admin cannot read another ADMIN', () => getDoc(D(opsAdmin, 'crmUsers/uidTechAdmin')))
  await no('C1: an agency cannot read a staff document', () => getDoc(D(agency, 'crmUsers/uidOpsMember')))

  for (const [who, c] of [['the owner', owner], ['a tech admin', techAdmin], ['an ops member', opsMember], ['a support member', support]]) {
    await ok(`C2: ${who} reads an internal ticket`, () => getDoc(D(c, 'techTickets/T1')))
    await no(`C2: ${who} cannot file a ticket from the browser (tickets API only)`, () => setDoc(D(c, `techTickets/T_${rnd()}`), TICKET))
    await no(`C2: ${who} cannot move a ticket from the browser`, () => updateDoc(D(c, 'techTickets/T1'), { status: 'in_progress' }))
  }
  for (const [who, c] of [['an agency', agency], ['a seller', seller], ['a pending self-signup login', pendingAg], ['a user', user], ['a guest', guest], ['a signed-out caller', nobody], ['a deactivated login', gone]]) {
    await no(`C2: ${who} cannot read an internal ticket`, () => getDoc(D(c, 'techTickets/T1')))
  }
  await no('C2 (unchanged): an ops member cannot delete a ticket', () => deleteDoc(D(opsMember, 'techTickets/T1')))
  await ok('C2 (unchanged): the Owner deletes a ticket', () => deleteDoc(D(owner, 'techTickets/T1')))

  const FEEDBACK = (uid) => ({ userId: uid, subject: 'Hi', message: 'Broken', status: 'open', createdAt: new Date() })
  await ok('C3: an app user files feedback in its own name', () => setDoc(D(user, 'feedbackTickets/F1'), FEEDBACK('uidUser')))
  await no('C3: …not in somebody else\'s name', () => setDoc(D(user, 'feedbackTickets/F2'), FEEDBACK('uidOther')))
  await ok('C3: the user reads its own feedback', () => getDoc(D(user, 'feedbackTickets/F1')))
  await ok('C3: …and lists it (FeedbackScreen query)', () => getDocs(query(collection(fs(user), 'feedbackTickets'), where('userId', '==', 'uidUser'))))
  await no('C3: another user cannot read it', () => getDoc(D(other, 'feedbackTickets/F1')))
  for (const [who, c] of [['an ops member', opsMember], ['a support member', support], ['a marketing admin', mktAdmin], ['the owner', owner]]) {
    await ok(`C3: ${who} reads feedback`, () => getDoc(D(c, 'feedbackTickets/F1')))
    await no(`C3: ${who} cannot change feedback from the browser (tickets API)`, () => updateDoc(D(c, 'feedbackTickets/F1'), { status: 'resolved' }))
    await no(`C3: ${who} cannot delete feedback from the browser`, () => deleteDoc(D(c, 'feedbackTickets/F1')))
  }
  await no('C3: the user cannot edit its own feedback after filing', () => updateDoc(D(user, 'feedbackTickets/F1'), { message: 'changed' }))
  await no('C3: a tech member (no support role) cannot read feedback', () => getDoc(D(techMember, 'feedbackTickets/F1')))
  await ok('C3: an app user files a support ticket in its own name', () => setDoc(D(user, 'supportTickets/S1'), FEEDBACK('uidUser')))
  await ok('C3: support reads a support ticket', () => getDoc(D(support, 'supportTickets/S1')))
  await no('C3: support cannot change a support ticket from the browser', () => updateDoc(D(support, 'supportTickets/S1'), { status: 'closed' }))
  await no('C3: the owner cannot delete a support ticket from the browser', () => deleteDoc(D(owner, 'supportTickets/S1')))

  // ══════════════════════════════════════════════════════════════════════════
  console.log('D1 — weeklyPayoutReports/{id}/hostPayouts: Finance/admin, the row\'s agency, the host; no client write')
  // ══════════════════════════════════════════════════════════════════════════
  await seed('weeklyPayoutReports/W1', { weekLabel: 'W1', status: 'generated', createdAt: new Date(), agencySummaries: [] })
  const ROW = (agencyId, hostUid) => ({ agencyId, agencyName: agencyId, hostUid, hostName: hostUid, weekBeans: 100, hostPayoutInr: 50,
    weekLabel: 'W1', weekStart: new Date(), weekEnd: new Date(), status: 'pending', eligible: true, createdAt: new Date() })
  await seed('weeklyPayoutReports/W1/hostPayouts/AG1_uidHost', ROW('AG1', 'uidHost'))
  await seed('weeklyPayoutReports/W1/hostPayouts/AG2_uidHost2', ROW('AG2', 'uidHost2'))
  const rows = (c) => collection(fs(c), 'weeklyPayoutReports/W1/hostPayouts')
  for (const [who, c] of [['a finance member', finMember], ['a finance admin', finAdmin], ['an ops admin', opsAdmin], ['the owner', owner]]) {
    await ok(`D1: ${who} lists every row of a report (the payouts page)`, () => getDocs(rows(c)))
    await ok(`D1: ${who} gets one row`, () => getDoc(D(c, 'weeklyPayoutReports/W1/hostPayouts/AG1_uidHost')))
  }
  await ok('D1: the report\'s agency owner lists the rows of ITS agency (where agencyId == own)', () => getDocs(query(rows(agency), where('agencyId', '==', 'AG1'))))
  await ok('D1: the agency owner gets one of its own rows', () => getDoc(D(agency, 'weeklyPayoutReports/W1/hostPayouts/AG1_uidHost')))
  await ok('D1: the second agency gets its own row', () => getDoc(D(agency2, 'weeklyPayoutReports/W1/hostPayouts/AG2_uidHost2')))
  await no('D1: an agency cannot list a report\'s rows unconstrained', () => getDocs(rows(agency)))
  await no('D1: an agency cannot list another agency\'s rows', () => getDocs(query(rows(agency), where('agencyId', '==', 'AG2'))))
  await no('D1: an agency cannot get another agency\'s row', () => getDoc(D(agency2, 'weeklyPayoutReports/W1/hostPayouts/AG1_uidHost')))
  await no('D1: the host named on a row cannot read it (no app reader; the legacy host arm is not copied)', () => getDoc(D(host, 'weeklyPayoutReports/W1/hostPayouts/AG1_uidHost')))
  await no('D1: …nor list its rows (where hostUid == me)', () => getDocs(query(rows(host), where('hostUid', '==', 'uidHost'))))
  await no('D1: a host cannot read another host\'s row', () => getDoc(D(host2, 'weeklyPayoutReports/W1/hostPayouts/AG1_uidHost')))
  for (const [who, c] of [['an ordinary user', user], ['a guest', guest], ['a signed-out caller', nobody], ['an ops member (not admin, not finance)', opsMember], ['a seller', seller], ['an unbound Owner', ownerUnbound]]) {
    await no(`D1: ${who} cannot read payout rows`, () => getDocs(rows(c)))
  }
  for (const [who, c] of [['the owner', owner], ['a finance admin', finAdmin], ['the agency', agency], ['the host', host], ['a user', user]]) {
    await no(`D1: ${who} cannot create a payout row`, () => setDoc(D(c, `weeklyPayoutReports/W1/hostPayouts/X_${rnd()}`), ROW('AG1', 'uidUser')))
    await no(`D1: ${who} cannot edit a payout row`, () => updateDoc(D(c, 'weeklyPayoutReports/W1/hostPayouts/AG1_uidHost'), { hostPayoutInr: 999999 }))
    await no(`D1: ${who} cannot delete a payout row`, () => deleteDoc(D(c, 'weeklyPayoutReports/W1/hostPayouts/AG1_uidHost')))
  }
  await ok('D1 (unchanged): finance reads the report document', () => getDoc(D(finMember, 'weeklyPayoutReports/W1')))
  await ok('D1 (unchanged): finance approves the report (approvePayoutReport)', () => updateDoc(D(finAdmin, 'weeklyPayoutReports/W1'), { status: 'approved', approvedBy: 'uidFinAdmin', approvedAt: new Date() }))
  await no('D1 (unchanged): a host cannot read the report document', () => getDoc(D(host, 'weeklyPayoutReports/W1')))

  // ══════════════════════════════════════════════════════════════════════════
  console.log('D2 — top-level hostPayouts (legacy): the agency update arm is closed; reads unchanged')
  // ══════════════════════════════════════════════════════════════════════════
  await seed('hostPayouts/HP1', { reportId: 'W1', agencyId: 'AG1', agencyOwnerUid: 'uidAgency', hostUid: 'uidHost', payoutAmount: 50, status: 'pending' })
  await no('D2 (R-11): the agency named as agencyOwnerUid cannot rewrite a legacy payout row', () => updateDoc(D(agency, 'hostPayouts/HP1'), { payoutAmount: 999999 }))
  await no('D2 (R-11): …not even its status', () => updateDoc(D(agency, 'hostPayouts/HP1'), { status: 'paid' }))
  await ok('D2 (unchanged): the agency named as agencyOwnerUid still reads it', () => getDoc(D(agency, 'hostPayouts/HP1')))
  await ok('D2 (unchanged): the host reads its own', () => getDoc(D(host, 'hostPayouts/HP1')))
  await ok('D2 (unchanged): finance lists the legacy rows for a report (the fallback query)', () => getDocs(query(collection(fs(finMember), 'hostPayouts'), where('reportId', '==', 'W1'))))
  await ok('D2 (unchanged): finance may still update a legacy row', () => updateDoc(D(finAdmin, 'hostPayouts/HP1'), { status: 'paid' }))
  await no('D2 (unchanged): a user cannot read it', () => getDoc(D(user, 'hostPayouts/HP1')))

  // ══════════════════════════════════════════════════════════════════════════
  console.log('D3 — salaryRequests: the decision may name its actor, and only truthfully')
  // ══════════════════════════════════════════════════════════════════════════
  const SR = (status, extra = {}) => ({ agencyId: 'AG1', agencyOwnerUid: 'uidAgency', hostUid: 'uidHost', hostName: 'h', amountInr: 500, beansEarned: 1000,
    status, createdAt: new Date(), ...extra })
  await seed('salaryRequests/SR_A', SR('pending'))
  await seed('salaryRequests/SR_B', SR('pending'))
  await seed('salaryRequests/SR_C', SR('pending'))
  await seed('salaryRequests/SR_D', SR('pending'))
  await seed('salaryRequests/SR_E', SR('pending'))
  await seed('salaryRequests/SR_F', SR('pending'))
  await seed('salaryRequests/SR_G', SR('pending'))
  await seed('salaryRequests/SR_H', SR('approved', { approvedBy: 'uidFinAdmin' }))
  await ok('D3: finance approves naming itself as approvedBy (C-8 actor)', () => updateDoc(D(finAdmin, 'salaryRequests/SR_A'), { status: 'approved', approvedAt: new Date(), approvedBy: 'uidFinAdmin' }))
  await ok('D3: a finance member approves naming itself', () => updateDoc(D(finMember, 'salaryRequests/SR_B'), { status: 'approved', approvedAt: new Date(), approvedBy: 'uidFinMember' }))
  await ok('D3: the Owner approves naming itself', () => updateDoc(D(owner, 'salaryRequests/SR_C'), { status: 'approved', approvedAt: new Date(), approvedBy: 'uidOwner' }))
  await no('D3: finance cannot name SOMEBODY ELSE as the approver', () => updateDoc(D(finAdmin, 'salaryRequests/SR_D'), { status: 'approved', approvedAt: new Date(), approvedBy: 'uidOwner' }))
  await no('D3: no other actor spelling is admitted (approvedByUid, even its own uid)', () => updateDoc(D(finAdmin, 'salaryRequests/SR_D'), { status: 'approved', approvedAt: new Date(), approvedByUid: 'uidFinAdmin' }))
  await no('D3: a stored actor cannot be removed with the decision', () => updateDoc(D(finAdmin, 'salaryRequests/SR_H'), { status: 'rejected', rejectionReason: 'x', approvedBy: deleteField() }))
  await ok('D3: finance rejects naming itself', () => updateDoc(D(finAdmin, 'salaryRequests/SR_E'), { status: 'rejected', rejectedAt: new Date(), rejectionReason: 'no', approvedBy: 'uidFinAdmin' }))
  await ok('D3 (unchanged): the old write without an actor still passes (today\'s Client.tsx)', () => updateDoc(D(finAdmin, 'salaryRequests/SR_F'), { status: 'approved', approvedAt: new Date() }))
  await ok('D3: rejecting an approved request without touching the stored approvedBy is fine', () => updateDoc(D(finAdmin, 'salaryRequests/SR_H'), { status: 'rejected', rejectionReason: 'reversed' }))
  await no('D3 (unchanged): amountInr still cannot move with the decision', () => updateDoc(D(finAdmin, 'salaryRequests/SR_G'), { status: 'approved', approvedBy: 'uidFinAdmin', amountInr: 99999 }))
  await no('D3 (unchanged): `paid` is never written from a browser', () => updateDoc(D(finAdmin, 'salaryRequests/SR_G'), { status: 'paid', approvedBy: 'uidFinAdmin' }))
  await no('D3 (unchanged): the agency cannot approve its own request, actor or not', () => updateDoc(D(agency, 'salaryRequests/SR_G'), { status: 'approved', approvedBy: 'uidAgency' }))
  await no('D3 (unchanged): an ops admin (isAdmin by spelling) cannot approve', () => updateDoc(D(opsAdmin, 'salaryRequests/SR_G'), { status: 'approved', approvedBy: 'uidOpsAdmin' }))
  await no('D3: an unbound Owner cannot approve', () => updateDoc(D(ownerUnbound, 'salaryRequests/SR_G'), { status: 'approved', approvedBy: 'uidOwner' }))

  // ══════════════════════════════════════════════════════════════════════════
  console.log('D4 — users: the ban\'s scope/category/evidence and the hold\'s reason/stamp are server-only')
  // ══════════════════════════════════════════════════════════════════════════
  await seed('users/uidBanned', { uid: 'uidBanned', name: 'bn', isProfileComplete: true, isBanned: true, accountState: 'banned',
    banReason: 'fraud', banScope: 'account', banCategory: 'fraud', banEvidence: ['https://example.invalid/1.png'],
    payoutHold: true, payoutHoldReason: 'frozen_for_owner_review: a ban', payoutHoldAt: new Date(), credentialsValidAfter: 1000 })
  const banned = phoneCtx('uidBanned', '07')
  for (const [field, value] of [['banScope', 'none'], ['banCategory', ''], ['banEvidence', []], ['payoutHoldReason', ''], ['payoutHoldAt', null], ['credentialsValidAfter', 0]]) {
    await no(`D4: a banned account cannot write its own ${field}`, () => updateDoc(D(banned, 'users/uidBanned'), { [field]: value }))
    await no(`D4: an active account cannot write its own ${field} either`, () => updateDoc(D(user, 'users/uidUser'), { [field]: value }))
    await no(`D4: a staff browser cannot write ${field} on somebody's document`, () => updateDoc(D(opsAdmin, 'users/uidBanned'), { [field]: value }))
    await no(`D4: the Owner's browser cannot write ${field} either`, () => updateDoc(D(owner, 'users/uidBanned'), { [field]: value }))
  }
  await no('D4: a banned account cannot delete the evidence list', () => updateDoc(D(banned, 'users/uidBanned'), { banEvidence: deleteField() }))
  await ok('D4 (unchanged): an active account still edits its bio', () => updateDoc(D(user, 'users/uidUser'), { bio: 'hello' }))
  await ok('D4 (unchanged): staff still write an unprotected field (warnings list)', () => updateDoc(D(opsAdmin, 'users/uidUser'), { warnings: [{ reason: 'x' }] }))
  await ok('D4 (unchanged): the banned account reads its own ban fields', () => getDoc(D(banned, 'users/uidBanned')))

  // ══════════════════════════════════════════════════════════════════════════
  console.log('D5 — users: gender is set once')
  // ══════════════════════════════════════════════════════════════════════════
  await seed('users/uidSetup', { uid: 'uidSetup', name: '', photoUrl: '', isProfileComplete: false, createdAt: new Date(), lastSeen: 1 })
  const setup = phoneCtx('uidSetup', '08')
  await ok('D5: profile setup writes gender onto a document that has none', () => setDoc(D(setup, 'users/uidSetup'), { ...PROFILE, gender: 'male' }, { merge: true }))
  await ok('D5: re-saving the profile with the SAME gender is no change', () => setDoc(D(setup, 'users/uidSetup'), { ...PROFILE, gender: 'male', bio: 'x' }, { merge: true }))
  await no('D5: changing it afterwards is refused', () => updateDoc(D(setup, 'users/uidSetup'), { gender: 'female' }))
  await no('D5: …also inside a full profile save', () => setDoc(D(setup, 'users/uidSetup'), { ...PROFILE, gender: 'female' }, { merge: true }))
  await no('D5: …and it cannot be removed', () => updateDoc(D(setup, 'users/uidSetup'), { gender: deleteField() }))
  await ok('D5 (unchanged): the other profile fields still move', () => updateDoc(D(setup, 'users/uidSetup'), { bio: 'y', city: 'Delhi' }))
  await seed('users/uidEmptyGender', { uid: 'uidEmptyGender', name: 'e', gender: '', isProfileComplete: false })
  const emptyGender = phoneCtx('uidEmptyGender', '09')
  await ok('D5: an explicitly empty stored gender may be set', () => updateDoc(D(emptyGender, 'users/uidEmptyGender'), { gender: 'female' }))
  await seed('users/uidNullGender', { uid: 'uidNullGender', name: 'n', gender: null, isProfileComplete: false })
  const nullGender = phoneCtx('uidNullGender', '10')
  await ok('D5: a null stored gender may be set', () => updateDoc(D(nullGender, 'users/uidNullGender'), { gender: 'male' }))
  await ok('D5 (unchanged): a staff browser may still correct a gender (staff arm, no CRM screen does)', () => updateDoc(D(opsAdmin, 'users/uidSetup'), { gender: 'other' }))

  // ══════════════════════════════════════════════════════════════════════════
  console.log('D6 — notifications: the addressee reads; nobody writes from a client')
  // ══════════════════════════════════════════════════════════════════════════
  const NOTICE = (uid) => ({ userId: uid, type: 'ticket_reply', title: 'Reply', body: 'We looked at it.', relatedId: 'F1', createdAt: new Date(), isRead: false })
  await seed('notifications/N1', NOTICE('uidUser'))
  await seed('notifications/N2', NOTICE('uidOther'))
  await ok('D6: the addressee reads its notice', () => getDoc(D(user, 'notifications/N1')))
  await ok('D6: …and lists its notices (myNotificationsFlow query)', () => getDocs(query(collection(fs(user), 'notifications'), where('userId', '==', 'uidUser'))))
  await no('D6: another user cannot read it', () => getDoc(D(other, 'notifications/N1')))
  await no('D6: a user cannot list every notice', () => getDocs(collection(fs(user), 'notifications')))
  await no('D6: an ops admin cannot read somebody\'s notice (admin read arm removed; nothing in the CRM reads it)', () => getDoc(D(opsAdmin, 'notifications/N1')))
  await no('D6: the Owner cannot either', () => getDoc(D(owner, 'notifications/N1')))
  await no('D6: a guest cannot', () => getDoc(D(guest, 'notifications/N1')))
  await no('D6: a signed-out caller cannot', () => getDoc(D(nobody, 'notifications/N1')))
  for (const [who, c] of [['an ops admin', opsAdmin], ['a marketing admin', mktAdmin], ['the owner', owner], ['a support member', support], ['the addressee', user], ['a guest', guest]]) {
    await no(`D6: ${who} cannot create a notice`, () => setDoc(D(c, `notifications/N_${rnd()}`), NOTICE('uidOther')))
    await no(`D6: ${who} cannot edit a notice`, () => updateDoc(D(c, 'notifications/N1'), { body: 'Pay here: …' }))
    await no(`D6: ${who} cannot delete a notice`, () => deleteDoc(D(c, 'notifications/N1')))
  }
  await no('D6: the addressee cannot mark its own notice read from a client (nothing in the app does)', () => updateDoc(D(user, 'notifications/N1'), { isRead: true }))

  // ══════════════════════════════════════════════════════════════════════════
  console.log('D7 / D10 — appConfig: paymentCredentials is not for every token; the rest reads as before')
  // ══════════════════════════════════════════════════════════════════════════
  await seed('appConfig/paymentCredentials', { bankName: 'B', bankAccount: '000', bankIfsc: 'X', bankHolder: 'Z', binanceUid: '1' })
  await seed('appConfig/economy', { beanRate: 1 })
  await seed('appConfig/control', { maintenance: false })
  await seed('appConfig/luckyGifts', { version: 1, combos: [], receiverPct: 50, odds: [] })
  const creds = (c) => getDoc(D(c, 'appConfig/paymentCredentials'))
  for (const [who, c] of [['the owner', owner], ['a tech member', techMember], ['a finance member', finMember], ['a support member', support], ['a marketing admin', mktAdmin]]) {
    await ok(`D7: ${who} reads paymentCredentials (staff)`, () => creds(c))
  }
  await ok('D7: a CRM seller with a STARTED seller role reads them (BuyInventoryDialog)', () => creds(seller))
  await ok('D7: an app seller on a legacy uid-keyed APPROVED record, phone on the token, reads them (BuyCoinScreen)', () => creds(appSeller))
  await ok('D7: an app seller whose login names its approved record (FX-05 id) reads them', () => creds(appSellerNamed))
  await no('D7: a PENDING CRM seller cannot', () => creds(sellerPending))
  await no('D7: an agency cannot', () => creds(agency))
  await no('D7: a pending self-signup login cannot', () => creds(pendingAg))
  await no('D7: an ordinary user cannot', () => creds(user))
  await no('D7: a host cannot', () => creds(host))
  await no('D7: a guest cannot', () => creds(guest))
  await no('D7: an app seller on an ANONYMOUS token (no verified contact) cannot', () => creds(appSellerGuest))
  await no('D7: a signed-out caller cannot', () => creds(nobody))
  await no('D7: a deactivated staff login cannot', () => creds(gone))
  await no('D7: an unbound Owner cannot', () => creds(ownerUnbound))
  await ok('D7 (unchanged): a guest reads appConfig/economy', () => getDoc(D(guest, 'appConfig/economy')))
  await ok('D7 (unchanged): a user reads appConfig/control', () => getDoc(D(user, 'appConfig/control')))
  await no('D7 (unchanged): a signed-out caller cannot read appConfig/economy', () => getDoc(D(nobody, 'appConfig/economy')))
  await no('D7 (unchanged): a signed-out caller cannot read appConfig/control', () => getDoc(D(nobody, 'appConfig/control')))
  await ok('D10: a signed-in user reads appConfig/luckyGifts (the gift sheet)', () => getDoc(D(user, 'appConfig/luckyGifts')))
  await ok('D10: a guest reads luckyGifts too', () => getDoc(D(guest, 'appConfig/luckyGifts')))
  await ok('D10: a tech member writes luckyGifts (the CRM page after the server guard)', () => setDoc(D(techMember, 'appConfig/luckyGifts'), { version: 2, combos: [], receiverPct: 50, odds: [], updatedBy: 'uidTechMember' }))
  await ok('D10: the Owner writes luckyGifts', () => updateDoc(D(owner, 'appConfig/luckyGifts'), { version: 3 }))
  await no('D10: an ops admin cannot write luckyGifts', () => updateDoc(D(opsAdmin, 'appConfig/luckyGifts'), { receiverPct: 100 }))
  await no('D10: a user cannot write luckyGifts', () => updateDoc(D(user, 'appConfig/luckyGifts'), { receiverPct: 100 }))
  await no('D10: an unbound Owner cannot write luckyGifts', () => updateDoc(D(ownerUnbound, 'appConfig/luckyGifts'), { version: 9 }))
  await no('D15: a tech admin cannot switch lucky gifts on (enabled is the Owner\'s)', () => updateDoc(D(techAdmin, 'appConfig/luckyGifts'), { enabled: true, version: 4 }))
  await ok('D7 (unchanged): the Owner writes paymentCredentials', () => updateDoc(D(owner, 'appConfig/paymentCredentials'), { bankName: 'C' }))
  await no('D7 (unchanged): a tech admin cannot write paymentCredentials', () => updateDoc(D(techAdmin, 'appConfig/paymentCredentials'), { bankName: 'D' }))
  await no('D7: a CRM seller who may READ the credentials cannot write them', () => updateDoc(D(seller, 'appConfig/paymentCredentials'), { bankAccount: '999' }))

  // ══════════════════════════════════════════════════════════════════════════
  console.log('D8 — hostKyc: admins and the host only')
  // ══════════════════════════════════════════════════════════════════════════
  await seed('hostKyc/uidHost', { accountNumber: '000111222', ifscCode: 'ZIPR0000001' })
  await ok('D8: the host reads its own', () => getDoc(D(host, 'hostKyc/uidHost')))
  await ok('D8: an ops admin reads it', () => getDoc(D(opsAdmin, 'hostKyc/uidHost')))
  await ok('D8: the Owner reads it', () => getDoc(D(owner, 'hostKyc/uidHost')))
  await no('D8 (R-8): another user cannot read it although the host has an agencyId', () => getDoc(D(other, 'hostKyc/uidHost')))
  await no('D8 (R-8): a guest cannot', () => getDoc(D(guest, 'hostKyc/uidHost')))
  await no('D8 (R-8): the host\'s own agency login cannot (no agency screen reads it)', () => getDoc(D(agency, 'hostKyc/uidHost')))
  await no('D8 (R-8): an ops member (not admin) cannot', () => getDoc(D(opsMember, 'hostKyc/uidHost')))
  await no('D8 (R-8): a signed-out caller cannot', () => getDoc(D(nobody, 'hostKyc/uidHost')))
  await ok('D8 (unchanged): a staff admin still writes it', () => updateDoc(D(opsAdmin, 'hostKyc/uidHost'), { ifscCode: 'ZIPR0000002' }))
  await no('D8 (unchanged): the host cannot write it', () => updateDoc(D(host, 'hostKyc/uidHost'), { accountNumber: '42' }))

  // ══════════════════════════════════════════════════════════════════════════
  console.log('D9 — followers: the follower writes its own row; giftsReceived: no client create')
  // ══════════════════════════════════════════════════════════════════════════
  const FOLLOW = (uid) => ({ uid, followedAt: new Date() })
  await ok('D9: a user follows a host (writes users/{host}/followers/{me})', () => setDoc(D(user, 'users/uidHost/followers/uidUser'), FOLLOW('uidUser')))
  await ok('D9 (unchanged): …and its own following row', () => setDoc(D(user, 'users/uidUser/following/uidHost'), FOLLOW('uidHost')))
  await no('D9 (R-10): a user cannot plant a follower row under somebody else\'s name', () => setDoc(D(user, 'users/uidHost/followers/uidOther'), FOLLOW('uidOther')))
  await seed('users/uidHost/followers/uidOther', FOLLOW('uidOther'))
  await no('D9 (R-10): a user cannot delete another follower\'s row', () => deleteDoc(D(user, 'users/uidHost/followers/uidOther')))
  await no('D9 (R-10): the followed host cannot edit a follower\'s row either', () => updateDoc(D(host, 'users/uidHost/followers/uidOther'), { uid: 'x' }))
  await no('D9 (R-10): a guest cannot plant a follower row', () => setDoc(D(guest, 'users/uidHost/followers/uidUser'), FOLLOW('uidUser')))
  await ok('D9: the follower unfollows (deletes its own row)', () => deleteDoc(D(user, 'users/uidHost/followers/uidUser')))
  await ok('D9 (unchanged): anyone signed in reads a followers list (counts)', () => getDocs(collection(fs(other), 'users/uidHost/followers')))
  await no('D9 (unchanged): a user cannot write somebody else\'s following list', () => setDoc(D(user, 'users/uidOther/following/uidHost'), FOLLOW('uidHost')))
  const GIFT = { giftId: 'rose', count: 999, fromUid: 'uidUser', at: new Date() }
  await no('D9 (R-10): a user cannot create a giftsReceived row on a host', () => setDoc(D(user, 'users/uidHost/giftsReceived/g1'), GIFT))
  await no('D9 (R-10): the host cannot create one on itself', () => setDoc(D(host, 'users/uidHost/giftsReceived/g2'), GIFT))
  await no('D9 (R-10): an ops admin cannot create one', () => setDoc(D(opsAdmin, 'users/uidHost/giftsReceived/g3'), GIFT))
  await seed('users/uidHost/giftsReceived/g0', GIFT)
  await ok('D9 (unchanged): a signed-in user reads giftsReceived', () => getDoc(D(other, 'users/uidHost/giftsReceived/g0')))
  await ok('D9 (unchanged): the host still edits its own existing row', () => updateDoc(D(host, 'users/uidHost/giftsReceived/g0'), { count: 1 }))
  await no('D9 (unchanged): another user cannot edit it', () => updateDoc(D(user, 'users/uidHost/giftsReceived/g0'), { count: 5 }))

  // ══════════════════════════════════════════════════════════════════════════
  console.log('D12 / D13 — rateLimits and the party-room PIN secret are server-only')
  // ══════════════════════════════════════════════════════════════════════════
  const BUCKET = 'redeemQuickLogin:dev:0a1b2c3d:1700000000000'
  await seed(`rateLimits/${BUCKET}`, { scope: 'redeemQuickLogin', kind: 'dev', count: 9, windowStartMs: 1700000000000, expiresAt: new Date() })
  for (const [who, c] of [['a signed-out caller', nobody], ['a guest', guest], ['a user', user], ['an ops admin', opsAdmin], ['a tech admin', techAdmin], ['the owner', owner]]) {
    await no(`D12: ${who} cannot read a rate-limit bucket`, () => getDoc(D(c, `rateLimits/${BUCKET}`)))
    await no(`D12: ${who} cannot reset a bucket`, () => setDoc(D(c, `rateLimits/${BUCKET}`), { count: 0 }))
  }
  await no('D12: a user cannot list the buckets', () => getDocs(collection(fs(user), 'rateLimits')))
  await no('D12: the owner cannot delete a bucket', () => deleteDoc(D(owner, `rateLimits/${BUCKET}`)))

  await seed('partyRooms/PR1', { hostUid: 'uidHost', title: 'Room', mode: 'audio', visibility: 'private', isActive: true, passwordAttempts: 0, kickedUsers: [] })
  await seed('partyRooms/PR1/private/secret', { passwordHash: 'f'.repeat(64), passwordSalt: 'salt' })
  await seed('partyRooms/PR1/seats/0', { uid: 'uidHost', selfMuted: false, cameraOff: true })
  await seed('partyRooms/PR1/listeners/uidHost', { uid: 'uidHost', joinedAt: new Date() })
  for (const [who, c] of [['the room host', host], ['a listener', user], ['a guest', guest], ['an ops member', opsMember], ['an ops admin', opsAdmin], ['the owner', owner], ['a signed-out caller', nobody]]) {
    await no(`D13: ${who} cannot read the room's PIN secret`, () => getDoc(D(c, 'partyRooms/PR1/private/secret')))
    await no(`D13: ${who} cannot write it`, () => setDoc(D(c, 'partyRooms/PR1/private/secret'), { passwordHash: '0'.repeat(64), passwordSalt: 'x' }))
  }
  await no('D13: the host cannot list the private subcollection', () => getDocs(collection(fs(host), 'partyRooms/PR1/private')))
  await no('D13: ops cannot delete the secret from a browser (endPartyRoom does it)', () => deleteDoc(D(opsAdmin, 'partyRooms/PR1/private/secret')))
  await ok('D13 (unchanged): any signed-in account reads the room document (the room list)', () => getDoc(D(guest, 'partyRooms/PR1')))
  await ok('D13 (unchanged): …and its seats', () => getDoc(D(user, 'partyRooms/PR1/seats/0')))
  await ok('D13 (unchanged): …and its listeners', () => getDocs(collection(fs(user), 'partyRooms/PR1/listeners')))
  await no('D13 (unchanged): a signed-out caller cannot read the room', () => getDoc(D(nobody, 'partyRooms/PR1')))

  // ══════════════════════════════════════════════════════════════════════════
  console.log('D14 — §5 Host role suspension: the flag is server-only, and a suspended Host does not go live')
  // ══════════════════════════════════════════════════════════════════════════
  // The shape `users.suspend_host` leaves: the role kept (isHost, isVerifiedHost),
  // the suspension beside it. `uidLiveHost` is the same Host, not suspended.
  await seed('users/uidSuspHost', { uid: 'uidSuspHost', name: 'sh', isProfileComplete: true, isHost: true, isVerifiedHost: true,
    agencyId: 'AG1', hostSuspended: true, hostSuspendedReason: 'Repeated no-shows', hostSuspendedAt: new Date(),
    hostSuspendedUntil: new Date(Date.now() + 3 * 864e5), hostSuspensionDays: 3, hostStatusBeforeSuspension: 'active' })
  await seed('users/uidLiveHost', { uid: 'uidLiveHost', name: 'lh', isProfileComplete: true, isHost: true, isVerifiedHost: true, agencyId: 'AG1' })
  const suspHost = phoneCtx('uidSuspHost', '08'), liveHost = phoneCtx('uidLiveHost', '09')
  await no('D14: the suspended Host cannot lift its own suspension (hostSuspended: false)',
    () => updateDoc(D(suspHost, 'users/uidSuspHost'), { hostSuspended: false }))
  await no('D14: a staff browser cannot clear it either (Resume is the API, audited)',
    () => updateDoc(D(opsAdmin, 'users/uidSuspHost'), { hostSuspended: false, hostSuspendedUntil: deleteField() }))
  await no('D14: a suspended verified Host cannot open a live room (mayGoLive)',
    () => setDoc(D(suspHost, 'liveRooms/LR_SUSP'), { hostUid: 'uidSuspHost', title: 't', isActive: true }))
  await ok('D14 (control): the same Host unsuspended opens one',
    () => setDoc(D(liveHost, 'liveRooms/LR_LIVE'), { hostUid: 'uidLiveHost', title: 't', isActive: true }))

  // ══════════════════════════════════════════════════════════════════════════
  console.log('E — C-1 still withheld: the live CRM\'s self-signup login write passes')
  // ══════════════════════════════════════════════════════════════════════════
  await seed('agencies/AG_C1', { crmId: 'C1C1C1C1', agencyName: 'C1 Talents', ownerName: 'C', ownerPhone: '+919800000031',
    ownerEmail: 'c1@example.test', type: 'main', parentAgencyId: null, status: 'pending', kycStatus: 'pending', kycDocUrls: [],
    isActive: false, totalHosts: 0, totalSubAgencies: 0, source: 'self_signup' })
  const applicant = testEnv.authenticatedContext('uidC1', { email: 'c1@example.test', email_verified: true, firebase: { sign_in_provider: 'password' } })
  const LOGIN_AS_WRITTEN_BY_THE_CRM = { uid: 'uidC1', email: 'c1@example.test', name: 'C', phone: '+919800000031', role: 'agency',
    permissions: [], agencyId: 'AG_C1', isActive: true, status: 'pending', createdBy: 'self_signup', createdAt: new Date(), lastLoginAt: null }
  await ok('E (C-1 withheld): the CRM\'s self-signup login write (isActive: true, pending) is accepted', () => setDoc(D(applicant, 'crmUsers/uidC1'), LOGIN_AS_WRITTEN_BY_THE_CRM))
  await no('E → C2: the new pending login cannot read the team board', () => getDoc(D(applicant, 'techTickets/T1')))
  await no('E → D7: …nor the payment credentials', () => getDoc(D(applicant, 'appConfig/paymentCredentials')))
  await no('E → D1: …nor a payout report\'s rows', () => getDocs(rows(applicant)))
}

// ── Result ──────────────────────────────────────────────────────────────────
let aborted = false
try {
  await main()
} catch (err) {
  // Seeding or the harness itself failed: the run is incomplete, and says so.
  aborted = true
  console.error(`ABORTED: ${String(err?.message ?? err).split('\n')[0]}`)
} finally {
  await testEnv.cleanup().catch(() => undefined)
}
if (tally.failures > 0) {
  console.error(`\n${tally.failures} of ${tally.checks} RC2 rule checks FAILED:`)
  for (const f of failed) console.error(`  · ${f}`)
}
if (!aborted && tally.failures === 0) console.log(`\nAll ${tally.checks} RC2 rule checks passed.`)
printResult(aborted)
// Not `process.exit()` here: stdout to a pipe is asynchronous on macOS, and an
// immediate exit can drop the RC2-RESULT line the runner reads.
const code = aborted || tally.failures > 0 ? 1 : 0
process.exitCode = code
setTimeout(() => process.exit(code), 2000).unref()

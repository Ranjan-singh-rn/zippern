/**
 * firestore.rules — HOTFIX-1 (2026-11-01) regression tests (Firestore emulator).
 *
 * Rules under test: hotfix/rules-20261101/firestore.rules — the DEPLOYED text
 * (sha256 17b8ffee…) plus the hotfix-1 hunks, nothing else. ZIPPER_RULES_FILE
 * points the same checks at another rules file (the DEPLOYED text should fail
 * exactly the "new" checks; the Owner-MFA candidate is a different lineage).
 *
 *   R-5  `techTickets` are STAFF-only (`isStaff()`): partners, app users,
 *        guests, signed-out and deactivated logins are refused. Staff still
 *        file and move tickets from the browser — the tickets API is not
 *        deployed, so the working tree's `create, update: if false` is NOT
 *        ported.
 *   R-2  `coinPurchaseRequests` list: admin / finance list everything; a
 *        seller lists only queries constrained to its own record; an agency,
 *        an unfiltered seller query, and every non-CRM login are refused.
 *   A-5  `appConfig/androidUpdate` has no client writer; every other
 *        appConfig document is governed exactly as before, and the update
 *        document stays readable before sign-in.
 *   R-3  `calls/{id}` and `callHistory/{id}` have no client writer at all —
 *        not the parties, not a department admin, not the Owner. Reads and
 *        the in-call chat are unchanged.
 *   A-1  `ownerContactWriteOk()` old-client relief: an EMPTY `email` /
 *        `phoneNumber` written over a document that holds none is "no
 *        change". Non-empty typed values are still refused and an existing
 *        contact is still never cleared or replaced.
 *   C-1  NOT APPLIED (see hotfix/rules-20261101/firestore.rules.C-1.NOT-APPLIED.patch):
 *        the live CRM writes the self-signup login with `isActive: true`.
 *        Pinned here so the decision is visible: that write still passes, and
 *        R-2 / R-5 refuse such a pending login the two things C-1 was raised for.
 *
 * Same harness as firestore.p1gov.rules.test.mjs (ok/no thunks, classified
 * failures, one HOTFIX1-RESULT line). `demo-` project id: never a real project.
 *
 * Run from the repository root (needs Java + firebase CLI):
 *   firebase emulators:exec --only firestore --project demo-zipper "node tests/firestore.hotfix1.rules.test.mjs"
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
const RULES_PATH = process.env.ZIPPER_RULES_FILE || join(here, '..', 'hotfix', 'rules-20261101', 'firestore.rules')
const RULES = readFileSync(RULES_PATH, 'utf8')
const RULES_SHA256 = createHash('sha256').update(RULES, 'utf8').digest('hex')
console.log(`rules under test: ${RULES_PATH}`)
// The exact bytes uploaded to the emulator below — the runner compares this
// with the file it meant to test.
console.log(`rules sha256: ${RULES_SHA256}`)

// ── The check harness ───────────────────────────────────────────────────────
const tally = { checks: 0, failures: 0, ok_denied: 0, ok_error: 0, no_allowed: 0, no_error: 0 }
const failed = []

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
    `HOTFIX1-RESULT checks=${tally.checks} failures=${tally.failures} ok_denied=${tally.ok_denied} ` +
    `ok_error=${tally.ok_error} no_allowed=${tally.no_allowed} no_error=${tally.no_error} ` +
    `aborted=${aborted ? 1 : 0} rules_sha256=${RULES_SHA256}`,
  )
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

// The Owner in this suite acts from a bound post-MFA session (as in
// firestore.p1gov.rules.test.mjs). The DEPLOYED lineage ignores the binding;
// carrying it keeps this suite runnable against the Owner-MFA candidate too.
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

async function main() {
  await testEnv.clearFirestore()

  // ── Who is who ──────────────────────────────────────────────────────────
  const staffDoc = (uid, role, extra = {}) => seed(`crmUsers/${uid}`, { uid, role, isActive: true, status: 'approved', ...extra })
  await staffDoc('uidOwner', 'superadmin')
  await seed('ownerMfaSessions/uidOwner', OWNER_MFA_BOUND)
  await staffDoc('uidTechAdmin', 'tech_admin')
  await staffDoc('uidTechMember', 'tech_member')
  await staffDoc('uidOpsAdmin', 'ops_admin')
  await staffDoc('uidOpsMember', 'ops_member')
  await staffDoc('uidFinAdmin', 'finance_admin')
  await staffDoc('uidFinMember', 'finance_member')
  await staffDoc('uidMktAdmin', 'marketing_admin')
  await staffDoc('uidSupport', 'support_member')
  await staffDoc('uidGone', 'ops_member', { isActive: false })
  await seed('crmUsers/uidAgency', { uid: 'uidAgency', role: 'agency', isActive: true, status: 'approved', agencyId: 'AG1', roleStatus: { agency: 'approved' } })
  await seed('crmUsers/uidSeller', { uid: 'uidSeller', role: 'seller', isActive: true, status: 'approved', sellerId: 'SL1', roleStatus: { seller: 'approved' } })
  await seed('crmUsers/uidSeller2', { uid: 'uidSeller2', role: 'seller', isActive: true, status: 'approved', sellerId: 'SL2', roleStatus: { seller: 'approved' } })
  // A legacy seller login: its seller record is keyed by the login uid, no `sellerId`.
  await seed('crmUsers/uidSellerLegacy', { uid: 'uidSellerLegacy', role: 'seller', isActive: true, status: 'approved' })
  // The document the LIVE CRM writes for a public self-signup (createAgencyAccount):
  // active, pending, no roles/roleStatus. C-1 is about exactly this login.
  await seed('crmUsers/uidPendingAg', { uid: 'uidPendingAg', role: 'agency', isActive: true, status: 'pending', agencyId: 'AG_PEND', createdBy: 'self_signup' })
  await seed('users/uidHost', { uid: 'uidHost', name: 'h', isHost: true, isProfileComplete: true })
  await seed('users/uidUser', { uid: 'uidUser', name: 'u', isProfileComplete: true })
  await seed('users/uidOther', { uid: 'uidOther', name: 'o', isProfileComplete: true })

  const ctx = (uid, extra = {}) => testEnv.authenticatedContext(uid, { email: `${uid}@example.test`, email_verified: true, ...extra })
  const owner = testEnv.authenticatedContext('uidOwner', { email: 'uidOwner@example.test', email_verified: true, ...OWNER_MFA_TOKEN })
  const techAdmin = ctx('uidTechAdmin'), techMember = ctx('uidTechMember')
  const opsAdmin = ctx('uidOpsAdmin'), opsMember = ctx('uidOpsMember')
  const finAdmin = ctx('uidFinAdmin'), finMember = ctx('uidFinMember')
  const mktAdmin = ctx('uidMktAdmin'), support = ctx('uidSupport'), gone = ctx('uidGone')
  const agency = ctx('uidAgency'), seller = ctx('uidSeller'), seller2 = ctx('uidSeller2'), sellerLegacy = ctx('uidSellerLegacy')
  const pendingAg = ctx('uidPendingAg')
  // App users carry no CRM document. `auth_time` 2000 ≥ an absent
  // `credentialsValidAfter` (0), so their session is current.
  const host = testEnv.authenticatedContext('uidHost', { phone_number: '+919800000001', auth_time: 2000, firebase: { sign_in_provider: 'phone' } })
  const user = testEnv.authenticatedContext('uidUser', { phone_number: '+919800000002', auth_time: 2000, firebase: { sign_in_provider: 'phone' } })
  const other = testEnv.authenticatedContext('uidOther', { phone_number: '+919800000003', auth_time: 2000, firebase: { sign_in_provider: 'phone' } })
  const guest = testEnv.authenticatedContext('uidGuest', { auth_time: 2000, firebase: { sign_in_provider: 'anonymous' } })
  const nobody = testEnv.unauthenticatedContext()

  // ══════════════════════════════════════════════════════════════════════════
  console.log('R-5 — internal team tickets are staff-only; staff still write them from the browser')
  // ══════════════════════════════════════════════════════════════════════════
  const TICKET = { title: 'Routed app ticket', description: 'An app user wrote this.', category: 'support',
    priority: 'medium', status: 'open', source: 'app', assignedTeam: 'tech', reportedBy: 'Support', labels: [], attachmentUrls: [] }
  await seed('techTickets/T1', TICKET)

  for (const [who, c] of [['the owner', owner], ['a tech admin', techAdmin], ['a tech member', techMember], ['an ops member', opsMember],
    ['a finance member', finMember], ['a support member', support], ['a marketing admin', mktAdmin]]) {
    await ok(`R-5: ${who} reads an internal ticket`, () => getDoc(D(c, 'techTickets/T1')))
  }
  await ok('R-5: a staff member lists the board', () => getDocs(collection(fs(opsMember), 'techTickets')))
  // Unchanged on purpose: the live CRM files and moves tickets from the
  // browser (routeSupportTicketToTeam, the board). The tickets API is not deployed.
  await ok('R-5: a staff member still files a ticket from the browser (tickets API not deployed)', () => setDoc(D(opsMember, 'techTickets/T_NEW'), TICKET))
  await ok('R-5: a staff member still moves a ticket from the browser', () => updateDoc(D(techAdmin, 'techTickets/T1'), { status: 'in_progress' }))
  await ok('R-5: a support member still routes an app ticket to a team (creates one)', () => setDoc(D(support, 'techTickets/T_ROUTED'), TICKET))

  for (const [who, c] of [['an agency', agency], ['a coin seller', seller], ['a PENDING self-signup login (isActive: true)', pendingAg],
    ['a host', host], ['a normal user', user], ['a guest', guest], ['a signed-out caller', nobody], ['a deactivated staff login', gone]]) {
    await no(`R-5: ${who} cannot read an internal ticket`, () => getDoc(D(c, 'techTickets/T1')))
    await no(`R-5: ${who} cannot list the board`, () => getDocs(collection(fs(c), 'techTickets')))
    await no(`R-5: ${who} cannot file a ticket`, () => setDoc(D(c, `techTickets/T_${Math.random().toString(36).slice(2)}`), TICKET))
    await no(`R-5: ${who} cannot edit a ticket`, () => updateDoc(D(c, 'techTickets/T1'), { status: 'done' }))
  }
  await no('R-5 (unchanged): an ops member cannot delete a ticket', () => deleteDoc(D(opsMember, 'techTickets/T_NEW')))
  await ok('R-5 (unchanged): the owner deletes a ticket', () => deleteDoc(D(owner, 'techTickets/T_NEW')))

  // ══════════════════════════════════════════════════════════════════════════
  console.log('R-2 — a seller lists only its own coin purchase requests; admin / finance list all')
  // ══════════════════════════════════════════════════════════════════════════
  await seed('sellers/SL1', { crmUid: 'uidSeller', displayName: 's1', status: 'approved' })
  await seed('sellers/SL2', { crmUid: 'uidSeller2', displayName: 's2', status: 'approved' })
  await seed('sellers/uidSellerLegacy', { crmUid: 'uidSellerLegacy', displayName: 'legacy', status: 'approved' })
  await seed('coinPurchaseRequests/P1', { sellerUid: 'SL1', coinsRequested: 100, status: 'pending' })
  await seed('coinPurchaseRequests/P2', { sellerUid: 'SL2', coinsRequested: 200, status: 'pending' })
  await seed('coinPurchaseRequests/P3', { sellerUid: 'uidSellerLegacy', coinsRequested: 300, status: 'pending' })
  const cpr = (c) => collection(fs(c), 'coinPurchaseRequests')
  const own = (c, sellerUid) => getDocs(query(cpr(c), where('sellerUid', '==', sellerUid)))

  await ok('R-2 (unchanged): the owner lists every request', () => getDocs(cpr(owner)))
  await ok('R-2 (unchanged): a finance admin lists every request', () => getDocs(cpr(finAdmin)))
  await ok('R-2 (unchanged): a finance member lists every request (the /coin-purchases board)', () => getDocs(cpr(finMember)))
  await ok('R-2 (unchanged): an ops admin lists every request (isAdmin)', () => getDocs(cpr(opsAdmin)))
  await ok('R-2 (unchanged): finance lists with a status filter', () => getDocs(query(cpr(finAdmin), where('status', '==', 'pending'))))
  await ok('R-2: a seller lists its own requests (the seller-dashboard query)', () => own(seller, 'SL1'))
  await ok('R-2: a legacy uid-keyed seller lists its own', () => own(sellerLegacy, 'uidSellerLegacy'))
  await no('R-2: a seller cannot list another seller\'s requests', () => own(seller, 'SL2'))
  await no('R-2: a seller cannot list every request by leaving the filter off', () => getDocs(cpr(seller)))
  await no('R-2: a seller cannot list by status alone (unconstrained on sellerUid)', () => getDocs(query(cpr(seller), where('status', '==', 'pending'))))
  await no('R-2: an agency cannot list purchase requests', () => getDocs(cpr(agency)))
  await no('R-2: an agency cannot list them filtered to some seller either', () => own(agency, 'SL1'))
  await no('R-2: a PENDING self-signup login (isActive: true) cannot list them', () => getDocs(cpr(pendingAg)))
  // New narrowing for staff outside admin / finance: no live CRM screen lists
  // this collection as such a role (/coin-purchases is finance + owner).
  await no('R-2: an ops member (not admin, not finance) cannot list every request', () => getDocs(cpr(opsMember)))
  await no('R-2: a support member cannot list every request', () => getDocs(cpr(support)))
  for (const [who, c] of [['a normal user', user], ['a guest', guest], ['a signed-out caller', nobody], ['a deactivated staff login', gone]]) {
    await no(`R-2: ${who} cannot list purchase requests`, () => getDocs(cpr(c)))
  }
  await ok('R-2 (unchanged): a seller still gets its own request document', () => getDoc(D(seller, 'coinPurchaseRequests/P1')))
  await no('R-2 (unchanged): a seller cannot get another seller\'s request document', () => getDoc(D(seller, 'coinPurchaseRequests/P2')))
  await ok('R-2 (unchanged): finance gets any request document', () => getDoc(D(finMember, 'coinPurchaseRequests/P2')))

  // ══════════════════════════════════════════════════════════════════════════
  console.log('A-5 — appConfig/androidUpdate has no client writer; the rest of appConfig is unchanged')
  // ══════════════════════════════════════════════════════════════════════════
  await seed('appConfig/androidUpdate', { debug: { versionCode: 19, mandatory: false, minSupportedVersionCode: 19 } })
  await seed('appConfig/control', { maintenance: false })
  await seed('appConfig/economy', { beanRate: 1 })
  await seed('appConfig/paymentCredentials', { bank: 'x' })
  const UPDATE_ORDER = { debug: { versionCode: 99, mandatory: true, url: 'https://example.invalid/evil.apk', sha256: 'f'.repeat(64) } }

  for (const [who, c] of [['a tech member', techMember], ['a tech admin', techAdmin], ['the owner', owner], ['an ops admin', opsAdmin]]) {
    await no(`A-5: ${who} cannot overwrite the update order`, () => setDoc(D(c, 'appConfig/androidUpdate'), UPDATE_ORDER))
    await no(`A-5: ${who} cannot edit the update order`, () => updateDoc(D(c, 'appConfig/androidUpdate'), { 'debug.mandatory': true }))
    await no(`A-5: ${who} cannot merge into the update order`, () => setDoc(D(c, 'appConfig/androidUpdate'), { release: UPDATE_ORDER.debug }, { merge: true }))
  }
  await no('A-5: the owner cannot delete the update order', () => deleteDoc(D(owner, 'appConfig/androidUpdate')))
  await no('A-5: a user cannot write the update order', () => setDoc(D(user, 'appConfig/androidUpdate'), UPDATE_ORDER))
  await ok('A-5 (unchanged): a tech admin still writes appConfig/control', () => updateDoc(D(techAdmin, 'appConfig/control'), { maintenance: true }))
  await ok('A-5 (unchanged): a tech member still writes appConfig/economy', () => updateDoc(D(techMember, 'appConfig/economy'), { beanRate: 2 }))
  await ok('A-5 (unchanged): the owner still writes appConfig/economy', () => updateDoc(D(owner, 'appConfig/economy'), { beanRate: 3 }))
  await ok('A-5 (unchanged): the owner still writes paymentCredentials', () => updateDoc(D(owner, 'appConfig/paymentCredentials'), { bank: 'y' }))
  await no('A-5 (unchanged): a tech admin cannot write paymentCredentials', () => updateDoc(D(techAdmin, 'appConfig/paymentCredentials'), { bank: 'z' }))
  await no('A-5 (unchanged): an ops admin cannot write appConfig/control', () => updateDoc(D(opsAdmin, 'appConfig/control'), { maintenance: false }))
  await ok('A-5 (unchanged): the update order is readable BEFORE sign-in (the login-screen updater)', () => getDoc(D(nobody, 'appConfig/androidUpdate')))
  await ok('A-5 (unchanged): a signed-in user reads the update order', () => getDoc(D(user, 'appConfig/androidUpdate')))
  await no('A-5 (unchanged): a signed-out caller cannot read appConfig/control', () => getDoc(D(nobody, 'appConfig/control')))

  // ══════════════════════════════════════════════════════════════════════════
  console.log('R-3 — calls and callHistory have no client writer; reads and the in-call chat are unchanged')
  // ══════════════════════════════════════════════════════════════════════════
  await seed('calls/CALL1', { callerId: 'uidUser', receiverId: 'uidHost', status: 'active', startedAt: new Date(), perMinRateDiamonds: 10, tickIndex: 1 })
  await seed('callHistory/CH1', { callerUid: 'uidUser', receiverUid: 'uidHost', durationSeconds: 60, beansEarned: 5, timestamp: new Date() })
  const CALL = { callerId: 'uidUser', receiverId: 'uidHost', status: 'ringing', createdAt: new Date() }
  const HISTORY = { callerUid: 'uidUser', receiverUid: 'uidHost', durationSeconds: 1, beansEarned: 9999, timestamp: new Date() }

  for (const [who, c] of [['the owner', owner], ['an ops admin', opsAdmin], ['a marketing admin (isAdmin by spelling)', mktAdmin],
    ['the caller', user], ['the receiver', host], ['a bystander', other], ['a guest', guest]]) {
    await no(`R-3: ${who} cannot edit the bill (calls)`, () => updateDoc(D(c, 'calls/CALL1'), { tickIndex: 99 }))
    await no(`R-3: ${who} cannot create a call document`, () => setDoc(D(c, `calls/CALL_${Math.random().toString(36).slice(2)}`), CALL))
    await no(`R-3: ${who} cannot delete a call document`, () => deleteDoc(D(c, 'calls/CALL1')))
    await no(`R-3: ${who} cannot edit a call history row`, () => updateDoc(D(c, 'callHistory/CH1'), { beansEarned: 9999 }))
    await no(`R-3: ${who} cannot create a call history row`, () => setDoc(D(c, `callHistory/CH_${Math.random().toString(36).slice(2)}`), HISTORY))
    await no(`R-3: ${who} cannot delete a call history row`, () => deleteDoc(D(c, 'callHistory/CH1')))
  }
  await no('R-3: the caller cannot end its own call by writing status', () => updateDoc(D(user, 'calls/CALL1'), { status: 'ended' }))
  await ok('R-3 (unchanged): the caller reads the call', () => getDoc(D(user, 'calls/CALL1')))
  await ok('R-3 (unchanged): the receiver reads the call', () => getDoc(D(host, 'calls/CALL1')))
  await ok('R-3 (unchanged): an ops admin reads the call', () => getDoc(D(opsAdmin, 'calls/CALL1')))
  await no('R-3 (unchanged): a bystander cannot read the call', () => getDoc(D(other, 'calls/CALL1')))
  await ok('R-3 (unchanged): the receiver still finds its ringing call (incomingCallFlow query)',
    () => getDocs(query(collection(fs(host), 'calls'), where('receiverId', '==', 'uidHost'))))
  await ok('R-3 (unchanged): the caller reads its history row', () => getDoc(D(user, 'callHistory/CH1')))
  await ok('R-3 (unchanged): the receiver reads the history row', () => getDoc(D(host, 'callHistory/CH1')))
  await ok('R-3 (unchanged): a staff member reads a history row', () => getDoc(D(opsMember, 'callHistory/CH1')))
  await no('R-3 (unchanged): a bystander cannot read a history row', () => getDoc(D(other, 'callHistory/CH1')))
  await ok('R-3 (unchanged): a party on a current session still posts in-call chat',
    () => setDoc(D(user, 'calls/CALL1/messages/m1'), { senderUid: 'uidUser', senderName: 'u', message: 'hi', timestamp: Date.now() }))
  await no('R-3 (unchanged): a bystander cannot post in-call chat',
    () => setDoc(D(other, 'calls/CALL1/messages/m2'), { senderUid: 'uidOther', senderName: 'o', message: 'hi', timestamp: Date.now() }))

  // ══════════════════════════════════════════════════════════════════════════
  console.log('A-1 — an empty contact over an absent one is no change; nothing else about contacts moved')
  // ══════════════════════════════════════════════════════════════════════════
  // What a pre-19 build writes on "Let's Go!" for a guest: the profile fields
  // plus `email: ""` and `phoneNumber: ""` (AuthRepository.saveUserProfile at
  // HEAD 1194e55), onto the document createUserDocument made.
  const PROFILE = { name: 'Pat', gender: 'f', dob: 1, age: 30, city: 'Pune', country: 'IN', languages: ['en'],
    bio: '', isProfileComplete: true, isOnline: true, lastSeen: 1 }
  const guestDoc = (uid) => ({ uid, name: '', photoUrl: '', phoneNumber: '', isProfileComplete: false, createdAt: new Date(), lastSeen: 1 })

  await seed('users/uidGuest', guestDoc('uidGuest'))
  await ok('A-1: a guest on a pre-19 build saves its profile with email: "" and phoneNumber: ""',
    () => setDoc(D(guest, 'users/uidGuest'), { ...PROFILE, email: '', phoneNumber: '' }, { merge: true }))
  await ok('A-1 (unchanged): a guest saves its profile with no contact fields at all (build 19)',
    () => setDoc(D(guest, 'users/uidGuest'), { ...PROFILE, bio: 'x' }, { merge: true }))
  // Phone-OTP user on a pre-19 build: the token phone is re-written, the email is "".
  await seed('users/uidPhoneOld', { uid: 'uidPhoneOld', name: '', photoUrl: '', phoneNumber: '+919800000011', isProfileComplete: false, createdAt: new Date(), lastSeen: 1 })
  const phoneOld = testEnv.authenticatedContext('uidPhoneOld', { phone_number: '+919800000011', auth_time: 2000, firebase: { sign_in_provider: 'phone' } })
  await ok('A-1: a phone user on a pre-19 build saves its profile (email: "", phoneNumber = the token\'s)',
    () => setDoc(D(phoneOld, 'users/uidPhoneOld'), { ...PROFILE, email: '', phoneNumber: '+919800000011' }, { merge: true }))
  // A document that already holds both keys with an empty string.
  await seed('users/uidEmptyKeys', { uid: 'uidEmptyKeys', name: '', email: '', phoneNumber: '', isProfileComplete: false, createdAt: new Date(), lastSeen: 1 })
  const emptyKeys = testEnv.authenticatedContext('uidEmptyKeys', { auth_time: 2000, firebase: { sign_in_provider: 'anonymous' } })
  await ok('A-1 (unchanged): empty over an explicitly empty stored contact is accepted',
    () => setDoc(D(emptyKeys, 'users/uidEmptyKeys'), { ...PROFILE, email: '', phoneNumber: '' }, { merge: true }))
  await ok('A-1: removing an empty contact key is accepted (still nothing on the document)',
    () => updateDoc(D(emptyKeys, 'users/uidEmptyKeys'), { email: deleteField() }))

  // ── The other direction: nothing non-empty, and nothing existing, moves ──
  await no('A-1: a guest cannot write a typed email (not on its token)',
    () => setDoc(D(guest, 'users/uidGuest'), { ...PROFILE, email: 'typed@example.test' }, { merge: true }))
  await no('A-1: a guest cannot write a typed phone number',
    () => setDoc(D(guest, 'users/uidGuest'), { ...PROFILE, phoneNumber: '+919800000099' }, { merge: true }))
  await no('A-1: a phone user cannot write a typed email beside its verified phone',
    () => setDoc(D(phoneOld, 'users/uidPhoneOld'), { ...PROFILE, email: 'typed@example.test', phoneNumber: '+919800000011' }, { merge: true }))
  await no('A-1: a phone user cannot change its phone to one not on the token',
    () => updateDoc(D(phoneOld, 'users/uidPhoneOld'), { phoneNumber: '+919800000012' }))
  const googleTyped = testEnv.authenticatedContext('uidGuest', { email: 'uidGuest@example.test', email_verified: true, auth_time: 2000, firebase: { sign_in_provider: 'google.com' } })
  await no('A-1: a Google user cannot write a typed phone number beside its verified email (old-client Google case stays refused)',
    () => setDoc(D(googleTyped, 'users/uidGuest'), { ...PROFILE, email: 'uidGuest@example.test', phoneNumber: '9800000077' }, { merge: true }))
  const unverified = testEnv.authenticatedContext('uidGuest', { email: 'uidGuest@example.test', email_verified: false, auth_time: 2000, firebase: { sign_in_provider: 'password' } })
  await no('A-1 (unchanged): an UNVERIFIED token email cannot land on the document',
    () => updateDoc(D(unverified, 'users/uidGuest'), { email: 'uidGuest@example.test' }))
  await ok('A-1 (unchanged): the owner may record the verified email that is on the token',
    () => updateDoc(D(googleTyped, 'users/uidGuest'), { email: 'uidGuest@example.test' }))

  await seed('users/uidHasBoth', { uid: 'uidHasBoth', name: 'b', email: 'old@example.test', phoneNumber: '+919800000021', isProfileComplete: true })
  const hasBothPhone = testEnv.authenticatedContext('uidHasBoth', { phone_number: '+919800000021', auth_time: 2000, firebase: { sign_in_provider: 'phone' } })
  const hasBothGoogle = testEnv.authenticatedContext('uidHasBoth', { email: 'new@example.test', email_verified: true, auth_time: 2000, firebase: { sign_in_provider: 'google.com' } })
  await no('A-1: an existing email is not CLEARED by writing ""', () => updateDoc(D(hasBothPhone, 'users/uidHasBoth'), { email: '' }))
  await no('A-1: an existing phone is not CLEARED by writing ""', () => updateDoc(D(hasBothPhone, 'users/uidHasBoth'), { phoneNumber: '' }))
  await no('A-1: an existing email is not REMOVED (deleteField)', () => updateDoc(D(hasBothPhone, 'users/uidHasBoth'), { email: deleteField() }))
  await no('A-1: an existing phone is not REMOVED (deleteField)', () => updateDoc(D(hasBothPhone, 'users/uidHasBoth'), { phoneNumber: deleteField() }))
  await no('A-1: a pre-19 style save that would blank BOTH existing contacts is refused',
    () => setDoc(D(hasBothPhone, 'users/uidHasBoth'), { ...PROFILE, email: '', phoneNumber: '' }, { merge: true }))
  await no('A-1 (unchanged): an existing email is not REPLACED, even by a verified token email',
    () => updateDoc(D(hasBothGoogle, 'users/uidHasBoth'), { email: 'new@example.test' }))
  await ok('A-1 (unchanged): writing the SAME contacts again (build 19 saveUserProfile) is fine',
    () => setDoc(D(hasBothPhone, 'users/uidHasBoth'), { ...PROFILE, email: 'old@example.test', phoneNumber: '+919800000021' }, { merge: true }))
  await ok('A-1 (unchanged): the owner still edits ordinary profile fields',
    () => updateDoc(D(hasBothPhone, 'users/uidHasBoth'), { bio: 'hello', city: 'Delhi' }))
  await no('A-1 (unchanged): a staff browser cannot write email: "" on somebody\'s document',
    () => updateDoc(D(opsAdmin, 'users/uidGuest'), { email: '' }))
  await no('A-1 (unchanged): another user cannot write email: "" on the document',
    () => updateDoc(D(other, 'users/uidGuest'), { email: '' }))
  await seed('users/uidBannedOld', { uid: 'uidBannedOld', name: '', phoneNumber: '', isBanned: true, accountState: 'banned', isProfileComplete: false })
  const bannedOld = testEnv.authenticatedContext('uidBannedOld', { auth_time: 2000, firebase: { sign_in_provider: 'anonymous' } })
  await no('A-1 (unchanged): a banned account still cannot save its profile, empty contacts or not',
    () => setDoc(D(bannedOld, 'users/uidBannedOld'), { ...PROFILE, email: '', phoneNumber: '' }, { merge: true }))

  // ══════════════════════════════════════════════════════════════════════════
  console.log('C-1 — NOT applied: the live self-signup login write still passes; R-2/R-5 close what it was raised for')
  // ══════════════════════════════════════════════════════════════════════════
  // The verified applicant and the record its address was filed under
  // (agency-signup step 3), then the login document createAgencyAccount writes
  // in step 4 — `isActive: true, status: 'pending'`. This is the write the
  // specified C-1 hunk would refuse; the live CRM depends on it.
  await seed('agencies/AG_C1', { crmId: 'C1C1C1C1', agencyName: 'C1 Talents', ownerName: 'C', ownerPhone: '+919800000031',
    ownerEmail: 'c1@example.test', type: 'main', parentAgencyId: null, status: 'pending', kycStatus: 'pending', kycDocUrls: [],
    isActive: false, totalHosts: 0, totalSubAgencies: 0, source: 'self_signup' })
  const applicant = testEnv.authenticatedContext('uidC1', { email: 'c1@example.test', email_verified: true, firebase: { sign_in_provider: 'password' } })
  const LOGIN_AS_WRITTEN_BY_THE_LIVE_CRM = { uid: 'uidC1', email: 'c1@example.test', name: 'C', phone: '+919800000031', role: 'agency',
    permissions: [], agencyId: 'AG_C1', isActive: true, status: 'pending', createdBy: 'self_signup', createdAt: new Date(), lastLoginAt: null }
  await ok('C-1 (withheld, pinned): the live CRM\'s self-signup login write (isActive: true, pending) is still accepted',
    () => setDoc(D(applicant, 'crmUsers/uidC1'), LOGIN_AS_WRITTEN_BY_THE_LIVE_CRM))
  await ok('C-1 (unchanged): the new pending login writes its own lastLoginAt at sign-in (resolveCrmUser)',
    () => updateDoc(D(applicant, 'crmUsers/uidC1'), { lastLoginAt: new Date() }))
  const stranger = testEnv.authenticatedContext('uidStranger', { email: 'stranger@example.test', email_verified: true, firebase: { sign_in_provider: 'google.com' } })
  await no('C-1 (unchanged): a verified stranger with no application under its address cannot mint a login',
    () => setDoc(D(stranger, 'crmUsers/uidStranger'), { ...LOGIN_AS_WRITTEN_BY_THE_LIVE_CRM, uid: 'uidStranger', email: 'stranger@example.test' }))
  await no('C-1 (unchanged): nobody self-issues a staff role', () => setDoc(D(stranger, 'crmUsers/uidStranger'),
    { ...LOGIN_AS_WRITTEN_BY_THE_LIVE_CRM, uid: 'uidStranger', email: 'stranger@example.test', role: 'superadmin' }))
  // …and what that pending login can now reach (the exposures C-1 named):
  await no('C-1 → R-5: the new pending self-signup login cannot read the team board', () => getDoc(D(applicant, 'techTickets/T1')))
  await no('C-1 → R-5: …nor file a ticket', () => setDoc(D(applicant, 'techTickets/T_C1'), TICKET))
  await no('C-1 → R-2: …nor list every seller\'s purchase requests', () => getDocs(cpr(applicant)))
  await no('C-1 → A-5: …nor write the update order', () => setDoc(D(applicant, 'appConfig/androidUpdate'), UPDATE_ORDER))
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
  console.error(`\n${tally.failures} of ${tally.checks} hotfix-1 rule checks FAILED:`)
  for (const f of failed) console.error(`  · ${f}`)
}
if (!aborted && tally.failures === 0) console.log(`\nAll ${tally.checks} hotfix-1 rule checks passed.`)
printResult(aborted)
// Not `process.exit()` here: stdout to a pipe is asynchronous on macOS, and an
// immediate exit can drop the HOTFIX1-RESULT line the runner reads. The exit
// code is set and the process ends once the output has drained; the unref'd
// timer only matters if a stray handle would otherwise keep the emulator run
// waiting.
const code = aborted || tally.failures > 0 ? 1 : 0
process.exitCode = code
setTimeout(() => process.exit(code), 2000).unref()

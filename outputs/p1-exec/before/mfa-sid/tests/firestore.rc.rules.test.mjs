/**
 * firestore.rules — Decision 15 (RC) regression tests, against the Firestore
 * emulator.
 *
 *   * A partner role the Owner approved while the login's contacts were
 *     incomplete WAITS (`roleStatus.<role> == 'awaiting_verification'`): it
 *     holds no partner authority — no invitation, no salary request, no
 *     sub-agency, no contest, no coin purchase, no going online.
 *   * The protected partner ACTIONS need a role that has STARTED (approved):
 *     a PENDING role may still complete its own application, and may not take
 *     them.
 *   * `contactVerifications/{uid}` (the server's record of completed
 *     verifications) is readable by its owner and staff and writable by no
 *     client — a browser that could write it would verify itself.
 *   * An Owner's browser creates a partner LOGIN only as `pending`, with no
 *     `roles` / `roleStatus` — approval and the start are the API's.
 *
 * Each `no(...)` is a path the rules must refuse; each `ok(...)` the
 * legitimate flow beside it, so a rule that "fixes" a hole by refusing
 * everything fails.
 *
 * ZIPPER_RULES_FILE=<path> runs the same checks against another rules file
 * (the pre-change copy) to show which `no(...)` checks fail there.
 *
 * Failure classes, as in the other rules suites: [no:allowed] is the only
 * failure that is evidence about the rules; [ok:denied] a legitimate request
 * refused; [*:error] the request never reached a rules decision. The last line
 * is always one `RC-RESULT …` summary.
 *
 * Run (needs Java 21 + firebase CLI), from the repository root:
 *     firebase emulators:exec --only firestore --project demo-zipper \
 *         "node tests/firestore.rc.rules.test.mjs"
 * `demo-` project ids never reach a real project.
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { doc, setDoc, getDoc, updateDoc, deleteDoc, collection } from 'firebase/firestore'

const here = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = process.env.ZIPPER_RULES_FILE || join(here, '..', 'firestore.rules')
const RULES = readFileSync(RULES_PATH, 'utf8')
const RULES_SHA256 = createHash('sha256').update(RULES, 'utf8').digest('hex')
console.log(`rules under test: ${RULES_PATH}`)
console.log(`rules sha256: ${RULES_SHA256}`)

const tally = { checks: 0, failures: 0, ok_denied: 0, ok_error: 0, no_allowed: 0, no_error: 0 }
const failed = []

function isPermissionDenied(err) {
  const code = String(err?.code ?? '').toLowerCase()
  const msg = String(err?.message ?? '').toLowerCase()
  return code === 'permission-denied' || code === 'permission_denied'
    || msg.includes('permission_denied') || msg.includes('permission denied')
}
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
  const why = o.kind === 'allowed' ? 'the request was ALLOWED' : String(o.err?.message ?? o.err).split('\n')[0]
  console.error(`  FAIL  [${tag}] ${claim}\n        ${why}`)
}
const ok = (claim, run) => expect(claim, run, true)
const no = (claim, run) => expect(claim, run, false)

function printResult(aborted) {
  console.log(
    `RC-RESULT checks=${tally.checks} failures=${tally.failures} ok_denied=${tally.ok_denied} ` +
    `ok_error=${tally.ok_error} no_allowed=${tally.no_allowed} no_error=${tally.no_error} ` +
    `aborted=${aborted ? 1 : 0} rules_sha256=${RULES_SHA256}`,
  )
}

const testEnv = await initializeTestEnvironment({
  projectId: 'demo-zipper',
  firestore: { rules: RULES, host: '127.0.0.1', port: 8080 },
})
async function seed(path, data) {
  await testEnv.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), path), data) })
}

// P1-A3b — Owner authority in the rules holds only for a Firebase sign-in the
// backend bound to an MFA-verified session (ownerMfaSessions/{uid}). The mock
// token's defaults are auth_time 0 and provider 'custom', so that is the key
// the Owners in this suite are bound under. Pending/unbound Owners are covered
// in tests/firestore.p1mfa.rules.test.mjs.
const OWNER_MFA_BOUND = { active: { '0:custom': new Date(Date.now() + 7 * 864e5) } }
const handles = new Map()
function fs(ctx) {
  if (!handles.has(ctx)) handles.set(ctx, ctx.firestore())
  return handles.get(ctx)
}
const D = (ctx, path) => doc(fs(ctx), path)
// eslint-disable-next-line no-unused-vars
const C = (ctx, path) => collection(fs(ctx), path)

async function main() {
  await testEnv.clearFirestore()

  const STAFF = (uid, role) => ({ uid, role, isActive: true, status: 'approved' })
  await seed('crmUsers/uidRcOps', STAFF('uidRcOps', 'ops_admin'))
  await seed('crmUsers/uidRcOwner', STAFF('uidRcOwner', 'superadmin'))
  await seed('ownerMfaSessions/uidRcOwner', OWNER_MFA_BOUND)  // P1-A3b
  const opsAdmin = testEnv.authenticatedContext('uidRcOps', { email: 'ops@zipper.test', email_verified: true })
  const ownerStaff = testEnv.authenticatedContext('uidRcOwner', { email: 'own@zipper.test', email_verified: true })

  // Three main agencies, identical but for the agency role's state on the login.
  const AGENCY = (crmUid, code, status) => ({
    agencyName: crmUid, ownerEmail: `${crmUid}@example.test`, type: 'main', parentAgencyId: null,
    status, isActive: status === 'approved', kycStatus: 'approved', crmUid, referralCode: code,
  })
  const states = [
    ['AG_RC_LIVE', 'uidRcLive', 'RCLIVE', 'approved'],
    ['AG_RC_WAIT', 'uidRcWait', 'RCWAIT', 'awaiting_verification'],
    ['AG_RC_PEND', 'uidRcPend', 'RCPEND', 'pending'],
  ]
  for (const [id, uid, code, st] of states) {
    await seed(`agencies/${id}`, AGENCY(uid, code, st))
    await seed(`crmUsers/${uid}`, {
      uid, role: 'agency', isActive: true, status: st, agencyId: id, roleStatus: { agency: st },
    })
  }
  const live = testEnv.authenticatedContext('uidRcLive', { email: 'uidRcLive@example.test', email_verified: true })
  const wait = testEnv.authenticatedContext('uidRcWait', { email: 'uidRcWait@example.test', email_verified: true })
  const pend = testEnv.authenticatedContext('uidRcPend', { email: 'uidRcPend@example.test', email_verified: true })

  // ════════════════════════════════════════════════════════════════════════
  console.log('D15 — an approved role WAITING for verified contacts holds no partner authority')
  // ════════════════════════════════════════════════════════════════════════
  const INVITE = (agencyId, code) => ({
    referralCode: code, agencyId, agencyName: 'A', hostName: 'Invited', applicantPhone: '+919800000910',
    applicantEmail: 'inv@example.test', isActivated: false, status: 'pending', kycStatus: 'submitted',
    createdAt: new Date(),
  })
  await ok('a STARTED agency invites a host (unchanged)',
    () => setDoc(D(live, 'hostApplications/RC_HA_LIVE'), INVITE('AG_RC_LIVE', 'RCLIVE')))
  await no('a WAITING agency cannot invite a host',
    () => setDoc(D(wait, 'hostApplications/RC_HA_WAIT'), INVITE('AG_RC_WAIT', 'RCWAIT')))
  await no('a PENDING agency cannot invite a host either',
    () => setDoc(D(pend, 'hostApplications/RC_HA_PEND'), INVITE('AG_RC_PEND', 'RCPEND')))

  const SALARY = (agencyId) => ({
    agencyId, hostUid: 'uidSomeHost', hostName: 'H', periodStart: '2026-10-01', periodEnd: '2026-10-07',
    beansEarned: 2000, amountInr: 200, notes: '', status: 'pending', createdAt: new Date(),
  })
  await ok('a STARTED agency raises a salary request (unchanged)',
    () => setDoc(D(live, 'salaryRequests/RC_SR_LIVE'), SALARY('AG_RC_LIVE')))
  await no('a WAITING agency cannot',
    () => setDoc(D(wait, 'salaryRequests/RC_SR_WAIT'), SALARY('AG_RC_WAIT')))
  await no('a PENDING agency cannot',
    () => setDoc(D(pend, 'salaryRequests/RC_SR_PEND'), SALARY('AG_RC_PEND')))

  const NEW_SUB = (parent, creator) => ({
    agencyName: 'New sub', ownerName: 'S', ownerEmail: `sub-of-${parent}@example.test`, type: 'sub',
    parentAgencyId: parent, status: 'pending', kycStatus: 'submitted', isActive: false,
    source: 'agency_created', createdByUid: creator,
  })
  await ok('a STARTED main agency creates a sub-agency (unchanged)',
    () => setDoc(D(live, 'agencies/RC_SUB_LIVE'), NEW_SUB('AG_RC_LIVE', 'uidRcLive')))
  await no('a WAITING main agency cannot',
    () => setDoc(D(wait, 'agencies/RC_SUB_WAIT'), NEW_SUB('AG_RC_WAIT', 'uidRcWait')))
  await no('a PENDING main agency cannot',
    () => setDoc(D(pend, 'agencies/RC_SUB_PEND'), NEW_SUB('AG_RC_PEND', 'uidRcPend')))

  // A sub-agency's brand-new login binds only to a record a STARTED parent made.
  await seed('agencies/RC_SUB_BY_WAIT', NEW_SUB('AG_RC_WAIT', 'uidRcWait'))
  const subLogin = testEnv.authenticatedContext('uidRcSubLogin', {
    email: 'sub-of-AG_RC_WAIT@example.test', email_verified: false, firebase: { sign_in_provider: 'password' },
  })
  await no('a sub-agency login cannot bind to a record a WAITING parent made',
    () => setDoc(D(subLogin, 'crmUsers/uidRcSubLogin'), {
      uid: 'uidRcSubLogin', email: 'sub-of-AG_RC_WAIT@example.test', name: 'S', phone: '', role: 'agency',
      permissions: [], agencyId: 'RC_SUB_BY_WAIT', isActive: true, status: 'pending',
      createdBy: 'agency_created', createdAt: new Date(), lastLoginAt: null,
    }))

  const CONTEST = (agencyId) => ({
    subjectUid: 'uidRcHost', subjectName: 'H', raisedByUid: 'x', raisedByRole: 'agency', agencyId,
    kind: 'report', reportId: 'RPT1', statement: 'The report was about another account; not our host.',
    status: 'pending', createdAt: new Date(),
  })
  await ok('a STARTED agency contests for a host (same shape, unchanged)',
    () => setDoc(D(live, 'appeals/contest_AG_RC_LIVE_RPT1'), { ...CONTEST('AG_RC_LIVE'), raisedByUid: 'uidRcLive' }))
  await no('a WAITING agency cannot contest for a host',
    () => setDoc(D(wait, 'appeals/contest_AG_RC_WAIT_RPT1'), { ...CONTEST('AG_RC_WAIT'), raisedByUid: 'uidRcWait' }))
  await no('a PENDING agency cannot either',
    () => setDoc(D(pend, 'appeals/contest_AG_RC_PEND_RPT1'), { ...CONTEST('AG_RC_PEND'), raisedByUid: 'uidRcPend' }))
  await no('RC: a contest at an id that is not its pinned id is refused',
    () => setDoc(D(live, 'appeals/RC_APL_ANY'), { ...CONTEST('AG_RC_LIVE'), reportId: 'RPT2', raisedByUid: 'uidRcLive' }))
  // A second contest after the first was decided needs a new reason.
  await seed('appeals/contest_AG_RC_LIVE_RPT9', { ...CONTEST('AG_RC_LIVE'), reportId: 'RPT9', raisedByUid: 'uidRcLive', status: 'upheld' })
  await no('RC: re-contesting a decided report with the same statement is refused',
    () => setDoc(D(live, 'appeals/contest_AG_RC_LIVE_RPT9_2'), { ...CONTEST('AG_RC_LIVE'), reportId: 'RPT9', raisedByUid: 'uidRcLive' }))
  await ok('RC: …with a new reason it is accepted',
    () => setDoc(D(live, 'appeals/contest_AG_RC_LIVE_RPT9_2'), { ...CONTEST('AG_RC_LIVE'), reportId: 'RPT9', raisedByUid: 'uidRcLive',
      statement: 'Since the decision the caller admitted the report was about another host entirely.' }))
  // Each slot has exactly one id: `_02`, `_0`, `_1` would all point back at
  // slot 1 and let several re-contests wait at once.
  const NEW_REASON = (n) => ({ ...CONTEST('AG_RC_LIVE'), reportId: 'RPT9', raisedByUid: 'uidRcLive',
    statement: `A further new reason, number ${n}, that no decided contest has given before.` })
  await no('RC: a zero-padded slot id (_02) is refused',
    () => setDoc(D(live, 'appeals/contest_AG_RC_LIVE_RPT9_02'), NEW_REASON(2)))
  await no('RC: slot _1 is not an id (slot 1 is the bare id)',
    () => setDoc(D(live, 'appeals/contest_AG_RC_LIVE_RPT9_1'), NEW_REASON(1)))
  await no('RC: slot _0 is not an id either',
    () => setDoc(D(live, 'appeals/contest_AG_RC_LIVE_RPT9_0'), NEW_REASON(0)))
  await no('RC: the next slot waits for the previous one to be decided (_3 while _2 is pending)',
    () => setDoc(D(live, 'appeals/contest_AG_RC_LIVE_RPT9_3'), NEW_REASON(3)))

  await ok('a WAITING agency is still signed in to its own login document (the waiting room)',
    () => getDoc(D(wait, 'crmUsers/uidRcWait')))
  await ok('a PENDING agency still completes its own application (KYC) — unchanged',
    () => updateDoc(D(pend, 'agencies/AG_RC_PEND'), { kycStatus: 'submitted', kycDocUrls: ['k1', 'k2', 'k3'] }))

  // ── Coin sellers ─────────────────────────────────────────────────────────
  const SELLER = (crmUid, status, over = {}) => ({
    crmUid, ownerUid: crmUid, displayName: crmUid, status, isApproved: status === 'approved',
    isActive: status === 'approved', city: 'Pune', coinBalance: 0, totalCoinsSold: 0, isOnline: false, ...over,
  })
  for (const [id, uid, st] of [
    ['SL_RC_LIVE', 'uidRcSlLive', 'approved'],
    ['SL_RC_WAIT', 'uidRcSlWait', 'awaiting_verification'],
    ['SL_RC_PEND', 'uidRcSlPend', 'pending'],
  ]) {
    await seed(`sellers/${id}`, SELLER(uid, st))
    await seed(`crmUsers/${uid}`, { uid, role: 'seller', isActive: true, status: st, sellerId: id, roleStatus: { seller: st } })
  }
  const slLive = testEnv.authenticatedContext('uidRcSlLive', { email: 'sl@example.test', email_verified: true })
  const slWait = testEnv.authenticatedContext('uidRcSlWait', { email: 'sw@example.test', email_verified: true })
  const slPend = testEnv.authenticatedContext('uidRcSlPend', { email: 'sp@example.test', email_verified: true })
  await ok('a STARTED seller files a coin purchase (unchanged)',
    () => setDoc(D(slLive, 'coinPurchaseRequests/RC_CP_LIVE'), { sellerUid: 'SL_RC_LIVE', status: 'pending', coins: 1000 }))
  await no('a WAITING seller cannot',
    () => setDoc(D(slWait, 'coinPurchaseRequests/RC_CP_WAIT'), { sellerUid: 'SL_RC_WAIT', status: 'pending', coins: 1000 }))
  await no('a PENDING seller cannot',
    () => setDoc(D(slPend, 'coinPurchaseRequests/RC_CP_PEND'), { sellerUid: 'SL_RC_PEND', status: 'pending', coins: 1000 }))
  await no('a WAITING seller cannot go online',
    () => updateDoc(D(slWait, 'sellers/SL_RC_WAIT'), { isOnline: true }))
  await ok('a STARTED seller goes online (unchanged)',
    () => updateDoc(D(slLive, 'sellers/SL_RC_LIVE'), { isOnline: true }))
  await no('a PENDING seller cannot go online either (neither the details arm nor the pending arm)',
    () => updateDoc(D(slPend, 'sellers/SL_RC_PEND'), { isOnline: true }))
  await ok('…a PENDING seller still completes its own details (unchanged)',
    () => updateDoc(D(slPend, 'sellers/SL_RC_PEND'), { description: 'Open 9 to 6' }))
  await seed('sellers/SL_RC_PEND_ON', SELLER('uidRcSlPend', 'pending', { isOnline: true }))
  await ok('…and may always go OFFLINE (a legacy pending seller left online)',
    () => updateDoc(D(slPend, 'sellers/SL_RC_PEND_ON'), { isOnline: false }))

  // An app-only seller (no crmUsers document) whose record waits.
  const appWait = testEnv.authenticatedContext('uidRcAppSlWait', {
    phone_number: '+919800000920', firebase: { sign_in_provider: 'phone' },
  })
  await seed('sellers/uidRcAppSlWait', SELLER('', 'awaiting_verification', { ownerUid: 'uidRcAppSlWait' }))
  await no('an app-only seller whose record WAITS cannot go online from the app',
    () => updateDoc(D(appWait, 'sellers/uidRcAppSlWait'), { isOnline: true }))
  await no('…nor file a coin purchase as itself',
    () => setDoc(D(appWait, 'coinPurchaseRequests/RC_CP_APPWAIT'),
      { sellerUid: 'uidRcAppSlWait', status: 'pending', coins: 1000 }))
  const appLive = testEnv.authenticatedContext('uidRcAppSlLive', {
    phone_number: '+919800000921', firebase: { sign_in_provider: 'phone' },
  })
  await seed('sellers/uidRcAppSlLive', SELLER('', 'approved', { ownerUid: 'uidRcAppSlLive' }))
  await ok('an app-only STARTED seller still goes online from the app (unchanged)',
    () => updateDoc(D(appLive, 'sellers/uidRcAppSlLive'), { isOnline: true }))
  await ok('RC: …and files a coin purchase as itself (legacy record keyed by the uid)',
    () => setDoc(D(appLive, 'coinPurchaseRequests/RC_CP_APPLIVE'),
      { sellerUid: 'uidRcAppSlLive', status: 'pending', coins: 1000 }))

  // An app seller whose record has an AUTOMATIC id (FX-05): BuyCoinScreen
  // still writes `sellerUid = auth.uid`; the started record is the one the
  // login names. This is the shape every new app seller has.
  const APP_AUTO = (uid, sellerId, st) => ({
    uid, role: 'seller', isActive: true, status: st, sellerId, roleStatus: { seller: st },
  })
  await seed('crmUsers/uidRcAppAuto', APP_AUTO('uidRcAppAuto', 'SL_RC_AUTO', 'approved'))
  await seed('sellers/SL_RC_AUTO', SELLER('uidRcAppAuto', 'approved', { ownerUid: 'uidRcAppAuto' }))
  const appAuto = testEnv.authenticatedContext('uidRcAppAuto', {
    phone_number: '+919800000922', firebase: { sign_in_provider: 'phone' },
  })
  await ok('RC: an app seller with an automatic-id STARTED record files a coin purchase as itself',
    () => setDoc(D(appAuto, 'coinPurchaseRequests/RC_CP_APPAUTO'),
      { sellerUid: 'uidRcAppAuto', status: 'pending', coins: 1000 }))
  await seed('crmUsers/uidRcAppAutoWait', APP_AUTO('uidRcAppAutoWait', 'SL_RC_AUTO_WAIT', 'awaiting_verification'))
  await seed('sellers/SL_RC_AUTO_WAIT', SELLER('uidRcAppAutoWait', 'awaiting_verification', { ownerUid: 'uidRcAppAutoWait' }))
  const appAutoWait = testEnv.authenticatedContext('uidRcAppAutoWait', {
    phone_number: '+919800000923', firebase: { sign_in_provider: 'phone' },
  })
  await no('RC: …but not while that record WAITS for verified contacts',
    () => setDoc(D(appAutoWait, 'coinPurchaseRequests/RC_CP_APPAUTOWAIT'),
      { sellerUid: 'uidRcAppAutoWait', status: 'pending', coins: 1000 }))
  await seed('crmUsers/uidRcAppAutoOther', APP_AUTO('uidRcAppAutoOther', 'SL_RC_AUTO', 'approved'))
  const appAutoOther = testEnv.authenticatedContext('uidRcAppAutoOther', {
    phone_number: '+919800000924', firebase: { sign_in_provider: 'phone' },
  })
  await no('RC: …and a login naming SOMEBODY ELSE\'s started record cannot use it',
    () => setDoc(D(appAutoOther, 'coinPurchaseRequests/RC_CP_APPAUTOOTHER'),
      { sellerUid: 'uidRcAppAutoOther', status: 'pending', coins: 1000 }))

  // ════════════════════════════════════════════════════════════════════════
  console.log('RF-27 — going live reads every restriction, not isBanned alone')
  // ════════════════════════════════════════════════════════════════════════
  const LIVE_HOST = (over = {}) => ({ uid: 'x', name: 'H', isHost: true, isVerifiedHost: true, isBanned: false, ...over })
  await seed('users/uidRcLiveOk', LIVE_HOST({ uid: 'uidRcLiveOk' }))
  await seed('users/uidRcLiveSusp', LIVE_HOST({ uid: 'uidRcLiveSusp', accountState: 'suspended' }))
  await seed('users/uidRcLiveSuspFlag', LIVE_HOST({ uid: 'uidRcLiveSuspFlag', isSuspended: true }))
  const liveOk = testEnv.authenticatedContext('uidRcLiveOk', { phone_number: '+919800000930' })
  const liveSusp = testEnv.authenticatedContext('uidRcLiveSusp', { phone_number: '+919800000931' })
  const liveSuspFlag = testEnv.authenticatedContext('uidRcLiveSuspFlag', { phone_number: '+919800000932' })
  await ok('a verified, unrestricted Host opens a live room (unchanged)',
    () => setDoc(D(liveOk, 'liveRooms/RC_LR_OK'), { hostUid: 'uidRcLiveOk', isActive: true }))
  await no('RF-27: a Host whose accountState says suspended (flags not set) cannot',
    () => setDoc(D(liveSusp, 'liveRooms/RC_LR_SUSP'), { hostUid: 'uidRcLiveSusp', isActive: true }))
  await no('RF-27: …nor one with isSuspended set',
    () => setDoc(D(liveSuspFlag, 'liveRooms/RC_LR_SUSPFLAG'), { hostUid: 'uidRcLiveSuspFlag', isActive: true }))

  // ════════════════════════════════════════════════════════════════════════
  console.log('RC — an agency withdraws its own INVITATION, never a self-filed application')
  // ════════════════════════════════════════════════════════════════════════
  // Withdrawal now also deletes the invitation's KYC uploads (Functions
  // `onHostInvitationWithdrawn`); a self-filed application is the applicant's,
  // decided by staff (`decide_host_application` excludes every partner).
  await seed('hostApplications/RC_HA_INV', INVITE('AG_RC_LIVE', 'RCLIVE'))
  await seed('hostApplications/RC_HA_SELF', { ...INVITE('AG_RC_LIVE', 'RCLIVE'), applicantUid: 'uidRcApplicant', source: 'self_app' })
  await seed('hostApplications/RC_HA_SELF_NOUID', { ...INVITE('AG_RC_LIVE', 'RCLIVE'), source: 'self_app' })
  await no('RC: an agency cannot delete a self-filed Host application under it',
    () => deleteDoc(D(live, 'hostApplications/RC_HA_SELF')))
  await no('RC: …nor one marked self_app',
    () => deleteDoc(D(live, 'hostApplications/RC_HA_SELF_NOUID')))
  await seed('hostApplications/RC_HA_REDEEMED_LEGACY', { ...INVITE('AG_RC_LIVE', 'RCLIVE'), activatedByUid: 'uidRcSomeHost' })
  await no('RC: …nor an invitation somebody redeemed (activatedByUid), even if isActivated was never set',
    () => deleteDoc(D(live, 'hostApplications/RC_HA_REDEEMED_LEGACY')))
  await ok('RC: the agency still withdraws its own pending invitation (FX-12, unchanged)',
    () => deleteDoc(D(live, 'hostApplications/RC_HA_INV')))
  await ok('RC: staff (admin) may still delete a self-filed application',
    () => deleteDoc(D(opsAdmin, 'hostApplications/RC_HA_SELF')))

  // ════════════════════════════════════════════════════════════════════════
  console.log('D16 — a re-application is written by the API only')
  // ════════════════════════════════════════════════════════════════════════
  await no('a parent agency cannot write the API\'s own `reapply` source on a sub-agency',
    () => setDoc(D(live, 'agencies/RC_SUB_REAPPLY'), { ...NEW_SUB('AG_RC_LIVE', 'uidRcLive'), source: 'reapply' }))
  await no('…nor can staff (it is the Admin SDK\'s alone, like `self_app`)',
    () => setDoc(D(opsAdmin, 'agencies/RC_SUB_REAPPLY_STAFF'), { ...NEW_SUB('AG_RC_LIVE', 'uidRcOps'), source: 'reapply' }))

  // ════════════════════════════════════════════════════════════════════════
  console.log('D15 — contactVerifications is the server\'s record')
  // ════════════════════════════════════════════════════════════════════════
  await seed('contactVerifications/uidRcWait', {
    email: { address: 'uidrcwait@example.test', method: 'email_code', verifiedAt: new Date() },
  })
  await ok('the person reads their own verification record',
    () => getDoc(D(wait, 'contactVerifications/uidRcWait')))
  await ok('staff read it (support)',
    () => getDoc(D(opsAdmin, 'contactVerifications/uidRcWait')))
  await no('another partner cannot read it',
    () => getDoc(D(live, 'contactVerifications/uidRcWait')))
  await no('the person cannot WRITE their own (that would verify themselves)',
    () => setDoc(D(wait, 'contactVerifications/uidRcWait'),
      { email: { address: 'uidrcwait@example.test', method: 'email_code' }, phone: { number: '+91', method: 'sms' } }))
  await no('…nor create one from nothing',
    () => setDoc(D(pend, 'contactVerifications/uidRcPend'), { email: { address: 'x@example.test', method: 'email_code' } }))
  await no('an Owner\'s browser cannot write one either',
    () => setDoc(D(ownerStaff, 'contactVerifications/uidRcPend'), { email: { address: 'x@example.test', method: 'email_code' } }))

  // ════════════════════════════════════════════════════════════════════════
  console.log('D15 — an Owner\'s browser creates a partner LOGIN only as pending')
  // ════════════════════════════════════════════════════════════════════════
  const LOGIN = (uid, over = {}) => ({
    uid, email: `${uid}@example.test`, name: 'P', phone: '', role: 'agency', permissions: [],
    agencyId: 'AG_RC_NEW', isActive: true, status: 'pending', createdBy: 'crm_admin',
    createdAt: new Date(), lastLoginAt: null, ...over,
  })
  await ok('an Owner creates a pending partner login (lib/auth.ts, unchanged)',
    () => setDoc(D(ownerStaff, 'crmUsers/uidRcNew1'), LOGIN('uidRcNew1')))
  await no('…but not one born approved',
    () => setDoc(D(ownerStaff, 'crmUsers/uidRcNew2'), LOGIN('uidRcNew2', { status: 'approved' })))
  await no('…nor one carrying a per-role decision',
    () => setDoc(D(ownerStaff, 'crmUsers/uidRcNew3'), LOGIN('uidRcNew3', { roleStatus: { agency: 'approved' } })))
  await no('…nor a capability list',
    () => setDoc(D(ownerStaff, 'crmUsers/uidRcNew4'), LOGIN('uidRcNew4', { roles: ['agency', 'seller'] })))
  await no('an Owner cannot start a WAITING role from the browser',
    () => updateDoc(D(ownerStaff, 'crmUsers/uidRcWait'), { roleStatus: { agency: 'approved' }, status: 'approved' }))
}

let aborted = false
try {
  await main()
} catch (err) {
  aborted = true
  console.error(`ABORTED: ${String(err?.message ?? err).split('\n')[0]}`)
} finally {
  await testEnv.cleanup().catch(() => undefined)
}
if (tally.failures > 0) {
  console.error(`\n${tally.failures} of ${tally.checks} RC rule checks FAILED:`)
  for (const f of failed) console.error(`  · ${f}`)
}
if (!aborted && tally.failures === 0) console.log(`\nAll ${tally.checks} RC rule checks passed.`)
printResult(aborted)
const code = aborted || tally.failures > 0 ? 1 : 0
process.exitCode = code
setTimeout(() => process.exit(code), 2000).unref()

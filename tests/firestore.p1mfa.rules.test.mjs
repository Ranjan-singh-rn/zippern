/**
 * firestore.rules — P1-A3b Owner MFA boundary, per-session `mfa_sid`
 * (Firestore emulator, demo-zipper).
 *
 * An Owner's Firestore authority holds only for the Firebase session made from
 * the backend's post-MFA custom token: the token's `mfa_sid` names an ACTIVE,
 * unexpired binding in ownerMfaSessions/{uid} whose authTime equals the
 * token's auth_time, and the provider is 'custom'.
 *
 *   * DENIED through every helper family (isSuperAdmin, isAdmin, department
 *     helpers, isStaff, hasPerm via canDecideCoinOps): no binding document;
 *     password / Google / phone sign-ins at the SAME auth_time as a bound
 *     session; a quick-login custom token without mfa_sid; an unknown sid;
 *     another Owner's sid; minted-but-unconfirmed; a replayed redemption
 *     (other auth_time); mfa_sid on a non-custom provider; expired; signed out
 *     (binding removed); reset/suspended (document removed).
 *   * ALLOWED: the bound CRM session and the bound Android session,
 *     independently; signing out one leaves the other.
 *   * An Owner's own crmUsers document and personal app reads stay open.
 *   * Department roles and partners unchanged; no client reads or writes
 *     ownerMfaSessions.
 *
 * Run from the repository root (Java + firebase CLI):
 *   firebase emulators:exec --only firestore --project demo-zipper "node tests/firestore.p1mfa.rules.test.mjs"
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { doc, setDoc, getDoc, updateDoc, deleteDoc, collection, collectionGroup, getDocs, query, where } from 'firebase/firestore'

const here = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = process.env.ZIPPER_RULES_FILE || join(here, '..', 'firestore.rules')
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
    `P1MFA-RESULT checks=${tally.checks} failures=${tally.failures} ok_denied=${tally.ok_denied} ` +
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

// One handle per context — see the note at the top.
const handles = new Map()
function fs(ctx) {
  if (!handles.has(ctx)) handles.set(ctx, ctx.firestore())
  return handles.get(ctx)
}
const D = (ctx, path) => doc(fs(ctx), path)


const FUTURE = () => new Date(Date.now() + 7 * 864e5)
const PAST = () => new Date(Date.now() - 1000)
const live = (authTime, extra = {}) => ({ state: 'active', authTime, expiresAt: FUTURE(), apiJti: 'j', client: 'crm', ...extra })

async function main() {
  await testEnv.clearFirestore()

  // ── People ──────────────────────────────────────────────────────────────
  const ALL_PERMS = ['can_view_users', 'can_ban_users', 'can_adjust_balance', 'can_view_agencies',
    'can_view_sellers', 'can_approve_kyc', 'can_approve_seller', 'can_coin_operations', 'can_view_finance',
    'can_process_payout', 'can_economy_config', 'can_commission_slabs', 'can_app_config',
    'can_create_tickets', 'can_assign_tickets', 'can_close_tickets', 'can_manage_team',
    'can_send_broadcasts', 'can_approve_requests', 'can_monitor_live']
  const staff = (uid, role, extra = {}) => seed(`crmUsers/${uid}`, { uid, role, isActive: true, ...extra })
  for (const u of ['uidOwnB', 'uidOwnP', 'uidOwn2']) await staff(u, 'superadmin', { permissions: ALL_PERMS })
  await staff('uidFinA', 'finance_admin', { dept: 'finance', permissions: ['can_coin_operations', 'can_view_finance'] })
  await staff('uidFinM', 'finance_member', { dept: 'finance', permissions: ['can_coin_operations'] })
  await staff('uidTechM', 'tech_member', { dept: 'tech' })
  await staff('uidMktM', 'marketing_member', { dept: 'marketing' })
  await staff('uidSupM', 'support_member', { dept: 'support' })
  await staff('uidOpsA', 'ops_admin', { dept: 'ops' })
  await staff('uidOpsM', 'ops_member', { dept: 'ops' })
  await seed('crmUsers/uidAg', { uid: 'uidAg', role: 'agency', isActive: true, status: 'approved', agencyId: 'AG1', roleStatus: { agency: 'approved' } })
  await seed('users/uidUser', { name: 'u' })

  // uidOwnB: two confirmed sessions (CRM sid S_CRM @1000, Android sid S_AND @2000),
  // one minted-not-confirmed (S_MINT), one expired (S_EXP). uidOwn2 holds S_OTHER.
  // uidOwnP has no document (pending).
  const BINDINGS_B = {
    S_CRM: live(1000), S_AND: live(2000, { client: 'android' }),
    S_MINT: { state: 'minted', expiresAt: FUTURE(), apiJti: 'j3', client: 'crm' },
    S_EXP: { state: 'active', authTime: 1000, expiresAt: PAST(), apiJti: 'j4', client: 'crm' },
  }
  await seed('ownerMfaSessions/uidOwnB', { bindings: BINDINGS_B })
  await seed('ownerMfaSessions/uidOwn2', { bindings: { S_OTHER: live(1000) } })

  const ctx = (uid, t = {}) => testEnv.authenticatedContext(uid, { email: `${uid}@example.test`, email_verified: true, ...t })
  const cust = (auth_time, sid) => ({ auth_time, firebase: { sign_in_provider: 'custom' }, ...(sid ? { mfa_sid: sid } : {}) })
  const crm = ctx('uidOwnB', cust(1000, 'S_CRM'))       // bound CRM session
  const android = ctx('uidOwnB', cust(2000, 'S_AND'))   // bound Android ownerWork session
  const OWNERS_REFUSED = [
    ['a pending Owner (no binding document)', ctx('uidOwnP', cust(1000, 'S_CRM'))],
    ['a PASSWORD sign-in at the same auth_time as the bound CRM session', ctx('uidOwnB', { auth_time: 1000, firebase: { sign_in_provider: 'password' } })],
    ['a GOOGLE sign-in at the same auth_time', ctx('uidOwnB', { auth_time: 1000, firebase: { sign_in_provider: 'google.com' } })],
    ['a PHONE sign-in at the same auth_time', ctx('uidOwnB', { auth_time: 1000, phone_number: '+910000000001', firebase: { sign_in_provider: 'phone' } })],
    ['a quick-login custom token without mfa_sid', ctx('uidOwnB', cust(1000))],
    ['an unknown mfa_sid', ctx('uidOwnB', cust(1000, 'S_NOPE'))],
    ['another Owner\'s mfa_sid', ctx('uidOwnB', cust(1000, 'S_OTHER'))],
    ['a minted but unconfirmed binding', ctx('uidOwnB', cust(1000, 'S_MINT'))],
    ['a replayed redemption (same sid, other auth_time)', ctx('uidOwnB', cust(1001, 'S_CRM'))],
    ['mfa_sid on a non-custom (password) provider', ctx('uidOwnB', { auth_time: 1000, mfa_sid: 'S_CRM', firebase: { sign_in_provider: 'password' } })],
    ['an expired binding', ctx('uidOwnB', cust(1000, 'S_EXP'))],
    ['the default test token', ctx('uidOwnB')],
  ]

  // Fixtures the operations touch.
  await seed('withdrawalRequests/W1', { hostUid: 'someHost', amount: 1, status: 'pending' })
  await seed('users/someHost/diamondTransactions/T1', { amount: 1 })
  await seed('kycSubmissions/K1', { uid: 'someone', status: 'pending' })
  await seed('approvalRequests/A1', { requestedBy: { uid: 'uidOpsA' }, status: 'pending' })
  await seed('coinPurchaseRequests/C1', { sellerUid: 'SL1', status: 'pending', coinsRequested: 1 })

  const OPS = [
    ['read another staff member\'s crmUsers document (isSuperAdmin arm)', (c) => getDoc(D(c, 'crmUsers/uidFinA'))],
    ['read a withdrawal request (isFinance/isAdmin)', (c) => getDoc(D(c, 'withdrawalRequests/W1'))],
    ['collection-group read of diamondTransactions (isFinance/isAdmin)', (c) => getDocs(collectionGroup(fs(c), 'diamondTransactions'))],
    ['read a KYC submission (isAdmin/isSupport)', (c) => getDoc(D(c, 'kycSubmissions/K1'))],
    ['read an approval request (isSuperAdmin)', (c) => getDoc(D(c, 'approvalRequests/A1'))],
    ['list users (isStaff)', (c) => getDocs(collection(fs(c), 'users'))],
    ['write appConfig/control (isTech/isSuperAdmin)', (c) => setDoc(D(c, 'appConfig/control'), { maintenance: false })],
    ['write appConfig/paymentCredentials (owner only)', (c) => setDoc(D(c, 'appConfig/paymentCredentials'), { k: 'x' })],
    ['write a broadcast (isAdmin/isMarketing)', (c) => setDoc(D(c, `broadcasts/B_${Math.random().toString(36).slice(2)}`), { title: 't' })],
    ['reject a coin purchase (canDecideCoinOps → isSuperAdmin / hasPerm)', (c) => updateDoc(D(c, 'coinPurchaseRequests/C1'), { status: 'rejected' })],
  ]

  // ════════════════════════════════════════════════════════════════════════
  console.log('P1-A3b — Owner sign-ins without a live, confirmed mfa_sid are refused everywhere')
  // ════════════════════════════════════════════════════════════════════════
  for (const [who, c] of OWNERS_REFUSED) {
    for (const [what, run] of OPS) await no(`${who} cannot ${what}`, () => run(c))
  }

  // ════════════════════════════════════════════════════════════════════════
  console.log('P1-A3b — an Owner can always read their OWN crmUsers document and personal data')
  // ════════════════════════════════════════════════════════════════════════
  const pending = OWNERS_REFUSED[0][1]
  const pw = OWNERS_REFUSED[1][1]
  await seed('users/uidOwnP', { name: 'Owner personal profile' })
  await seed('broadcasts/BP1', { title: 'hello' })
  await ok('a pending Owner reads their own crmUsers document (MFA login screen)', () => getDoc(D(pending, 'crmUsers/uidOwnP')))
  await ok('a password sign-in of a bound Owner reads its own crmUsers document', () => getDoc(D(pw, 'crmUsers/uidOwnB')))
  await ok('a pending Owner reads their own app profile', () => getDoc(D(pending, 'users/uidOwnP')))
  await ok('a pending Owner reads in-app announcements like any app user', () => getDoc(D(pending, 'broadcasts/BP1')))

  // ════════════════════════════════════════════════════════════════════════
  console.log('P1-A3b — bound CRM and Android sessions keep full authority, independently')
  // ════════════════════════════════════════════════════════════════════════
  for (const [what, run] of OPS) await ok(`the bound CRM session can ${what}`, () => run(crm))
  for (const [what, run] of OPS.slice(0, 6)) await ok(`the bound Android session can ${what}`, () => run(android))

  // Sign-out of the CRM session removes ONLY its sid.
  const { S_CRM, ...rest } = BINDINGS_B
  await seed('ownerMfaSessions/uidOwnB', { bindings: rest })
  await no('after the CRM session signs out, the CRM session is refused', () => getDoc(D(crm, 'withdrawalRequests/W1')))
  await ok('…and the Android session is unaffected', () => getDoc(D(android, 'withdrawalRequests/W1')))

  // Observer reset / suspension / deactivation: the whole document goes.
  await seed('ownerMfaSessions/uidOwnB', { bindings: {} })
  await no('after a reset (all bindings removed) the Android session is refused too', () => getDoc(D(android, 'withdrawalRequests/W1')))

  // ════════════════════════════════════════════════════════════════════════
  console.log('P1-A3b — department roles and partners are unchanged')
  // ════════════════════════════════════════════════════════════════════════
  const finA = ctx('uidFinA'), finM = ctx('uidFinM'), techM = ctx('uidTechM'), mktM = ctx('uidMktM')
  const supM = ctx('uidSupM'), opsA = ctx('uidOpsA'), opsM = ctx('uidOpsM'), ag = ctx('uidAg'), user = ctx('uidUser')
  await ok('finance admin reads a withdrawal request', () => getDoc(D(finA, 'withdrawalRequests/W1')))
  await ok('finance member reads a withdrawal request', () => getDoc(D(finM, 'withdrawalRequests/W1')))
  await seed('coinPurchaseRequests/C3', { sellerUid: 'SL1', status: 'pending', coinsRequested: 1 })
  await ok('finance admin rejects a coin purchase (hasPerm + finance_admin)', () => updateDoc(D(finA, 'coinPurchaseRequests/C3'), { status: 'rejected' }))
  await seed('coinPurchaseRequests/C2', { sellerUid: 'SL1', status: 'pending', coinsRequested: 1 })
  await no('finance member cannot reject a coin purchase (unchanged)', () => updateDoc(D(finM, 'coinPurchaseRequests/C2'), { status: 'rejected' }))
  await ok('tech member writes appConfig/control (unchanged; see A2)', () => setDoc(D(techM, 'appConfig/control'), { maintenance: false }))
  await no('tech member cannot write paymentCredentials (owner only)', () => setDoc(D(techM, 'appConfig/paymentCredentials'), { k: 'y' }))
  await ok('marketing member writes a broadcast (unchanged)', () => setDoc(D(mktM, 'broadcasts/BM1'), { title: 't' }))
  await ok('support member reads a KYC submission (unchanged)', () => getDoc(D(supM, 'kycSubmissions/K1')))
  await ok('ops admin reads a KYC submission (isAdmin, unchanged)', () => getDoc(D(opsA, 'kycSubmissions/K1')))
  await no('ops member cannot read approval requests (unchanged)', () => getDoc(D(opsM, 'approvalRequests/A1')))
  await ok('a staff member with a stray mfa_sid claim is unaffected (claim ignored for non-owners)',
    () => getDoc(D(ctx('uidFinA', cust(5, 'S_NOPE')), 'withdrawalRequests/W1')))
  await ok('an agency reads its own crmUsers document', () => getDoc(D(ag, 'crmUsers/uidAg')))
  await no('an agency cannot read a withdrawal request', () => getDoc(D(ag, 'withdrawalRequests/W1')))
  await no('an app user cannot read approval requests', () => getDoc(D(user, 'approvalRequests/A1')))

  // ════════════════════════════════════════════════════════════════════════
  console.log('P1-A3b — no client reads or writes ownerMfaSessions')
  // ════════════════════════════════════════════════════════════════════════
  await seed('ownerMfaSessions/uidOwnB', { bindings: { S_CRM: live(1000) } })
  for (const [who, c] of [['a bound Owner', crm], ['a pending Owner', pending], ['a finance admin', finA],
                          ['an app user', user], ['a signed-out caller', testEnv.unauthenticatedContext()]]) {
    await no(`${who} cannot read ownerMfaSessions`, () => getDoc(D(c, 'ownerMfaSessions/uidOwnB')))
    await no(`${who} cannot list ownerMfaSessions`, () => getDocs(collection(fs(c), 'ownerMfaSessions')))
    await no(`${who} cannot write ownerMfaSessions`, () =>
      setDoc(D(c, 'ownerMfaSessions/uidOwnP'), { bindings: { X: live(1000) } }))
  }
  await no('a pending Owner cannot bind ITSELF', () =>
    setDoc(D(pending, 'ownerMfaSessions/uidOwnP'), { bindings: { S_CRM: live(1000) } }))
  await no('a bound Owner cannot confirm or extend its own binding', () =>
    updateDoc(D(crm, 'ownerMfaSessions/uidOwnB'), { 'bindings.S_CRM.expiresAt': FUTURE() }))
  await no('a bound Owner cannot delete its binding document', () => deleteDoc(D(crm, 'ownerMfaSessions/uidOwnB')))
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
  console.error(`\n${tally.failures} of ${tally.checks} P1 owner-MFA rule checks FAILED:`)
  for (const f of failed) console.error(`  · ${f}`)
}
if (!aborted && tally.failures === 0) console.log(`\nAll ${tally.checks} P1 owner-MFA rule checks passed.`)
printResult(aborted)
// Not `process.exit()` here: stdout to a pipe is asynchronous on macOS, and an
// immediate exit can drop the P1MFA-RESULT line the runner reads. The exit code
// is set and the process ends once the output has drained; the unref'd timer
// only matters if a stray handle would otherwise keep the emulator run waiting.
const code = aborted || tally.failures > 0 ? 1 : 0
process.exitCode = code
setTimeout(() => process.exit(code), 2000).unref()

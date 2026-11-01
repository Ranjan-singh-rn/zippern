/**
 * firestore.rules — P1-A3b Owner MFA boundary (Firestore emulator, demo-zipper).
 *
 * An Owner's Firestore authority holds only for a Firebase sign-in the backend
 * bound to an MFA-verified API session: ownerMfaSessions/{uid}.active has the
 * key "<auth_time>:<sign_in_provider>" with an unexpired timestamp.
 *
 *   * pending (no document), expired, mismatched auth_time, mismatched
 *     provider and revoked (key removed) Owners are refused through EVERY
 *     helper family: isSuperAdmin, isAdmin, the department helpers, isStaff,
 *     and hasPerm (via canDecideCoinOps);
 *   * a bound Owner gets the same operations;
 *   * an Owner can always read their OWN crmUsers document (MFA login screen);
 *   * independent CRM and Android sign-ins: both bound, removing one leaves
 *     the other; same-auth_time collision — one shared key, sign-out of one
 *     session (key kept while another binding holds it) leaves access;
 *   * department roles and partners are unchanged;
 *   * no client — Owner, staff, app user, signed out — reads or writes
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

async function main() {
  await testEnv.clearFirestore()

  // ── People ──────────────────────────────────────────────────────────────
  const ALL_PERMS = ['can_view_users', 'can_ban_users', 'can_adjust_balance', 'can_view_agencies',
    'can_view_sellers', 'can_approve_kyc', 'can_approve_seller', 'can_coin_operations', 'can_view_finance',
    'can_process_payout', 'can_economy_config', 'can_commission_slabs', 'can_app_config',
    'can_create_tickets', 'can_assign_tickets', 'can_close_tickets', 'can_manage_team',
    'can_send_broadcasts', 'can_approve_requests', 'can_monitor_live']
  const staff = (uid, role, extra = {}) => seed(`crmUsers/${uid}`, { uid, role, isActive: true, ...extra })
  for (const u of ['uidOwnB', 'uidOwnP', 'uidOwnX', 'uidOwnR', 'uidOwnC']) await staff(u, 'superadmin', { permissions: ALL_PERMS })
  await staff('uidFinA', 'finance_admin', { dept: 'finance', permissions: ['can_coin_operations', 'can_view_finance'] })
  await staff('uidFinM', 'finance_member', { dept: 'finance', permissions: ['can_coin_operations'] })
  await staff('uidTechM', 'tech_member', { dept: 'tech' })
  await staff('uidMktM', 'marketing_member', { dept: 'marketing' })
  await staff('uidSupM', 'support_member', { dept: 'support' })
  await staff('uidOpsA', 'ops_admin', { dept: 'ops' })
  await staff('uidOpsM', 'ops_member', { dept: 'ops' })
  await seed('crmUsers/uidAg', { uid: 'uidAg', role: 'agency', isActive: true, status: 'approved', agencyId: 'AG1', roleStatus: { agency: 'approved' } })
  await seed('users/uidUser', { name: 'u' })

  // Bindings. Keys are "<auth_time>:<provider>".
  await seed('ownerMfaSessions/uidOwnB', { active: { '1000:password': FUTURE(), '2000:phone': FUTURE(), '900:password': PAST() } })
  await seed('ownerMfaSessions/uidOwnR', { bindings: {}, active: {} })            // revoked: every key removed
  await seed('ownerMfaSessions/uidOwnX', { active: { '1000:password': PAST() } })   // expired
  await seed('ownerMfaSessions/uidOwnC', { active: { '1000:password': FUTURE() } }) // collision fixture
  // uidOwnP has no document at all (pending).

  const tok = (auth_time, provider) => ({ email_verified: true, auth_time, firebase: { sign_in_provider: provider } })
  const ctx = (uid, t = {}) => testEnv.authenticatedContext(uid, { email: `${uid}@example.test`, email_verified: true, ...t })
  const crm = ctx('uidOwnB', tok(1000, 'password'))       // bound CRM sign-in
  const android = ctx('uidOwnB', tok(2000, 'phone'))      // bound Android sign-in
  const OWNERS_REFUSED = [
    ['a pending Owner (no binding document)', ctx('uidOwnP', tok(1000, 'password'))],
    ['an Owner whose binding expired', ctx('uidOwnX', tok(1000, 'password'))],
    ['an Owner whose binding was revoked', ctx('uidOwnR', tok(1000, 'password'))],
    ['an Owner sign-in with a different auth_time', ctx('uidOwnB', tok(1001, 'password'))],
    ['an Owner sign-in with a different provider', ctx('uidOwnB', tok(1000, 'google.com'))],
    ['an Owner sign-in matching only an EXPIRED key', ctx('uidOwnB', tok(900, 'password'))],
    ['an Owner with the default test token (no key)', ctx('uidOwnB')],
  ]

  // Fixtures the operations touch.
  await seed('withdrawalRequests/W1', { hostUid: 'someHost', amount: 1, status: 'pending' })
  await seed('users/someHost/diamondTransactions/T1', { amount: 1 })
  await seed('kycSubmissions/K1', { uid: 'someone', status: 'pending' })
  await seed('approvalRequests/A1', { requestedBy: { uid: 'uidOpsA' }, status: 'pending' })
  await seed('coinPurchaseRequests/C1', { sellerUid: 'SL1', status: 'pending', coinsRequested: 1 })

  // One operation per helper family. Each must be refused to every unbound
  // Owner and allowed to a bound one.
  const OPS = [
    ['read another staff member\'s crmUsers document (isSuperAdmin arm)', (c) => getDoc(D(c, 'crmUsers/uidFinA'))],
    ['read a withdrawal request (isFinance/isAdmin)', (c) => getDoc(D(c, 'withdrawalRequests/W1'))],
    ['collection-group read of diamondTransactions (isFinance/isAdmin)', (c) => getDocs(collectionGroup(fs(c), 'diamondTransactions'))],
    ['read a KYC submission (isAdmin/isSupport)', (c) => getDoc(D(c, 'kycSubmissions/K1'))],
    ['read an approval request (isSuperAdmin)', (c) => getDoc(D(c, 'approvalRequests/A1'))],
    ['write appConfig/control (isTech/isSuperAdmin)', (c) => setDoc(D(c, 'appConfig/control'), { maintenance: false })],
    ['write appConfig/paymentCredentials (owner only)', (c) => setDoc(D(c, 'appConfig/paymentCredentials'), { k: 'x' })],
    ['write a broadcast (isAdmin/isMarketing)', (c) => setDoc(D(c, `broadcasts/B_${Math.random().toString(36).slice(2)}`), { title: 't' })],
    ['reject a coin purchase (canDecideCoinOps → isSuperAdmin / hasPerm)', (c) => updateDoc(D(c, 'coinPurchaseRequests/C1'), { status: 'rejected' })],
  ]

  // ════════════════════════════════════════════════════════════════════════
  console.log('P1-A3b — unbound Owners are refused through every helper family')
  // ════════════════════════════════════════════════════════════════════════
  for (const [who, c] of OWNERS_REFUSED) {
    for (const [what, run] of OPS) await no(`${who} cannot ${what}`, () => run(c))
  }

  // ════════════════════════════════════════════════════════════════════════
  console.log('P1-A3b — an Owner can always read their OWN crmUsers document')
  // ════════════════════════════════════════════════════════════════════════
  for (const [who, c] of OWNERS_REFUSED.slice(0, 3)) {
    await ok(`${who} reads their own crmUsers document (MFA login screen)`, () =>
      getDoc(D(c, `crmUsers/${who.includes('pending') ? 'uidOwnP' : who.includes('expired') ? 'uidOwnX' : 'uidOwnR'}`)))
  }

  // ════════════════════════════════════════════════════════════════════════
  console.log('P1-A3b — a pending Owner keeps their PERSONAL app access (independent of CRM MFA)')
  // ════════════════════════════════════════════════════════════════════════
  await seed('users/uidOwnP', { name: 'Owner personal profile' })
  await seed('broadcasts/BP1', { title: 'hello' })
  const pending = OWNERS_REFUSED[0][1]
  await ok('a pending Owner reads their own app profile (users/{uid})', () => getDoc(D(pending, 'users/uidOwnP')))
  await ok('a pending Owner reads in-app announcements like any app user', () => getDoc(D(pending, 'broadcasts/BP1')))
  await no('a pending Owner cannot LIST every user (staff power, gated)', () => getDocs(collection(fs(pending), 'users')))
  await ok('a bound Owner can list users', () => getDocs(collection(fs(crm), 'users')))

  // ════════════════════════════════════════════════════════════════════════
  console.log('P1-A3b — bound Owner sign-ins (CRM and Android) keep full authority')
  // ════════════════════════════════════════════════════════════════════════
  for (const [what, run] of OPS) await ok(`the bound CRM sign-in can ${what}`, () => run(crm))
  for (const [what, run] of OPS.slice(0, 5)) await ok(`the bound Android sign-in can ${what}`, () => run(android))

  // Signing out the CRM session removes ITS key; Android keeps working.
  await seed('ownerMfaSessions/uidOwnB', { active: { '2000:phone': FUTURE() } })
  await no('after the CRM session signs out, the CRM sign-in is refused', () => getDoc(D(crm, 'withdrawalRequests/W1')))
  await ok('…and the Android sign-in is unaffected', () => getDoc(D(android, 'withdrawalRequests/W1')))

  // ════════════════════════════════════════════════════════════════════════
  console.log('P1-A3b — same-auth_time collision: the derived key, not one binding, decides')
  // ════════════════════════════════════════════════════════════════════════
  // Two API sessions of uidOwnC both bound to auth_time 1000/password: the
  // backend keeps two bindings and one active key. Signing one out keeps the
  // key (the other binding still holds it); removing the last drops it.
  const twin = ctx('uidOwnC', tok(1000, 'password'))
  await seed('ownerMfaSessions/uidOwnC', {
    bindings: { b1: { authTime: 1000, provider: 'password', apiJti: 'j1', expiresAt: FUTURE() },
                b2: { authTime: 1000, provider: 'password', apiJti: 'j2', expiresAt: FUTURE() } },
    active: { '1000:password': FUTURE() } })
  await ok('with two bindings on one key, the sign-in is authorised', () => getDoc(D(twin, 'withdrawalRequests/W1')))
  await seed('ownerMfaSessions/uidOwnC', {
    bindings: { b2: { authTime: 1000, provider: 'password', apiJti: 'j2', expiresAt: FUTURE() } },
    active: { '1000:password': FUTURE() } })
  await ok('after one session signs out, the other keeps access (key still derived)', () => getDoc(D(twin, 'withdrawalRequests/W1')))
  await seed('ownerMfaSessions/uidOwnC', { bindings: {}, active: {} })
  await no('after the last session signs out, the key is gone', () => getDoc(D(twin, 'withdrawalRequests/W1')))

  // ════════════════════════════════════════════════════════════════════════
  console.log('P1-A3b — department roles and partners are unchanged')
  // ════════════════════════════════════════════════════════════════════════
  const finA = ctx('uidFinA'), finM = ctx('uidFinM'), techM = ctx('uidTechM'), mktM = ctx('uidMktM')
  const supM = ctx('uidSupM'), opsA = ctx('uidOpsA'), opsM = ctx('uidOpsM'), ag = ctx('uidAg'), user = ctx('uidUser')
  await ok('finance admin reads a withdrawal request', () => getDoc(D(finA, 'withdrawalRequests/W1')))
  await ok('finance member reads a withdrawal request', () => getDoc(D(finM, 'withdrawalRequests/W1')))
  await ok('finance admin rejects a coin purchase (hasPerm + finance_admin)', () => updateDoc(D(finA, 'coinPurchaseRequests/C1'), { status: 'rejected' }))
  await seed('coinPurchaseRequests/C2', { sellerUid: 'SL1', status: 'pending', coinsRequested: 1 })
  await no('finance member cannot reject a coin purchase (unchanged)', () => updateDoc(D(finM, 'coinPurchaseRequests/C2'), { status: 'rejected' }))
  await ok('tech member writes appConfig/control (unchanged; see A2)', () => setDoc(D(techM, 'appConfig/control'), { maintenance: false }))
  await no('tech member cannot write paymentCredentials (owner only)', () => setDoc(D(techM, 'appConfig/paymentCredentials'), { k: 'y' }))
  await ok('marketing member writes a broadcast (unchanged)', () => setDoc(D(mktM, 'broadcasts/BM1'), { title: 't' }))
  await ok('support member reads a KYC submission (unchanged)', () => getDoc(D(supM, 'kycSubmissions/K1')))
  await ok('ops admin reads a KYC submission (isAdmin, unchanged)', () => getDoc(D(opsA, 'kycSubmissions/K1')))
  await no('ops member cannot read approval requests (unchanged)', () => getDoc(D(opsM, 'approvalRequests/A1')))
  await ok('an agency reads its own crmUsers document', () => getDoc(D(ag, 'crmUsers/uidAg')))
  await no('an agency cannot read a withdrawal request', () => getDoc(D(ag, 'withdrawalRequests/W1')))
  await no('an app user cannot read approval requests', () => getDoc(D(user, 'approvalRequests/A1')))

  // ════════════════════════════════════════════════════════════════════════
  console.log('P1-A3b — no client reads or writes ownerMfaSessions')
  // ════════════════════════════════════════════════════════════════════════
  for (const [who, c] of [['a bound Owner', crm], ['a pending Owner', OWNERS_REFUSED[0][1]], ['a finance admin', finA],
                          ['an app user', user], ['a signed-out caller', testEnv.unauthenticatedContext()]]) {
    await no(`${who} cannot read ownerMfaSessions`, () => getDoc(D(c, 'ownerMfaSessions/uidOwnB')))
    await no(`${who} cannot list ownerMfaSessions`, () => getDocs(collection(fs(c), 'ownerMfaSessions')))
    await no(`${who} cannot write ownerMfaSessions`, () =>
      setDoc(D(c, 'ownerMfaSessions/uidOwnP'), { active: { '1000:password': FUTURE() } }))
  }
  await no('a pending Owner cannot bind ITSELF', () =>
    setDoc(D(OWNERS_REFUSED[0][1], 'ownerMfaSessions/uidOwnP'), { active: { '1000:password': FUTURE() } }))
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

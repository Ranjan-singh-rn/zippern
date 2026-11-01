/**
 * firestore.rules — UGP (User / Guest / Partner) regression tests, against the
 * Firestore emulator.
 *
 *   UGP-C   emailOtpChallenges / emailOtpRate are server-only: a client that
 *           could read its own challenge could brute-force the code's digest
 *           offline; one that could write it could reset its attempt count.
 *   UGP-G   sub-agencies are ONE level: an agency login may create a
 *           sub-agency only when its OWN agency is a main agency (stored with
 *           `parentAgencyId: null`, '' or no field); the signup arms create
 *           main agencies only.
 *   UGP-F   an agency login with an EMPTY agency id cannot read the
 *           agency-less appeals (in-app and public-web ones).
 *
 * Each `no(...)` is a path the rules must refuse; each `ok(...)` the legitimate
 * flow beside it, so a rule that "fixes" a hole by refusing everything fails.
 *
 * ZIPPER_RULES_FILE=<path> runs the same checks against another rules file
 * (the pre-change copy) to show the new `no(...)` checks fail there.
 *
 * ── WHAT A FAILURE SAYS, AND WHY IT IS CLASSIFIED ───────────────────────────
 *
 *   FAIL [no:allowed]  a request the rules must refuse was ALLOWED — the only
 *                      failure that is evidence about the rules in a RED run
 *   FAIL [ok:denied]   a legitimate request was refused
 *   FAIL [no:error] / [ok:error]
 *                      the request did not reach a rules decision at all (a
 *                      harness or emulator problem). Never counted as RED.
 *
 * Every check is passed as a THUNK and run inside the try, so a synchronous
 * throw while building a request becomes a classified FAIL line instead of
 * killing the run; and the last line is always one `UGP-RESULT …` summary
 * (with `aborted=1` if the run stopped early), which the Mac runner parses.
 *
 * ── ONE FIRESTORE HANDLE PER CONTEXT ────────────────────────────────────────
 *
 * `RulesTestContext.firestore()` (rules-unit-testing 3.x) calls `useEmulator()`
 * on EVERY call, which rewrites the instance's settings — and once an instance
 * has been used, that throws "Firestore has already been started and its
 * settings can no longer be changed" (failed-precondition). The first version
 * of this file called it once per check and died on the second check of every
 * run, before any result was printed. Handles are therefore memoised per
 * context, exactly as `firestore.rules.test.mjs` and the Phase 1A suite do.
 * Seeding is unaffected: `withSecurityRulesDisabled` builds a fresh context
 * per call.
 *
 * Run (needs Java 21 + firebase CLI), from the repository root:
 *     firebase emulators:exec --only firestore --project demo-zipper \
 *         "node tests/firestore.ugp.rules.test.mjs"
 * `demo-` project ids never reach a real project.
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { doc, setDoc, getDoc } from 'firebase/firestore'

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
    `UGP-RESULT checks=${tally.checks} failures=${tally.failures} ok_denied=${tally.ok_denied} ` +
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

async function main() {
  await testEnv.clearFirestore()

  // ══════════════════════════════════════════════════════════════════════════
  console.log('UGP-C — the email-code collections are server-only')
  // ══════════════════════════════════════════════════════════════════════════
  const user = testEnv.authenticatedContext('uidU', {
    email: 'u@example.test', email_verified: true, firebase: { sign_in_provider: 'password' },
  })
  const nobody = testEnv.unauthenticatedContext()
  await seed('users/uidU', { name: 'u' })
  await seed('emailOtpChallenges/uidU', { emailKey: 'u@example.test', digest: 'ab', salt: 'cd', attempts: 4 })
  await seed('emailOtpRate/u_uidU', { windowStartMs: 1, count: 5 })
  await no('the owner cannot READ their own email-code challenge',
    () => getDoc(D(user, 'emailOtpChallenges/uidU')))
  await no('…nor WRITE it (reset the attempt counter)',
    () => setDoc(D(user, 'emailOtpChallenges/uidU'), { emailKey: 'u@example.test', attempts: 0 }))
  await no('…nor create one for somebody else',
    () => setDoc(D(user, 'emailOtpChallenges/uidOther'), { attempts: 0 }))
  await no('…nor read the send-rate rows',
    () => getDoc(D(user, 'emailOtpRate/u_uidU')))
  await no('…nor reset them',
    () => setDoc(D(user, 'emailOtpRate/u_uidU'), { windowStartMs: 1, count: 0 }))
  await no('an unauthenticated caller cannot read a challenge',
    () => getDoc(D(nobody, 'emailOtpChallenges/uidU')))

  // ══════════════════════════════════════════════════════════════════════════
  console.log('UGP-G — a sub-agency cannot create a sub-agency')
  // ══════════════════════════════════════════════════════════════════════════
  const AGENCY = (over = {}) => ({
    agencyName: 'A', ownerEmail: 'a@example.test', status: 'approved', isActive: true,
    kycStatus: 'approved', ...over,
  })
  // The REAL shape of a main agency: the signup forms and the API store an
  // explicit `parentAgencyId: null` (review finding — a rule reading
  // `get('parentAgencyId', '') == ''` refused every one of them).
  await seed('agencies/AG_MAIN', AGENCY({ type: 'main', parentAgencyId: null, crmUid: 'uidMainAg' }))
  await seed('crmUsers/uidMainAg', {
    uid: 'uidMainAg', role: 'agency', isActive: true, status: 'approved', agencyId: 'AG_MAIN',
    roleStatus: { agency: 'approved' },
  })
  await seed('agencies/AG_SUB', AGENCY({ type: 'sub', parentAgencyId: 'AG_MAIN', crmUid: 'uidSubAg' }))
  await seed('crmUsers/uidSubAg', {
    uid: 'uidSubAg', role: 'agency', isActive: true, status: 'approved', agencyId: 'AG_SUB',
    roleStatus: { agency: 'approved' },
  })
  // A legacy sub-agency: a parent link and no `type` — the API reads it as a sub.
  await seed('agencies/AG_LEGACY_SUB', AGENCY({ parentAgencyId: 'AG_MAIN', crmUid: 'uidLegacySub' }))
  await seed('crmUsers/uidLegacySub', {
    uid: 'uidLegacySub', role: 'agency', isActive: true, status: 'approved', agencyId: 'AG_LEGACY_SUB',
    roleStatus: { agency: 'approved' },
  })

  const NEW_SUB = (parent, creator) => ({
    agencyName: 'New sub', ownerName: 'S', ownerEmail: 'new@example.test', type: 'sub',
    parentAgencyId: parent, status: 'pending', kycStatus: 'submitted', isActive: false,
    source: 'agency_created', createdByUid: creator,
  })
  const mainAg = testEnv.authenticatedContext('uidMainAg', { email: 'main@example.test', email_verified: true })
  const subAg = testEnv.authenticatedContext('uidSubAg', { email: 'sub@example.test', email_verified: true })
  const legacySub = testEnv.authenticatedContext('uidLegacySub', { email: 'leg@example.test', email_verified: true })

  await ok('a MAIN agency creates a sub-agency under itself (unchanged)',
    () => setDoc(D(mainAg, 'agencies/NEW_SUB_OK'), NEW_SUB('AG_MAIN', 'uidMainAg')))
  await no('a SUB-agency cannot create a sub-agency under itself',
    () => setDoc(D(subAg, 'agencies/NEW_SUB_NESTED'), NEW_SUB('AG_SUB', 'uidSubAg')))
  await no('…nor can a legacy sub (parent link, no type)',
    () => setDoc(D(legacySub, 'agencies/NEW_SUB_LEGACY'), NEW_SUB('AG_LEGACY_SUB', 'uidLegacySub')))
  await no('a main agency cannot create a sub under ANOTHER agency',
    () => setDoc(D(mainAg, 'agencies/NEW_SUB_OTHER'), NEW_SUB('AG_SUB', 'uidMainAg')))

  // Older main agencies: no `type`, no `parentAgencyId` at all — still main.
  await seed('agencies/AG_OLD_MAIN', AGENCY({ crmUid: 'uidOldMain' }))
  await seed('crmUsers/uidOldMain', {
    uid: 'uidOldMain', role: 'agency', isActive: true, status: 'approved', agencyId: 'AG_OLD_MAIN',
    roleStatus: { agency: 'approved' },
  })
  const oldMain = testEnv.authenticatedContext('uidOldMain', { email: 'old@example.test', email_verified: true })
  await ok('an OLDER main agency (no type, no parent field) still creates a sub-agency',
    () => setDoc(D(oldMain, 'agencies/NEW_SUB_OLDMAIN'), NEW_SUB('AG_OLD_MAIN', 'uidOldMain')))
  // A login whose agency document does not exist: the get fails, and that denies.
  await seed('crmUsers/uidGhostAg', {
    uid: 'uidGhostAg', role: 'agency', isActive: true, status: 'approved', agencyId: 'AG_GHOST',
    roleStatus: { agency: 'approved' },
  })
  const ghostAg = testEnv.authenticatedContext('uidGhostAg', { email: 'ghost@example.test', email_verified: true })
  await no('a login whose own agency document is missing cannot create a sub-agency',
    () => setDoc(D(ghostAg, 'agencies/NEW_SUB_GHOST'), NEW_SUB('AG_GHOST', 'uidGhostAg')))

  // The signup arms create MAIN agencies only.
  const MAIN_SIGNUP = (over = {}) => ({
    agencyName: 'Signup', ownerName: 'S', ownerEmail: 'signup@example.test', type: 'main',
    parentAgencyId: null, status: 'pending', kycStatus: 'pending', isActive: false,
    source: 'self_signup', ...over,
  })
  const verifiedApp = testEnv.authenticatedContext('uidVerifiedApp', {
    email: 'signup@example.test', email_verified: true, firebase: { sign_in_provider: 'password' },
  })
  await ok('a verified signup still creates a MAIN agency (agency-signup, unchanged)',
    () => setDoc(D(verifiedApp, 'agencies/SIGNUP_MAIN'), MAIN_SIGNUP()))
  await no('…but not a SUB-agency naming any parent',
    () => setDoc(D(verifiedApp, 'agencies/SIGNUP_SUB'), MAIN_SIGNUP({ type: 'sub', parentAgencyId: 'AG_MAIN' })))
  const { type: _dropped, ...UNTYPED } = MAIN_SIGNUP({ parentAgencyId: 'AG_MAIN' })
  await no('…nor a record with a parent link and no type',
    () => setDoc(D(verifiedApp, 'agencies/SIGNUP_PARENTED'), UNTYPED))
  await no('…nor a sub-agency spelled another way (type "SUB", no parent)',
    () => setDoc(D(verifiedApp, 'agencies/SIGNUP_SUB_UPPER'), MAIN_SIGNUP({ type: 'SUB', parentAgencyId: '' })))
  // An agency whose OWN record says 'SUB' (the API lower-cases it) is a sub.
  await seed('agencies/AG_UPPER', AGENCY({ type: 'SUB', parentAgencyId: '', crmUid: 'uidUpper' }))
  await seed('crmUsers/uidUpper', {
    uid: 'uidUpper', role: 'agency', isActive: true, status: 'approved', agencyId: 'AG_UPPER',
    roleStatus: { agency: 'approved' },
  })
  const upperAg = testEnv.authenticatedContext('uidUpper', { email: 'upper@example.test', email_verified: true })
  await no('an agency stored as type "SUB" cannot create a sub-agency either',
    () => setDoc(D(upperAg, 'agencies/NEW_SUB_UPPER'), NEW_SUB('AG_UPPER', 'uidUpper')))
  const anon = testEnv.unauthenticatedContext()
  // FX-09: the unauthenticated create arm is removed — the public forms sign
  // in first, and an unauthenticated document names no owner, so approval
  // applied no per-person or contact rule to it. (Was asserted ALLOWED here.)
  await no('FX-09: an unauthenticated caller can no longer create a MAIN agency',
    () => setDoc(D(anon, 'agencies/PUBLIC_MAIN'), MAIN_SIGNUP({ ownerEmail: 'pub@example.test' })))
  await no('…nor a SUB-agency',
    () => setDoc(D(anon, 'agencies/PUBLIC_SUB'),
      MAIN_SIGNUP({ ownerEmail: 'pub@example.test', type: 'sub', parentAgencyId: 'AG_MAIN' })))

  // ══════════════════════════════════════════════════════════════════════════
  console.log('UGP-F — appeals with no agency are not readable by an agency login with no agency')
  // ══════════════════════════════════════════════════════════════════════════
  await seed('appeals/APL_PUBLIC', {
    subjectUid: 'uidBanned', subjectName: 'B', raisedByUid: '', raisedByRole: 'public', agencyId: '',
    kind: 'ban', statement: 'x'.repeat(30), status: 'pending', source: 'public_web',
  })
  // Raised by somebody OTHER than the reading login, so the read below is
  // decided by the agency arm and not by the raiser arm beside it.
  await seed('appeals/APL_AGENCY', {
    subjectUid: 'uidHost', subjectName: 'H', raisedByUid: 'uidAgencyStaff', raisedByRole: 'agency',
    agencyId: 'AG_MAIN', kind: 'ban', statement: 'y'.repeat(30), status: 'pending',
  })
  // A seller login that holds the agency capability before any agency record is linked.
  await seed('crmUsers/uidNoLink', {
    uid: 'uidNoLink', role: 'seller', roles: ['seller', 'agency'], isActive: true, status: 'approved',
    agencyId: '', sellerId: 'SL1', roleStatus: { seller: 'approved', agency: 'approved' },
  })
  const noLink = testEnv.authenticatedContext('uidNoLink', { email: 'nolink@example.test', email_verified: true })
  await no('an agency-capability login with an EMPTY agency id cannot read a public (agency-less) appeal',
    () => getDoc(D(noLink, 'appeals/APL_PUBLIC')))
  await ok('an agency login still reads the appeals of its own agency',
    () => getDoc(D(mainAg, 'appeals/APL_AGENCY')))
  await no('…and not the agency-less ones',
    () => getDoc(D(mainAg, 'appeals/APL_PUBLIC')))
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
  console.error(`\n${tally.failures} of ${tally.checks} UGP rule checks FAILED:`)
  for (const f of failed) console.error(`  · ${f}`)
}
if (!aborted && tally.failures === 0) console.log(`\nAll ${tally.checks} UGP rule checks passed.`)
printResult(aborted)
// Not `process.exit()` here: stdout to a pipe is asynchronous on macOS, and an
// immediate exit can drop the UGP-RESULT line the runner reads. The exit code
// is set and the process ends once the output has drained; the unref'd timer
// only matters if a stray handle would otherwise keep the emulator run waiting.
const code = aborted || tally.failures > 0 ? 1 : 0
process.exitCode = code
setTimeout(() => process.exit(code), 2000).unref()

/**
 * The session gate, case by case.
 *
 * `sessionGate` is the only thing in the CRM that may send somebody to /login.
 * It has been got wrong twice, and both times a signed-in person was thrown out
 * of the application. So it is checked exhaustively rather than by example.
 *
 * Three claims:
 *
 *   1. **Exactly one combination means "signed out".** Every other combination
 *      of every fact must render the app. This is asserted over the full
 *      cross-product, not over cases somebody remembered to write down — which
 *      is the point, because both live bugs were combinations nobody thought of.
 *   2. **The two historical regressions stay fixed.** The observer bounce and
 *      the owner-refresh bounce are asserted by name, so a future change that
 *      reintroduces either fails here with the story attached.
 *   3. **The decision never depends on the path.** The gate answers "is there a
 *      session", nothing more. Where that session may then sit is
 *      `resolvePartnerRedirect`'s job, and keeping the two apart is what stops
 *      one of them growing a special case that breaks the other.
 *
 * Run:  npm run test:session
 */

import { Gate, ONLY_SIGNED_OUT, SessionFacts, sessionGate } from './sessionGate'

let failures = 0
let checks = 0

function ok(claim: string, cond: boolean): void {
  checks += 1
  if (!cond) {
    failures += 1
    console.error(`  FAIL  ${claim}`)
  }
}

function eq(claim: string, got: Gate, want: Gate): void {
  checks += 1
  if (got !== want) {
    failures += 1
    console.error(`  FAIL  ${claim}\n        got ${got}, want ${want}`)
  }
}

const show = (f: SessionFacts): string =>
  `crmUser=${f.hasCrmUser} api=${f.apiRole ?? 'none'} ` +
  `token=${f.hasSessionToken} unread=${f.crmProfileUnread}`

const same = (a: SessionFacts, b: SessionFacts): boolean =>
  a.hasCrmUser === b.hasCrmUser &&
  a.apiRole === b.apiRole &&
  a.hasSessionToken === b.hasSessionToken &&
  a.crmProfileUnread === b.crmProfileUnread

// Every role the API can answer with, plus "not resolved yet".
const API_ROLES: (string | null)[] = [
  null, 'owner', 'observer', 'finance_admin', 'ops_admin', 'app_member', 'agency', 'seller',
]

// ── 1. Exactly one combination is signed out ────────────────────────────────
console.log('\n1. Exactly one combination means signed out')

const signedOut: SessionFacts[] = []
let combinations = 0

for (const hasCrmUser of [false, true]) {
  for (const apiRole of API_ROLES) {
    for (const hasSessionToken of [false, true]) {
      for (const crmProfileUnread of [false, true]) {
        const f: SessionFacts = { hasCrmUser, apiRole, hasSessionToken, crmProfileUnread }
        combinations += 1
        if (sessionGate(f) === 'login') signedOut.push(f)
      }
    }
  }
}

ok(
  `${combinations} combinations checked, exactly 1 is signed out ` +
    `(got ${signedOut.length}: ${signedOut.map(show).join(' | ') || 'none'})`,
  signedOut.length === 1,
)
ok(
  'and it is the one with no profile, no API identity, no token and no failed read',
  signedOut.length === 1 && same(signedOut[0], ONLY_SIGNED_OUT),
)

// ── 2. The two regressions that reached production ──────────────────────────
console.log('\n2. The bugs that actually happened')

eq(
  'the observer — an API identity and deliberately no Firestore record — is not evicted',
  sessionGate({
    hasCrmUser: false, apiRole: 'observer', hasSessionToken: true, crmProfileUnread: false,
  }),
  'allow',
)

eq(
  'an owner mid-refresh — API session resolved, Firebase still reading IndexedDB — is not evicted',
  sessionGate({
    hasCrmUser: false, apiRole: 'owner', hasSessionToken: true, crmProfileUnread: false,
  }),
  'allow',
)

eq(
  'the same owner one moment earlier, before the API identity resolved either',
  sessionGate({
    hasCrmUser: false, apiRole: null, hasSessionToken: true, crmProfileUnread: false,
  }),
  'allow',
)

eq(
  'a failed crmUsers read is unknown, not absent — hold position, do not evict',
  sessionGate({
    hasCrmUser: false, apiRole: null, hasSessionToken: false, crmProfileUnread: true,
  }),
  'allow',
)

eq(
  'a Firebase account with no staff record and nothing else IS signed out',
  sessionGate(ONLY_SIGNED_OUT),
  'login',
)

// ── 3. A loaded profile always renders ──────────────────────────────────────
console.log('\n3. A loaded profile always renders')

for (const apiRole of API_ROLES) {
  for (const hasSessionToken of [false, true]) {
    for (const crmProfileUnread of [false, true]) {
      eq(
        `a loaded crmUser renders regardless of the rest (${show({
          hasCrmUser: true, apiRole, hasSessionToken, crmProfileUnread,
        })})`,
        sessionGate({ hasCrmUser: true, apiRole, hasSessionToken, crmProfileUnread }),
        'allow',
      )
    }
  }
}

// ── 4. The gate is a pure function of the facts ─────────────────────────────
console.log('\n4. Stable and side-effect free')

const probe: SessionFacts = {
  hasCrmUser: false, apiRole: 'owner', hasSessionToken: true, crmProfileUnread: false,
}
const first = sessionGate(probe)
ok(
  'the same facts give the same answer every time',
  [...Array(50)].every(() => sessionGate({ ...probe }) === first),
)
ok(
  'and the facts are not mutated by asking',
  same(probe, {
    hasCrmUser: false, apiRole: 'owner', hasSessionToken: true, crmProfileUnread: false,
  }),
)

// ── Result ──────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n${failures} of ${checks} checks FAILED.\n`)
  process.exit(1)
}
console.log(`\nAll ${checks} session-gate checks passed.`)
console.log('  · exactly one combination out of ' + combinations + ' means signed out')
console.log('  · the observer is never evicted for having no Firestore record')
console.log('  · an owner mid-refresh is never evicted for Firestore lagging localStorage')
console.log('  · a failed profile read is unknown, and unknown is not absent')
console.log('  · nobody with a loaded profile is ever sent to /login\n')

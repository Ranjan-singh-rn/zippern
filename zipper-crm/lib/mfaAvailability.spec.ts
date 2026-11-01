/**
 * Audit C-3 — a backend without `/auth/mfa/status` must not lock every Owner
 * out. A 404 is "not available yet": proceed as before, with a notice. Any
 * other failure stays blocked.
 *
 * REAL: `lib/mfaAvailability.ts`, imported and called. The wiring in
 * `app/login/page.tsx` (Owner) and `app/observer/page.tsx` (Observer) is
 * checked on their source — they need a browser and a server, which a spec
 * does not have.
 *
 *   npm run test:mfaavail
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  OBSERVER_MFA_UNAVAILABLE_NOTICE, OWNER_MFA_UNAVAILABLE_NOTICE,
  classifyMfaStatusFailure, mfaUnavailable,
} from './mfaAvailability'

let checks = 0
const failures: string[] = []
function eq(claim: string, got: unknown, want: unknown): void {
  checks += 1
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g !== w) failures.push(`${claim}\n        got ${g}  want ${w}`)
}
function ok(claim: string, cond: boolean): void {
  checks += 1
  if (!cond) failures.push(claim)
}

// ── the classification ────────────────────────────────────────────────────────
eq('404 = the server has no two-step sign-in', classifyMfaStatusFailure({ status: 404 }), 'unavailable')
eq('405 too (a proxy answering for an unknown method)', classifyMfaStatusFailure({ status: 405 }), 'unavailable')
eq('a 5xx is a failure of THIS sign-in, not an absence', classifyMfaStatusFailure({ status: 503 }), 'failed')
eq('a 500 too', classifyMfaStatusFailure({ status: 500 }), 'failed')
eq('a network failure (status 0) stays blocked', classifyMfaStatusFailure({ status: 0 }), 'failed')
eq('a 401 stays blocked — the session is the problem', classifyMfaStatusFailure({ status: 401 }), 'failed')
eq('a 403 stays blocked — degrading on it would be a way around MFA', classifyMfaStatusFailure({ status: 403 }), 'failed')
eq('a plain Error with no status is a failure', classifyMfaStatusFailure(new Error('x')), 'failed')
eq('null is a failure', classifyMfaStatusFailure(null), 'failed')
eq('undefined is a failure', classifyMfaStatusFailure(undefined), 'failed')
eq('a string is a failure', classifyMfaStatusFailure('404'), 'failed')
eq('mfaUnavailable is the boolean form', [mfaUnavailable({ status: 404 }), mfaUnavailable({ status: 500 })], [true, false])

// ── the notices say "as before" and never claim the step was passed ──────────
for (const [who, notice] of [['Owner', OWNER_MFA_UNAVAILABLE_NOTICE], ['Observer', OBSERVER_MFA_UNAVAILABLE_NOTICE]] as const) {
  ok(`${who} notice says the step is not available`, /not available/i.test(notice))
  ok(`${who} notice says it is the server, not the person`, /server/i.test(notice))
  ok(`${who} notice says sign-in continued as before`, /as before/i.test(notice))
  ok(`${who} notice never says "verified"`, !/verified/i.test(notice))
}

// ── the wiring ────────────────────────────────────────────────────────────────
{
  const login = fs.readFileSync(path.join(__dirname, '..', 'app', 'login', 'page.tsx'), 'utf8')
  const fn = login.slice(login.indexOf('async function beginMfa('), login.indexOf('async function handleGoogle('))
  ok('beginMfa exists on the login page', fn.length > 0)
  ok('…asks the server for the MFA status', fn.includes('api.auth.mfaStatus()'))
  ok('…classifies a failure of that call with the shared module', fn.includes('mfaUnavailable('))
  ok('…on a stage that is not "blocked"', fn.includes("setMfaStage('unavailable')"))
  ok('…and that stage shows the Owner notice', login.includes("mfaStage === 'unavailable'") && login.includes('OWNER_MFA_UNAVAILABLE_NOTICE'))
  // The missing-binding case (CRM-FINDINGS F2): only a reported `bound` enters.
  const enter = login.slice(login.indexOf('function enterOrExplain('), login.indexOf('async function handleRetryBind('))
  ok('only a reported `bound` binding enters the CRM (F2)', enter.includes("b?.state === 'bound'") && !enter.includes("!b || b.state === 'bound'"))

  const observer = fs.readFileSync(path.join(__dirname, '..', 'app', 'observer', 'page.tsx'), 'utf8')
  ok('the observer page asks for its MFA status after the emailed code', observer.includes('api.auth.observerMfaStatus()'))
  ok('…classifies a failure with the shared module', observer.includes('mfaUnavailable('))
  ok('…and shows the Observer notice instead of blocking', observer.includes('OBSERVER_MFA_UNAVAILABLE_NOTICE'))
}

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} MFA-availability checks FAILED:\n`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`All ${checks} MFA-availability checks passed.`)
console.log('  · 404/405 on the status route = not available yet: proceed as before, with a notice')
console.log('  · 5xx, network, 401, 403 stay blocked — an outage is not a way around the second step')

/**
 * Decision 16 (RC) — a rejected partner is told the application's status at the
 * CRM door, not "This account has been deactivated".
 *
 * REAL: `lib/crmDoor.ts`, imported and called. The wiring in `lib/auth.ts`
 * (`resolveCrmUser`) and `lib/api.ts` (`refusalForCurrentLogin`) is checked on
 * their source — they need Firebase and a server, which a spec does not have.
 * The server half (the sentence itself) is `backend/tests/test_rc_subagency_reapply.py` §6.
 *
 *   npm run test:crmdoor
 */

import * as fs from 'fs'
import * as path from 'path'
import { DEACTIVATED_MESSAGE, asksApiWhyInactive, inactiveLoginMessage } from './crmDoor'

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

const REJECTED =
  'This application was not approved: Documents unreadable. You may apply again — a new application is reviewed on its own.'

// ── the sentence ──────────────────────────────────────────────────────────────
eq('a rejected agency login is shown the API\'s reason', inactiveLoginMessage('agency', REJECTED), REJECTED)
eq('…and so is a rejected seller login', inactiveLoginMessage('seller', REJECTED), REJECTED)
eq('a partner the API could not be asked about keeps the old sentence', inactiveLoginMessage('agency', ''), DEACTIVATED_MESSAGE)
eq('…also when the answer is blank', inactiveLoginMessage('agency', '   '), DEACTIVATED_MESSAGE)
eq('a deactivated STAFF login is never sent to the API and keeps the old sentence',
  [asksApiWhyInactive('ops_admin'), inactiveLoginMessage('ops_admin', REJECTED)], [false, DEACTIVATED_MESSAGE])
eq('the Owner too', [asksApiWhyInactive('superadmin'), inactiveLoginMessage('superadmin', 'x')], [false, DEACTIVATED_MESSAGE])
eq('only partner capabilities ask', ['agency', 'seller', '', undefined].map((r) => asksApiWhyInactive(r as string)),
  [true, true, false, false])

// ── the wiring ────────────────────────────────────────────────────────────────
{
  const auth = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auth.ts'), 'utf8')
  const fn = auth.slice(auth.indexOf('async function resolveCrmUser('), auth.indexOf('export async function crmSignIn('))
  const inactive = fn.slice(fn.indexOf('if (!data.isActive) {'))
  const asks = inactive.indexOf('apiAuth.refusalForCurrentLogin()')
  const out = inactive.indexOf('await firebaseSignOut(auth)')
  ok('resolveCrmUser asks the API why an inactive partner login is refused…', asks > 0)
  ok('…BEFORE signing the browser out (the Firebase session is what it asks with)', asks > 0 && out > asks)
  ok('…only for a partner login', inactive.slice(0, asks).includes('asksApiWhyInactive(data.role)'))
  ok('…and throws the door\'s sentence, so nobody is let in', inactive.includes('throw new Error(inactiveLoginMessage(data.role, apiRefusal))'))

  const api = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api.ts'), 'utf8')
  const start = api.indexOf('async refusalForCurrentLogin()')
  const body = api.slice(start, api.indexOf('requestObserverCode:', start))
  ok('refusalForCurrentLogin exists', start > 0)
  ok('…never adopts a session', !body.includes('adopt('))
  ok('…asks /auth/signin without a stored session (no 401 announcement)', body.includes("post<SessionResponse>('/auth/signin', { id_token: idToken }, false)"))
  ok('…revokes any session it was unexpectedly issued, with that session\'s own token',
    body.includes("request('/auth/signout'") && body.includes('Authorization: `Bearer ${issued.token}`'))
  ok('…returns the refusal only for 401/403', body.includes('err.status === 401 || err.status === 403'))
}

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} CRM door checks FAILED\n`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log(`All ${checks} CRM door checks passed.`)
console.log('  · a rejected partner sees the application status from the API, not "deactivated"')
console.log('  · staff and unreachable-API cases keep the old sentence; nobody is let in')

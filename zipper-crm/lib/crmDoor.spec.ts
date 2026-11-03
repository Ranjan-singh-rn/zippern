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
import { CrmDoorRefusal, DEACTIVATED_MESSAGE, asksApiWhyInactive, doorRefusalText, inactiveLoginMessage } from './crmDoor'

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
// QA #44: a SUSPENDED member of staff is told so — the API knows, the door asks.
const SUSPENDED =
  'Your staff access is suspended. An Owner can restore it. Your personal Zipper app account is not affected.'
eq('QA #44: an inactive STAFF login is asked about and shown the API\'s sentence (suspension)',
  [asksApiWhyInactive('ops_admin'), inactiveLoginMessage('ops_admin', SUSPENDED)], [true, SUSPENDED])
eq('QA #44: …a deactivated one keeps the deactivation sentence when the API says nothing more',
  inactiveLoginMessage('support_member', ''), DEACTIVATED_MESSAGE)
eq('every login with a role asks; a blank role does not', ['agency', 'seller', 'superadmin', 'ops_member', '', undefined]
  .map((r) => asksApiWhyInactive(r as string)), [true, true, true, true, false, false])
eq('a blank role keeps the old sentence whatever is passed', inactiveLoginMessage('', REJECTED), DEACTIVATED_MESSAGE)

// ── QA #49: the login page shows a door refusal as it is ───────────────────────
{
  const r = new CrmDoorRefusal(REJECTED)
  ok('a door refusal is an Error and a CrmDoorRefusal', r instanceof Error && r instanceof CrmDoorRefusal)
  eq('the rejection sentence is shown verbatim — even a reason containing "not found"',
    doorRefusalText('This application was not approved: the registration document was not found. You may apply again — a new application is reviewed on its own.'),
    'This application was not approved: the registration document was not found. You may apply again — a new application is reviewed on its own.')
  eq('the deactivation sentence gains the way forward', doorRefusalText(DEACTIVATED_MESSAGE),
    'This account has been deactivated. Contact your administrator.')
  const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'login', 'page.tsx'), 'utf8')
  const login = page.slice(page.indexOf('async function handleLogin()'), page.indexOf('// ── Step 2a'))
  ok('QA #49: the password door checks for a CrmDoorRefusal FIRST, before any substring',
    login.indexOf('err instanceof CrmDoorRefusal') > 0
    && login.indexOf('err instanceof CrmDoorRefusal') < login.indexOf("msg.includes('CRM account not found')"))
  ok('QA #49: the page no longer sorts door refusals by the word "deactivated"', !login.includes("msg.includes('deactivated')"))
  ok('QA #49: the Google door shows it too', page.includes("setError(err instanceof CrmDoorRefusal ? doorRefusalText(err.message) : 'Google sign-in failed. Try again.')"))
}

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
  ok('…and throws the door\'s sentence, so nobody is let in', inactive.includes('throw new CrmDoorRefusal(inactiveLoginMessage(data.role, apiRefusal))'))
  // QA #49: the question is asked with the token of THIS sign-in. AuthProvider's
  // crmUsers listener signs the browser out on `isActive: false` and used to
  // win the race, so `currentUser` was gone and the API was never asked.
  ok('QA #49: resolveCrmUser asks with the sign-in\'s own ID token when it has one',
    inactive.includes('idToken ? apiAuth.refusalForLogin(idToken) : apiAuth.refusalForCurrentLogin()'))
  const signIn = auth.slice(auth.indexOf('export async function crmSignIn('), auth.indexOf('export async function crmSignIn(') + 600)
  ok('QA #49: crmSignIn takes the token right after signing in and passes it on',
    signIn.indexOf('await cred.user.getIdToken()') > 0
    && signIn.indexOf('await cred.user.getIdToken()') < signIn.indexOf('resolveCrmUser(cred.user.uid, idToken)'))
  ok('QA #49: the Google doors pass their token too',
    auth.includes("resolveCrmUser(cred.user.uid, await cred.user.getIdToken().catch(() => ''))")
    && auth.includes("resolveCrmUser(res.user.uid, await res.user.getIdToken().catch(() => ''))"))

  const api = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api.ts'), 'utf8')
  const start = api.indexOf('async refusalForCurrentLogin()')
  const body = api.slice(start, api.indexOf('requestObserverCode:', start))
  ok('refusalForCurrentLogin exists', start > 0)
  ok('…never adopts a session', !body.includes('adopt('))
  ok('…asks /auth/signin without a stored session (no 401 announcement)', body.includes("post<SessionResponse>('/auth/signin', { id_token: idToken }, false)"))
  ok('…revokes any session it was unexpectedly issued, with that session\'s own token',
    body.includes("request('/auth/signout'") && body.includes('Authorization: `Bearer ${issued.token}`'))
  ok('…returns the refusal only for 401/403', body.includes('err.status === 401 || err.status === 403'))
  const given = api.indexOf('async refusalForLogin(idToken: string)')
  ok('QA #49: refusalForLogin asks with a GIVEN token and needs nobody signed in', given > 0
    && !api.slice(given, api.indexOf('requestObserverCode:', given)).includes('getAuth().currentUser'))
  ok('QA #49: refusalForCurrentLogin is the same question with the current token', body.includes('return auth.refusalForLogin(idToken)'))
}

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} CRM door checks FAILED\n`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log(`All ${checks} CRM door checks passed.`)
console.log('  · a rejected partner sees the application status from the API, not "deactivated"')
console.log('  · staff are asked too (QA #44); an unreachable API keeps the old sentence; nobody is let in')
console.log('  · QA #49: asked with the token of the sign-in being refused, not whoever is signed in by then')

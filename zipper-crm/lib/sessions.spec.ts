/**
 * B3 / §13 — every signed-in login (staff, Observer, agency, coin seller) can
 * see its live sessions and end the others: `/sessions`.
 *
 * REAL: `lib/sessions.ts` and `lib/partnerRouting.ts`, imported and run — the
 * second proves a partner can actually SIT on /sessions (it is a shared path,
 * like /profile) rather than being bounced to a dashboard. The page, the nav
 * entries and the export check are verified on their source; the routes and
 * their partner reachability are compared with the backend when it sits
 * beside this repo.
 *
 *   npm run test:sessions
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  PARTNER_SHARED_PATHS, allowedPartnerPaths, partnerLanding, resolvePartnerRedirect,
  type PartnerRoleHolder,
} from './partnerRouting'
import {
  QUICK_LOGIN_NOTE, clientLabel, describeUserAgent, otherSessions, revokeAllSummary, sessionsFrom,
} from './sessions'

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

const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36'
const SAFARI_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const EDGE_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0'
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0'
const ANDROID_APP = 'okhttp/4.12.0'

// ── 1. reading the list ──────────────────────────────────────────────────────
{
  const rows = sessionsFrom({
    count: 4,
    sessions: [
      { id: 'aaaa1111', current: false, client: 'android', ip: '10.0.0.2', user_agent: ANDROID_APP, issued_at: '2026-10-30T10:00:00Z', expires_at: '2026-11-06T10:00:00Z', last_active_at: '2026-10-31T10:00:00Z', mfa_verified: null, renewed: true },
      { id: 'bbbb2222', current: true, client: 'crm', ip: '10.0.0.1', user_agent: CHROME_MAC, issued_at: '2026-10-29T10:00:00Z', expires_at: '2026-11-05T10:00:00Z', mfa_verified: true },
      { id: 'cccc3333', current: false, client: '', user_agent: '', issued_at: '2026-10-31T12:00:00Z' },
      { current: false, client: 'crm' },
      null,
    ],
  })
  eq('rows with an id; current first, then newest', rows.map((r) => r.id), ['bbbb2222', 'cccc3333', 'aaaa1111'])
  eq('the current one is flagged', rows[0].current, true)
  eq('clients by name', rows.map((r) => r.clientLabel), ['CRM (web)', 'Unknown client', 'Zipper app (Android)'])
  eq('devices from the user agent', rows.map((r) => r.device), ['Chrome on macOS', 'Unknown device', 'Android app'])
  eq('the second step, as recorded', rows.map((r) => r.mfa), ['verified', 'n/a', 'n/a'])
  eq('renewal is shown', rows.map((r) => r.renewed), [false, false, true])
  eq('a missing address is empty, never invented', rows[1].ip, '')
  eq('"everywhere else" is everything but this one', otherSessions(rows).map((r) => r.id), ['cccc3333', 'aaaa1111'])
  eq('a bare array works', sessionsFrom([{ id: 'x', current: true }]).length, 1)
  eq('nothing usable → empty, never a throw', [sessionsFrom(null), sessionsFrom({}), sessionsFrom('x')], [[], [], []])
}

// ── 2. user agents ───────────────────────────────────────────────────────────
eq('Safari on iOS', describeUserAgent(SAFARI_IOS), 'Safari on iOS')
eq('Edge on Windows (not Chrome)', describeUserAgent(EDGE_WIN), 'Edge on Windows')
eq('Firefox on Linux', describeUserAgent(FIREFOX_LINUX), 'Firefox on Linux')
eq('blank', describeUserAgent(''), 'Unknown device')
eq('an unknown client value is shown as written', clientLabel('ios'), 'ios')

// ── 3. after "Sign out everywhere else" ──────────────────────────────────────
{
  const kept = revokeAllSummary({ message: 'Signed out everywhere else.', revoked: 2, current_kept: true, problems: [] })
  eq('the server\'s sentence first, then the count', kept.text, 'Signed out everywhere else. 2 sessions ended.')
  eq('…and this browser stays signed in', kept.signedOutHere, false)
  const none = revokeAllSummary({ message: 'Signed out everywhere else.', revoked: 0, current_kept: true })
  eq('nothing else to end is said plainly', none.text, 'Signed out everywhere else. There were no other sessions to end.')
  const all = revokeAllSummary({ message: 'Signed out everywhere.', revoked: 3, current_kept: false, problems: ['firebase: timeout', ' '] })
  eq('including this one → sign out here too', all.signedOutHere, true)
  eq('…and the problems are shown, blanks dropped', all.problems, ['firebase: timeout'])
  eq('no count from the server is said, not guessed', revokeAllSummary({ message: 'Signed out.' }).text,
    'Signed out. The server did not say how many sessions were ended.')
  ok('quick login is named as untouched', /not removed by this/.test(QUICK_LOGIN_NOTE))
}

// ── 4. a partner may sit on /sessions; nobody is landed there ───────────────
{
  ok('/sessions is a shared partner path', PARTNER_SHARED_PATHS.includes('/sessions'))
  const users: PartnerRoleHolder[] = [
    { role: 'agency', status: 'approved' },
    { role: 'seller', status: 'pending' },
    { role: 'agency', status: 'approved', roles: ['agency', 'seller'], roleStatus: { agency: 'approved', seller: 'approved' } },
    { role: 'seller', status: 'awaiting_verification' },
  ]
  for (const u of users) {
    for (const p of ['/sessions', '/sessions/']) {
      eq(`partner ${u.role}/${u.status} may sit on ${p}`, resolvePartnerRedirect(u, p), null)
    }
    ok(`partner ${u.role}/${u.status} is never landed on /sessions`, partnerLanding(u) !== '/sessions')
    ok(`partner ${u.role}/${u.status}: /sessions is not a capability path`, !allowedPartnerPaths(u).includes('/sessions'))
  }
  eq('a path that merely starts with the letters is still refused',
    resolvePartnerRedirect({ role: 'agency', status: 'approved' }, '/sessions-export'), '/agency-dashboard')
  eq('staff are untouched', resolvePartnerRedirect({ role: 'ops_admin' }, '/sessions'), null)
}

// ── 5. compared with the server ──────────────────────────────────────────────
{
  const backend = path.join(__dirname, '..', '..', 'backend', 'app')
  const auth = path.join(backend, 'routers', 'auth.py')
  const deps = path.join(backend, 'core', 'deps.py')
  if (fs.existsSync(auth) && fs.existsSync(deps)) {
    const a = fs.readFileSync(auth, 'utf8')
    ok('server: GET /auth/sessions', a.includes('@router.get("/sessions")'))
    ok('server: POST /auth/sessions/revoke-all', a.includes('@router.post("/sessions/revoke-all")'))
    ok('server: include_current defaults to false ("everywhere ELSE")', a.includes('include_current: bool = Field(default=False)'))
    ok('server: both are self-scoped', (a.match(/uid = own_session_uid\(user\)/g) ?? []).length >= 2)
    const d = fs.readFileSync(deps, 'utf8')
    ok('server: a partner session may reach both',
      d.includes('("GET", "/api/auth/sessions")') && d.includes('("POST", "/api/auth/sessions/revoke-all")'))
  } else {
    console.log('  (backend not beside this repo — the server comparison was skipped)')
  }
}

// ── 6. the wiring ────────────────────────────────────────────────────────────
{
  const root = path.join(__dirname, '..')
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')
  const page = read('app/sessions/page.tsx')
  ok('the page lists the sessions', page.includes('api.auth.sessions()') && page.includes('sessionsFrom('))
  ok('…offers "Sign out everywhere else"', page.includes('api.auth.revokeAllSessions(false)') && page.includes('Sign out everywhere else'))
  ok('…and signs this browser out when the current session went too', page.includes('signedOutHere'))
  const layout = read('app/layout.tsx')
  ok('staff have a nav entry', /href: '\/sessions',[^\n]*roles: STAFF_ROLES/.test(layout))
  ok('the Observer may open it and has a nav entry', layout.includes("'/sessions'") && layout.includes('href="/sessions"'))
  ok('partners have a nav entry', read('components/PartnerRoleSwitcher.tsx').includes('href="/sessions"'))
  ok('the export check requires the page', read('scripts/verify-out.mjs').includes("'sessions/index.html'"))
  const api = read('lib/api.ts')
  ok('lib/api.ts: the two routes', api.includes("'/auth/sessions'") && api.includes("'/auth/sessions/revoke-all', { include_current: includeCurrent }"))
}

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} session checks FAILED:\n`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`All ${checks} session checks passed.`)
console.log('  · every live session of the login, current first; "Sign out everywhere else" ends the rest')
console.log('  · staff, the Observer and partners all reach /sessions; a partner is never bounced off it, nor landed on it')

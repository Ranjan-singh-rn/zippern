/**
 * FX-11 (RF-16) — the agency dashboard lists its hosts from its own roster
 * (readable by the agency), current rows only, completed from each user
 * document.
 *
 * REAL: `lib/agencyDashboardHosts.ts`, imported and called. The page-level
 * wiring (which collection is read) is checked at the source below.
 *
 *   npm run test:dashhosts
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  currentRosterRows, hostsFromRoster, rosterRowIsCurrent, type RosterRowDoc, type UserRead,
} from './agencyDashboardHosts'

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

type Host = { uid: string; name: string; beans?: number; isVerifiedHost?: boolean; callRateBeans?: number }
const row = (id: string, data: Record<string, unknown> = {}): RosterRowDoc => ({ id, data: { uid: id, ...data } })

// ── current rows only ────────────────────────────────────────────────────────
eq('a legacy row (no active) is current', rosterRowIsCurrent({ uid: 'a' }), true)
eq('active:false is not', rosterRowIsCurrent({ active: false }), false)
eq('revoked and purged rows are not listed',
  currentRosterRows([row('A'), row('R', { active: false, removedReason: 'revoked' }),
    row('P', { active: false, removedReason: 'purged' }), row('C', { active: true })]).map((r) => r.id),
  ['A', 'C'])
eq('one row per uid (a stray duplicate is not a second host)',
  currentRosterRows([row('A'), { id: 'A-dup', data: { uid: 'A' } }]).length, 1)

// ── completed from the user document ─────────────────────────────────────────
{
  const users = new Map<string, UserRead>([
    ['A', { name: 'Asha', beans: 1200, isVerifiedHost: true }],
    ['B', null], // refused or missing
  ])
  const hosts = hostsFromRoster<Host>([row('A', { name: 'roster name' }), row('B', { name: 'Bina', callRateBeans: 500 })], users)
  eq('the user document fills the row', [hosts[0].name, hosts[0].beans, hosts[0].isVerifiedHost], ['Asha', 1200, true])
  eq('an unreadable user still shows, from the roster row', [hosts[1].uid, hosts[1].name, hosts[1].callRateBeans], ['B', 'Bina', 500])
  eq('the uid is the roster\'s, whatever the user document says',
    hostsFromRoster<Host>([row('Z')], new Map([['Z', { uid: 'someone-else', name: 'Z' }]]))[0].uid, 'Z')
}

// ── distinct hosts stay distinct; nothing is invented ────────────────────────
eq('two hosts, two rows', hostsFromRoster<Host>([row('A'), row('B')], new Map()).map((h) => h.uid), ['A', 'B'])
eq('an empty roster is an empty list', hostsFromRoster<Host>([], new Map()), [])

// ── the page reads the roster, not a `users` list ────────────────────────────
{
  const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'agency-dashboard', 'page.tsx'), 'utf8')
  const load = page.slice(page.indexOf('async function loadData()'))
  const batch = load.slice(0, load.indexOf('// Each of the four is recorded'))
  ok("the dashboard no longer LISTS users (agency logins are refused that)",
    !batch.includes("getDocs(query(collection(db, 'users'), where('agencyId', '==', agencyId)))"))
  ok("…it reads its own roster subcollection",
    batch.includes("getDocs(collection(db, 'agencies', agencyId, 'agencyHosts'))"))
  ok('…and completes each current row with a single user GET',
    load.includes("getDoc(doc(db, 'users', uid))") && load.includes('hostsFromRoster<Host>('))
}

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} agency dashboard host checks FAILED\n`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log(`All ${checks} agency dashboard host checks passed.`)
console.log('  · the list comes from the roster the agency may read, not a refused users list')
console.log('  · revoked and purged rows are history, not hosts')
console.log('  · each row is completed from its user document; an unreadable one still shows')

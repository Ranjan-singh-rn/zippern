/**
 * QA #54 — the CRM's moderation and partner screens show times in IST, with
 * the zone named, whatever zone the browser is in. Stored values stay UTC.
 *
 * REAL: `lib/istTime.ts`, imported and called under a non-Indian process zone;
 * the screens are read for the wiring.
 *
 *   npm run test:istdisplay
 */

import * as fs from 'fs'
import * as path from 'path'
import { formatIst, formatIstDate } from './istTime'

// The npm script runs this with TZ=America/Los_Angeles — a browser (or a
// server) outside India. Say so, so a run without it is not mistaken for one.
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone

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

ok(`the process zone is not India (${zone})`, zone !== 'Asia/Kolkata' && zone !== 'Asia/Calcutta')

// 22:21 UTC on 3 Nov is 3:51 am on 4 Nov in India (the QA example).
eq('an instant is read in IST and says so', formatIst(Date.UTC(2026, 10, 3, 22, 21)), 'Wed, 4 Nov 2026, 3:51 am IST')
eq('…a date alone, in IST', formatIstDate(Date.UTC(2026, 10, 3, 22, 21)), '4 Nov 2026')
eq('…an ISO string from the API', formatIst('2026-11-04T10:15:00Z'), 'Wed, 4 Nov 2026, 3:45 pm IST')
eq('…nothing is nothing', [formatIst(null), formatIst(''), formatIstDate(undefined), formatIst('not a date')], ['', '', '', ''])

const root = path.join(__dirname, '..')
const SCREENS: [string, string][] = [
  ['app/users/[uid]/UserActions.tsx', 'formatIst('],
  ['app/users/[uid]/Client.tsx', 'formatIst('],
  ['app/users/page.tsx', 'formatIstDate('],
  ['app/operations/page.tsx', 'formatIstDate('],
  ['app/operations/appeals/page.tsx', 'formatIst('],
  ['app/operations/bans/page.tsx', 'formatIst('],
  ['app/operations/reports/page.tsx', 'formatIst('],
  ['app/operations/feedback/page.tsx', 'formatIstDate('],
]
for (const [file, call] of SCREENS) {
  const src = fs.readFileSync(path.join(root, file), 'utf8')
  ok(`${file}: times go through ${call.slice(0, -1)}`, src.includes(call))
  ok(`${file}: no date printed in the browser's own zone`,
    !/new Date\([^)]*\)\.toLocale(Date|Time)?String\('en-IN'/.test(src) && !/\bd\.toLocaleString\('en-IN'\)/.test(src))
}

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} IST display checks FAILED\n`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log(`All ${checks} IST display checks passed.`)
console.log('  · QA #54: user, appeal, ban, report and feedback screens show IST whatever the browser zone')

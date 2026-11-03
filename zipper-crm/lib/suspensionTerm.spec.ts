/**
 * QA #52 — the suspension length: empty to start, digits only, 1–365, and the
 * end shown in IST before confirming. QA #54 — times shown in IST.
 *
 * REAL: `lib/suspensionTerm.ts` and `lib/istTime.ts`, imported and called; the
 * component, the reports queue and the server's bounds are checked on source.
 *
 *   npm run test:suspension
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  DEFAULT_SUSPENSION, normaliseDaysInput, suspensionDays, suspensionPreview, suspensionProblem, suspensionResult,
} from './suspensionTerm'
import { formatIst, formatIstDate } from './istTime'

let checks = 0
const failures: string[] = []
function eq(claim: string, got: unknown, want: unknown): void {
  checks += 1
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g !== w) failures.push(`${claim}\n        got ${g}  want ${w}`)
}
function ok(claim: string, cond: boolean, detail = ''): void {
  checks += 1
  if (!cond) failures.push(detail ? `${claim}\n        ${detail}` : claim)
}

// ── the original failure ──────────────────────────────────────────────────────
eq('the days box starts EMPTY (it used to hold 7, and typing 2 made 72)', DEFAULT_SUSPENSION, { timed: true, days: '' })
eq('typing 2 into the default box is 2 days', suspensionDays({ ...DEFAULT_SUSPENSION, days: normaliseDaysInput(DEFAULT_SUSPENSION.days + '2') }), 2)
ok('an untouched timed term cannot be confirmed — the operator must choose', suspensionProblem(DEFAULT_SUSPENSION) !== null)

// ── numeric input and limits ──────────────────────────────────────────────────
eq('only digits survive, at most three', ['1e2', '-3', '2.5', ' 14 ', '12345', 'abc'].map(normaliseDaysInput), ['12', '3', '25', '14', '123', ''])
eq('1 and 365 are allowed', [suspensionProblem({ timed: true, days: '1' }), suspensionProblem({ timed: true, days: '365' })], [null, null])
ok('0 and 366 are refused with the bounds', [suspensionProblem({ timed: true, days: '0' }), suspensionProblem({ timed: true, days: '366' })]
  .every((p) => p !== null && p.includes('1 to 365')))
ok('a non-integer that slipped in is refused', suspensionProblem({ timed: true, days: '2.5' }) !== null)
eq('indefinite needs no number', suspensionProblem({ timed: false, days: '' }), null)
eq('indefinite sends no days', suspensionDays({ timed: false, days: '9' }), undefined)

// ── the end, before confirming, in IST ───────────────────────────────────────
const NOW = Date.UTC(2026, 10, 3, 10, 21) // 3 Nov 2026 10:21 UTC = 15:51 IST
const p2 = suspensionPreview({ timed: true, days: '2' }, NOW)
ok('2 days from 3 Nov 15:51 IST ends Thu 5 Nov 3:51 pm IST', p2 !== null && p2.includes('5 Nov 2026') && p2.includes('3:51') && p2.includes('IST'), String(p2))
ok('…and says how far off it is', p2 !== null && p2.includes('2 days from now'))
eq('no preview while the term is not valid', suspensionPreview({ timed: true, days: '' }, NOW), null)
ok('indefinite says it never ends by itself', String(suspensionPreview({ timed: false, days: '' }, NOW)).includes('until somebody presses Resume'))
ok('the result line uses IST too', suspensionResult(2, new Date(NOW + 2 * 86400e3).toISOString()).includes('IST'))

// ── QA #54: IST whatever the zone of the browser ─────────────────────────────
ok('a UTC instant prints as the IST clock time', formatIst(Date.UTC(2026, 10, 3, 22, 21)).includes('4 Nov 2026') && formatIst(Date.UTC(2026, 10, 3, 22, 21)).includes('3:51'),
  formatIst(Date.UTC(2026, 10, 3, 22, 21)))
eq('an empty or bad value prints nothing', [formatIst(''), formatIst('not a date'), formatIst(null)], ['', '', ''])
eq('the date alone', formatIstDate(Date.UTC(2026, 10, 3, 22, 21)), '4 Nov 2026')

// ── the wiring ────────────────────────────────────────────────────────────────
{
  const comp = fs.readFileSync(path.join(__dirname, '..', 'components', 'SuspendDuration.tsx'), 'utf8')
  ok('the control is a text box that keeps digits only', comp.includes('type="text"') && comp.includes('normaliseDaysInput(e.target.value)'))
  ok('…not a number input', !comp.includes('type="number"'))
  ok('…and shows the preview', comp.includes('suspensionPreview(value)'))
  ok('temporary and indefinite are named as such', comp.includes('Temporary — a set number of days') && comp.includes('Indefinite — until Resume'))

  const reports = fs.readFileSync(path.join(__dirname, '..', 'app', 'operations', 'reports', 'page.tsx'), 'utf8')
  ok('the reports queue shows the same preview', reports.includes('suspensionPreview({ timed: days.trim() !== \'\', days })'))

  const users = fs.readFileSync(path.join(__dirname, '..', 'app', 'users', '[uid]', 'UserActions.tsx'), 'utf8')
  ok('the account page and the Host-role suspension use the shared control', users.includes('<SuspendDuration value={term} onChange={setTerm} />')
    && users.includes('api.users.suspendHost(uid, why, suspensionDays(term))'))

  const backend = path.join(__dirname, '..', '..', 'backend', 'app', 'services', 'users.py')
  if (fs.existsSync(backend)) {
    const src = fs.readFileSync(backend, 'utf8')
    ok('server: account suspension refuses outside 1–365 and a non-integer', src.includes('raise UserError("A suspension runs from 1 to 365 days.")')
      && src.includes('isinstance(days, bool) or not isinstance(days, int) or not 1 <= days <= 365'))
    ok('server: Host-role suspension likewise', src.includes('not 1 <= days <= HOST_SUSPENSION_MAX_DAYS'))
  }
}

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} suspension checks FAILED\n`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log(`All ${checks} suspension checks passed.`)
console.log('  · QA #52: the box starts empty, keeps digits only, 1–365, and the end is shown in IST before confirming')
console.log('  · QA #54: an instant is printed in IST whatever the browser\'s zone')

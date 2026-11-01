/**
 * FX-13 (RF-19 / DUP-09) — an agency contests a report decision once while
 * that contest is pending; the button goes once it is sent.
 *
 * REAL: `lib/appealIds.ts`, over an in-memory store that refuses a second
 * write to an existing id (as the rules do — `appeals` allows no update); and,
 * at the source, the HostReports wiring.
 *
 *   npm run test:appealids
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  contestAppealId, overturnedContestReportIds, pendingContestReportIds, placeContest, type AppealPlacementSteps,
} from './appealIds'

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

function store() {
  const docs = new Map<string, Record<string, unknown>>()
  const steps: AppealPlacementSteps = {
    createIfAbsent: async (id) => {
      const existing = docs.get(id)
      if (existing) return { created: false, existing }
      docs.set(id, { status: 'pending' })
      return { created: true }
    },
  }
  return { docs, steps }
}

async function main(): Promise<void> {
  eq('the id names the agency and the report', contestAppealId('AG1', 'R9', 1), 'contest_AG1_R9')
  eq('…and later slots are suffixed', contestAppealId('AG1', 'R9', 2), 'contest_AG1_R9_2')

  // The defect: pressing Contest again filed another appeal.
  {
    const s = store()
    const first = await placeContest('AG1', 'R1', s.steps)
    const again = await placeContest('AG1', 'R1', s.steps)
    eq('the first contest is placed', first.ok, true)
    eq('a second while the first is pending is refused', [again.ok, !again.ok && again.reason], [false, 'pending'])
    eq('…one appeal', s.docs.size, 1)
  }
  // Concurrent: two tabs.
  {
    const s = store()
    const r = await Promise.all([placeContest('AG1', 'R2', s.steps), placeContest('AG1', 'R2', s.steps)])
    eq('two at once → one contest', [r.filter((x) => x.ok).length, s.docs.size], [1, 1])
  }
  // RC (confirmed): after a decision, only new evidence or a new reason.
  {
    const s = store()
    s.docs.set(contestAppealId('AG1', 'R3', 1), { status: 'rejected', statement: 'The report was about another host.' })
    const same = await placeContest('AG1', 'R3', s.steps, '  the REPORT was about another host. ')
    eq('RC: repeating the decided statement is not filed', [same.ok, !same.ok && same.reason], [false, 'needs_new'])
    eq('RC: …nothing was written', s.docs.size, 1)
    const r = await placeContest('AG1', 'R3', s.steps, 'Since the decision the caller admitted it was not our host.')
    eq('a decided contest is history; a NEW reason takes the next slot', [r.ok, r.ok && r.slot], [true, 2])
    const withEvidence = await placeContest('AG1', 'R6', store().steps, 'x', 1)
    eq('new evidence alone is enough (no earlier decision here anyway)', withEvidence.ok, true)
  }
  // No automatic-id fallback: the pinned ids are the only ids the rules accept.
  {
    const s = store()
    for (let n = 1; n <= 50; n += 1) s.docs.set(contestAppealId('AG1', 'R7', n), { status: 'rejected', statement: `s${n}` })
    const r = await placeContest('AG1', 'R7', s.steps, 'yet another statement')
    eq('every slot decided → exhausted, nothing written', [r.ok, !r.ok && r.reason, s.docs.size], [false, 'exhausted', 50])
  }
  eq('RC: an OVERTURNED contest hides Contest for that report',
    Array.from(overturnedContestReportIds([
      { kind: 'report', raisedByRole: 'agency', reportId: 'R1', status: 'overturned' },
      { kind: 'report', raisedByRole: 'agency', reportId: 'R2', status: 'upheld' },
    ])),
    ['R1'])
  // Distinct reports and agencies stay distinct.
  {
    const s = store()
    await placeContest('AG1', 'R4', s.steps)
    await placeContest('AG1', 'R5', s.steps)
    await placeContest('AG2', 'R4', s.steps)
    eq('different reports / agencies → separate contests', s.docs.size, 3)
  }
  // The button.
  eq('only this agency\'s PENDING report contests hide the button',
    Array.from(pendingContestReportIds([
      { kind: 'report', raisedByRole: 'agency', reportId: 'R1', status: 'pending' },
      { kind: 'report', raisedByRole: 'agency', reportId: 'R2', status: 'rejected' },
      { kind: 'ban', raisedByRole: 'self', reportId: '', status: 'pending' },
      { kind: 'report', raisedByRole: 'self', reportId: 'R3', status: 'pending' },
    ])),
    ['R1'])

  {
    const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'agency-dashboard', 'HostReports.tsx'), 'utf8')
    ok('HostReports places the contest at its deterministic id', page.includes('placeContest(agencyId, contesting.id, {'))
    ok('…hides Contest for a pending contest', page.includes("!contested.has(r.id) && ("))
    ok('…and marks it contested once sent', page.includes('setContested((prev) => new Set(prev).add(contesting.id))'))
    const fn = page.slice(page.indexOf('async function raiseAppeal()'))
    ok('…and never at an automatic id (RC: the rules accept only the pinned ids)', !fn.slice(0, 4000).includes('addDoc('))
    ok('…and hides Contest for a report already overturned on appeal', page.includes('overturned.has(r.id)'))
  }

  if (failures.length) {
    console.error(`\n${failures.length} of ${checks} contest checks FAILED\n`)
    for (const f of failures) console.error('  ✗ ' + f)
    process.exit(1)
  }
  console.log(`All ${checks} contest checks passed.`)
  console.log('  · one pending contest per (agency, report); a second press sends nothing')
  console.log('  · two at once → one; after a decision a new contest is allowed, as before')
  console.log('  · the button is hidden while one is pending')
}

void main()

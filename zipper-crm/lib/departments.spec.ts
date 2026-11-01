/**
 * §9 — departments and their Admin seat on /team, from `GET /staff/departments`,
 * and "Reports to" on every staff row from `reports_to_resolved`.
 *
 * Replaces a stub that assumed `GET /staff/vacancies`, which never shipped.
 *
 * REAL: `lib/departments.ts`, imported and run. The wiring in
 * `app/team/page.tsx` and the feature flag are checked on their source; the
 * route and the vacancy label are compared with the backend when it sits
 * beside this repo.
 *
 *   npm run test:departments
 */

import * as fs from 'fs'
import * as path from 'path'
import { BACKEND_FEATURES } from './backendFeatures'
import {
  VACANCY_NOTE, adminNames, departmentsFrom, reportsToOf, vacantDepartments,
} from './departments'

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

const RESPONSE = {
  departments: [
    { team: 'app', label: 'App', admins: [{ uid: 'a1', name: 'Asha Rao', email: 'asha@x.in' }], vacancy: false, vacancy_since: null, vacancy_cause: '' },
    { team: 'finance', label: 'Finance', admins: [], vacancy: true, vacancy_since: '2026-10-28T08:15:00+00:00', vacancy_cause: 'admin deactivated' },
    { team: 'ops', label: 'Operations', admins: [{ uid: 'o1', name: '', email: 'ops@x.in' }, { uid: 'o2', name: 'Vikram', email: '' }], vacancy: false },
    { team: '', label: 'nameless' },
    'garbage',
  ],
}

// ── 1. reading the response ──────────────────────────────────────────────────
{
  const rows = departmentsFrom(RESPONSE)
  eq('every department with a team, in order; junk dropped', rows.map((r) => r.team), ['app', 'finance', 'ops'])
  eq('a vacant department says since when and why', [rows[1].vacancy, rows[1].vacancySinceMs, rows[1].vacancyCause],
    [true, Date.parse('2026-10-28T08:15:00+00:00'), 'admin deactivated'])
  eq('an occupied one carries no vacancy facts', [rows[0].vacancy, rows[0].vacancySinceMs, rows[0].vacancyCause], [false, null, ''])
  eq('only the vacant ones', vacantDepartments(rows).map((r) => r.label), ['Finance'])
  eq('admins by name, then email', adminNames(rows[2]), 'ops@x.in and Vikram')
  eq('one admin', adminNames(rows[0]), 'Asha Rao')
  eq('none', adminNames(rows[1]), '')
  eq('a bare array works', departmentsFrom(RESPONSE.departments).length, 3)
  eq('nothing usable is an empty list, never a throw', [departmentsFrom(null), departmentsFrom({}), departmentsFrom('x')], [[], [], []])
  eq('only an explicit true is a vacancy', departmentsFrom([{ team: 'tech', vacancy: 'yes' }])[0].vacancy, false)
  ok('the note says members report to the Owner', /report to the Owner/.test(VACANCY_NOTE))
}

// ── 2. "Reports to" ──────────────────────────────────────────────────────────
eq('a member of a vacant department: the server\'s label, verbatim',
  reportsToOf({ reports_to_resolved: { uid: '', name: 'Owner', role: 'owner', label: 'Owner (vacancy)', vacancy: true } }),
  { label: 'Owner (vacancy)', vacancy: true, known: true })
eq('a member with an Admin: the Admin\'s name',
  reportsToOf({ reports_to_resolved: { uid: 'a1', name: 'Asha Rao', role: 'app_admin', label: 'Asha Rao', vacancy: false } }),
  { label: 'Asha Rao', vacancy: false, known: true })
eq('an older server sends nothing: said so, never guessed',
  reportsToOf({}), { label: 'Not reported by this server', vacancy: false, known: false })
eq('a blank label is not a label', reportsToOf({ reports_to_resolved: { label: '  ', vacancy: true } }).known, false)
eq('null-safe', reportsToOf(null).known, false)

// ── 3. the flag ──────────────────────────────────────────────────────────────
eq('departmentVacancy is on — the route has shipped', BACKEND_FEATURES.departmentVacancy, true)

// ── 4. compared with the server ──────────────────────────────────────────────
{
  const backend = path.join(__dirname, '..', '..', 'backend', 'app')
  const router = path.join(backend, 'routers', 'staff.py')
  const svc = path.join(backend, 'services', 'staff.py')
  if (fs.existsSync(router) && fs.existsSync(svc)) {
    const r = fs.readFileSync(router, 'utf8')
    ok('server: GET /staff/departments exists', r.includes('@router.get("/departments")'))
    ok('server: answers {departments: [...]}', r.includes('return {"departments": await svc.departments(user)}'))
    ok('server: no /staff/vacancies route (the stub\'s assumption)', !r.includes('"/vacancies"'))
    const s = fs.readFileSync(svc, 'utf8')
    ok('server: the vacancy label is "Owner (vacancy)"', s.includes('REPORTS_TO_OWNER_VACANCY = "Owner (vacancy)"'))
    ok('server: every listed row carries reports_to_resolved', s.includes('doc["reports_to_resolved"] = ('))
  } else {
    console.log('  (backend not beside this repo — the server comparison was skipped)')
  }
}

// ── 5. the wiring ────────────────────────────────────────────────────────────
{
  const root = path.join(__dirname, '..')
  const team = fs.readFileSync(path.join(root, 'app', 'team', 'page.tsx'), 'utf8')
  ok('/team reads the departments', team.includes('api.staff.departments()'))
  ok('…through the shared reader', team.includes('departmentsFrom('))
  ok('…shows "Reports to" from the server', team.includes('reportsToOf(') && team.includes('Reports to:'))
  ok('…and the stub is gone', !team.includes('NEXT_RELEASE_NOTE') && !team.includes('/staff/vacancies'))
  const api = fs.readFileSync(path.join(root, 'lib', 'api.ts'), 'utf8')
  ok('lib/api.ts: GET /staff/departments', api.includes("get<{ departments: Department[] }>('/staff/departments')"))
}

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} department checks FAILED:\n`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`All ${checks} department checks passed.`)
console.log('  · /team reads GET /staff/departments; a vacant seat says since when and why')
console.log('  · "Reports to" is the server\'s label — "Owner (vacancy)" for a member of a vacant department')

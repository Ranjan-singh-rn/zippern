/**
 * QA #43 — the Change role picker opens on the person's current role, so an
 * Owner who does not touch it cannot promote anybody by accident.
 *
 * REAL: `lib/rolePicker.ts`, imported and called; the /team page is read for
 * the wiring.
 *
 *   npm run test:rolepicker
 */

import * as fs from 'fs'
import * as path from 'path'
import { roleChangeReady, roleChangeSummary, rolePickerInitial, rolePickerOptions } from './rolePicker'

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

// What an Owner may assign, in the order the API lists it (App Admin first —
// the role the old picker silently pre-selected).
const ASSIGNABLE = ['app_admin', 'app_member', 'ops_admin', 'support_admin', 'support_member', 'finance_member']
const LABEL: Record<string, string> = {
  app_admin: 'App Admin', app_member: 'App Team', ops_admin: 'Ops Admin',
  support_admin: 'Support Admin', support_member: 'Support Team', finance_member: 'Finance Team',
}
const label = (r: string) => LABEL[r] ?? r

// ── The QA case ───────────────────────────────────────────────────────────────
eq('the picker opens on the current role, not on App Admin', rolePickerInitial('support_member'), 'support_member')
eq('the current role is listed first, marked, and only once',
  rolePickerOptions('support_member', ASSIGNABLE).map((o) => `${o.value}${o.current ? '*' : ''}`),
  ['support_member*', 'app_admin', 'app_member', 'ops_admin', 'support_admin', 'finance_member'])
eq('a role the actor cannot assign is still shown as the current one',
  rolePickerOptions('tech_member', ['support_member']).map((o) => o.value), ['tech_member', 'support_member'])

eq('pressing Change role without choosing does nothing (button disabled)',
  roleChangeReady('support_member', rolePickerInitial('support_member'), 'Moving to finance after the reshuffle.', 3), false)
eq('a different role and a reason enable it', roleChangeReady('support_member', 'finance_member', 'Moving to finance.', 3), true)
eq('…but not without a reason', roleChangeReady('support_member', 'finance_member', '  ', 3), false)
eq('…nor with an empty choice', roleChangeReady('support_member', '', 'Moving to finance.', 3), false)

eq('the change is spelled out before it is confirmed',
  roleChangeSummary('support_member', 'finance_member', label), 'Support Team → Finance Team')
ok('…and says there is no change yet when nothing was chosen',
  roleChangeSummary('support_member', 'support_member', label).startsWith('No change yet — Support Team is their role now.'))

// ── The page uses it ─────────────────────────────────────────────────────────
{
  const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'team', 'page.tsx'), 'utf8')
  const panel = page.slice(page.indexOf('function RolePanel('), page.indexOf('// ── Revoke'))
  ok('the panel builds its options from rolePickerOptions', panel.includes('const options = rolePickerOptions(member.role, roles)'))
  ok('…opens on the current role', panel.includes('useState<ApiRole>(rolePickerInitial(member.role) as ApiRole)'))
  ok('…is ready only for a real change', panel.includes('const ready = roleChangeReady(member.role, role, reason, MIN_REASON)'))
  ok('…shows the change', panel.includes('{roleChangeSummary(member.role, role, label)}'))
  ok('the old default (the first assignable role) is gone', !panel.includes('choices[0]'))
}

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} role picker checks FAILED\n`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log(`All ${checks} role picker checks passed.`)
console.log('  · QA #43: Change role opens on the current role and is disabled until a different one is chosen')

/**
 * QA #39 — the staff invitation: plain words for a refused address, the CRM's
 * role names in the email, no internal section reference.
 *
 * REAL: `lib/staffInvite.ts`, imported and called. The backend's role labels
 * and the invitation template are read when the backend sits beside this repo.
 *
 *   npm run test:staffinvite
 */

import * as fs from 'fs'
import * as path from 'path'
import { inviteEmailProblem, inviteErrorText } from './staffInvite'

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

// ── The address ───────────────────────────────────────────────────────────────
eq('a plain address is fine', inviteEmailProblem('priya@zipperlive.org'), null)
eq('an empty one is asked for', inviteEmailProblem('  '), 'Enter the person\'s email address.')
eq('two addresses run together are caught', inviteEmailProblem('a@x.coma@x.com'), 'Enter one email address.')
eq('no domain is caught', inviteEmailProblem('priya@gmail'), 'That is not a valid email address.')

// ── The API's validator text, worded ─────────────────────────────────────────
const RAW = 'email value is not a valid email address: The domain name qa.test is a special-use or reserved name that cannot be used with email.'
eq('the QA case: a reserved test domain', inviteErrorText(RAW),
  'That address is on a reserved test domain and cannot receive email. Use the person\'s own working address.')
ok('…and no validator jargon reaches the screen', !/value is not a valid|special-use/.test(inviteErrorText(RAW)))
eq('a domain that takes no mail',
  inviteErrorText('email value is not a valid email address: The domain name nomail.example does not accept email.'),
  'That address\'s domain does not accept email. Check the spelling, or use another address.')
eq('any other refusal is shown as the server said it', inviteErrorText('This address already has staff access.'),
  'This address already has staff access.')

// ── Both invite forms use it ──────────────────────────────────────────────────
const root = path.join(__dirname, '..')
for (const page of ['team', 'team-access']) {
  const src = fs.readFileSync(path.join(root, 'app', page, 'page.tsx'), 'utf8')
  ok(`/${page}: checks the address before sending`, src.includes('const problem = inviteEmailProblem(email)'))
  ok(`/${page}: words the API's refusal`, src.includes('inviteErrorText('))
}

// ── The email's role names are the CRM's ─────────────────────────────────────
const team = fs.readFileSync(path.join(root, 'app', 'team', 'page.tsx'), 'utf8')
const crmLabels: Record<string, string> = {}
{
  const block = team.slice(team.indexOf('const ROLE_LABEL'), team.indexOf('}', team.indexOf('const ROLE_LABEL')))
  const re = /(\w+):\s*'([^']+)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(block)) !== null) crmLabels[m[1]] = m[2]
}
ok('the CRM role labels were read', Object.keys(crmLabels).length >= 14)
eq('the CRM calls support_member "Support Team"', crmLabels.support_member, 'Support Team')

const backend = path.join(root, '..', 'backend')
const labelsPy = path.join(backend, 'app', 'core', 'role_labels.py')
if (fs.existsSync(labelsPy)) {
  const py = fs.readFileSync(labelsPy, 'utf8')
  for (const [role, label] of Object.entries(crmLabels)) {
    if (role === 'agency' || role === 'seller') continue
    ok(`backend says "${label}" for ${role}, as the CRM does`, py.includes(`"${role}": "${label}"`))
  }
  const staff = fs.readFileSync(path.join(backend, 'app', 'services', 'staff.py'), 'utf8')
  ok('the invitation uses the shared labels', staff.includes('role_label = staff_role_label(inv.role)'))
  ok('…and so does the role-change notice', staff.includes('role_label = staff_role_label(new_role or str(person.get("role", "")))'))
  ok('no role label is made from the role id any more', !/\.replace\("_", " "\)\.title\(\)\s*\n\s*(invited_by|body = body\.format)/.test(staff))
  const tpl = fs.readFileSync(path.join(backend, 'app', 'templates', 'staff_invitation.html'), 'utf8')
  ok('the invitation no longer shows "(2.1.3)"', !tpl.includes('(2.1.3)'))
}

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} staff invitation checks FAILED\n`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log(`All ${checks} staff invitation checks passed.`)
console.log('  · QA #39: refusals in plain words, the CRM\'s role names in the email, no "(2.1.3)"')

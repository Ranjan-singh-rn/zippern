/**
 * QA #28 / #35 / #40 / #42 — small CRM wording fixes, checked on the source so
 * they cannot quietly come back.
 *
 *   #28  the agency dashboard's Active Hosts hint pointed to "the Hosts table
 *        above"; the table is below it.
 *   #35  a seller's ID was "Registration proof" in the review queue (and on the
 *        server's document list); the app and /seller-signup ask for a
 *        "Government photo ID".
 *   #40  /team told every non-Owner "You can invite members of your own team",
 *        with or without an Invite button.
 *   #42  /team showed Owners an internal design note ("One of them should go").
 *
 *   npm run test:crmcopy
 */

import * as fs from 'fs'
import * as path from 'path'

let checks = 0
const failures: string[] = []
function ok(claim: string, cond: boolean): void {
  checks += 1
  if (!cond) failures.push(claim)
}

const root = path.join(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')

const money = read('app/agency-dashboard/AgencyMoney.tsx')
ok('#28: the hint points below, where the Hosts table is', money.includes('are in the Hosts table below.'))
ok('#28: …and never above', !money.includes('Hosts table above'))

const queues = read('lib/reviewQueues.ts')
ok('#35: the review queue calls a seller\'s ID a "Government photo ID"', queues.includes("label: 'Government photo ID', url: proof"))
ok('#35: …not "Registration proof"', !queues.includes("label: 'Registration proof'"))
const docsPy = path.join(root, '..', 'backend', 'app', 'services', 'documents.py')
if (fs.existsSync(docsPy)) {
  ok('#35: the server\'s document list says the same', fs.readFileSync(docsPy, 'utf8').includes('"registrationProofUrl": "Government photo ID"'))
}

const team = read('app/team/page.tsx')
ok('#40: /team words its headline by what the viewer can do', team.includes('teamAccessHeadline(me?.role ?? \'\', assignable.length)'))
ok('#40: …and no longer promises every non-Owner an Invite', !team.includes(": 'You can invite members of your own team.'}"))
ok('#42: the internal design note is gone from the screen', !team.includes('One of them should go') && !team.includes('now do the same job'))

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} CRM wording checks FAILED\n`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log(`All ${checks} CRM wording checks passed.`)
console.log('  · QA #28 / #35 / #40 / #42: hosts table below, Government photo ID, truthful headline, no design notes')

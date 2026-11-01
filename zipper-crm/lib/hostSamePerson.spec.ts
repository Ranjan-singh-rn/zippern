/**
 * FX-12 (RF-05 / DUP-06) — /kyc says when two host applications are the same
 * person.
 *
 * REAL: `lib/hostSamePerson.ts`, imported and called; and, at the source,
 * that the review queue and the /kyc page use it.
 *
 *   npm run test:sameperson
 */

import * as fs from 'fs'
import * as path from 'path'
import { samePersonMatches, samePersonNote, type PersonApplication } from './hostSamePerson'

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

function app(id: string, over: Partial<PersonApplication> = {}): PersonApplication {
  const base: PersonApplication = {
    id, uid: '', phone: '', email: '', status: 'pending', isActivated: false, name: id,
  }
  return { ...base, ...over }
}

// The DUP-06 pair: a redeemed invitation and a pending self-application of one account.
{
  const m = samePersonMatches([
    app('INV', { uid: 'P', status: 'approved', isActivated: true, phone: '+919800000001' }),
    app('SELF', { uid: 'P' }),
  ])
  eq('the pending self-application is matched to the redeemed invitation', m.get('SELF')?.map((a) => a.id), ['INV'])
  ok('…and the badge says it is a duplicate of a Host', samePersonNote(m.get('SELF')).includes('already made this person a Host'))
  eq('only a PENDING application is badged', m.has('INV'), false)
}

// An unredeemed invitation (no account yet) and a self-application with the same phone.
{
  const m = samePersonMatches([
    app('INV2', { phone: '+91 98000 00002' }),
    app('SELF2', { uid: 'Q', phone: '+919800000002' }),
  ])
  eq('same phone, one side with no account yet → the same person', m.get('INV2')?.map((a) => a.id), ['SELF2'])
  ok('…two pending ones are told to be decided together', samePersonNote(m.get('INV2')).includes('Decide them together'))
}

// Same email, different case.
eq('same email (case aside) → the same person',
  samePersonMatches([app('A', { email: 'Host@X.io' }), app('B', { email: 'host@x.io' })]).get('A')?.length, 1)

// Distinct people stay distinct; refused applications are not matched against.
{
  const m = samePersonMatches([
    app('X', { uid: 'U1', phone: '+919800000010', email: 'x@x.io' }),
    app('Y', { uid: 'U2', phone: '+919800000011', email: 'y@x.io' }),
    app('Z', { uid: 'U1', status: 'rejected' }),
  ])
  eq('different accounts, phones and emails → no badge', [m.has('X'), m.has('Y')], [false, false])
  eq('a refused application is history, not a match', samePersonNote(m.get('X')), '')
}

// The wiring.
{
  const root = path.join(__dirname, '..')
  const queues = fs.readFileSync(path.join(root, 'lib', 'reviewQueues.ts'), 'utf8')
  const kyc = fs.readFileSync(path.join(root, 'app', 'kyc', 'page.tsx'), 'utf8')
  ok('the review queue computes the matches over every host application', queues.includes('samePersonMatches('))
  ok('…and puts the note on the host item', queues.includes('samePerson: samePersonNote(matches.get(d.id)),'))
  ok('/kyc shows the badge', kyc.includes('{item.samePerson && ('))
}

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} same-person checks FAILED\n`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log(`All ${checks} same-person checks passed.`)
console.log('  · a self-application and an invitation of one human are badged on /kyc')
console.log('  · by account, phone or email; distinct people and refused history are not')

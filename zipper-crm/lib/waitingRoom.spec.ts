/**
 * QA #25 — an APPROVED partner waiting to verify a contact is no longer told
 * the application "is being reviewed… 1-2 business days".
 *
 * REAL: `lib/waitingRoom.ts`, imported and called; the shared component and
 * both pages are read for the wiring.
 *
 *   npm run test:waitingroom
 */

import * as fs from 'fs'
import * as path from 'path'
import { waitingRoomCopy, waitingRoomExit } from './waitingRoom'

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

const all = (c: ReturnType<typeof waitingRoomCopy>) => [c.title, c.subtitle, c.intro, ...c.steps.map((s) => s.text)].join(' | ')

for (const kind of ['agency', 'seller'] as const) {
  const waiting = waitingRoomCopy(kind, true, 'p@x.test')
  const text = all(waiting)
  eq(`${kind}, approved: the headline`, waiting.title, 'Approved — Verify to Start')
  ok(`${kind}, approved: says it was approved`, waiting.subtitle.endsWith('has been approved'))
  ok(`${kind}, approved: never "being reviewed" or "business days"`, !/being reviewed|business days/.test(text))
  ok(`${kind}, approved: never the pre-approval steps ("once approved", "After approval")`, !/once approved|After approval/.test(text))
  ok(`${kind}, approved: says what starts the role — both contacts verified`, waiting.intro.includes('both your phone number and your email address are verified'))
  eq(`${kind}, approved: the steps are the two verifications, then the dashboard`, waiting.steps.map((s) => s.icon), ['mail', 'phone', 'dashboard'])

  const review = waitingRoomCopy(kind, false, 'p@x.test')
  eq(`${kind}, under review: the headline is unchanged`, review.title, 'Application Under Review')
  ok(`${kind}, under review: the review time is unchanged`, review.intro.includes('1-2 business days'))
  ok(`${kind}, under review: the email it will be told at`, review.steps[1].text.includes('p@x.test'))
}
eq('a login with no email on file: a phrase, not "undefined"', waitingRoomCopy('seller', false, undefined).steps[1].text,
  'You will receive an email at your email once approved')

// E2E re-run (3 Nov 2026): after both contacts were verified the handover reloaded the waiting room, and the
// started agency read "Application Under Review … 1-2 business days". A started role leaves for its dashboard.
eq('a started role leaves the waiting room for its dashboard',
  [waitingRoomExit('agency', 'approved'), waitingRoomExit('seller', 'approved')], ['/agency-dashboard', '/seller-dashboard'])
eq('…every other state stays',
  ['pending', 'awaiting_verification', 'rejected', '', null, undefined].map((s) => waitingRoomExit('agency', s)),
  [null, null, null, null, null, null])

// ── Wiring ────────────────────────────────────────────────────────────────────
const root = path.join(__dirname, '..')
const room = fs.readFileSync(path.join(root, 'components', 'PartnerWaitingRoom.tsx'), 'utf8')
ok('the room reads its words from waitingRoomCopy', room.includes('const copy = waitingRoomCopy(kind, waiting, crmUser?.email)'))
ok('…shows the verification steps only when waiting', room.includes('{waiting && <ContactVerificationPanel />}'))
ok('…and the support address from lib/contacts', room.includes('mailtoHref(SUPPORT_EMAIL)'))
ok('…with no hard-coded review sentence left in it', !room.includes('is being reviewed by our team'))
ok('…and passes a started role on to its dashboard before any waiting-room words',
  room.includes('const exit = waitingRoomExit(kind, status)') && room.includes('if (exit) router.replace(exit)')
  && room.indexOf('if (exit) {') < room.indexOf('const icon = (name: WaitingRoomIcon)'))
for (const [page, kind] of [['agency-pending', 'agency'], ['seller-pending', 'seller']] as const) {
  const src = fs.readFileSync(path.join(root, 'app', page, 'page.tsx'), 'utf8')
  ok(`/${page} renders the shared room as "${kind}"`, src.includes(`kind="${kind}"`) && src.includes('<PartnerWaitingRoom'))
  ok(`/${page} has no address of its own`, !/mailto:|@gmail\.com|zipperlive\./.test(src))
}

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} waiting room checks FAILED\n`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log(`All ${checks} waiting room checks passed.`)
console.log('  · QA #25: approved-and-verifying says so; under review is unchanged')

/**
 * One row per PERSON on the host screens (GOV B08 / contract C5).
 *
 * ── THE BUG THIS ENCODES ────────────────────────────────────────────────────
 *
 * An approved SELF-application carries `applicantUid` and never
 * `activatedByUid`, and approving it did not stamp `isActivated`. /hosts
 * concatenated `users isHost==true` with `hostApplications isActivated==false`
 * and joined nothing, so the same human was listed as "Active" AND as
 * "Awaiting Activation", and every tab count added both. The roster and the
 * agency dashboard joined on `activatedByUid` only — the same miss.
 *
 * REAL: `lib/hostRows.ts`, imported and called.
 *
 *   npm run test:hostrows
 */

import {
  applicationPersonUid,
  contactMatch,
  hostTabCounts,
  linkedApplicationLabel,
  linkedPersonUid,
  personStatusOf,
  primaryApplication,
  reconcileHostRows,
  resolveAgencyName,
  sameEmail,
  samePhone,
  type PersonStatus,
} from './hostRows'

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

interface H { uid: string; isHost?: boolean; phoneNumber?: string; email?: string; name?: string; isBanned?: boolean }
interface A {
  id: string; status?: string; isActivated?: boolean
  activatedByUid?: string; applicantUid?: string
  applicantPhone?: string; applicantEmail?: string
}

const host = (uid: string, over: Partial<H> = {}): H => ({
  uid, isHost: true, phoneNumber: '', email: '', name: uid, ...over,
})
const app = (id: string, over: Partial<A> = {}): A => ({ id, status: 'pending', isActivated: false, ...over })

// ── 1. Whose application is this ────────────────────────────────────────────
console.log('1. Whose application is it')
eq('the redeemer is the person', applicationPersonUid({ activatedByUid: 'u1', applicantUid: 'u2' }), 'u1')
eq('…else the self-applicant', applicationPersonUid({ applicantUid: ' u2 ' }), 'u2')
eq('an unredeemed invitation has nobody yet', applicationPersonUid({}), '')
eq('a non-string field is nobody, not "[object Object]"', applicationPersonUid({ applicantUid: { x: 1 } }), '')
eq('only an explicit false is a former Host', [personStatusOf(false), personStatusOf(true), personStatusOf(undefined)],
  ['former', 'current', 'current'])

const statusOf = (m: Record<string, PersonStatus>) => (uid: string) => m[uid]
eq('a CURRENT Host\'s self-application is that Host\'s', linkedPersonUid({ applicantUid: 'h1' }, statusOf({ h1: 'current' })), 'h1')
eq('a CURRENT Host\'s redeemed invitation is that Host\'s', linkedPersonUid({ activatedByUid: 'h1' }, statusOf({ h1: 'current' })), 'h1')
eq('a FORMER Host who REDEEMED it keeps it as history', linkedPersonUid({ activatedByUid: 'f1' }, statusOf({ f1: 'former' })), 'f1')
eq('…but a former Host\'s own NEW application is a row of its own',
  linkedPersonUid({ applicantUid: 'f1' }, statusOf({ f1: 'former' })), '')
eq('an applicant with no row on the screen is a row of their own', linkedPersonUid({ applicantUid: 'x' }, statusOf({})), '')

// ── 2. The reported bug: one human, two rows ────────────────────────────────
console.log('2. An approved self-application is the Host it made, not a second person')
{
  const hosts = [host('h1', { phoneNumber: '+919800000001' })]
  const apps = [app('A_SELF', { status: 'approved', applicantUid: 'h1' })]
  const r = reconcileHostRows(hosts, apps)
  eq('no "Awaiting Activation" row for the Host', r.applicationRows.length, 0)
  eq('…the application is on the Host\'s own row', r.hostRows[0].applications.map((a) => a.id), ['A_SELF'])
  eq('…and the person is counted once', r.people, 1)
  eq('…labelled as the application it came from', linkedApplicationLabel(apps[0]), 'via application A_SELF')
  const tabs = hostTabCounts(r, (h) => !!h.isBanned)
  eq('tabs count people: All 1, Active 1, Banned 0, Invited 0', [tabs.all, tabs.active, tabs.banned, tabs.invited], [1, 1, 0, 0])
}
{
  // A second, still-pending application by somebody who is already a Host.
  const r = reconcileHostRows([host('h1')], [app('A_AGAIN', { status: 'pending', applicantUid: 'h1' })])
  eq('a current Host\'s pending application is on their row too', r.hostRows[0].applications.length, 1)
  eq('…read as a pending application, not as the one that made them a Host',
    linkedApplicationLabel(r.hostRows[0].applications[0]), 'pending application A_AGAIN')
  eq('…and adds no person', r.people, 1)
}

// ── 3. Separate people stay separate ────────────────────────────────────────
console.log('3. Somebody who is not a Host yet is their own row')
{
  const hosts = [host('h1', { phoneNumber: '+919800000001', email: 'h1@example.test' })]
  const apps = [
    app('A_INVITE', { status: 'approved', applicantPhone: '+919800000002', applicantEmail: 'new@example.test' }),
    app('A_PENDING_SELF', { status: 'pending', applicantUid: 'u9' }),
  ]
  const r = reconcileHostRows(hosts, apps)
  eq('both applications are rows of their own', r.applicationRows.map((x) => x.app.id), ['A_INVITE', 'A_PENDING_SELF'])
  eq('…neither is flagged', r.applicationRows.map((x) => x.sameContactAs), [null, null])
  eq('…and they are two more people', r.people, 3)
  const tabs = hostTabCounts(r, () => false)
  eq('All = Active + Banned + Invited', tabs.all, tabs.active + tabs.banned + tabs.invited)
  eq('…Invited counts the two applicants', tabs.invited, 2)
}

// ── 4. The invitation that is an existing Host's ────────────────────────────
console.log('4. An invitation carrying an existing Host\'s contact is flagged, never hidden')
{
  const h1 = host('h1', { phoneNumber: '+919800000001', email: 'Host.One@Example.test' })
  const hosts = [h1, host('h2', { phoneNumber: '+919800000003' })]
  const apps = [
    app('A_SAME_PHONE', { status: 'approved', applicantPhone: '+91 98000-00001' }),
    app('A_SAME_EMAIL', { status: 'approved', applicantEmail: ' host.one@example.TEST ' }),
    app('A_BARE_LEGACY', { status: 'approved', applicantPhone: '9800000003' }),
  ]
  const r = reconcileHostRows(hosts, apps)
  eq('every one of them is still a row', r.applicationRows.map((x) => x.app.id), ['A_SAME_PHONE', 'A_SAME_EMAIL', 'A_BARE_LEGACY'])
  eq('…each flagged with the Host it belongs to', r.applicationRows.map((x) => x.sameContactAs?.uid), ['h1', 'h1', 'h2'])
  eq('…none is counted as somebody new', r.people, 2)
  eq('…and the count of flagged rows is reported', r.flaggedApplications, 3)
  const tabs = hostTabCounts(r, () => false)
  eq('Invited excludes them; All is still the sum', [tabs.all, tabs.invited, tabs.flagged], [2, 0, 3])
}
{
  // A self-application is identified by its uid, not its contact.
  const r = reconcileHostRows(
    [host('h1', { phoneNumber: '+919800000001' })],
    [app('A_OTHER_UID', { applicantUid: 'u7', applicantPhone: '+919800000001' })],
  )
  eq('an application with its own uid is never matched on contact', r.applicationRows[0].sameContactAs, null)
  eq('…and is a person of its own', r.people, 2)
}
{
  // A former Host is not "an existing Host" for the flag.
  const r = reconcileHostRows(
    [host('f1', { isHost: false, phoneNumber: '+919800000004' })],
    [app('A_TO_FORMER', { status: 'approved', applicantPhone: '+919800000004' })],
  )
  eq('an invitation matching a FORMER Host is not flagged', r.applicationRows[0].sameContactAs, null)
  eq('…a former Host is not counted as a person here', r.currentHosts, 0)
}

// ── 5. Phone and email equality ─────────────────────────────────────────────
console.log('5. Contact equality')
ok('formatting does not matter', samePhone('+91 98765-43210', '+919876543210'))
ok('a bare legacy number is the same number with its country code', samePhone('9876543210', '+919876543210'))
ok('…either way round', samePhone('+919876543210', '9876543210'))
ok('two different FULL international numbers never match', !samePhone('+919876543210', '+449876543210'))
ok('…nor a full number that merely ends the same way', !samePhone('+19876543210', '+919876543210'))
ok('short or empty numbers never match', !samePhone('12345', '12345') && !samePhone('', '') && !samePhone(undefined, '+91'))
ok('email is case- and space-insensitive', sameEmail(' A@B.test ', 'a@b.TEST'))
ok('…and an empty or address-less value never matches', !sameEmail('', '') && !sameEmail('abc', 'abc'))
eq('contactMatch finds the first Host with that contact',
  contactMatch({ applicantPhone: '+919800000009' }, [host('a'), host('b', { phoneNumber: '+919800000009' })])?.uid, 'b')
eq('…and nobody when there is no match', contactMatch({ applicantEmail: 'x@y.test' }, [host('a')]), null)

// ── 6. Former Hosts and redeemed invitations (the roster's join, preserved) ──
console.log('6. A redeemed invitation is the redeemer\'s history')
{
  const r = reconcileHostRows(
    [host('f1', { isHost: false })],
    [app('A_REDEEMED', { status: 'approved', isActivated: true, activatedByUid: 'f1' }),
     app('A_REAPPLY', { status: 'pending', applicantUid: 'f1' })],
  )
  eq('the redeemed invitation joins the former Host\'s row', r.hostRows[0].applications.map((a) => a.id), ['A_REDEEMED'])
  eq('…the re-application is its own row', r.applicationRows.map((x) => x.app.id), ['A_REAPPLY'])
  eq('…counted once, as the applicant (a former Host is not counted)', r.people, 1)
}

// ── 7. Nothing is ever dropped ──────────────────────────────────────────────
console.log('7. Every application comes out somewhere')
{
  const hosts = [host('h1', { phoneNumber: '+919800000001' }), host('h1'), host('')]
  const apps = [
    app('X1', { applicantUid: 'h1' }), app('X2', { activatedByUid: 'h1' }), app('X3'),
    app('X4', { applicantPhone: '+919800000001' }), app('X5', { applicantUid: 'nobody' }),
  ]
  const r = reconcileHostRows(hosts, apps)
  const out = r.hostRows.reduce((n, row) => n + row.applications.length, 0) + r.applicationRows.length
  eq('applications in = applications out', out, apps.length)
  eq('a repeated uid is one person row; a blank uid is none', r.hostRows.map((x) => x.host.uid), ['h1'])
}

// ── 8. Which application is shown as the person's ───────────────────────────
console.log('8. The primary application')
eq('redeemed first, then approved, then pending',
  primaryApplication([
    app('P', { status: 'pending' }), app('AP', { status: 'approved' }), app('R', { status: 'approved', isActivated: true }),
  ])?.id, 'R')
eq('approved beats pending', primaryApplication([app('P', { status: 'pending' }), app('AP', { status: 'approved' })])?.id, 'AP')
eq('none for nobody', primaryApplication([]), undefined)

// ── 9. Which agency (B20) ───────────────────────────────────────────────────
console.log('9. The agency is named by its current document')
const names = new Map([['AG1', 'Starlight Talent'], ['AG2', 'Moon']])
eq('the agency document\'s current name wins', resolveAgencyName('AG1', names, 'Starlight'),
  { label: 'Starlight Talent', current: true, staleName: 'Starlight' })
eq('…with no stale note when the copy agrees', resolveAgencyName('AG2', names, 'Moon'),
  { label: 'Moon', current: true, staleName: '' })
eq('an agency document that could not be read falls back to the copy', resolveAgencyName('AG9', names, 'Old Name'),
  { label: 'Old Name', current: false, staleName: '' })
eq('…and to the id when there is no copy', resolveAgencyName('AG9', names, ''),
  { label: 'AG9', current: false, staleName: '' })
eq('no agency at all is an empty label', resolveAgencyName('', names, undefined),
  { label: '', current: false, staleName: '' })

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} host-row checks FAILED\n`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log(`All ${checks} host-row checks passed.`)
console.log('  · an approved self-application is its Host\'s row, never a second person')
console.log('  · an invitation with an existing Host\'s phone or email is flagged, shown, not counted')
console.log('  · every application comes out somewhere; tab counts are people')
console.log('  · the agency is named by its current document, the copied name only as a fallback')

/**
 * FX-10 (RF-15 / DUP-08) — one agency's roster: current hosts only, each
 * person counted once, under the agency they belong to.
 *
 * REAL: `lib/agencyRoster.ts`, the merge `getAgencyRoster` runs over its two
 * reads, imported and called with plain documents.
 *
 *   npm run test:roster
 */

import { mergeAgencyRoster, type RosterDoc, type RosterRead } from './agencyRoster'

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

const read = (docs: RosterDoc[], capped = false): RosterRead => ({ docs, capped })
const user = (id: string, data: Record<string, unknown> = {}): RosterDoc =>
  ({ id, data: { name: id, isHost: true, ...data } })
const app = (id: string, data: Record<string, unknown> = {}): RosterDoc =>
  ({ id, data: { hostName: id, status: 'approved', kycStatus: 'approved', ...data } })
const stateOf = (r: ReturnType<typeof mergeAgencyRoster>, key: string) =>
  r.members.find((m) => m.uid === key || m.applicationId === key)?.state

// ── 1. The defect: a transferred Host counted under both agencies ─────────────
{
  // P joined A on invitation INV_A, and was then moved to B. P's user document
  // says B; the activated invitation still says A.
  const invitation = app('INV_A', { isActivated: true, activatedByUid: 'P', agencyId: 'A' })

  // Before FX-10's stamp: nothing on the application says it moved.
  const aRoster = mergeAgencyRoster(read([user('Q')]), read([invitation]))
  eq('A: P (redeemed, but not on A\'s users list) is not an active host of A', stateOf(aRoster, 'P'), 'former')
  eq('A counts only Q', [aRoster.active, aRoster.total], [1, 1])
  ok('…and P is still LISTED on A (history), just not counted', aRoster.members.some((m) => m.uid === 'P'))

  const bRoster = mergeAgencyRoster(read([user('P')]), read([]))
  eq('B counts P', [bRoster.active, bRoster.total], [1, 1])

  // With the stamp `_move_host` now writes.
  const stamped = app('INV_A2', {
    isActivated: true, activatedByUid: 'P2', agencyId: 'A', transferredTo: 'B', transferredFrom: 'A',
  })
  const aStamped = mergeAgencyRoster(null, read([stamped]))
  eq('a stamped activation is former even when the users read was refused', stateOf(aStamped, 'P2'), 'former')
  eq('…and names where it went', aStamped.members[0].movedTo, 'B')
  eq('…counted nowhere here', aStamped.total, 0)
}

// ── 2. Without evidence it moved, an activation stays active (unchanged) ─────
{
  const invitation = app('INV_X', { isActivated: true, activatedByUid: 'X' })
  eq('users read refused → cannot tell → active, as before',
    stateOf(mergeAgencyRoster(null, read([invitation])), 'X'), 'active')
  eq('users read capped → absence is not evidence → active, as before',
    stateOf(mergeAgencyRoster(read([user('Q')], true), read([invitation])), 'X'), 'active')
  const nobody = app('INV_N', { isActivated: true })
  eq('an activation with no redeemer named stays active (nothing to check)',
    stateOf(mergeAgencyRoster(read([]), read([nobody])), 'INV_N'), 'active')
}

// ── 3. The same person, seen from both sides, is ONE row ─────────────────────
{
  const r = mergeAgencyRoster(
    read([user('P', { phoneNumber: '+919800000001' })]),
    read([app('INV_P', { isActivated: true, activatedByUid: 'P' })]),
  )
  eq('one member, not two', r.members.length, 1)
  eq('…active, with the invitation attached', [r.members[0].state, r.members[0].applicationId], ['active', 'INV_P'])
  eq('…counted once', r.total, 1)
}

// ── 4. Distinct people stay distinct ─────────────────────────────────────────
{
  const r = mergeAgencyRoster(
    read([user('P1'), user('P2')]),
    read([
      app('INV_1', { isActivated: true, activatedByUid: 'P1' }),
      app('INV_3', { status: 'approved', applicantPhone: '+919800000003' }),
      app('INV_4', { status: 'pending', kycStatus: 'submitted', applicantPhone: '+919800000004' }),
    ]),
  )
  eq('two active, one awaiting, one pending', [r.active, r.awaiting, r.pending, r.total], [2, 1, 1, 4])
}

// ── 5. What did not change ───────────────────────────────────────────────────
{
  const r = mergeAgencyRoster(
    read([user('F', { isHost: false }), user('H', { phoneNumber: '+919800000009' })]),
    read([
      app('INV_REJ', { status: 'rejected', kycStatus: 'rejected' }),
      app('INV_TWIN', { status: 'approved', applicantPhone: '+919800000009' }),
    ]),
  )
  eq('a revoked Host on the users list is former, not counted', [stateOf(r, 'F'), r.former], ['former', 1])
  ok('a refused invitation is not on the roster', !r.members.some((m) => m.applicationId === 'INV_REJ'))
  const twin = r.members.find((m) => m.applicationId === 'INV_TWIN')
  eq('an invitation carrying a current host\'s phone is flagged, not counted',
    [twin?.sameContactAs, r.flagged, r.total], ['H', 1, 1])
  eq('order: active, awaiting, pending, former', r.members.map((m) => m.state)[r.members.length - 1], 'former')
}

// ── 6. Repeated reads give the same answer (no hidden state) ─────────────────
{
  const users = read([user('P')])
  const apps = read([app('INV_A', { isActivated: true, activatedByUid: 'Z' })])
  eq('the merge is a function of its inputs', JSON.stringify(mergeAgencyRoster(users, apps)),
    JSON.stringify(mergeAgencyRoster(users, apps)))
}

function main(): void {
  if (failures.length) {
    console.error(`\n${failures.length} of ${checks} agency roster checks FAILED\n`)
    for (const f of failures) console.error('  ✗ ' + f)
    process.exit(1)
  }
  console.log(`All ${checks} agency roster checks passed.`)
  console.log('  · a Host moved to another agency is counted once — where their account says they are')
  console.log('  · an activation is not dropped without evidence (users read refused or capped)')
  console.log('  · the same person seen from both reads is one row; distinct people stay distinct')
  console.log('  · revoked, refused and same-contact rows behave exactly as before')
}

main()

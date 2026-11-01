/**
 * Reinstatement and transfer requests — what the CRM may offer (GOV C2 / C3).
 *
 * ── THE BUGS THIS ENCODES ───────────────────────────────────────────────────
 *
 * B05: a revoked role had no way back except a Restore button any KYC reviewer
 * could press — no request from the person, no recommendation, no Owner.
 * B10: a Host or a Sub-agency changed agency only as a side effect of a
 * revoke, executed by an ops admin, with no Owner decision at all.
 *
 * The server now refuses a non-Owner on both. This module decides what the
 * screens OFFER, so nobody is shown a button that was always going to 403.
 *
 * REAL: `lib/governanceRequests.ts`, imported and called.
 *
 *   npm run test:govrequests
 */

import {
  MIN_NOTE,
  OWNER_DECIDES_REINSTATEMENT,
  REVOKED_RESTORE_HINT,
  canRecommendTransfer,
  idOf,
  listFrom,
  noteProblem,
  presentRoleAppealStatus,
  presentTransferStatus,
  restoreGate,
  restoreNeedsOwner,
  revokeTransferNote,
  reviewPermissionFor,
  roleAppealActions,
  roleAppealIsOpen,
  roleRecordHref,
  transferDestinations,
  transferIsOpen,
  transferRequestProblem,
  type AgencyOption,
} from './governanceRequests'

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

// ── 1. Notes ────────────────────────────────────────────────────────────────
console.log('1. A recommendation or decision says why')
ok('the minimum is ten characters', MIN_NOTE === 10)
ok('an empty note is refused', noteProblem('') !== '')
ok('nine characters are refused, and the count is shown', noteProblem('123456789').includes('9 so far'))
eq('ten characters are fine', noteProblem('1234567890'), '')
ok('surrounding spaces do not count', noteProblem('   short    ') !== '')

// ── 2. Reinstatement: who may recommend, who may decide ─────────────────────
console.log('2. Reviewers recommend; the Owner decides')
const owner = { isOwner: true, permissions: [] as string[] }
const kycReviewer = { isOwner: false, permissions: ['can_approve_kyc'] }
const sellerReviewer = { isOwner: false, permissions: ['can_approve_seller'] }
const nobody = { isOwner: false, permissions: ['can_view_users'] }

eq('a Host request is reviewed under can_approve_kyc', reviewPermissionFor('host'), 'can_approve_kyc')
eq('…an Agency and a Sub-agency too', [reviewPermissionFor('agency'), reviewPermissionFor('sub_agency')],
  ['can_approve_kyc', 'can_approve_kyc'])
eq('…a Coin Seller under can_approve_seller', reviewPermissionFor('seller'), 'can_approve_seller')

eq('a KYC reviewer may recommend a pending Host request, not decide it',
  roleAppealActions({ status: 'pending', kind: 'host' }, kycReviewer),
  { recommend: true, decide: false, hint: OWNER_DECIDES_REINSTATEMENT })
eq('…and may NOT recommend a Coin Seller one', roleAppealActions({ status: 'pending', kind: 'seller' }, kycReviewer).recommend, false)
eq('a seller reviewer may recommend a Coin Seller request', roleAppealActions({ status: 'pending', kind: 'seller' }, sellerReviewer).recommend, true)
eq('a recommended request can be recommended again and is still open',
  roleAppealActions({ status: 'recommended', kind: 'agency' }, kycReviewer).recommend, true)
eq('the Owner may recommend and decide an open request',
  roleAppealActions({ status: 'recommended', kind: 'sub_agency' }, owner),
  { recommend: true, decide: true, hint: '' })
eq('nobody may act on a decided request — not even the Owner',
  [roleAppealActions({ status: 'restored', kind: 'host' }, owner), roleAppealActions({ status: 'kept_revoked', kind: 'host' }, kycReviewer)],
  [{ recommend: false, decide: false, hint: '' }, { recommend: false, decide: false, hint: '' }])
eq('a role without review permission gets nothing to press', roleAppealActions({ status: 'pending', kind: 'agency' }, nobody).recommend, false)
ok('…but is told who decides', roleAppealActions({ status: 'pending', kind: 'agency' }, nobody).hint.includes('Owner'))
eq('an unknown status is not open', roleAppealIsOpen('weird'), false)
ok('every status has a label, and an unknown one says so',
  ['pending', 'recommended', 'restored', 'kept_revoked'].every((s) => presentRoleAppealStatus(s).label !== s)
  && presentRoleAppealStatus('weird').note.includes('not one the CRM knows'))

eq('a request links to the record it is about',
  [roleRecordHref('host', 'u1', 'u1'), roleRecordHref('agency', 'A1', 'u2'), roleRecordHref('sub_agency', 'S1', 'u3'),
    roleRecordHref('seller', 'L1', 'u4'), roleRecordHref('seller', '', 'u4')],
  ['/users/u1', '/agencies/A1', '/agencies/S1', '/sellers/L1', ''])

// ── 3. Restoring a revoked role directly ────────────────────────────────────
console.log('3. A revoked role is restored by the Owner only; a suspended one as before')
ok('a revoked role needs the Owner', restoreNeedsOwner('revoked'))
ok('a suspended role does not', !restoreNeedsOwner('suspended'))
eq('a reviewer is refused on a revoked role, with the way forward',
  restoreGate('revoked', false), { allowed: false, hint: REVOKED_RESTORE_HINT })
ok('…and the hint names Reinstatement requests', REVOKED_RESTORE_HINT.includes('Reinstatement requests'))
eq('the Owner may', restoreGate('revoked', true), { allowed: true, hint: '' })
eq('anybody who could before may still lift a role-level suspension', restoreGate('suspended', false), { allowed: true, hint: '' })

// ── 4. Transfer destinations ────────────────────────────────────────────────
console.log('4. A transfer is offered only to a destination the server accepts')
const A = (id: string, over: Partial<AgencyOption> = {}): AgencyOption => ({
  id, kind: 'agency', status: 'approved', is_active: true, parent_id: null, name: id, ...over,
})
const agencies: AgencyOption[] = [
  A('MAIN_CUR', { name: 'Current' }),
  A('MAIN_B', { name: 'Bravo' }),
  A('MAIN_A', { name: 'Alpha' }),
  A('MAIN_SUSP', { status: 'suspended' }),
  A('MAIN_INACTIVE', { is_active: false }),
  A('MAIN_REVOKED', { status: 'revoked' }),
  A('SUB_LIVE', { kind: 'sub_agency', parent_id: 'MAIN_B', name: 'Sub of Bravo' }),
  A('SUB_UNDER_SUSP', { kind: 'sub_agency', parent_id: 'MAIN_SUSP' }),
  A('SUB_PENDING', { kind: 'sub_agency', parent_id: 'MAIN_A', status: 'pending' }),
  A('SUB_ORPHAN', { kind: 'sub_agency', parent_id: 'GONE' }),
  A('SUB_SELF', { kind: 'sub_agency', parent_id: 'MAIN_CUR', name: 'Zeta sub' }),
]
eq('a sub-agency may move to another live MAIN agency only — main first, by name',
  transferDestinations('sub_agency', { id: 'SUB_SELF', currentAgencyId: 'MAIN_CUR' }, agencies).map((a) => a.id),
  ['MAIN_A', 'MAIN_B'])
eq('a host may also move to a live sub-agency under a live main agency',
  transferDestinations('host', { id: 'uidHost', currentAgencyId: 'MAIN_CUR' }, agencies).map((a) => a.id),
  ['MAIN_A', 'MAIN_B', 'SUB_LIVE', 'SUB_SELF'])
ok('never the agency they are already under',
  !transferDestinations('host', { id: 'uidHost', currentAgencyId: 'SUB_LIVE' }, agencies).some((a) => a.id === 'SUB_LIVE'))
ok('never a suspended, inactive or revoked agency, nor a sub under one, nor an orphan',
  !transferDestinations('host', { id: 'uidHost', currentAgencyId: 'MAIN_CUR' }, agencies)
    .some((a) => ['MAIN_SUSP', 'MAIN_INACTIVE', 'MAIN_REVOKED', 'SUB_UNDER_SUSP', 'SUB_PENDING', 'SUB_ORPHAN'].includes(a.id)))
ok('a sub-agency is never offered itself',
  !transferDestinations('sub_agency', { id: 'MAIN_A', currentAgencyId: 'MAIN_CUR' }, agencies).some((a) => a.id === 'MAIN_A'))

const dest = transferDestinations('host', { id: 'uidHost', currentAgencyId: 'MAIN_CUR' }, agencies)
eq('a destination must be chosen', transferRequestProblem({ toAgencyId: '', note: 'a long enough note', destinations: dest }),
  'Choose the agency to move to.')
ok('…and must be one of the eligible ones',
  transferRequestProblem({ toAgencyId: 'MAIN_SUSP', note: 'a long enough note', destinations: dest }).includes('not an eligible'))
ok('…with a note of at least ten characters', transferRequestProblem({ toAgencyId: 'MAIN_A', note: 'short', destinations: dest }) !== '')
eq('a complete request has no problem', transferRequestProblem({ toAgencyId: 'MAIN_A', note: 'moving to a closer agency', destinations: dest }), '')

eq('a KYC approver or the Owner may recommend a transfer; nobody else',
  [canRecommendTransfer(kycReviewer), canRecommendTransfer(owner), canRecommendTransfer(sellerReviewer), canRecommendTransfer(nobody)],
  [true, true, false, false])
eq('only a pending transfer is open', [transferIsOpen('pending'), transferIsOpen('approved'), transferIsOpen('rejected')], [true, false, false])
ok('every transfer status has a label', ['pending', 'approved', 'rejected'].every((s) => presentTransferStatus(s).label !== s))

// ── 5. The revoke dialog ────────────────────────────────────────────────────
console.log('5. A revocation that moves dependents is the Owner\'s decision')
eq('nothing to say when nothing moves', revokeTransferNote({ subAgencies: 0, hosts: 0 }, false), '')
eq('nothing to say to the Owner', revokeTransferNote({ subAgencies: 2, hosts: 3 }, true), '')
const note = revokeTransferNote({ subAgencies: 1, hosts: 2 }, false)
ok('a non-Owner is told what would move', note.includes('2 hosts') && note.includes('1 sub-agency'))
ok('…that the Owner decides, and what to do instead', note.includes('Owner') && note.includes('transfer recommendation'))

// ── 6. Reading the responses ────────────────────────────────────────────────
console.log('6. Responses are read defensively')
eq('a bare list', listFrom<number>([1, 2], 'appeals'), [1, 2])
eq('a wrapped list', listFrom<number>({ appeals: [3] }, 'appeals'), [3])
eq('the usual other wrappers', listFrom<number>({ items: [4] }, 'transfers'), [4])
eq('anything else is empty, never a crash', [listFrom(null, 'x'), listFrom('nope', 'x'), listFrom({ x: 'nope' }, 'x')], [[], [], []])
eq('an id under either spelling', [idOf({ id: 'ra_1' }), idOf({ _id: 'tr_2' }), idOf(null)], ['ra_1', 'tr_2', ''])

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} governance-request checks FAILED\n`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log(`All ${checks} governance-request checks passed.`)
console.log('  · reviewers recommend a reinstatement; only the Owner decides one')
console.log('  · a revoked role is restored by the Owner only — a suspended one as before')
console.log('  · a transfer is offered only to a destination the server accepts')
console.log('  · a revocation that moves dependents is explained as the Owner\'s decision')

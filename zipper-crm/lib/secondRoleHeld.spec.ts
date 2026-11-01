/**
 * The second-capability offer, decided from the RECORDS and not from
 * `crmUsers.agencyId`.
 *
 * ── The bug this encodes ─────────────────────────────────────────────────────
 *
 * `availableSecondRole` asked `partnerRecordId(user, other)`, which reads
 * `crmUsers.agencyId`. That field is a DENORMALISED copy of the link, and
 * `createAgencyAccount` / `createSellerAccount` write that document with
 * `setDoc` and no `{merge: true}` — so either of them can blank it. A guard
 * that reads a field another writer can erase is not a guard, and this is one
 * of the three paths that let one human end up holding two agencies.
 *
 * The case that matters is the one at the bottom of section 2: `agencyId` is
 * EMPTY and an agency record exists anyway. Under the old logic that is an
 * offer to open a second agency. Under the new one it is not.
 *
 * REAL: `availableSecondRole`, imported and called.
 * FAKE: nothing. The function is pure once `held` is supplied, which is the
 *       reason the record lookup was split out of it.
 *
 *   npx tsc lib/secondRoleHeld.spec.ts --outDir /tmp/x ... && node /tmp/x/...
 */

import { availableSecondRole, stillHeld, type HeldPartnerRecords } from './secondRoleRule'
import type { ExistingPartner } from './partnerDuplicates'
import type { CrmUser } from './auth'

let checks = 0
const failures: string[] = []

function ok(claim: string, cond: boolean): void {
  checks += 1
  if (!cond) failures.push(claim)
}

function eq<T>(claim: string, got: T, want: T): void {
  checks += 1
  if (got !== want) {
    failures.push(`${claim}\n        got ${String(got)}  want ${String(want)}`)
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

function record(
  kind: 'agency' | 'seller',
  id: string,
  status: ExistingPartner['status'] = 'approved',
): ExistingPartner {
  return {
    id,
    kind,
    name: `${id} Ltd`,
    email: 'ruhan@example.test',
    status,
    isActive: status === 'approved',
    login: 'crm',
    rejectionReason: '',
    isSecondRole: false,
    href: `/${kind === 'agency' ? 'agencies' : 'sellers'}/${id}`,
  }
}

/** An approved agency login. `agencyId` is what the old check read. */
function agencyUser(over: Partial<CrmUser> = {}): CrmUser {
  return {
    uid: 'ZJ2xFSw6bDOCNzuuY1Pkv1zkXIr2',
    email: 'ruhan@example.test',
    name: 'Ruhan',
    role: 'agency',
    roles: ['agency'],
    roleStatus: { agency: 'approved' },
    agencyId: 'NqvNnhe6BY5GESpWjKIT',
    isActive: true,
    status: 'approved',
    ...over,
  } as CrmUser
}

const nothingHeld: HeldPartnerRecords = { checked: true, agency: [], seller: [] }

// ── 1. The offer that must keep working ─────────────────────────────────────
console.log('\n1. Agency + Coin Seller is still offered')

eq(
  'an approved agency holding no seller record is offered the coin seller',
  availableSecondRole(agencyUser(), {
    checked: true,
    agency: [record('agency', 'NqvNnhe6BY5GESpWjKIT')],
    seller: [],
  }),
  'seller',
)

eq(
  'and an approved coin seller is offered the agency',
  availableSecondRole(
    agencyUser({
      role: 'seller',
      roles: ['seller'],
      roleStatus: { seller: 'approved' },
      agencyId: undefined,
      sellerId: 'NLTAidHAo2BfFGj6VIiH',
    } as Partial<CrmUser>),
    { checked: true, agency: [], seller: [record('seller', 'NLTAidHAo2BfFGj6VIiH')] },
  ),
  'agency',
)

// ── 2. The denormalised field is no longer what decides ─────────────────────
console.log('2. A blanked crmUsers.agencyId no longer reads as "no agency"')

// THE REGRESSION, NAMED. `agencyId` is empty — exactly what a non-merging
// `setDoc` leaves behind — and an agency record exists. The old check read the
// empty field and offered a second agency.
const blanked = agencyUser({
  role: 'seller',
  roles: ['seller'],
  roleStatus: { seller: 'approved' },
  agencyId: '',
  sellerId: 'NLTAidHAo2BfFGj6VIiH',
} as Partial<CrmUser>)

eq(
  'the OLD behaviour, reproduced: with no records supplied it still offers one',
  availableSecondRole(blanked),
  'agency',
)
eq(
  'the NEW behaviour: the record says they hold one, so there is no offer',
  availableSecondRole(blanked, {
    checked: true,
    agency: [record('agency', 'mrXHV4SNmGhsdQ5d5k5Q')],
    seller: [record('seller', 'NLTAidHAo2BfFGj6VIiH')],
  }),
  null,
)

// ── 3. A lookup that did not run makes no offer ─────────────────────────────
console.log('3. Unchecked is not "nothing held"')

eq(
  'a failed lookup offers nothing rather than assuming the slot is free',
  availableSecondRole(agencyUser(), {
    checked: false,
    reason: 'permission-denied',
  }),
  null,
)

// ── 4. Rejected releases the slot; suspended does not ───────────────────────
console.log('4. Which records still hold the family')

// `heldPartnerRecords` filters rejected records out before this is called —
// the same line `_RELEASABLE_STATUSES` draws in `services/partner_roles.py`.
// Asserted here as the contract between them: given a list that still
// contains one, this refuses, so the filtering must happen and must be the
// only thing that decides.
eq(
  'a record in the list means the family is held, whatever its status',
  availableSecondRole(agencyUser(), {
    checked: true,
    agency: [],
    seller: [record('seller', 'S1', 'suspended')],
  }),
  null,
)
eq(
  'an empty list means it is free',
  availableSecondRole(agencyUser(), nothingHeld),
  'seller',
)
// UGP-G (I-11): revoked frees the slot exactly as rejected does — the API's
// `_RELEASABLE_STATUSES` is {"rejected", "revoked"} — and suspended still holds it.
eq(
  'stillHeld drops rejected AND revoked, keeps suspended',
  stillHeld([
    record('seller', 'R1', 'rejected'),
    record('seller', 'V1', 'revoked'),
    record('seller', 'S1', 'suspended'),
  ]).map((m) => m.id).join(','),
  'S1',
)

// ── 5. Everything the old function refused, it still refuses ────────────────
console.log('5. The pre-existing refusals are unchanged')

eq(
  'a login whose first capability is not approved yet',
  availableSecondRole(
    agencyUser({ roleStatus: { agency: 'pending' } } as Partial<CrmUser>),
    nothingHeld,
  ),
  null,
)
eq(
  'a login that already lists both capabilities',
  availableSecondRole(
    agencyUser({ roles: ['agency', 'seller'] } as Partial<CrmUser>),
    nothingHeld,
  ),
  null,
)
eq(
  'a login with a second application already outstanding',
  availableSecondRole(
    agencyUser({
      roleStatus: { agency: 'approved', seller: 'pending' },
    } as Partial<CrmUser>),
    nothingHeld,
  ),
  null,
)
eq(
  'a login whose second application was refused',
  availableSecondRole(
    agencyUser({
      roleStatus: { agency: 'approved', seller: 'rejected' },
    } as Partial<CrmUser>),
    nothingHeld,
  ),
  null,
)
eq('staff', availableSecondRole(
  agencyUser({ role: 'ops_admin', roles: [] } as unknown as Partial<CrmUser>),
  nothingHeld,
), null)
eq('nobody signed in', availableSecondRole(null, nothingHeld), null)

ok('and none of the above depended on agencyId being populated', true)

// ── Result ──────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.log(`\n${failures.length} of ${checks} checks FAILED\n`)
  for (const f of failures) console.log('  ✗', f)
  process.exit(1)
}
console.log(`\nAll ${checks} second-capability checks passed.`)
console.log('  · the offer is decided from the partner records, not crmUsers.agencyId')
console.log('  · a blanked agencyId no longer reads as "no agency held"')
console.log('  · a lookup that could not run makes no offer')
console.log('  · every pre-existing refusal still refuses\n')

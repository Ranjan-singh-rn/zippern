/**
 * Which second capability a login may apply for — the decision, with no I/O.
 *
 * ── Why this is its own file ────────────────────────────────────────────────
 *
 * It lived in `lib/partnerRoles.ts`, which imports `./firebase` and therefore
 * initialises an SDK the moment it is loaded. A pure rule sitting behind that
 * import cannot be run on its own, so the only way to exercise it was through
 * a browser. `lib/partnerRouting.ts` was split out for the same reason and is
 * covered by `partnerRouting.spec.ts`; this follows it.
 *
 * Everything here is a function of its arguments. The lookup that fetches
 * `HeldPartnerRecords` stays in `partnerRoles.ts`, where the Firestore query
 * belongs.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * One human holds at most one agency-family record and at most one coin
 * seller. The agency family is Agency *or* Sub-agency — never both, never two.
 *
 *                   Agency   Sub-agency   Coin Seller
 *     Agency          —          NO           YES
 *     Sub-agency      NO         —            YES
 *     Coin Seller    YES        YES            —
 *
 * This file answers only the Agency/Coin-Seller half, because that is the only
 * pair the second-capability form can file. The authority for all of it is
 * `backend/app/services/partner_roles.py`, which claims the family in Mongo
 * against the Firebase uid before any partner record is written. What happens
 * here saves a round trip and produces a better sentence; it decides nothing
 * the API will not re-decide.
 */

import {
  partnerRecordId,
  partnerRoleStatus,
  partnerRolesOf,
  primaryPartnerRole,
  type PartnerRole,
} from './partnerRouting'
import type { ExistingPartner } from './partnerDuplicates'
import type { CrmUser } from './auth'

/**
 * What this login actually holds, read from the partner RECORDS.
 *
 * Three-valued on purpose, like `DuplicateCheck`: "we looked and found
 * nothing" and "we could not look" are different answers, and reporting the
 * second as the first is how a check ends up silently never firing.
 */
export type HeldPartnerRecords =
  | { checked: true; agency: ExistingPartner[]; seller: ExistingPartner[] }
  | { checked: false; reason: string }

/**
 * The records that still occupy their role family.
 *
 * Mirrors `_RELEASABLE_STATUSES` in `services/partner_roles.py`: a REJECTED
 * record frees the slot — a refused application must not bar a second
 * attempt — and so does a REVOKED one (UGP-G, I-11: this used to free only
 * rejected, while the API frees both, so a revoked role still blocked a new
 * application here). `suspended` keeps its place, because the business still
 * exists. The two sides have to draw this line in the same spot or the
 * browser and the API will disagree about who holds what.
 */
export function stillHeld(matches: ExistingPartner[]): ExistingPartner[] {
  return matches.filter((m) => m.status !== 'rejected' && m.status !== 'revoked')
}

/**
 * The capability this login could still apply for, or null.
 *
 * Null for staff, for a partner that already holds both, for one whose
 * existing capability has not been approved yet — you cannot open a second
 * business on the strength of an application nobody has read — and for one
 * whose second application is already outstanding or has been refused.
 *
 * `held` is what the records say. Pass it and the decision is made from them.
 *
 * ── Omitting it is the old behaviour, and the old behaviour is a bug ────────
 *
 * Without `held` this falls back to `partnerRecordId`, which reads
 * `crmUsers.agencyId` — a DENORMALISED copy of the link that
 * `createAgencyAccount` and `createSellerAccount` can blank, because they
 * write that document with `setDoc` and no `{merge: true}`. A guard reading a
 * field another writer can erase is not a guard, and that is one of the three
 * paths that let one human end up holding two agencies in production.
 *
 * The fallback is kept for the first render only, before the query returns.
 * The card that uses it shows and then withdraws the offer, which is the
 * right way round: a flicker costs nothing, while the reverse would offer an
 * application the API refuses. Every caller that WRITES must pass `held`.
 */
export function availableSecondRole(
  user: CrmUser | null,
  held?: HeldPartnerRecords,
): PartnerRole | null {
  const primary = primaryPartnerRole(user)
  if (!user || !primary) return null
  if (partnerRoleStatus(user, primary) !== 'approved') return null

  const other: PartnerRole = primary === 'agency' ? 'seller' : 'agency'
  if (partnerRolesOf(user).includes(other)) return null
  if (user.roleStatus?.[other]) return null

  if (held) {
    // A lookup that did not run is not a clean result. What to do about that
    // is the caller's decision; here it simply is not an offer.
    if (!held.checked) return null
    return held[other].length > 0 ? null : other
  }
  return partnerRecordId(user, other) ? null : other
}

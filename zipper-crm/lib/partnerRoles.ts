'use client'

/**
 * Applying for the second partner capability.
 *
 * An approved agency asking to sell coins, or an approved coin seller asking to
 * run an agency. One login, two businesses — and, underneath, **two separate
 * partner records** with their own balances and their own ledgers. Nothing in
 * this file merges anything: it files an application, and that is all.
 *
 * ── What it writes, and why the rules allow it ───────────────────────────────
 *
 * Two documents, in this order:
 *
 *   1. The new partner document — `sellers/{id}` or `agencies/{id}` — pending,
 *      inactive, and with every balance pinned to zero. It carries
 *      `source: 'second_role'` and `secondRoleOwnerUid: <this login>`, and that
 *      second field is the ONLY thing `firestore.rules` binds the capability
 *      claim to. A partner can create a document naming themselves; they cannot
 *      write that field onto anybody else's record, because the only update
 *      clauses on an existing agency or seller are pinned to fields that do not
 *      include it.
 *
 *   2. Their own `crmUsers` document — `roles` gains the capability,
 *      `roleStatus.<capability>` is set to 'pending', and the link id is
 *      recorded. The rules permit exactly this shape and nothing else: the
 *      status must be 'pending', the link must have been empty, `roles` may
 *      contain only 'agency' and 'seller', and the new document must name this
 *      caller. A partner therefore cannot approve themselves, cannot point at
 *      somebody else's agency, and cannot mint a staff role.
 *
 * Approving it is staff work, on the same /agencies or /sellers screen and with
 * the same Approve button, because that is where the Mongo partner record is
 * created — at zero — and the capability granted. Coin inventory is real money.
 */

import {
  addDoc,
  collection,
  doc,
  getDoc,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore'
import { db } from './firebase'
import { generateCrmId } from './auth'
import type { CrmUser } from './auth'
import { findPartnersByEmail } from './partnerDuplicates'
import {
  availableSecondRole,
  stillHeld,
  type HeldPartnerRecords,
} from './secondRoleRule'

// Re-exported so every existing caller keeps importing the rule from here,
// while the rule itself stays free of the Firebase import that made it
// impossible to test.
export { availableSecondRole, type HeldPartnerRecords }
import {
  PARTNER_ROLE_LABEL,
  partnerRecordId,
  partnerRoleStatus,
  partnerRolesOf,
  primaryPartnerRole,
  type PartnerRole,
} from './partnerRouting'

/** The minimum a person has to tell us to open the second business. */
export interface SecondRoleApplication {
  /** Trading name of the new business — agency name, or coin-shop name. */
  name: string
  phone: string
  /** Why they want it. Kept on the application and shown to the reviewer. */
  reason: string
}

export interface SecondRoleResult {
  /** The capability applied for. */
  role: PartnerRole
  /** The Firestore document id of the new partner record. */
  partnerId: string
}

export class SecondRoleError extends Error {}

const MIN_REASON = 3

/**
 * What this login actually holds, read from the partner RECORDS.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The question "does this person already have an agency?" was answered by
 * `partnerRecordId(user, 'agency')`, which reads `crmUsers.agencyId`. That is
 * a DENORMALISED copy of the link, and `createAgencyAccount` /
 * `createSellerAccount` write that document with `setDoc` and no
 * `{merge: true}` — so either of them can blank the field the check depends
 * on. A guard that reads a field another writer can erase is not a guard, and
 * this is one of the three ways the production duplicate got in.
 *
 * So the records answer for themselves.
 *
 * ── Matched on the verified email, not the uid ──────────────────────────────
 *
 * `crmUid` appears in no read clause in `firestore.rules`, so
 * `where('crmUid','==',me)` is refused for every document and the list query
 * fails outright. `ownerEmail == request.auth.token.email` IS a read clause,
 * and the address is one Firebase verified, so that is the shape the rules
 * permit a partner to ask. `findPartnersByEmail` already issues exactly it.
 *
 * This is a client-side pre-check and is NOT the enforcement. The API claims
 * the role family in Mongo, keyed on the Firebase uid, before any partner
 * record is written (`backend/app/services/partner_roles.py`), and refuses a
 * second agency whatever the browser believed. What this buys is a sentence
 * instead of a 400, and a card that does not offer something that cannot work.
 *
 * The decision itself — `availableSecondRole` — is in `lib/secondRoleRule.ts`,
 * which has no Firebase import and so can be run on its own. Re-exported
 * below so callers keep importing it from here.
 */
export async function heldPartnerRecords(
  user: CrmUser | null,
): Promise<HeldPartnerRecords> {
  if (!user) return { checked: false, reason: 'There is no signed-in account.' }
  const email = (user.email || '').trim().toLowerCase()
  if (!email) {
    return { checked: false, reason: 'This login carries no email address.' }
  }

  const [agency, seller] = await Promise.all([
    findPartnersByEmail('agency', email),
    findPartnersByEmail('seller', email),
  ])
  if (!agency.checked) return { checked: false, reason: agency.reason }
  if (!seller.checked) return { checked: false, reason: seller.reason }

  return {
    checked: true,
    agency: stillHeld(agency.matches),
    seller: stillHeld(seller.matches),
  }
}

export function secondRoleLabel(role: PartnerRole): string {
  return PARTNER_ROLE_LABEL[role]
}

/**
 * File the application. Returns the new partner record's id.
 *
 * Not idempotent, and deliberately not retried on a partial failure: the two
 * writes are checked in the opposite order to the one they happen in, so if the
 * `crmUsers` write is refused the caller is told, the orphaned application
 * document holds nothing, and nothing about their existing business changed.
 */
export async function requestSecondRole(
  user: CrmUser,
  application: SecondRoleApplication,
): Promise<SecondRoleResult> {
  // ── THE RECORDS DECIDE, AND A LOOKUP THAT DID NOT RUN IS NOT A CLEAN
  //    RESULT ────────────────────────────────────────────────────────────────
  //
  // Read before anything else, because every other check here is about the
  // shape of the application and this one is about whether it may exist at
  // all. Failing closed is the whole point: the version of this that asked
  // `crmUsers.agencyId` could be told "no agency" by a document another writer
  // had blanked, and went ahead.
  const held = await heldPartnerRecords(user)
  if (!held.checked) {
    throw new SecondRoleError(
      'The check for businesses you already hold could not be run, so nothing ' +
        `was created: ${held.reason}. Please try again in a moment.`,
    )
  }

  const role = availableSecondRole(user, held)
  if (!role) {
    const already = held.agency.length > 0 && held.seller.length > 0
    throw new SecondRoleError(
      already
        ? 'This account already holds both an agency and a coin seller, so ' +
          'there is no second capability left to apply for.'
        : 'This account cannot apply for a second capability right now. It ' +
          'either holds both already, has an application outstanding, or is ' +
          'still waiting on its first approval.',
    )
  }

  // One human holds one agency-family record. The API enforces this against
  // Mongo and will refuse the write regardless; saying so here turns a 400
  // into a sentence that names the business already held.
  if (held[role].length > 0) {
    const existing = held[role][0]
    throw new SecondRoleError(
      `This account already holds ${existing.name ? `"${existing.name}"` : 'a record'} ` +
        `as a ${role === 'agency' ? 'agency' : 'coin seller'}. One person holds ` +
        'one of each, so nothing was created.',
    )
  }

  const name = application.name.trim()
  const phone = application.phone.trim()
  const reason = application.reason.trim()
  if (!name) throw new SecondRoleError('A business name is required.')
  if (!phone) throw new SecondRoleError('A contact phone number is required.')
  if (reason.length < MIN_REASON) {
    throw new SecondRoleError(
      'Tell the reviewer why you want this, in at least a few words. Every ' +
        'partner decision is recorded with a reason.',
    )
  }

  const email = user.email.trim().toLowerCase()

  // The business they already run, recorded on the new application as
  // `secondRoleOfPartnerId`. Taken from the RECORD, with `crmUsers` only as a
  // fallback: this was `partnerRecordId(user, …)`, the same denormalised field
  // the guard above used to trust, and a non-merging `setDoc` elsewhere can
  // blank it. That failure is quiet — the application is still filed, just
  // with an empty `secondRoleOfPartnerId`, so the reviewer cannot see which
  // existing partner it belongs to.
  const alreadyHolds: PartnerRole = role === 'agency' ? 'seller' : 'agency'
  const heldPartnerId =
    held[alreadyHolds][0]?.id ?? partnerRecordId(user, alreadyHolds)

  const created =
    role === 'seller'
      ? await addDoc(collection(db, 'sellers'), {
          crmId: generateCrmId(),
          crmUid: user.uid,
          ownerUid: '',
          displayName: name,
          phone,
          email,
          description: reason,
          registrationFeePaid: false,
          registrationProofUrl: '',
          isApproved: false,
          isActive: false,
          status: 'pending',
          // Money. Pinned to zero here and by the security rules, and loaded
          // only by an approved, signed coin purchase card.
          coinBalance: 0,
          totalCoinsSold: 0,
          qrCodeUrl: '',
          source: 'second_role',
          secondRoleOwnerUid: user.uid,
          secondRoleOfPartnerId: heldPartnerId,
          secondRoleReason: reason,
          createdAt: serverTimestamp(),
        })
      : await addDoc(collection(db, 'agencies'), {
          crmId: generateCrmId(),
          crmUid: user.uid,
          agencyName: name,
          ownerName: user.name,
          ownerPhone: phone,
          ownerEmail: email,
          type: 'main',
          parentAgencyId: null,
          status: 'pending',
          kycStatus: 'pending',
          kycDocUrls: [],
          isActive: false,
          totalHosts: 0,
          totalSubAgencies: 0,
          source: 'second_role',
          secondRoleOwnerUid: user.uid,
          secondRoleOfPartnerId: heldPartnerId,
          secondRoleReason: reason,
          createdAt: serverTimestamp(),
        })

  // The capability goes on the login as PENDING. It is listed in `roles` from
  // now on — the same way a fresh signup's `role` is listed while it waits —
  // and `roleStatus` is what withholds the dashboard until staff decide.
  const roles = Array.from(new Set([...partnerRolesOf(user), role]))
  await updateDoc(doc(db, 'crmUsers', user.uid), {
    roles,
    [`roleStatus.${role}`]: 'pending',
    [role === 'seller' ? 'sellerId' : 'agencyId']: created.id,
  })

  return { role, partnerId: created.id }
}

/**
 * Whether the application filed for `role` has been refused, and why.
 *
 * The reason is written onto the partner document by the API when a reviewer
 * rejects it (`reject_partner` mirrors it to Firestore), so this reads it from
 * there rather than duplicating it onto the login.
 */
export async function secondRoleRefusal(
  user: CrmUser | null,
  role: PartnerRole,
): Promise<string> {
  if (!user || partnerRoleStatus(user, role) !== 'rejected') return ''
  const id = partnerRecordId(user, role)
  if (!id) return ''
  const snap = await getDoc(doc(db, role === 'seller' ? 'sellers' : 'agencies', id))
  if (!snap.exists()) return ''
  const reason = snap.data().rejectionReason
  return typeof reason === 'string' ? reason : ''
}

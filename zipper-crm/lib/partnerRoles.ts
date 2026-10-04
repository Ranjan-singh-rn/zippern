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
 * The capability this login could still apply for, or null.
 *
 * Null for staff, for a partner that already holds both, for one whose existing
 * capability has not been approved yet — you cannot open a second business on
 * the strength of an application nobody has read — and for one whose second
 * application is already outstanding or has been refused.
 */
export function availableSecondRole(user: CrmUser | null): PartnerRole | null {
  const primary = primaryPartnerRole(user)
  if (!user || !primary) return null
  if (partnerRoleStatus(user, primary) !== 'approved') return null

  const other: PartnerRole = primary === 'agency' ? 'seller' : 'agency'
  if (partnerRolesOf(user).includes(other)) return null
  if (user.roleStatus?.[other]) return null
  if (partnerRecordId(user, other)) return null
  return other
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
  const role = availableSecondRole(user)
  if (!role) {
    throw new SecondRoleError(
      'This account cannot apply for a second capability right now. It either ' +
        'holds both already, has an application outstanding, or is still waiting ' +
        'on its first approval.',
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
  const held = partnerRecordId(user, role === 'agency' ? 'seller' : 'agency')

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
          secondRoleOfPartnerId: held,
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
          secondRoleOfPartnerId: held,
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

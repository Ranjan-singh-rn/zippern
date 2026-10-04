import { db } from '@/lib/firebase'
import {
  collection,
  getDocs,
  doc,
  getDoc,
  updateDoc,
  serverTimestamp,
  query,
  where,
  orderBy,
  limit,
  Timestamp,
} from 'firebase/firestore'
import {
  submitPartnerUpdate,
  type Proposer,
  type SubmitResult,
} from '@/lib/pendingChanges'

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface Seller {
  id: string
  crmId?: string           // 8-char human-readable ID, e.g. "A1B2C3D4"
  crmUid?: string
  ownerUid: string
  displayName: string
  phone: string
  email: string
  /** Contact detail, self-editable — already on the rules' allow-list. */
  city?: string
  isApproved: boolean
  isActive: boolean
  registrationFeePaid: boolean
  registrationProofUrl: string
  idDocUrls?: Array<{ label: string; url: string }>  // KYC docs uploaded at registration
  /**
   * The decision, where the record carries one. Sellers were approved through
   * `isApproved` alone for a long time and many documents still have no
   * `status` at all, which is why `firestoreStatusOf` on /kyc consults both.
   */
  status?: 'pending' | 'approved' | 'rejected' | 'suspended'
  /**
   * A proposed change to identity details, waiting on a reviewer. Read it with
   * `readPendingChanges` — a browser writes it and the security rules say
   * nothing about what may be inside, so it is not typed as trustworthy.
   */
  pendingChanges?: unknown
  coinBalance: number
  totalCoinsSold: number
  qrCodeUrl: string
  description: string
  createdAt: Timestamp
  approvedAt?: Timestamp
  approvedBy?: string
  // ── Dual-role (Coin Seller + Agency) ────────────────────────────────────────
  isAgency?: boolean          // true when this seller entity is also an agency
  linkedAgencyId?: string     // Firestore doc ID in the `agencies` collection
}

export interface RechargeRequest {
  id: string
  buyerUid: string
  buyerName: string
  buyerPhone: string
  sellerUid: string
  sellerName: string
  diamondPackage: number
  amountPaid: number
  paymentScreenshotUrl: string
  status: 'pending' | 'approved' | 'rejected'
  approvedBy?: string
  approvedAt?: Timestamp
  rejectedReason?: string
  createdAt: Timestamp
}

// ── Seller Helpers ────────────────────────────────────────────────────────────

export async function getSellers(approvedOnly?: boolean): Promise<Seller[]> {
  let q = approvedOnly
    ? query(
        collection(db, 'sellers'),
        where('isApproved', '==', true),
        orderBy('createdAt', 'desc')
      )
    : query(collection(db, 'sellers'), orderBy('createdAt', 'desc'))

  const snap = await getDocs(q)
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Seller))
}

/**
 * One seller, by document id — or, failing that, by the `crmId` field.
 *
 * The two are different things and mixing them up blanks the whole profile.
 * The document id is `OMWiwVyaS8o9vhBNqxLL`; `crmId` is the short human code
 * inside it, `2675X843`. Callers used to pass `p.crm_id || id`, which meant a
 * partner that *had* a `crmId` never had its real id tried at all —
 * `getDoc(doc(db,'sellers','2675X843'))` finds nothing, so the seller's phone,
 * email and every KYC document rendered as "—" while sitting in Firestore.
 *
 * Taking the id first and treating `crmId` as a **query**, never as a document
 * id, is the same order `app/kyc/page.tsx` settled on for the same reason.
 */
export async function getSeller(id: string, crmId?: string): Promise<Seller | null> {
  const byId = await getDoc(doc(db, 'sellers', id))
  if (byId.exists()) return { id: byId.id, ...byId.data() } as Seller

  const code = (crmId ?? '').trim()
  if (!code || code === id) return null

  const found = await getDocs(
    query(collection(db, 'sellers'), where('crmId', '==', code), limit(1)),
  )
  const hit = found.docs[0]
  return hit ? ({ id: hit.id, ...hit.data() } as Seller) : null
}

/**
 * A coin seller keeping their own contact details current, from /profile.
 *
 * No security rule was added for this. The `sellers` update clause already
 * carries an allow-list for exactly this case —
 *
 *   isCrmUser() && sellers/{id}.crmUid == request.auth.uid
 *     && affectedKeys().hasOnly(['displayName','phone','email','city',
 *                               'description','qrCodeUrl','idDocUrls',
 *                               'isOnline','lastSeen'])
 *
 * — and the four fields written below are a subset of it.
 *
 * `email` is NOT among them, although the rule would permit it. It is the
 * address `sellerNamesCaller()` matches a partner application against, so it is
 * an account fact rather than a preference; it stays where the other account
 * facts are, out of reach of this screen.
 *
 * Nothing here can touch `coinBalance` or `totalCoinsSold`. Those are
 * inventory, they are money, and no clause in the rules lets any browser write
 * them at all.
 *
 * ── THAT ALLOW-LIST HAS SINCE BEEN CUT IN HALF ───────────────────────────────
 *
 * `displayName`, `phone`, `email` and `idDocUrls` have come OUT of the rule
 * quoted above. They are the identity a reviewer signed off on — the shop name
 * on the seller's QR code, and the contact pair `activateHost` matches a
 * referral code against — and an approved seller could rewrite all four without
 * anyone looking again. What remains directly writable is
 * `['city','description','qrCodeUrl','isOnline','lastSeen']`.
 *
 * So two of the four fields below are now proposed rather than written:
 * `city` and `description` go straight on, `displayName` and `phone` land in
 * `pendingChanges` and do not move until a reviewer applies them on /kyc.
 *
 * **And unlike the agency clause, the seller one has no pending-record escape
 * hatch.** An agency still awaiting its first decision may edit these directly,
 * because there is nothing verified to protect yet; the `sellers` allow-list
 * carries no equivalent, so a seller proposes whatever their status. That is
 * what the rules say, and building the other behaviour would only produce a
 * permission-denied on a form the person thought they had saved.
 */
export async function updateOwnSellerProfile(
  id: string,
  details: { displayName: string; phone: string; city: string; description: string },
  actor: Proposer,
): Promise<SubmitResult> {
  return submitPartnerUpdate({
    collection: 'sellers',
    id,
    actor,
    patch: {
      displayName: details.displayName.trim(),
      phone:       details.phone.trim(),
      city:        details.city.trim(),
      description: details.description.trim(),
    },
  })
}

// REMOVED: `approveSeller` and `deactivateSeller`.
//
// Both wrote an incomplete status set straight from a browser, and neither had a
// single caller anywhere in the CRM.
//
//   approveSeller     wrote `isApproved` and `isActive`, and never `status` or
//                     `kycStatus`. A seller approved through it read as pending
//                     on /kyc, which consults `status` first, and as
//                     KYC-unverified everywhere — while `approvedAt` and
//                     `approvedBy` sat on the document saying it had been done.
//   deactivateSeller  wrote `isActive: false` alone, leaving `status: approved`
//                     behind it. Suspended and approved at the same time.
//
// A seller is approved, rejected, suspended and reinstated through
// `partnerOps.*` in lib/apiPartners.ts → `backend/app/services/partner_ops.py`,
// where `_fs_status_fields` writes every one of those fields together so they
// cannot disagree, and where the act is audited against a mandatory reason.
// These two were the shape of function that makes the next person wire a button
// to one and half-approve somebody without knowing it.

// ── Recharge Request Helpers ──────────────────────────────────────────────────

export async function getRechargeRequests(status?: string): Promise<RechargeRequest[]> {
  const q = status
    ? query(
        collection(db, 'rechargeRequests'),
        where('status', '==', status),
        orderBy('createdAt', 'desc')
      )
    : query(collection(db, 'rechargeRequests'), orderBy('createdAt', 'desc'))

  const snap = await getDocs(q)
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as RechargeRequest))
}

export async function getSellerRechargeRequests(sellerUid: string): Promise<RechargeRequest[]> {
  const snap = await getDocs(
    query(
      collection(db, 'rechargeRequests'),
      where('sellerUid', '==', sellerUid),
      orderBy('createdAt', 'desc')
    )
  )
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as RechargeRequest))
}

export async function approveRecharge(reqId: string, approvedByUid: string): Promise<void> {
  await updateDoc(doc(db, 'rechargeRequests', reqId), {
    status: 'approved',
    approvedBy: approvedByUid,
    approvedAt: serverTimestamp(),
    rejectedReason: '',
  })
}

export async function rejectRecharge(
  reqId: string,
  reason: string,
  approvedByUid: string
): Promise<void> {
  await updateDoc(doc(db, 'rechargeRequests', reqId), {
    status: 'rejected',
    rejectedReason: reason,
    approvedBy: approvedByUid,
    approvedAt: serverTimestamp(),
  })
}

// ── Update seller fields ───────────────────────────────────────────────────────
export async function updateSeller(
  id: string,
  updates: Partial<Pick<Seller, 'displayName' | 'phone' | 'email'>>
): Promise<void> {
  await updateDoc(doc(db, 'sellers', id), updates)
}

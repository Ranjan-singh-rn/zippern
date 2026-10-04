'use client'

/**
 * Proposed changes to a partner's payout and identity details.
 *
 * ── THE HOLE THIS CLOSES ─────────────────────────────────────────────────────
 *
 * An approved, active partner could open "Update your KYC and payment details"
 * on their own dashboard and replace their bank account. The write set
 * `kycStatus: 'submitted'` and put the new `accountNumber` STRAIGHT ONTO the
 * live record, leaving `status: 'approved'` and `isActive: true` exactly where
 * they were — and `/kyc` keys its queues off `status`, so the row went on
 * reading "approved" and nobody ever looked again. A payout is a human reading
 * an account number off that record and paying it. Approve once with clean
 * documents, then swap the destination: that was the whole attack, and it
 * needed no privilege at all.
 *
 * So a sensitive change is now **proposed, not applied**. The live field does
 * not move, which means money keeps going to the account somebody already
 * verified while the new one waits for a reviewer. The partner is not blocked
 * from trading or earning in the meantime, and that matters: replacing an
 * expired Aadhaar is the common, honest case, and punishing it would train
 * everybody to leave stale documents on file.
 *
 * ── THE SHAPE, AND WHY IT IS ONE OBJECT ──────────────────────────────────────
 *
 * `firestore.rules` lets a partner make exactly one kind of write to their own
 * record once it has been decided:
 *
 *   proposesChangeOnly() = affectedKeys().hasOnly(
 *                            ['pendingChanges', 'kycStatus', 'kycSubmittedAt'])
 *                       && kycStatus == 'submitted'
 *
 * `hasOnly` is why the whole proposal is ONE map under one key. Spreading it
 * over `pendingBank`, `pendingDocs` and `pendingIdentity` would put three keys
 * in the affected set, and the clause would refuse every one of them.
 *
 * The map carries the three things a reviewer and an auditor each need — what
 * is proposed, when, and by whom — plus one thing the *reject* path needs:
 *
 *   fields              the proposed values, keyed by the LIVE field name they
 *                       would replace. Keyed that way deliberately: the review
 *                       screen renders OLD → NEW as `live[key]` against
 *                       `fields[key]`, and the server applies the whole map with
 *                       one `update(fields)`. No translation table exists to
 *                       drift out of step with the form that writes it.
 *   submittedAt         when it was proposed, so a proposal that has sat for a
 *                       week is visible as one.
 *   submittedBy         who proposed it — uid, name and role. For a partner
 *                       this is themselves; on `hostApplications` it is the
 *                       staff member or agency proposing on a host's behalf,
 *                       and it is what the four-eyes check on the server
 *                       compares the approver against.
 *   note                free text from the proposer. Empty is normal.
 *   previousKycStatus   where `kycStatus` stood before the proposal moved it to
 *                       'submitted'. Rejecting restores this EXACTLY rather
 *                       than guessing: an approved partner whose replacement
 *                       document was refused still has verified documents on
 *                       file, and writing 'rejected' onto them would say the
 *                       opposite of what happened.
 *
 * ── WHAT THIS MODULE DOES NOT DO ─────────────────────────────────────────────
 *
 * It never applies a proposal. Applying one writes the live payout fields, no
 * clause in `firestore.rules` lets any browser do that, and that is deliberate:
 * the apply runs server-side in `partner_ops.apply_pending_changes` (agencies
 * and sellers) or `users.decide_host_pending_changes` (hosts), where it is
 * audited against a mandatory reason and a named person.
 *
 * Nor does it decide what a reviewer is allowed to accept. Firestore permits
 * ANY content under `pendingChanges` — a partner could park
 * `{ coinBalance: 999999 }` there — so the server keeps its own allow-list and
 * refuses to apply anything outside it. The list here exists to build the right
 * write and to label it on screen, not to constrain what is honoured.
 */

import { doc, getDoc, serverTimestamp, updateDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'

/** The three collections a partner record can live in. */
export type PartnerCollection = 'agencies' | 'sellers' | 'hostApplications'

/**
 * Where the money goes. Mirrors `payoutFields()` in `firestore.rules` — if the
 * two ever disagree, the rules win and a write built here is simply refused,
 * which is the safe direction for them to disagree in.
 */
export const PAYOUT_FIELDS = [
  'accountHolderName', 'accountNumber', 'bankAccount', 'ifscCode',
  'bankName', 'branch', 'upiId', 'binanceUid', 'paymentType', 'currency',
] as const

/**
 * Who they are. Mirrors `identityFields()` in `firestore.rules`: the documents,
 * the facts those documents corroborate, and the contact pair that
 * `activateHost` matches a referral code against — changing a phone or an email
 * changes who may redeem an invitation, so it is identity, not a preference.
 */
export const IDENTITY_FIELDS = [
  'kycDocUrls', 'idDocUrls', 'dob', 'country', 'address',
  'agencyName', 'displayName', 'hostName', 'ownerName',
  // `ownerPhone` is how an agency document spells its contact number, and
  // `address` sits beside it. Both were in `identityFields()` in the rules and
  // missing here, which is worse than either alone: this list decides what gets
  // PROPOSED, the rules decide what may be WRITTEN, and a field the rules call
  // sensitive that this list calls ordinary is written directly and refused.
  // `updateOwnAgencyProfile` patches exactly these two, so every agency saving
  // its own profile got permission-denied.
  //
  // The two lists have to agree. Anything added to `reapprovalFields()` in
  // firestore.rules belongs here in the same commit.
  'ownerPhone',
  'phone', 'applicantPhone', 'email', 'applicantEmail', 'ownerEmail',
] as const

export const REAPPROVAL_FIELDS: readonly string[] = [
  ...PAYOUT_FIELDS,
  ...IDENTITY_FIELDS,
]

/**
 * The two keys the rules let travel WITH a proposal. They are the envelope, not
 * the content: `kycStatus` moves so the partner's own dashboard can say "with a
 * reviewer", and it is deliberately not what any review queue keys off.
 */
const ENVELOPE_FIELDS = ['kycStatus', 'kycSubmittedAt'] as const

export function isSensitiveField(field: string): boolean {
  return REAPPROVAL_FIELDS.includes(field)
}

/** What each field is called on screen. An unlabelled field is shown raw. */
export const FIELD_LABELS: Record<string, string> = {
  accountHolderName: 'Account holder name',
  accountNumber: 'Account number',
  bankAccount: 'Bank account',
  ifscCode: 'IFSC code',
  bankName: 'Bank name',
  branch: 'Branch',
  upiId: 'UPI ID',
  binanceUid: 'Binance UID',
  paymentType: 'Payment type',
  currency: 'Currency',
  kycDocUrls: 'KYC documents',
  idDocUrls: 'Identity documents',
  dob: 'Date of birth',
  country: 'Country',
  agencyName: 'Agency name',
  displayName: 'Display name',
  hostName: 'Host name',
  ownerName: 'Owner name',
  phone: 'Phone',
  applicantPhone: 'Phone',
  email: 'Email',
  applicantEmail: 'Email',
  ownerEmail: 'Email',
}

export function labelOf(field: string): string {
  return FIELD_LABELS[field] ?? field
}

/** Who proposed a change. Flat and string-valued, like every other actor stamp. */
export interface Proposer {
  uid: string
  name: string
  role: string
}

export interface PendingChanges {
  fields: Record<string, unknown>
  /** Firestore `Timestamp`, or a string on a record written by an older client. */
  submittedAt: unknown
  submittedBy: Proposer
  note: string
  previousKycStatus: string
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

/**
 * Read a `pendingChanges` block defensively, or `null` when there is nothing
 * waiting.
 *
 * A block with an empty `fields` map is `null` too, and that is not pedantry: a
 * partner who proposes values identical to the live ones would otherwise create
 * a review item that changes nothing, and a reviewer cannot tell an empty
 * proposal from a read that went wrong.
 */
export function readPendingChanges(raw: unknown): PendingChanges | null {
  if (!raw || typeof raw !== 'object') return null
  const block = raw as Record<string, unknown>
  const fields =
    block.fields && typeof block.fields === 'object'
      ? (block.fields as Record<string, unknown>)
      : {}
  if (Object.keys(fields).length === 0) return null

  const by = (block.submittedBy ?? {}) as Record<string, unknown>
  return {
    fields,
    submittedAt: block.submittedAt ?? null,
    submittedBy: {
      uid: textOf(by.uid),
      name: textOf(by.name),
      role: textOf(by.role),
    },
    note: textOf(block.note),
    previousKycStatus: textOf(block.previousKycStatus),
  }
}

/** One field a proposal would move, with both sides of it. */
export interface FieldChange {
  field: string
  label: string
  from: unknown
  to: unknown
}

/**
 * Every field the proposal would move, paired with what is live today.
 *
 * Fields whose proposed value already matches the live one are dropped. They
 * are noise on a review screen, and a row reading "HDFC Bank → HDFC Bank" is
 * exactly the kind of thing that gets a whole list skim-read.
 */
export function changesOf(
  pending: PendingChanges,
  live: Record<string, unknown>,
): FieldChange[] {
  return Object.keys(pending.fields)
    .filter((field) => !sameValue(live[field], pending.fields[field]))
    .map((field) => ({
      field,
      label: labelOf(field),
      from: live[field],
      to: pending.fields[field],
    }))
}

/**
 * A value as a human reads it.
 *
 * Document lists are the awkward case: `kycDocUrls` is three URL strings and
 * `idDocUrls` is three `{label, url}` maps, and neither is worth printing in
 * full on a comparison row. They are counted here and rendered as thumbnails
 * elsewhere, where looking at them is the point.
 */
export function displayValue(value: unknown): string {
  if (value == null || value === '') return '—'
  if (Array.isArray(value)) {
    const n = value.filter((v) => (v && typeof v === 'object' ? (v as { url?: string }).url : v)).length
    return n === 1 ? '1 file' : `${n} files`
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** URLs out of either document shape, for showing what was proposed. */
export function docUrlsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((v) => (v && typeof v === 'object' ? textOf((v as { url?: unknown }).url) : textOf(v)))
    .filter(Boolean)
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  // Absent and empty-string are the same fact on these records: a field that
  // was never written and one cleared to '' both mean "we do not have it".
  if ((a == null || a === '') && (b == null || b === '')) return true
  if (Array.isArray(a) && Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b)
  return false
}

// ── Writing one ───────────────────────────────────────────────────────────────

export interface SubmitResult {
  /** Keys written straight onto the live record. */
  applied: string[]
  /** Keys parked in `pendingChanges`, waiting on a reviewer. */
  proposed: string[]
  /**
   * True when this record had never been decided, so nothing was parked and
   * every field went on live.
   */
  direct: boolean
}

/**
 * Whether this record may still be edited directly.
 *
 * **Agencies only, and only while `status` is literally 'pending'.** There is
 * no approved bank account to protect on a record nobody has ever looked at,
 * and forcing a proposal flow before the first review would add a step that
 * protects nothing — so `firestore.rules` exempts exactly that case in the
 * `agencies` update clause (`resource.data.get('status','') == 'pending'`).
 *
 * **The `sellers` clause carries no such exemption**, and this follows the
 * rules rather than the symmetry. A seller's self-edit allow-list is
 * `['city','description','qrCodeUrl','isOnline','lastSeen']` with no status
 * escape hatch, so a pending seller proposing their own phone number is the
 * only write Firestore will accept from them. Attempting the direct write to
 * be consistent would hand them a permission-denied instead of a saved form.
 *
 * `hostApplications` is never direct from here either: a host has no dashboard
 * of their own, so every proposal on that collection is somebody proposing on
 * their behalf, and the rules make that four-eyes — an admin may propose, only
 * a superadmin may write a sensitive field straight on.
 */
function directWriteAllowed(
  collection: PartnerCollection,
  current: Record<string, unknown>,
): boolean {
  return collection === 'agencies' && textOf(current.status).trim() === 'pending'
}

export interface SubmitArgs {
  collection: PartnerCollection
  id: string
  /**
   * The whole patch the form wants to write, keyed by the live field name.
   * `kycStatus` and `kycSubmittedAt` may be included and are treated as the
   * proposal envelope rather than as content.
   */
  patch: Record<string, unknown>
  /** Who is proposing. Their own record, for a partner editing themselves. */
  actor: Proposer
  /**
   * The record as it stands. Supplied by callers that already hold it; read
   * here otherwise, because both the status branch and the diff need it.
   */
  current?: Record<string, unknown>
  /** Free text from the proposer, shown to the reviewer. */
  note?: string
  /**
   * The caller knows the rules let THIS actor write these fields straight on.
   *
   * There is exactly one case, and it is `hostApplications`: the rules make a
   * host's details four-eyes — `isAdmin() && (touchesNoSensitiveField() ||
   * isSuperAdmin())` — so an admin proposes and a superadmin may write. The
   * distinction belongs to the caller because it is about who is signed in,
   * which this module does not and should not know.
   *
   * It is a claim, not a grant. If it is wrong the rules refuse the write, and
   * that is the correct outcome: this flag can make a form fail, never make it
   * succeed where it should not.
   */
  allowDirect?: boolean
}

/**
 * Write a partner's edit — directly if the record has never been decided,
 * otherwise as a proposal.
 *
 * **Two writes, not one, when the patch is mixed.** The rules accept either an
 * ordinary edit that touches no sensitive field, or a proposal whose affected
 * keys are exactly the three of the envelope. One write carrying both would
 * satisfy neither clause and be refused whole, taking the harmless half of the
 * edit down with it. So the ordinary keys go first, on their own — if the
 * proposal then fails, the partner has still had their address change saved
 * rather than losing everything to a refusal about their bank account.
 *
 * Unchanged fields are never proposed. A form seeded from the live record
 * submits every field it holds whether or not the person touched it, and
 * without the diff a partner who came back to fix a typo in their address would
 * put their untouched bank account into a re-approval queue.
 */
export async function submitPartnerUpdate(args: SubmitArgs): Promise<SubmitResult> {
  const { collection, id, patch, actor } = args
  const ref = doc(db, collection, id)

  let current = args.current
  if (!current) {
    const snap = await getDoc(ref)
    current = snap.exists() ? (snap.data() as Record<string, unknown>) : {}
  }

  const envelope = new Set<string>(ENVELOPE_FIELDS)
  const keys = Object.keys(patch)

  if (args.allowDirect || directWriteAllowed(collection, current)) {
    await updateDoc(ref, patch)
    return { applied: keys, proposed: [], direct: true }
  }

  const ordinary: Record<string, unknown> = {}
  const proposed: Record<string, unknown> = {}
  for (const key of keys) {
    if (envelope.has(key)) continue
    if (sameValue(current[key], patch[key])) continue
    if (isSensitiveField(key)) proposed[key] = patch[key]
    else ordinary[key] = patch[key]
  }

  // The harmless half first, and on its own. A seller's allow-list is narrower
  // than "not sensitive" — `['city','description','qrCodeUrl','isOnline',
  // 'lastSeen']` — so a caller putting anything else in here is choosing a
  // refusal; the rules, not this function, are what decide that.
  if (Object.keys(ordinary).length > 0) {
    await updateDoc(ref, ordinary)
  }

  if (Object.keys(proposed).length === 0) {
    return { applied: Object.keys(ordinary), proposed: [], direct: false }
  }

  // Where `kycStatus` stood BEFORE any of this. On a re-proposal it is already
  // 'submitted' from the first one, and reading it again would lose the real
  // answer for ever — so an open proposal's own record of it wins.
  const open = readPendingChanges(current.pendingChanges)
  const previousKycStatus =
    open?.previousKycStatus || textOf(current.kycStatus) || 'pending'

  const block: PendingChanges = {
    fields: proposed,
    submittedAt: serverTimestamp(),
    submittedBy: { uid: actor.uid, name: actor.name, role: actor.role },
    note: (args.note ?? '').trim(),
    previousKycStatus,
  }

  await updateDoc(ref, {
    pendingChanges: block,
    // Required by `proposesChangeOnly()` — the clause refuses a proposal that
    // does not also say the record is with a reviewer.
    kycStatus: 'submitted',
    kycSubmittedAt: serverTimestamp(),
  })

  return {
    applied: Object.keys(ordinary),
    proposed: Object.keys(proposed),
    direct: false,
  }
}

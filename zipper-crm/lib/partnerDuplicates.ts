'use client'

/**
 * "Has this email already applied?" — asked BEFORE anything is written.
 *
 * ── The bug this exists to stop ──────────────────────────────────────────────
 *
 * The same coin seller was registered three times against
 * `ruhanmittal2001@gmail.com`. Three `sellers` documents, one `crmUid` between
 * them. `app/sellers/register` wrote the document first and created the Firebase
 * Auth account second, so every retry after the first died on
 * `auth/email-already-in-use` — after the write — and returned, leaving a seller
 * record nobody can sign in as and which `backfill_partners` then faithfully
 * gave a Mongo partner row of its own.
 *
 * ── What counts as a duplicate ───────────────────────────────────────────────
 *
 * **The same email, already holding a partner record OF THE SAME KIND.**
 *
 *   * Kind matters. An agency at this address applying to also sell coins is
 *     NOT a duplicate — that is the second-capability feature, and it does not
 *     come through any of the four registration forms. It is filed from the
 *     partner's own dashboard by `lib/partnerRoles.ts::requestSecondRole`,
 *     which writes `source: 'second_role'` and is bridged into the queue by
 *     `components/SecondRoleApplications.tsx`. Nothing here is on that path, so
 *     nothing here can block it. Checking one collection rather than both is
 *     what keeps that true.
 *
 *   * Status does not matter — pending, approved, suspended and **rejected all
 *     count**. A rejected application is the case worth arguing about, so:
 *     the reason a partner was turned down lives on the record, and both list
 *     pages put it in front of the next reviewer precisely because "an
 *     applicant who is told nothing simply reapplies". Letting the same address
 *     file a second, clean-looking application is how that reason gets buried —
 *     the next reviewer sees a fresh row and has no idea this person was
 *     already refused. So a rejected application refuses too, quoting the
 *     reason back. Overturning it is a decision made on the existing record in
 *     the CRM, where it stays auditable, not a new record filed around it.
 *
 *   * A `second_role` record already sitting in the collection counts as well.
 *     That address holds a record of this kind; a second one is a duplicate
 *     whatever created the first.
 *
 * ── Who can actually run this query ──────────────────────────────────────────
 *
 * `sellers`  →  `allow read: if request.auth != null`
 * `agencies` →  every read clause requires `request.auth != null` as well
 *               (`isAdmin()`, `isAgencyCrmUser() && …`, `ownerUid ==
 *               request.auth.uid`, `ownerEmail == request.auth.token.email`),
 *               and the file ends in `match /{document=**} { allow read, write:
 *               if false }`.
 *
 * So an UNAUTHENTICATED caller can read neither collection, and a duplicate
 * check bolted onto the public forms before signup would be permission-denied
 * every single time — a check that never fires. The public pages therefore
 * create the Firebase Auth account FIRST (which is itself an authoritative,
 * server-side uniqueness test on the address, and writes nothing to Firestore
 * when it fails) and only then, now authenticated, run this query. The agency
 * query is `where('ownerEmail','==', <the caller's own verified address>)`,
 * which is exactly the shape the `ownerEmail == request.auth.token.email` read
 * clause is written for.
 *
 * A single equality filter and no `orderBy`, so neither query needs a composite
 * index.
 */

import { collection, getDocs, query, where } from 'firebase/firestore'
import { db } from './firebase'

export type DuplicateKind = 'seller' | 'agency'

export type ExistingStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'suspended'
  | 'unknown'

/** What the record can be signed into with. */
export type LoginState =
  /** A CRM login is attached (`crmUid`). The normal, healthy state. */
  | 'crm'
  /** An app account owns it (`ownerUid`) but no CRM login was ever created. */
  | 'app_only'
  /** Neither. Nobody can ever sign in as this record. */
  | 'none'

export interface ExistingPartner {
  /** Firestore document id, which is also the partner id on the API side. */
  id: string
  kind: DuplicateKind
  name: string
  email: string
  status: ExistingStatus
  isActive: boolean
  login: LoginState
  /** Why they were turned down, when they were. Shown back verbatim. */
  rejectionReason: string
  /** Filed as a second capability rather than walked in off the street. */
  isSecondRole: boolean
  /** The CRM detail page. Only linked where the reader may open it. */
  href: string
}

/**
 * Deliberately three-valued. "We looked and found nothing" and "we could not
 * look" are different answers, and reporting the second as the first is how a
 * check ends up silently never firing.
 */
export type DuplicateCheck =
  | { checked: true; matches: ExistingPartner[] }
  | { checked: false; reason: string }

const COLLECTION: Record<DuplicateKind, string> = {
  seller: 'sellers',
  agency: 'agencies',
}

/** Where each collection keeps the address the applicant signs in with. */
const EMAIL_FIELD: Record<DuplicateKind, string> = {
  seller: 'email',
  agency: 'ownerEmail',
}

export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

export function partnerNoun(kind: DuplicateKind): string {
  return kind === 'seller' ? 'coin seller' : 'agency'
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function bool(value: unknown): boolean {
  return value === true
}

function statusOf(kind: DuplicateKind, data: Record<string, unknown>): ExistingStatus {
  const raw = text(data.status).toLowerCase()
  if (
    raw === 'pending' ||
    raw === 'approved' ||
    raw === 'rejected' ||
    raw === 'suspended'
  ) {
    return raw
  }
  // Legacy documents predate `status`. Both collections still carry the flags
  // the status was derived from, and "no answer" must read as pending rather
  // than as approved.
  if (kind === 'seller') return bool(data.isApproved) ? 'approved' : 'pending'
  return bool(data.isActive) ? 'approved' : 'pending'
}

/**
 * What can sign in as this record.
 *
 * `.get`-style defaults everywhere: a legacy document carries neither field,
 * and an absent field must read as "not set" rather than throwing.
 */
export function loginStateOf(data: {
  crmUid?: unknown
  ownerUid?: unknown
}): LoginState {
  if (text(data.crmUid).trim() !== '') return 'crm'
  if (text(data.ownerUid).trim() !== '') return 'app_only'
  return 'none'
}

function toExisting(
  kind: DuplicateKind,
  id: string,
  data: Record<string, unknown>,
): ExistingPartner {
  return {
    id,
    kind,
    name:
      text(data.displayName) ||
      text(data.agencyName) ||
      text(data.ownerName) ||
      id,
    email: normaliseEmail(text(data[EMAIL_FIELD[kind]])),
    status: statusOf(kind, data),
    isActive: bool(data.isActive),
    login: loginStateOf(data),
    rejectionReason:
      text(data.rejectionReason) ||
      text(data.rejectedReason) ||
      text(data.rejection_reason),
    isSecondRole: text(data.source) === 'second_role',
    href: kind === 'seller' ? `/sellers/${id}` : `/agencies/${id}`,
  }
}

/**
 * Every partner record of `kind` already filed under this address.
 *
 * Never throws. A refusal, a missing index or a dropped connection comes back
 * as `{ checked: false }` with the reason, so the caller can say "not checked"
 * instead of "clean".
 */
export async function findPartnersByEmail(
  kind: DuplicateKind,
  email: string,
): Promise<DuplicateCheck> {
  const wanted = normaliseEmail(email)
  if (!wanted) return { checked: false, reason: 'No email address was given.' }

  try {
    const snap = await getDocs(
      query(
        collection(db, COLLECTION[kind]),
        where(EMAIL_FIELD[kind], '==', wanted),
      ),
    )
    return {
      checked: true,
      matches: snap.docs.map((d) =>
        toExisting(kind, d.id, d.data() as Record<string, unknown>),
      ),
    }
  } catch (err) {
    return {
      checked: false,
      reason:
        err instanceof Error
          ? err.message
          : 'The existing-applications check could not be run.',
    }
  }
}

/** "pending — waiting on a decision", and so on. One line, per record. */
export function statusPhrase(match: ExistingPartner): string {
  switch (match.status) {
    case 'pending':
      return 'pending — it is in the queue waiting on a decision'
    case 'approved':
      return match.isActive
        ? 'approved and active'
        : 'approved, but currently inactive'
    case 'rejected':
      return match.rejectionReason
        ? `rejected — "${match.rejectionReason}"`
        : 'rejected — no reason was recorded on it'
    case 'suspended':
      return 'suspended'
    default:
      return 'in an unrecorded state'
  }
}

/** What is wrong with the record itself, if anything. Empty when it is fine. */
export function loginPhrase(match: ExistingPartner): string {
  switch (match.login) {
    case 'crm':
      return ''
    case 'app_only':
      return 'It has no CRM login attached — nobody can sign into the CRM as it.'
    default:
      return 'It has no login attached at all — nobody can ever sign in as it.'
  }
}

/**
 * The headline a refusal leads with. Kept here so all four forms say the same
 * thing about the same situation.
 */
export function duplicateHeadline(
  kind: DuplicateKind,
  matches: readonly ExistingPartner[],
): string {
  const noun = partnerNoun(kind)
  if (matches.length === 1) {
    return `This email address already has a ${noun} record. Nothing was created.`
  }
  return (
    `This email address already has ${matches.length} ${noun} records. ` +
    'Nothing was created.'
  )
}

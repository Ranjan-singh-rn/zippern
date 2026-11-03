'use client'

/**
 * What is waiting on a reviewer — built once, read by every screen that asks.
 *
 * ── WHY THIS IS A MODULE AND NOT PART OF /kyc ────────────────────────────────
 *
 * /kyc built these queues inside its own component, and for a while that was
 * fine because /kyc was the only screen that cared. It is not any more: the
 * inbox — the screen whose entire job is to say what is waiting on you — could
 * only see money cards, so a coin seller whose documents had sat for a week was
 * invisible to the one page a person actually opens in the morning.
 *
 * The obvious fix is for the inbox to count the queues itself. That is the
 * wrong fix, and the reason is the whole history of this codebase: the moment
 * two screens decide independently what "pending" means, they drift, and the
 * drift shows up as one screen saying 0 and another saying 3 — which teaches
 * people to trust neither. The status vocabulary here is genuinely subtle
 * (`submitted` means pending, sellers record approval as `isApproved` and not
 * `status`, a host application can carry two status fields that disagree, and a
 * re-approval row is waiting regardless of any status at all). It gets ONE
 * definition, and both screens read it.
 *
 * So `loadReviewQueues()` is the same work /kyc used to do inline, moved
 * verbatim. /kyc renders the rows; the inbox counts them; neither knows
 * anything the other does not.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
 *
 * No React, no icons, no decisions. Deciding a row goes through the API from
 * the screen that shows it, because a decision needs a named person and a
 * reason and this module has neither.
 *
 * Nothing here ever turns a failed read into a zero. A queue that could not be
 * read reports itself as unreadable and the caller must render that — "nothing
 * is waiting on you" is the one sentence an inbox must never say by mistake.
 */

import {
  collection, getDocs, limit, query,
  type QuerySnapshot, type DocumentData,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { ApiError } from '@/lib/api'
import { failureReason } from '@/lib/readState'
import { partnerOps, type Partner, type PartnerStatus } from '@/lib/apiPartners'
import {
  changesOf, docUrlsOf, readPendingChanges,
  type FieldChange, type PendingChanges,
} from '@/lib/pendingChanges'
import { samePersonMatches, samePersonNote } from '@/lib/hostSamePerson'

// ── Fetch caps ────────────────────────────────────────────────────────────────
// Every one of these collections grows forever and is never archived, so each
// query is bounded and newest-first. When a cap is actually hit the caller is
// told — a reviewer who sees 200 of 500 with no indication will miss real work.
export const AGENCY_FETCH_LIMIT = 400
export const SELLER_FETCH_LIMIT = 400
export const HOST_APP_FETCH_LIMIT = 500
export const PARTNER_FETCH_LIMIT = 500

export type Category = 'main_agency' | 'sub_agency' | 'coin_seller' | 'host' | 'reapproval'

/** Tab order, and the only place the five are listed. */
export const CATEGORY_ORDER: Category[] = [
  'main_agency', 'sub_agency', 'coin_seller', 'host',
  // Last, and it holds every kind of partner rather than one. It is not a fifth
  // sort of applicant; it is the queue for a change to somebody already
  // approved, which is the case the other four are structurally blind to.
  'reapproval',
]

export const CATEGORY_LABELS: Record<Category, string> = {
  main_agency: 'Main agency',
  sub_agency: 'Sub-agency',
  coin_seller: 'Coin sellers',
  host: 'Hosts',
  reapproval: 'Changed details',
}

export interface DocRef {
  label: string
  url: string
}

/**
 * What can be decided about a row, and through what.
 *
 *   partner          — a business record exists. Approve / reject via the API.
 *   unregistered     — a Firestore applicant with NO business record. The only
 *                      thing available is creating it, which decides nothing.
 *   host             — a host application whose applicant has an app account.
 *   host_unlinked    — a host application nobody has redeemed yet, so there is
 *                      no account to grant host status to.
 *   reapproval       — an agency or seller carrying a proposed change to its
 *                      payout or identity details. Decided through
 *                      `partnerOps.decidePendingChanges`, which is a different
 *                      act from approving the partner: approving here applies
 *                      the proposed values, rejecting discards them and leaves
 *                      the live record alone.
 *   reapproval_host  — the same, on a host application. Its own linkage because
 *                      `hostApplications` has exactly one owner on the server
 *                      and it is not `partner_ops` — a host has no business
 *                      record for that module to resolve.
 */
export type Linkage =
  | 'partner'
  | 'unregistered'
  | 'host'
  | 'host_unlinked'
  | 'reapproval'
  | 'reapproval_host'

/** One row in a queue, whatever kind of applicant it is. */
export interface Item {
  /** Partner id, or the host application id. */
  id: string
  /** The app account, where there is one. Hosts need it to be granted. */
  uid: string
  name: string
  subtitle: string
  status: PartnerStatus
  rejectionReason: string
  /** ISO, or empty when nothing usable was stored. */
  submittedAt: string
  docs: DocRef[]
  agencyId: string
  linkage: Linkage
  /** Why this row cannot be decided the ordinary way. Shown verbatim. */
  linkageNote: string
  /** A contradiction in the record itself, shown rather than resolved. */
  conflict: string
  /**
   * FX-12: on a pending HOST application, the other applications of the same
   * person (same account, phone or email) — shown as a badge on /kyc. Absent
   * or '' everywhere else.
   */
  samePerson?: string
  href: string
  /**
   * Every field a proposed change would move, with both sides of it. Empty on
   * every row that is not a re-approval.
   */
  changes: FieldChange[]
  /** Who proposed it and when. Null on every row that is not a re-approval. */
  proposal: PendingChanges | null
  /**
   * What the documents on this row ARE, when that is not obvious. A re-approval
   * row shows the documents being *proposed* rather than the ones on file, and
   * a reviewer comparing the wrong set against the wrong name is the mistake
   * this line exists to prevent.
   */
  docsCaption: string
}

/** How one underlying source went. A failure is never counted as a zero. */
export type SourceState =
  | { ok: true; count: number; capped: boolean }
  | { ok: false; reason: string }

export interface Source {
  label: string
  state: SourceState
}

export interface Queue {
  items: Item[]
  sources: Source[]
}

export type Queues = Record<Category, Queue>

export const EMPTY_QUEUES: Queues = {
  main_agency: { items: [], sources: [] },
  sub_agency: { items: [], sources: [] },
  coin_seller: { items: [], sources: [] },
  host: { items: [], sources: [] },
  reapproval: { items: [], sources: [] },
}

// ── Small readers ─────────────────────────────────────────────────────────────

export function isoOf(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  const ts = value as { toMillis?: () => number; seconds?: number }
  try {
    if (typeof ts.toMillis === 'function') return new Date(ts.toMillis()).toISOString()
    if (typeof ts.seconds === 'number') return new Date(ts.seconds * 1000).toISOString()
  } catch {
    /* unusable timestamp */
  }
  return ''
}

export function textOf(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

/**
 * A status word from a Firestore document, in the vocabulary these queues use.
 *
 * `submitted` is what both the agency KYC form and the host invite modal write
 * and it means *waiting on us*, so it maps to `pending`. Anything unrecognised
 * also maps to `pending`, because the one thing that must never happen is a
 * record quietly leaving the queue on a word nobody has read.
 */
export function statusWord(raw: unknown): PartnerStatus | '' {
  const s = textOf(raw).trim().toLowerCase()
  if (!s) return ''
  if (s === 'approved' || s === 'active') return 'approved'
  if (s === 'rejected' || s === 'declined') return 'rejected'
  if (s === 'suspended' || s === 'deactivated') return 'suspended'
  // UGP-G (I-11): revoked is a terminal status of its own, not "waiting on us".
  if (s === 'revoked') return 'revoked'
  // Decision 15 (RC): decided (approved by the Owner) but NOT started — the
  // login still needs both verified contacts. Not "pending": nothing is left
  // for a reviewer to decide. Not "approved": the role grants nothing yet.
  if (s === 'awaiting_verification') return 'awaiting_verification'
  return 'pending'
}

/**
 * An agency or seller document that has no business record behind it.
 *
 * **The two kinds do not record approval the same way**, which is one reason
 * coin sellers never left this queue. `approve_agency` writes
 * `status: 'approved'`; every seller-side writer — `lib/sellers.ts` and the
 * `approve_seller` Cloud Function — writes `isApproved: true` and no `status`
 * at all. Reading only `status` therefore made every approved seller look
 * pending forever, including one that had `approvedAt` and `approvedBy` sitting
 * right beside it.
 *
 * `status` still wins where it exists, so nothing that already worked changes.
 * `isApproved` is consulted only when `status` is silent.
 */
export function firestoreStatusOf(raw: Record<string, unknown>): PartnerStatus {
  const stated = statusWord(raw.status)
  if (stated) return stated

  if (raw.isApproved === true) {
    // Approved, unless something else says it has since been switched off.
    return raw.isActive === false ? 'suspended' : 'approved'
  }
  // A recorded rejection with no `status` — the reason is the only evidence.
  if (textOf(raw.rejectionReason).trim()) return 'rejected'
  return 'pending'
}

/**
 * A host application's decision, read defensively because it was once written
 * carelessly.
 *
 * Nothing writes these two fields apart from each other any more — one server
 * call writes both, and the two screens that used to write one of them have
 * stopped. But every application decided before that is still in the collection
 * exactly as it was left, and some of them say `status: approved` beside
 * `kycStatus: pending` because a different screen wrote each.
 *
 * So a disagreement is the finding, not something to resolve: the row is held
 * as pending, the conflict is printed on it, and a human decides it on /kyc —
 * which writes both and ends the disagreement. Guessing which field is true
 * would silently confirm an approval nobody made, or discard one somebody did.
 */
export function hostDecisionOf(
  raw: Record<string, unknown>,
): { status: PartnerStatus; conflict: string } {
  const kyc = statusWord(raw.kycStatus)
  const plain = statusWord(raw.status)

  // Decision 15 (RC): `status: awaiting_verification` with `kycStatus:
  // approved` is ONE decision written by the server (documents approved, the
  // role waiting for verified contacts) — not two screens disagreeing.
  if (plain === 'awaiting_verification') return { status: 'awaiting_verification', conflict: '' }

  if (kyc && plain && kyc !== plain && kyc !== 'pending' && plain !== 'pending') {
    return {
      status: 'pending',
      conflict:
        `This application says kycStatus '${textOf(raw.kycStatus)}' and status ` +
        `'${textOf(raw.status)}'. Two different screens wrote those. It is held ` +
        'as pending until someone decides it here, which writes both.',
    }
  }
  if (kyc === 'rejected' || plain === 'rejected') return { status: 'rejected', conflict: '' }
  if (kyc === 'approved' || plain === 'approved') return { status: 'approved', conflict: '' }
  if (kyc === 'suspended' || plain === 'suspended') return { status: 'suspended', conflict: '' }
  return { status: 'pending', conflict: '' }
}

const AGENCY_DOC_LABELS = ['Aadhaar card', 'PAN card', 'Bank passbook']
/** The invite modal uploads three, and which three depends on where they bank. */
const HOST_DOC_LABELS_IN = ['Aadhaar card', 'PAN card', 'Bank passbook']
const HOST_DOC_LABELS_FOREIGN = ['Passport', 'National ID', 'Proof of address']

export const NO_PARTNER_RECORD_NOTE =
  'This application exists in Firestore but has no business record behind it, ' +
  'so there is nothing to approve yet. Registration is done by a Cloud Function ' +
  'trigger when the document is written; for this one it did not happen. ' +
  'Creating the record here makes no decision and grants nothing — it is created ' +
  'holding nothing and pending, and then reviewed like any other application.'

/**
 * Shown on an invitation nobody has redeemed. It is INFORMATION, not a refusal.
 *
 * Approving used to be blocked here, because granting host status needs a uid
 * and there is none before somebody redeems. That put the gate after the thing
 * it was gating: the referral code worked from the moment the agency created
 * the invitation, so an applicant became a host and started earning before
 * anyone had opened their Aadhaar card, and the review screen could only ratify
 * it afterwards.
 *
 * Approving now marks the APPLICATION, which needs no account, and the code
 * only starts working once that is done.
 */
export const HOST_UNLINKED_NOTE =
  'Nobody has redeemed this referral code yet — that is the normal state for a ' +
  'new invitation. Approving marks the application and switches the code on; ' +
  'host status is granted the moment the applicant signs in and enters it. ' +
  'Rejecting cancels the invitation, and the code stops working.'

// ── Document readers, one per applicant kind ─────────────────────────────────

/** `agencies.kycDocUrls` — a plain array of three URL strings. */
function agencyDocsOf(profile: Record<string, unknown>): DocRef[] {
  const urls = Array.isArray(profile.kycDocUrls) ? (profile.kycDocUrls as unknown[]) : []
  return urls
    .map((u, i) => ({ label: AGENCY_DOC_LABELS[i] ?? `Document ${i + 1}`, url: textOf(u) }))
    .filter((d) => d.url)
}

/**
 * `sellers.idDocUrls` — a different shape from the agency one: an array of
 * `{ label, url }` maps, because /sellers/register lets the uploader name each
 * file. A seller who came through the public /seller-signup form has none of
 * these at all and only a `registrationProofUrl`, which is appended so that row
 * is not documentless.
 */
function sellerDocsOf(profile: Record<string, unknown>): DocRef[] {
  const idDocs = Array.isArray(profile.idDocUrls) ? (profile.idDocUrls as unknown[]) : []
  const docs: DocRef[] = idDocs.map((d, i) => {
    const o = (d ?? {}) as Record<string, unknown>
    // Tolerate a plain string too — nothing writes that today, but a shape
    // change upstream must not silently blank the evidence on a KYC queue.
    if (typeof d === 'string') return { label: `Document ${i + 1}`, url: d }
    return { label: textOf(o.label) || `Document ${i + 1}`, url: textOf(o.url) }
  })
  const proof = textOf(profile.registrationProofUrl)
  // QA #35: the app and /seller-signup both ask for a "Government photo ID"
  // (Aadhaar, PAN, Voter ID, passport); the queue called it "Registration
  // proof", so a reviewer looked for a business document that was never asked for.
  if (proof) docs.push({ label: 'Government photo ID', url: proof })
  return docs.filter((d) => d.url)
}

/** `hostApplications.kycDocUrls` — three strings, labelled by payment country. */
function hostDocsOf(raw: Record<string, unknown>): DocRef[] {
  const urls = Array.isArray(raw.docUrls)
    ? (raw.docUrls as unknown[])
    : Array.isArray(raw.kycDocUrls)
      ? (raw.kycDocUrls as unknown[])
      : raw.docUrl
        ? [raw.docUrl]
        : []
  const labels = textOf(raw.paymentType) === 'foreign'
    ? HOST_DOC_LABELS_FOREIGN
    : HOST_DOC_LABELS_IN
  return urls
    .map((u, i) => ({ label: labels[i] ?? `Document ${i + 1}`, url: textOf(u) }))
    .filter((d) => d.url)
}

/**
 * Which agency queue a Firestore agency document belongs in.
 *
 * Mirrors `_derive_kind` on the server (backend/app/services/partner_ops.py:390)
 * exactly, including the second clause: a document carrying a `parentAgencyId`
 * but no `type: 'sub'` is still a sub-agency. Reading it as a main agency would
 * put it in the wrong queue here and pay it from the wrong slab table there.
 */
export function agencyCategoryOf(raw: Record<string, unknown>): Category {
  if (textOf(raw.type).trim().toLowerCase() === 'sub') return 'sub_agency'
  if (textOf(raw.parentAgencyId).trim()) return 'sub_agency'
  return 'main_agency'
}

// ══════════════════════════════════════════════════════════════════════════════

export interface QueuesResult {
  queues: Queues
  /**
   * Set only when NOTHING could be read — neither the business records nor the
   * applicant documents. Any lesser failure is reported per-source on the queue
   * it affects, because a reviewer can still work the queues that did load.
   */
  error: string
}

/**
 * Read every review queue.
 *
 * Six reads, none of which is allowed to take the others down, and each of
 * which is kept as an outcome rather than collapsed to `[]`.
 */
export async function loadReviewQueues(): Promise<QueuesResult> {
  /** A partner list read, kept as an outcome rather than collapsed to `[]`. */
  async function partners(kind: 'agency' | 'sub_agency' | 'seller'):
    Promise<{ ok: true; rows: Partner[] } | { ok: false; reason: string }> {
    try {
      return { ok: true, rows: await partnerOps.list({ kind, limit: PARTNER_FETCH_LIMIT }) }
    } catch (e) {
      // Verbatim. The API refuses with a sentence written to be shown.
      return {
        ok: false,
        reason: e instanceof ApiError ? e.message : 'The partner list could not be fetched.',
      }
    }
  }

  /**
   * A Firestore collection read, likewise.
   *
   * **No `orderBy` here, deliberately.** `orderBy('createdAt')` is an implicit
   * existence filter: Firestore does not return documents that lack the field
   * at all. It is not an error and nothing is logged, so the queue simply
   * reported itself empty — truthfully, over a set that had silently excluded
   * most of its members.
   *
   * That is what hid the coin sellers. A seller registered through the staff
   * approval queue never gets a `createdAt`, and those sellers were invisible
   * in every queue, every filter and every search while sitting in Firestore
   * the whole time.
   *
   * The rows are sorted by the screen anyway, off `submittedAt`, which is
   * derived from several possible fields. So the ordering was never needed from
   * the query, only the documents were.
   */
  async function firestore(name: string, cap: number):
    Promise<{ ok: true; snap: QuerySnapshot<DocumentData> } | { ok: false; reason: string }> {
    try {
      return { ok: true, snap: await getDocs(query(collection(db, name), limit(cap))) }
    } catch (e) {
      return { ok: false, reason: failureReason(e) }
    }
  }

  const [agencyRes, subRes, sellerRes, agencyDocsRes, sellerDocsRes, hostDocsRes] =
    await Promise.all([
      partners('agency'),
      partners('sub_agency'),
      partners('seller'),
      firestore('agencies', AGENCY_FETCH_LIMIT),
      firestore('sellers', SELLER_FETCH_LIMIT),
      firestore('hostApplications', HOST_APP_FETCH_LIMIT),
    ])

  if (
    !agencyRes.ok && !subRes.ok && !sellerRes.ok &&
    !agencyDocsRes.ok && !sellerDocsRes.ok && !hostDocsRes.ok
  ) {
    return {
      queues: EMPTY_QUEUES,
      error:
        'Nothing could be loaded — neither the partner records nor the applicant ' +
        `documents. ${agencyRes.reason}`,
    }
  }

  const agencyProfiles = new Map<string, Record<string, unknown>>()
  if (agencyDocsRes.ok) {
    agencyDocsRes.snap.docs.forEach((d) => agencyProfiles.set(d.id, d.data()))
  }
  const sellerProfiles = new Map<string, Record<string, unknown>>()
  if (sellerDocsRes.ok) {
    sellerDocsRes.snap.docs.forEach((d) => sellerProfiles.set(d.id, d.data()))
  }

  /**
   * The join between the two systems is the Firestore document id, which the
   * API returns as `id` (`_id` in Mongo). `crm_id` is a DIFFERENT thing — the
   * `crmId` field inside the applicant's document — so it is tried second and
   * never instead. Getting this the wrong way round blanks the documents.
   */
  function profileOf(
    map: Map<string, Record<string, unknown>>,
    p: Partner,
  ): Record<string, unknown> {
    return map.get(p.id) ?? (p.crm_id ? map.get(p.crm_id) : undefined) ?? {}
  }

  function agencyItem(p: Partner): Item {
    const profile = profileOf(agencyProfiles, p)
    return {
      id: p.id,
      uid: textOf(profile.ownerUid),
      name: p.name || textOf(profile.agencyName) || p.id,
      subtitle: [textOf(profile.ownerName), textOf(profile.ownerPhone) || p.phone || '']
        .filter(Boolean)
        .join(' · '),
      status: p.status,
      rejectionReason: p.rejection_reason ?? '',
      submittedAt: isoOf(profile.kycSubmittedAt) || isoOf(profile.createdAt) || p.created_at || '',
      docs: agencyDocsOf(profile),
      agencyId: p.id,
      linkage: 'partner',
      linkageNote: '',
      conflict: '',
      href: `/agencies/${p.id}`,
      changes: [],
      proposal: null,
      docsCaption: '',
    }
  }

  function sellerItem(p: Partner): Item {
    const profile = profileOf(sellerProfiles, p)
    return {
      id: p.id,
      uid: textOf(profile.ownerUid),
      name: p.name || textOf(profile.displayName) || p.id,
      subtitle: [textOf(profile.phone) || p.phone || '', textOf(profile.email) || p.email || '']
        .filter(Boolean)
        .join(' · '),
      status: p.status,
      rejectionReason: p.rejection_reason ?? '',
      submittedAt: isoOf(profile.createdAt) || p.created_at || '',
      docs: sellerDocsOf(profile),
      agencyId: '',
      linkage: 'partner',
      linkageNote: '',
      conflict: '',
      href: `/sellers/${p.id}`,
      changes: [],
      proposal: null,
      docsCaption: '',
    }
  }

  // ── The applicants with no business record ────────────────────────────────
  //
  // Built only when BOTH sides of the comparison were read. With a refused
  // partner list every Firestore document would look unregistered, which is a
  // fabricated queue rather than a discovered one.

  const registeredAgencyIds = new Set<string>([
    ...(agencyRes.ok ? agencyRes.rows.map((p) => p.id) : []),
    ...(subRes.ok ? subRes.rows.map((p) => p.id) : []),
  ])
  const registeredSellerIds = new Set(sellerRes.ok ? sellerRes.rows.map((p) => p.id) : [])

  const strandedAgencies: Record<'main_agency' | 'sub_agency', Item[]> = {
    main_agency: [], sub_agency: [],
  }
  if (agencyDocsRes.ok && agencyRes.ok && subRes.ok) {
    agencyDocsRes.snap.docs.forEach((d) => {
      if (registeredAgencyIds.has(d.id)) return
      const raw = d.data() as Record<string, unknown>
      // A second-capability application is bridged into the queue by staff from
      // the record its owner already holds, not from here.
      if (textOf(raw.source) === 'second_role') return
      strandedAgencies[agencyCategoryOf(raw) === 'sub_agency' ? 'sub_agency' : 'main_agency'].push({
        id: d.id,
        uid: textOf(raw.ownerUid),
        name: textOf(raw.agencyName) || d.id,
        subtitle: [textOf(raw.ownerName), textOf(raw.ownerPhone) || textOf(raw.ownerEmail)]
          .filter(Boolean)
          .join(' · '),
        status: firestoreStatusOf(raw),
        rejectionReason: textOf(raw.rejectionReason),
        submittedAt: isoOf(raw.kycSubmittedAt) || isoOf(raw.createdAt),
        docs: agencyDocsOf(raw),
        agencyId: d.id,
        linkage: 'unregistered',
        linkageNote: NO_PARTNER_RECORD_NOTE,
        conflict: '',
        href: `/agencies/${d.id}`,
        changes: [],
        proposal: null,
        docsCaption: '',
      })
    })
  }

  const strandedSellers: Item[] = []
  if (sellerDocsRes.ok && sellerRes.ok) {
    sellerDocsRes.snap.docs.forEach((d) => {
      if (registeredSellerIds.has(d.id)) return
      const raw = d.data() as Record<string, unknown>
      if (textOf(raw.source) === 'second_role') return
      strandedSellers.push({
        id: d.id,
        uid: textOf(raw.ownerUid),
        name: textOf(raw.displayName) || d.id,
        subtitle: [textOf(raw.phone), textOf(raw.email)].filter(Boolean).join(' · '),
        status: firestoreStatusOf(raw),
        rejectionReason: textOf(raw.rejectionReason),
        submittedAt: isoOf(raw.createdAt),
        docs: sellerDocsOf(raw),
        agencyId: '',
        linkage: 'unregistered',
        linkageNote: NO_PARTNER_RECORD_NOTE,
        conflict: '',
        href: `/sellers/${d.id}`,
        changes: [],
        proposal: null,
        docsCaption: '',
      })
    })
  }

  // ── Hosts ─────────────────────────────────────────────────────────────────
  //
  // Nothing is dropped here. An application with no documents used to be
  // skipped silently, which is the same failure this whole screen is about: a
  // record that exists, is not shown, and is not reported as not shown.

  const hostItems: Item[] = []
  if (hostDocsRes.ok) {
    // FX-12: who is the same person as whom, across every host application.
    const matches = samePersonMatches(
      hostDocsRes.snap.docs.map((d) => {
        const raw = d.data() as Record<string, unknown>
        return {
          id: d.id,
          uid: [raw.activatedByUid, raw.applicantUid].map(textOf).find((v) => v !== '') ?? '',
          phone: raw.applicantPhone ?? raw.phone ?? raw.phoneNumber,
          email: raw.applicantEmail ?? raw.email,
          status: hostDecisionOf(raw).status,
          isActivated: raw.isActivated === true,
          name: textOf(raw.hostName ?? raw.name ?? raw.displayName),
        }
      }),
    )
    hostDocsRes.snap.docs.forEach((d) => {
      const raw = d.data() as Record<string, unknown>
      // `activatedByUid` is the field the Android app writes when the applicant
      // redeems their referral code. `crmUid` is NOT an app account and must
      // never be used to grant host status.
      //
      // UGP (2.4): a SELF-application — filed from the app by the signed-in
      // person — carries `applicantUid` from the start. It is not an
      // unredeemed invitation, and the server decides it on that uid
      // (`decide_host_application` reads `activatedByUid or applicantUid`).
      const uid = [raw.activatedByUid, raw.applicantUid, raw.uid, raw.userId]
        .map(textOf).find((v) => v !== '') ?? ''
      const decision = hostDecisionOf(raw)
      hostItems.push({
        id: d.id,
        uid,
        name: textOf(raw.hostName ?? raw.name ?? raw.displayName) || 'Unnamed host',
        subtitle: [
          textOf(raw.applicantPhone ?? raw.phone ?? raw.phoneNumber),
          textOf(raw.applicantEmail ?? raw.email),
          textOf(raw.agencyName),
        ]
          .filter(Boolean)
          .join(' · '),
        status: decision.status,
        rejectionReason: textOf(raw.rejectionReason ?? raw.rejectedReason),
        submittedAt: isoOf(raw.submittedAt) || isoOf(raw.createdAt),
        docs: hostDocsOf(raw),
        agencyId: textOf(raw.agencyId),
        linkage: uid ? 'host' : 'host_unlinked',
        linkageNote: uid ? '' : HOST_UNLINKED_NOTE,
        conflict: decision.conflict,
        samePerson: samePersonNote(matches.get(d.id)),
        href: uid ? `/users/${uid}` : '',
        changes: [],
        proposal: null,
        docsCaption: '',
      })
    })
  }

  // ── Re-approval ───────────────────────────────────────────────────────────
  //
  // Built from the presence of a `pendingChanges` block and from NOTHING
  // else — no status is consulted anywhere below, and that is the entire point.
  // The four queues above all key off a status, which is precisely how an
  // approved partner changing their bank account stayed invisible: the row went
  // on reading approved and appeared in no queue at all.
  //
  // All three collections feed one list, because the reviewer's question is the
  // same in every case — did this partner mean to change this, and is the new
  // value theirs — and splitting it three ways would bury the one that matters
  // behind two empty tabs.

  const reapprovalItems: Item[] = []

  function reapprovalItem(
    id: string,
    raw: Record<string, unknown>,
    pending: PendingChanges,
    changes: FieldChange[],
    opts: { name: string; subtitle: string; href: string; linkage: Linkage; agencyId: string },
  ): Item {
    // The documents shown are the ones being PROPOSED, where the proposal
    // replaces them. Rendering the ones already on file would put a reviewer in
    // front of the evidence they are not being asked about.
    const proposedDocs: DocRef[] = Array.isArray(pending.fields.idDocUrls)
      ? (pending.fields.idDocUrls as unknown[]).map((d, i) => {
          const o = (d ?? {}) as Record<string, unknown>
          return typeof d === 'string'
            ? { label: `Proposed document ${i + 1}`, url: d }
            : { label: textOf(o.label) || `Proposed document ${i + 1}`, url: textOf(o.url) }
        }).filter((d) => d.url)
      : docUrlsOf(pending.fields.kycDocUrls).map((url, i) => ({
          label: AGENCY_DOC_LABELS[i] ?? `Document ${i + 1}`,
          url,
        }))
    return {
      id,
      uid: textOf(raw.ownerUid ?? raw.activatedByUid),
      name: opts.name || id,
      subtitle: opts.subtitle,
      // The LIVE status, unfiltered and unchanged. This row is here because of
      // the proposal, not because of the status — but the status is what tells
      // a reviewer whether they are looking at a partner who is currently being
      // paid, which changes what the decision means.
      status: firestoreStatusOf(raw),
      rejectionReason: textOf(raw.rejectionReason),
      submittedAt: isoOf(pending.submittedAt) || isoOf(raw.kycSubmittedAt),
      docs: proposedDocs,
      agencyId: opts.agencyId,
      linkage: opts.linkage,
      linkageNote: '',
      conflict: '',
      href: opts.href,
      changes,
      proposal: pending,
      docsCaption: proposedDocs.length > 0
        ? 'The documents being PROPOSED. The ones already on file are unchanged ' +
          'and stay in force unless this is approved.'
        : '',
    }
  }

  function collectReapprovals(
    snap: QuerySnapshot<DocumentData>,
    build: (id: string, raw: Record<string, unknown>) => {
      name: string; subtitle: string; href: string; linkage: Linkage; agencyId: string
    },
  ) {
    snap.docs.forEach((d) => {
      const raw = d.data() as Record<string, unknown>
      const pending = readPendingChanges(raw.pendingChanges)
      if (!pending) return
      const changes = changesOf(pending, raw)
      // A proposal whose every field already matches the live record changes
      // nothing. It is not a decision anybody needs to make, and a row offering
      // to apply nothing is worse than no row.
      if (changes.length === 0) return
      reapprovalItems.push(reapprovalItem(d.id, raw, pending, changes, build(d.id, raw)))
    })
  }

  if (agencyDocsRes.ok) {
    collectReapprovals(agencyDocsRes.snap, (id, raw) => ({
      name: textOf(raw.agencyName),
      subtitle: [
        agencyCategoryOf(raw) === 'sub_agency' ? 'Sub-agency' : 'Main agency',
        textOf(raw.ownerName),
        textOf(raw.ownerPhone) || textOf(raw.ownerEmail),
      ].filter(Boolean).join(' · '),
      href: `/agencies/${id}`,
      linkage: 'reapproval',
      agencyId: id,
    }))
  }
  if (sellerDocsRes.ok) {
    collectReapprovals(sellerDocsRes.snap, (id, raw) => ({
      name: textOf(raw.displayName),
      subtitle: ['Coin seller', textOf(raw.phone), textOf(raw.email)]
        .filter(Boolean).join(' · '),
      href: `/sellers/${id}`,
      linkage: 'reapproval',
      agencyId: '',
    }))
  }
  if (hostDocsRes.ok) {
    collectReapprovals(hostDocsRes.snap, (id, raw) => {
      const uid = textOf(raw.activatedByUid)
      return {
        name: textOf(raw.hostName ?? raw.name ?? raw.displayName),
        subtitle: [
          'Host',
          textOf(raw.applicantPhone ?? raw.phone),
          textOf(raw.agencyName),
        ].filter(Boolean).join(' · '),
        href: uid ? `/users/${uid}` : '',
        linkage: 'reapproval_host',
        agencyId: textOf(raw.agencyId),
      }
    })
  }

  function partnerSource(
    label: string,
    res: { ok: true; rows: Partner[] } | { ok: false; reason: string },
  ): Source {
    return {
      label,
      state: res.ok
        ? { ok: true, count: res.rows.length, capped: res.rows.length >= PARTNER_FETCH_LIMIT }
        : { ok: false, reason: res.reason },
    }
  }

  function firestoreSource(
    label: string,
    res: { ok: true; snap: QuerySnapshot<DocumentData> } | { ok: false; reason: string },
    cap: number,
  ): Source {
    return {
      label,
      state: res.ok
        ? { ok: true, count: res.snap.size, capped: res.snap.size >= cap }
        : { ok: false, reason: res.reason },
    }
  }

  const agencyDocSource = firestoreSource(
    'the agencies collection', agencyDocsRes, AGENCY_FETCH_LIMIT,
  )
  const sellerDocSource = firestoreSource(
    'the sellers collection', sellerDocsRes, SELLER_FETCH_LIMIT,
  )
  const hostDocSource = firestoreSource(
    'the hostApplications collection', hostDocsRes, HOST_APP_FETCH_LIMIT,
  )

  return {
    error: '',
    queues: {
      main_agency: {
        items: [
          ...(agencyRes.ok ? agencyRes.rows.map(agencyItem) : []),
          ...strandedAgencies.main_agency,
        ],
        sources: [partnerSource('main agency business records', agencyRes), agencyDocSource],
      },
      sub_agency: {
        // A sub-agency is reviewed against the same documents as a main agency.
        items: [
          ...(subRes.ok ? subRes.rows.map(agencyItem) : []),
          ...strandedAgencies.sub_agency,
        ],
        sources: [partnerSource('sub-agency business records', subRes), agencyDocSource],
      },
      coin_seller: {
        items: [
          ...(sellerRes.ok ? sellerRes.rows.map(sellerItem) : []),
          ...strandedSellers,
        ],
        sources: [partnerSource('coin seller business records', sellerRes), sellerDocSource],
      },
      host: {
        items: hostItems,
        sources: [hostDocSource],
      },
      reapproval: {
        items: reapprovalItems,
        // All three, because all three feed this one list — and a queue that
        // silently omits the collection it could not read would report "nobody
        // has changed their bank account" on the strength of two reads out of
        // three. That claim is the whole thing this queue exists to be able to
        // make honestly.
        sources: [agencyDocSource, sellerDocSource, hostDocSource],
      },
    },
  }
}

// ── Selecting rows across the queues ─────────────────────────────────────────
//
// ── WHY THIS IS HERE AND NOT ON THE SCREEN THAT NEEDED IT ────────────────────
//
// The approval queue could only ever show what was WAITING. Its Approved,
// Rejected and All tabs were wired to `approvalRequests` — the staff permission
// request collection — and nothing else, so an applicant whose KYC had been
// approved appeared on no tab of the screen where this business records its
// decisions. With the Host filter on and the Approved tab open it said "No
// approved requests in host" about a host whose own profile said "application
// approved", which is a false statement produced by a queue with no source.
//
// The decided rows were never missing from the data. `loadReviewQueues` reads
// every applicant at every status — `partnerOps.list` passes no status filter and
// the Firestore reads pass no `where` — and then /kyc and /approvals each threw
// away everything that was not pending. So this is a selection, not a new read.
//
// It lives here for the reason everything else in this module does: two screens
// deciding independently what "approved" means is how they came to disagree
// about "pending".

export interface ReviewRow {
  item: Item
  category: Category
}

/**
 * The coarse kind of applicant, in the vocabulary /approvals filters by.
 *
 * A re-approval row has no kind of its own — the queue deliberately mixes all
 * three — so it is recovered from how the row was built: `reapproval_host` is a
 * host application, and the rest are told apart by the link
 * `collectReapprovals` gave them. Reading the kind off `agencyId` instead would
 * be wrong: a seller's re-approval row has none, and so does an agency row built
 * from a document with no id in it.
 */
export function reviewTypeOf(row: ReviewRow): 'agency' | 'seller' | 'host' {
  if (row.item.linkage === 'reapproval_host') return 'host'
  if (row.category === 'reapproval') {
    return row.item.href.startsWith('/sellers/') ? 'seller' : 'agency'
  }
  if (row.category === 'host') return 'host'
  if (row.category === 'coin_seller') return 'seller'
  return 'agency'
}

/** Which rows a screen is asking for. */
export type ReviewStatusView = 'pending' | 'approved' | 'rejected' | 'all'

/**
 * Every row matching one view, across all five queues, oldest first.
 *
 * ── THE RE-APPROVAL QUEUE IS NOT FILTERED BY STATUS, AND MUST NOT BE ─────────
 *
 * Its rows exist because a proposal is open, and `item.status` on them is the
 * partner's LIVE status — whether they are currently being paid — not a verdict
 * on the proposal. Nearly all of them read `approved`, because an already
 * approved partner changing their bank account is the exact case the queue was
 * built for.
 *
 * So filtering them by status would file every open bank-account change under
 * "Approved", which is precisely backwards: it would show a decision nobody has
 * made as made. They belong to `pending` and `all` — both true, because they are
 * waiting — and to neither of the decided views. The moment somebody decides one
 * the `pendingChanges` block is cleared on the server and the row stops existing
 * at all, so there is no decided re-approval row to show anywhere.
 */
export function reviewRowsOf(
  queues: Queues,
  view: ReviewStatusView,
  type?: 'all' | 'agency' | 'seller' | 'host',
): ReviewRow[] {
  const rows: ReviewRow[] = []
  CATEGORY_ORDER.forEach((key) => {
    queues[key].items.forEach((item) => {
      const row: ReviewRow = { item, category: key }
      if (key === 'reapproval') {
        if (view === 'approved' || view === 'rejected') return
      } else if (view !== 'all' && item.status !== view) {
        return
      }
      if (type && type !== 'all' && reviewTypeOf(row) !== type) return
      rows.push(row)
    })
  })
  return rows.sort(
    (a, b) =>
      (new Date(a.item.submittedAt).getTime() || 0) -
      (new Date(b.item.submittedAt).getTime() || 0),
  )
}

/**
 * How many rows each type contributes to one view.
 *
 * For a screen whose type filter shows a count beside each option. A pill
 * reading 0 next to a list of two rows is the same disagreement this module
 * exists to prevent, one widget smaller.
 */
export function reviewTypeTally(
  queues: Queues,
  view: ReviewStatusView,
): { all: number; agency: number; seller: number; host: number } {
  const rows = reviewRowsOf(queues, view)
  const tally = { all: rows.length, agency: 0, seller: 0, host: 0 }
  rows.forEach((row) => { tally[reviewTypeOf(row)] += 1 })
  return tally
}

// ── Counting ──────────────────────────────────────────────────────────────────

/**
 * How many rows in one queue are waiting on a decision.
 *
 * `null` when the queue could not be read — to be rendered as a refusal, never
 * as "0 awaiting review". A zero here is a claim that nobody is waiting, and
 * these queues decide who gets to trade.
 */
export function pendingCountOf(queues: Queues, key: Category): number | null {
  const q = queues[key]
  if (q.sources.some((s) => !s.state.ok)) return null
  // Every row in the re-approval queue is waiting on a decision by
  // construction — it is there because a proposal is open, not because of a
  // status — so counting `status === 'pending'` would report nearly all of them
  // as zero. Which is the original bug, in a tile.
  if (key === 'reapproval') return q.items.length
  return q.items.filter((i) => i.status === 'pending').length
}

export interface ReviewTally {
  /** Per queue, in tab order. `count: null` means that queue was unreadable. */
  queues: { key: Category; label: string; count: number | null }[]
  /**
   * Everything waiting, across the readable queues. `null` when NONE of them
   * could be read; otherwise a number that is honest about what it covers —
   * see `unreadable`.
   */
  total: number | null
  /** Queues that could not be read. A non-empty list makes `total` a floor. */
  unreadable: { key: Category; label: string; reason: string }[]
}

/**
 * One tally of every review queue, for a screen that summarises rather than
 * shows them.
 *
 * The total is deliberately a *floor* when something failed, and says so
 * through `unreadable` rather than by quietly excluding the queue. "3 waiting"
 * beside "hosts could not be read" is a true and useful sentence; "3 waiting"
 * alone, when the host queue was refused, is not.
 */
export function tallyReviewQueues(queues: Queues): ReviewTally {
  const per = CATEGORY_ORDER.map((key) => ({
    key,
    label: CATEGORY_LABELS[key],
    count: pendingCountOf(queues, key),
  }))

  const unreadable = per
    .filter((q) => q.count === null)
    .map((q) => {
      const failed = queues[q.key].sources.find((s) => !s.state.ok)
      return {
        key: q.key,
        label: q.label,
        // The source's own sentence, verbatim — it distinguishes a refused read
        // from a missing index from an unreachable database, and those need
        // three different responses from whoever is looking.
        reason: failed && !failed.state.ok
          ? failed.state.reason
          : 'This queue could not be read.',
      }
    })

  const readable = per.filter((q) => q.count !== null)
  return {
    queues: per,
    total: readable.length === 0 ? null : readable.reduce((n, q) => n + (q.count ?? 0), 0),
    unreadable,
  }
}

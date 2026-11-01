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
  documentId,
  Timestamp,
} from 'firebase/firestore'
import {
  submitPartnerUpdate,
  type Proposer,
  type SubmitResult,
} from '@/lib/pendingChanges'
import { fromSettled, type ReadFailure } from '@/lib/readState'
import { mergeAgencyRoster, type RosterMember } from '@/lib/agencyRoster'

export interface Agency {
  id: string
  crmId?: string           // 8-char human-readable ID, e.g. "A1B2C3D4"
  crmUid?: string
  type: 'main' | 'sub'
  parentAgencyId: string | null
  ownerUid: string
  ownerName: string
  ownerPhone: string
  ownerEmail: string
  agencyName: string
  address?: string
  referralCode: string
  status: 'pending' | 'approved' | 'rejected'
  isActive?: boolean
  approvedBy?: string
  approvedAt?: Timestamp
  rejectedReason?: string
  kycStatus: 'pending' | 'submitted' | 'approved' | 'rejected'
  kycDocUrls: string[]
  /**
   * A proposed change to payout or identity details, waiting on a reviewer.
   * Read it with `readPendingChanges` — a browser writes it and nothing about
   * its shape is guaranteed by the security rules, so it is deliberately not
   * typed as trustworthy here.
   */
  pendingChanges?: unknown
  paymentType?: 'india' | 'foreign'
  country?: string
  binanceUid?: string
  bankName?: string
  accountNumber?: string
  ifscCode?: string
  accountHolderName?: string
  branch?: string
  upiId?: string
  currency?: 'INR' | 'USD'
  coinSellerUid?: string
  // ── Dual-role (Agency + Coin Seller) ────────────────────────────────────────
  isSeller?: boolean          // true when this agency entity is also a coin seller
  linkedSellerId?: string     // Firestore doc ID in the `sellers` collection
  commissionRate?: number      // percentage (default 5). Later: min/max range
  // Both of these are READ-ONLY here. They are written by the API when an
  // accrual or a payout executes, never by this client — see the two DELETED
  // blocks below. The authoritative figure is `commission_outstanding` from
  // GET /api/partners/agencies/{id}/statement; this field is the Firestore
  // mirror the list views read so a 200-row table needs no round trip per row.
  commissionBalance?: number   // cumulative INR/USD amount owed to agency (not yet paid)
  commissionPaidINR?: number   // total amount paid to agency as commission (lifetime, INR for India / USD for foreign)
  totalHosts: number
  totalSubAgencies: number
  createdAt: Timestamp
}

export interface AgencySalaryRequest {
  id: string
  agencyId: string
  hostUid: string
  hostName: string
  periodStart: string
  periodEnd: string
  beansEarned: number
  amountInr: number
  notes?: string
  // `rejected` was missing, which is why the refusal path wrote `distributed`
  // — the same value a completed payment ends at, making a refusal and a
  // success indistinguishable on every screen.
  status: 'pending' | 'approved' | 'paid' | 'distributed' | 'rejected'
  createdAt?: Timestamp
  approvedAt?: Timestamp
  paidAt?: Timestamp
}

// Cap on the agency list. Every agency write path in the CRM
// (app/agency-signup, app/agencies/register, app/agency-dashboard sub-agency
// creation) stamps createdAt: serverTimestamp(), and the Android app only reads
// agencies — so the pre-existing orderBy('createdAt') cannot silently drop rows.
// Callers should tell the user when they receive exactly AGENCY_LIST_LIMIT rows,
// because older agencies then exist off-list.
export const AGENCY_LIST_LIMIT = 500

export async function getAgencies(max: number = AGENCY_LIST_LIMIT): Promise<Agency[]> {
  const snap = await getDocs(
    query(collection(db, 'agencies'), orderBy('createdAt', 'desc'), limit(max))
  )
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Agency))
}

/**
 * One agency, by document id — or, failing that, by the `crmId` field.
 *
 * See `getSeller` for the full story. In short: the document id is
 * `6bKnnKRLkdfHVeq7b3IC` and `crmId` is `ZC2527X9`, and passing the second
 * where the first belongs blanks the contact panel, the bank panel and every
 * KYC document at once. Id first; `crmId` is a query and never a document id.
 */
export async function getAgency(id: string, crmId?: string): Promise<Agency | null> {
  const byId = await getDoc(doc(db, 'agencies', id))
  if (byId.exists()) return { id: byId.id, ...byId.data() } as Agency

  const code = (crmId ?? '').trim()
  if (!code || code === id) return null

  const found = await getDocs(
    query(collection(db, 'agencies'), where('crmId', '==', code), limit(1)),
  )
  const hit = found.docs[0]
  return hit ? ({ id: hit.id, ...hit.data() } as Agency) : null
}

/**
 * The CURRENT name of each of these agencies, keyed by document id (GOV B20).
 *
 * The name copied onto a host application — and the Mongo name behind the
 * applicant's agency picker — is set once and never follows a rename, which
 * lands only here, on the agency document. So a screen that names a Host's
 * agency resolves `users.agencyId` through this and keeps the copy as a
 * fallback (`resolveAgencyName` in lib/hostRows.ts).
 *
 * Never rejects. `where(documentId(), 'in', …)` takes at most 30 ids, so the
 * ids go in chunks; a refused chunk is reported in `failure` and its ids are
 * simply absent from `names`, which every caller already treats as "show the
 * id / the stored copy". The rules admit `isAdmin()` to list agencies, so a
 * department MEMBER gets the failure and the copy — never a blank.
 */
export async function getAgencyNames(
  ids: readonly string[],
): Promise<{ names: Map<string, string>; failure: ReadFailure | null }> {
  // A document id never contains '/', and one that did would make the whole
  // query throw while it is being built — so it is simply not looked up.
  const unique = Array.from(new Set(
    ids.map((i) => String(i ?? '').trim()).filter((i) => i !== '' && !i.includes('/')),
  ))
  const names = new Map<string, string>()
  if (unique.length === 0) return { names, failure: null }
  const chunks: string[][] = []
  for (let i = 0; i < unique.length; i += 30) chunks.push(unique.slice(i, i + 30))
  const results = await Promise.allSettled(
    // `async`, so anything thrown while the query is built is a rejection that
    // `allSettled` records, not an exception out of this function.
    chunks.map(async (chunk) =>
      getDocs(query(collection(db, 'agencies'), where(documentId(), 'in', chunk))),
    ),
  )
  let failure: ReadFailure | null = null
  results.forEach((res, i) => {
    const read = fromSettled(res, `agencies/names#${i}`)
    if (!read.ok) {
      failure = failure ?? read
      return
    }
    read.value.docs.forEach((d) => {
      const name = (d.data() as Record<string, unknown>).agencyName
      if (typeof name === 'string' && name.trim()) names.set(d.id, name.trim())
    })
  })
  return { names, failure }
}

export async function getSubAgencies(parentId: string): Promise<Agency[]> {
  // Avoid compound query (where + orderBy) — requires composite index.
  // Filter by parentAgencyId only, sort client-side.
  const snap = await getDocs(
    query(collection(db, 'agencies'), where('parentAgencyId', '==', parentId))
  )
  const subs = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Agency))
  return subs.sort((a, b) => {
    const aMs = (a.createdAt as { toMillis?: () => number })?.toMillis?.() ?? 0
    const bMs = (b.createdAt as { toMillis?: () => number })?.toMillis?.() ?? 0
    return bMs - aMs
  })
}

// Cap on the agencyHosts subcollection read. No orderBy: agencyHosts documents
// are written by the Android agency dashboard with no guaranteed timestamp
// field, so ordering by one would silently hide hosts. A bare limit() falls back
// to Firestore's implicit document-ID ordering, which is deterministic and
// excludes nothing.
export const AGENCY_HOSTS_LIMIT = 500

export async function getAgencyHosts(agencyId: string, max: number = AGENCY_HOSTS_LIMIT): Promise<any[]> {
  const snap = await getDocs(
    query(collection(db, 'agencies', agencyId, 'agencyHosts'), limit(max))
  )
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
}

/* ─────────────────────────────────────────────────────────────────────────────
 * THE ROSTER — who an agency actually has, and why it is read like this
 *
 * ── THE BUG THIS EXISTS TO END ───────────────────────────────────────────────
 *
 * /agencies and /agencies/{id} both showed a host count of 0 for an agency that
 * was, at that moment, listing two hosts in its own portal. Neither screen was
 * broken in the way it looked: both were faithfully rendering a number that is
 * structurally always zero.
 *
 *   * `AgencyStatement.host_count` — the figure on the list's HOSTS column and
 *     the detail page's "Active hosts" tile — is
 *     `db["agency_hosts"].count_documents({agency_id, active: true})`
 *     (backend/app/services/partners.py:136). That Mongo collection has no
 *     writer anywhere in the backend. Nothing has ever inserted a row into it,
 *     so the count is zero for every agency that has ever existed, forever.
 *   * `GET /partners/agencies/{id}/hosts` — the detail page's "Hosts" tab — is
 *     `agency_host_performance`, an aggregation over BEAN LEDGER movements
 *     (partners.py:196). It answers "which hosts earned, and how much", which
 *     is a real question and a completely different one. An agency whose hosts
 *     have not earned yet has no rows there and never did have a roster there.
 *   * `agencies/{id}.totalHosts` is written as `0` by all four registration
 *     paths and incremented by nothing.
 *
 * A roster count and an earnings count are different questions. The column is
 * labelled HOSTS, not HOSTS PAID, so it gets the roster.
 *
 * ── WHERE THE ROSTER ACTUALLY LIVES ──────────────────────────────────────────
 *
 * Two Firestore reads, and they are deliberately the same two
 * /agency-dashboard makes — the screen that was showing the right answer the
 * whole time (app/agency-dashboard/page.tsx:2080 and :2105). Two screens
 * counting one agency's hosts from two different sources is how they came to
 * disagree; there is now one definition and the CRM reads it.
 *
 *   users where agencyId == id      hosts who have redeemed their referral code.
 *                                   `activateHost` writes `agencyId` onto the
 *                                   user document, and `grant_host` does too.
 *   hostApplications where agencyId == id
 *                                   the invitations. This is what holds a host
 *                                   who has been approved but has not entered
 *                                   their code yet — "Awaiting Activation" on
 *                                   the agency's own screen — and that host
 *                                   exists in no other collection at all.
 *
 * The two are joined on `activatedByUid`, which is the field the Android app
 * writes when the code is redeemed, so a host with both a user document and an
 * application is ONE person and not two. GOV B08: and on `applicantUid` while
 * that person is a current host here — a SELF-application never carries
 * `activatedByUid`, and the join above listed an approved one as a second,
 * "awaiting" person (`linkedPersonUid` in lib/hostRows.ts). An invitation
 * nobody has redeemed that carries a current host's own phone or email is
 * flagged on its row (`sameContactAs`) and not counted.
 *
 * ── WHY NOT `agencies/{id}/agencyHosts` ──────────────────────────────────────
 *
 * That subcollection is the roster proper — `writeAgencyMembership` in
 * functions/src/hosts.ts and `grant_host` in backend/app/services/users.py both
 * write it — and it would be the obvious source. It is not used here for two
 * reasons, both about who is looking:
 *
 *   * `firestore.rules` gates it on `isAdmin()`, which is `superadmin`, `admin`
 *     and `*_admin` only. /agencies also admits `finance_member`, and for them
 *     every one of these reads would be refused — an empty list and a console
 *     error, which is the exact failure mode this whole change is about.
 *     `hostApplications` is gated on `isStaff()` and `users` on any signed-in
 *     account, so both work for every role that can open the page.
 *   * every host activated before `writeAgencyMembership` existed has no row
 *     there. The subcollection is repaired opportunistically (re-entering the
 *     code writes it), so it is a floor on the roster rather than the roster.
 *
 * Nothing here needs a composite index: both queries are a single equality with
 * no `orderBy`, which Firestore serves from its automatic single-field indexes.
 * Ordering is done below, in JavaScript, for the same reason `loadReviewQueues`
 * does — `orderBy` on a field is an implicit existence filter, and a host whose
 * document predates the field would silently vanish from the count.
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Where one person on the roster stands.
 *
 *   active   — redeemed their code. A `users` document points at this agency.
 *   awaiting — approved invitation nobody has entered yet. The referral code is
 *              live; there is no app account behind it and there is not meant
 *              to be one until the applicant signs in.
 *   pending  — invitation still waiting on a KYC decision. Counted, because the
 *              agency is already responsible for them and sees them on its own
 *              screen; the code does not work until somebody approves it.
 *   former   — host status was revoked and the link was left behind.
 *              `revoke_host` (backend/app/services/users.py) sets
 *              `isHost: false` and DELIBERATELY leaves `agencyId` alone, because
 *              commission has already been paid against that link and clearing
 *              it would orphan settled history. So the document still matches
 *              `where agencyId == this agency` and is still returned by the
 *              query — which is why this state has to exist. They are listed,
 *              because their earnings are in the agency's ledger, and they are
 *              NOT in `total`, because the column is called Hosts and they are
 *              not one.
 *
 *              `isHost === false` explicitly, never a missing field: an absent
 *              `isHost` would be read as "not a host" and would quietly delete
 *              real hosts from the count, which is the bug this is inside.
 */
export type { RosterState, RosterMember } from '@/lib/agencyRoster'

export interface AgencyRoster {
  /**
   * One row per PERSON, the two sources already reconciled. Includes former
   * hosts, which `total` does not — see `RosterState`.
   */
  members: RosterMember[]
  /** How many hosts the agency HAS: active + awaiting + pending, never former. */
  total: number
  active: number
  awaiting: number
  pending: number
  former: number
  /**
   * Invitation rows flagged as an existing host's contact (`sameContactAs`).
   * Listed, and in none of the counts above — they are a person already
   * counted.
   */
  flagged: number
  /**
   * Set when that read did not complete. A count taken over a refused read is
   * not a count, and `rosterCountOf` returns `null` rather than a number when
   * either of these is present — "this agency has 0 hosts" is a claim, and it
   * must never be the rendering of a permission error.
   */
  usersFailure: ReadFailure | null
  applicationsFailure: ReadFailure | null
  /** True when either source hit its cap, so the roster is a floor. */
  capped: boolean
}

/**
 * Cap on both roster reads. An agency with more hosts than this exists; the
 * caller is told through `capped` rather than being handed a quiet undercount.
 */
export const AGENCY_ROSTER_LIMIT = 500

/**
 * One agency's roster, from the two collections that actually hold it.
 *
 * Never rejects. Each read lands on its own and is reported on its own, because
 * the two answer different halves of the question and losing one is not the
 * same as losing both: with the invitations refused, the activated hosts are
 * still a true (if partial) roster, and the caller can say which half it has.
 */
export async function getAgencyRoster(
  agencyId: string,
  max: number = AGENCY_ROSTER_LIMIT,
): Promise<AgencyRoster> {
  if (!agencyId) {
    return {
      members: [], total: 0, active: 0, awaiting: 0, pending: 0, former: 0, flagged: 0,
      usersFailure: null, applicationsFailure: null, capped: false,
    }
  }

  const [usersRes, appsRes] = await Promise.allSettled([
    getDocs(query(collection(db, 'users'), where('agencyId', '==', agencyId), limit(max))),
    getDocs(
      query(collection(db, 'hostApplications'), where('agencyId', '==', agencyId), limit(max)),
    ),
  ])

  const usersRead = fromSettled(usersRes, `agencies/${agencyId}/roster-users`)
  const appsRead = fromSettled(appsRes, `agencies/${agencyId}/roster-invitations`)

  // The merge itself is pure, and specified on its own: lib/agencyRoster.ts.
  const merged = mergeAgencyRoster(
    usersRead.ok
      ? {
          docs: usersRead.value.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> })),
          capped: usersRead.value.size >= max,
        }
      : null,
    appsRead.ok
      ? {
          docs: appsRead.value.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> })),
          capped: appsRead.value.size >= max,
        }
      : null,
  )

  return {
    ...merged,
    usersFailure: usersRead.ok ? null : usersRead,
    applicationsFailure: appsRead.ok ? null : appsRead,
    capped:
      (usersRead.ok && usersRead.value.size >= max) ||
      (appsRead.ok && appsRead.value.size >= max),
  }
}

/**
 * How many hosts this agency has — or `null` when that cannot be said.
 *
 * `null` is returned whenever either source was refused, and it is the whole
 * point of this helper existing rather than callers reading `members.length`:
 * an empty roster and an unreadable one render as 0 and as a refusal
 * respectively, and the difference is the difference between "this agency has
 * nobody" and "you were not allowed to look".
 */
export function rosterCountOf(roster: AgencyRoster | null): number | null {
  if (!roster) return null
  if (roster.usersFailure || roster.applicationsFailure) return null
  // `total`, not `members.length` — former hosts are listed and not counted.
  return roster.total
}

/** The first read that did not complete, for rendering verbatim. */
export function rosterFailureOf(roster: AgencyRoster | null): ReadFailure | null {
  if (!roster) return null
  return roster.usersFailure ?? roster.applicationsFailure ?? null
}

/**
 * An agency owner keeping their own contact details current, from /profile.
 *
 * No security rule was added for this either. The `agencies` update clause
 * already lets an agency edit its own record —
 *
 *   isAgencyCrmUser() && crmUserAgencyId() == agencyId
 *     && !affectedKeys().hasAny(['status','approvedBy','approvedAt','isActive'])
 *
 * — which is how the KYC and bank forms on /agency-dashboard already work.
 *
 * That clause is a deny-list, so it would permit far more than the three fields
 * below. This function is the narrower thing on purpose, and two omissions are
 * deliberate rather than incidental:
 *
 *   ownerEmail   the binding `agencyNamesCaller()` matches a `crmUsers` create
 *                against. Repointing it at another address would hand the
 *                registration path for this agency to whoever holds that
 *                address. It is an account fact, and it is not edited here.
 *   agencyName   the trading name staff and hosts identify the business by,
 *                and the name on every commission statement. Changing it is a
 *                business change, not a contact update.
 *
 * Bank details, KYC and commission are untouched — they have their own screens
 * and, in the case of commission, are written only by the API.
 *
 * ── TWO OF THESE ARE NOW PROPOSED RATHER THAN WRITTEN ────────────────────────
 *
 * `ownerName` and `agencyName` are legal identity: they are the name a reviewer
 * checked the Aadhaar and PAN against, and the name on every commission
 * statement and payment instruction. `identityFields()` in `firestore.rules`
 * lists both, so on a record that has already been decided this function can no
 * longer write either of them directly, and neither can anything else in a
 * browser.
 *
 * `submitPartnerUpdate` sorts that out: `ownerPhone` and `address` go straight
 * on as they always did, the two identity fields become a proposal, and an
 * agency still awaiting its first decision writes all four directly because
 * there is nothing verified to protect yet. The caller gets back which of them
 * did which, so /profile can say so rather than claiming everything saved.
 *
 * `ownerPhone` staying directly writable is the rules' choice, not an
 * oversight here — `identityFields()` names `phone`, `applicantPhone`,
 * `email`, `applicantEmail` and `ownerEmail`, and an agency document spells its
 * contact number `ownerPhone`, which is on none of those lists.
 */
export async function updateOwnAgencyProfile(
  id: string,
  details: {
    ownerName: string
    ownerPhone: string
    address: string
    /** The trading name. Optional — omitted leaves it untouched. */
    agencyName?: string
  },
  actor: Proposer,
): Promise<SubmitResult> {
  const patch: Record<string, string> = {
    ownerName:  details.ownerName.trim(),
    ownerPhone: details.ownerPhone.trim(),
    address:    details.address.trim(),
  }

  // The trading name IS editable, contrary to the note above this function
  // when it was first written.
  //
  // The reasoning then was that the name appears on every commission statement
  // and staff identify the business by it, so changing it is a business change
  // rather than a contact update. Both halves of that are true. What does not
  // follow is that it should be unchangeable: a business that renames itself,
  // or that was registered with a typo, otherwise has no way to fix its own
  // name anywhere in the product — and the second capability granted from the
  // CRM is created with whatever name staff typed for them.
  //
  // It is not a money field. The statement is keyed on the record id, not the
  // name, so a rename re-labels history rather than moving any of it.
  const renamed = (details.agencyName ?? '').trim()
  if (renamed) patch.agencyName = renamed

  return submitPartnerUpdate({ collection: 'agencies', id, patch, actor })
}

// REMOVED: `approveAgency`, `rejectAgency` and `updateKycStatus`.
//
// All three decided an agency from a browser, none of them had a caller anywhere
// in the CRM, and each wrote a different subset of the fields that make up the
// decision:
//
//   approveAgency    wrote `status`, `kycStatus` and `isActive` on the Firestore
//                    document and nothing in Mongo. The `partners` record every
//                    money flow resolves against stayed `pending`, so an agency
//                    approved through it looked live on every screen and could
//                    not accrue a rupee of commission — and no referral code was
//                    issued, so it could not recruit a host either.
//   rejectAgency     wrote `status: 'rejected'` and left `kycStatus` wherever it
//                    was, which is how an agency ends up refused and
//                    KYC-approved at once.
//   updateKycStatus  wrote `kycStatus` on its own, to any string a caller passed.
//                    It is the agency-side twin of the /hosts dropdown, and it
//                    has the same problem: half a decision, from no screen, with
//                    no reason and nobody's name on it.
//
// An agency is decided through `partnerOps.approve` / `partnerOps.reject` in
// lib/apiPartners.ts → `backend/app/services/partner_ops.py`, which writes every
// status field together through `_fs_status_fields`, records the reason on the
// record and in the audit log, mirrors the decision onto the owner's `crmUsers`
// login so it actually reaches them, and issues the referral code.
//
// Note what is NOT here: `approveAgencyAccount` in lib/auth.ts is a different
// function about a different thing. It approves a `crmUsers` login, not the
// agency business record, and it is called.

export async function updateAgency(
  id: string,
  updates: Partial<Pick<Agency,
    'agencyName' | 'ownerName' | 'ownerPhone' | 'ownerEmail' | 'address' |
    'bankName' | 'accountNumber' | 'ifscCode' | 'accountHolderName' | 'branch' | 'upiId' |
    'paymentType' | 'country' | 'binanceUid' | 'coinSellerUid'
  >>
): Promise<void> {
  await updateDoc(doc(db, 'agencies', id), { ...updates, updatedAt: serverTimestamp() })
}

/*
 * disableAgency / enableAgency — REMOVED (Phase 1A, SECURITY-003/005).
 * They had no callers and wrote `agencies.isActive` and `crmUsers.isActive`
 * straight from the browser. Partner lifecycle goes through the partner-ops API
 * (`/partner-ops/partners/{id}/suspend|reactivate`), which the rules now require.
 */

export async function setAgencyCommissionRate(id: string, rate: number): Promise<void> {
  if (rate < 0 || rate > 100) throw new Error('Rate must be between 0 and 100.')
  await updateDoc(doc(db, 'agencies', id), { commissionRate: rate })
}

export interface CommissionLedgerEntry {
  id: string
  type: 'credit' | 'paid'
  beans: number
  rate?: number
  hostUid?: string
  hostName?: string
  inrAmount?: number
  usdAmount?: number
  reason: string
  timestamp: Timestamp | null
  // Payment proof (only on 'paid' entries)
  utrNumber?: string
  transactionRef?: string
  transactionProofUrl?: string
  transactionDate?: string
  paymentMode?: string   // NEFT | IMPS | UPI | Binance | USDT
}

/** Read-only: the commission ledger the API writes. Safe — this reads, it does not write. */
export async function getAgencyCommissionLedger(id: string): Promise<CommissionLedgerEntry[]> {
  const snap = await getDocs(
    query(collection(db, 'agencies', id, 'commissionLedger'), orderBy('timestamp', 'desc'), limit(100))
  )
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as CommissionLedgerEntry))
}

/* ─────────────────────────────────────────────────────────────────────────────
 * DELETED — `markCommissionPaid` (and its `CommissionPaymentProof` parameter)
 *
 * WHAT WAS HERE
 *   A browser-side commission payment writer. It read the agency doc and then
 *   wrote back
 *     commissionBalance: Math.max(0, currentBalance - inrAmount)
 *     commissionPaidINR: currentPaid + inrAmount
 *   followed by a 'paid' row in agencies/{id}/commissionLedger carrying the UTR.
 *
 * WHY IT IS GONE
 *   * It paid money with one click. No card, no second person verifying the
 *     facts, no owner signature — the three-stage control the money board
 *     exists to enforce, bypassed entirely from a browser.
 *   * It was read-then-write, not atomic. Two operators paying the same agency
 *     at the same time both read the same `currentBalance`, and the second write
 *     silently erased the first: one payment simply vanished from the balance
 *     while both appeared in the ledger.
 *   * `Math.max(0, …)` clamped an overpayment to zero instead of refusing it, so
 *     paying an agency more than it was owed looked like it worked and left no
 *     trace of the excess.
 *   * The proof (UTR, reference, screenshot) was optional, so a payment could be
 *     recorded against nothing at all.
 *
 * WHAT REPLACES IT
 *   Two calls, because a payout is two events — raising it and paying it:
 *     commission.requestPayout(agencyId, { amount_minor, reason })
 *       → POST /api/partner-ops/agencies/{id}/commission-payouts
 *     commission.executePayout(cardId, paymentRef)
 *       → POST /api/partner-ops/commission-payouts/{cardId}/execute
 *   (`lib/apiPartners.ts`; `api.partnerOps.requestCommissionPayout` /
 *   `executeCommissionPayout` in `lib/api.ts` are the same two endpoints.)
 *
 *   `requestPayout` moves nothing — it raises a card, and the API refuses it
 *   outright if it would overpay the agency. `executePayout` is owner-only
 *   (`require_owner` in backend/app/routers/partner_ops.py), requires a payment
 *   reference, and debits the balance server-side so the balance change, the
 *   ledger entry and the audit entry commit together.
 *
 *   `app/agencies/[id]/Client.tsx` already calls exactly these two.
 *
 * DO NOT REINTRODUCE. A commission balance is not something a browser writes.
 * ───────────────────────────────────────────────────────────────────────────── */

export async function getAgencySalaryRequests(agencyId: string): Promise<AgencySalaryRequest[]> {
  const snap = await getDocs(
    query(
      collection(db, 'salaryRequests'),
      where('agencyId', '==', agencyId),
      orderBy('createdAt', 'desc')
    )
  )
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as AgencySalaryRequest))
}

// ── Sub-agency payment records ─────────────────────────────────────────────────
// The historical record of a main agency settling with a sub-agency. READ ONLY
// from here: these rows are written by the API when a sub-agency payout's two
// legs execute. Superadmin audits them on the main agency detail page.

export interface SubAgencyPayment {
  id: string
  subAgencyId: string
  subAgencyName: string
  amount: number
  currency: 'INR' | 'USD'
  utrNumber?: string
  transactionRef?: string
  proofUrl?: string
  notes?: string
  recordedBy: string        // name of who logged it (agency owner or superadmin)
  recordedByUid: string
  createdAt: Timestamp
}

/* ─────────────────────────────────────────────────────────────────────────────
 * DELETED — `recordSubAgencyPayment`
 *
 * WHAT WAS HERE
 *   A browser-side sub-agency settlement writer. It appended a row to
 *   agencies/{mainId}/subAgencyPayments and then did
 *     updateDoc(agencies/{subId}, { commissionBalance: increment(-amount) })
 *
 * WHY IT IS GONE
 *   * It cleared a sub-agency's balance on the word of whoever was logged in.
 *     No card, no verification, no owner signature, and the UTR was optional —
 *     so a sub-agency's outstanding commission could be zeroed with no evidence
 *     that any money had left anybody's account.
 *   * It modelled a two-party settlement as one write. Money reaches a
 *     sub-agency *through its parent* (spec 4.2.4): we pay the parent, then the
 *     parent pays the sub. This collapsed both legs into a single decrement, so
 *     "we paid the parent but the sub was never paid" — the state most worth
 *     surfacing — could not be represented at all, let alone reported.
 *   * `increment()` is atomic, so unlike `markCommissionPaid` it did not lose
 *     concurrent writes; it took the balance negative instead, with nothing
 *     refusing an overpayment.
 *
 * WHAT REPLACES IT
 *   The payout is tracked as two legs, and the second one is a real event:
 *     commission.requestSubAgencyPayout({ parent_id, sub_id, amount_minor, reason })
 *       → POST /api/partner-ops/subagency-payouts        (raises a card)
 *     commission.executePayout / executeSubAgencyPayout(cardId, paymentRef)
 *       → POST /api/partner-ops/subagency-payouts/{cardId}/execute
 *          leg 1, owner-only — we pay the parent. The payout stays OPEN.
 *     commission.confirmSubAgencyLeg(payoutId, reason)
 *       → POST /api/partner-ops/subagency-payouts/{payoutId}/confirm-leg
 *          leg 2 — the parent confirms it paid the sub. Only now does it close.
 *   Anything still open is listed by
 *     commission.openSubAgencyPayouts()
 *       → GET /api/partner-ops/subagency-payouts/open
 *   which is what makes 4.2.4 enforceable rather than aspirational.
 *
 *   `app/agencies/[id]/Client.tsx` already calls exactly these.
 *
 * DO NOT REINTRODUCE.
 * ───────────────────────────────────────────────────────────────────────────── */

/** Read-only: the settlement history the API writes. Safe — this reads, it does not write. */
export async function getSubAgencyPayments(mainAgencyId: string): Promise<SubAgencyPayment[]> {
  const snap = await getDocs(
    query(
      collection(db, 'agencies', mainAgencyId, 'subAgencyPayments'),
      orderBy('createdAt', 'desc'),
    )
  )
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as SubAgencyPayment))
}

// ── Dual-role: link / unlink ──────────────────────────────────────────────────
//
// Bidirectional: sets isSeller + linkedSellerId on the agency doc,
// and isAgency + linkedAgencyId on the seller doc simultaneously.

export async function linkAgencyToSeller(agencyId: string, sellerId: string): Promise<void> {
  await Promise.all([
    updateDoc(doc(db, 'agencies', agencyId), {
      isSeller: true,
      linkedSellerId: sellerId,
    }),
    updateDoc(doc(db, 'sellers', sellerId), {
      isAgency: true,
      linkedAgencyId: agencyId,
    }),
  ])
}

export async function unlinkAgencyFromSeller(agencyId: string, sellerId: string): Promise<void> {
  await Promise.all([
    updateDoc(doc(db, 'agencies', agencyId), {
      isSeller: false,
      linkedSellerId: null,
    }),
    updateDoc(doc(db, 'sellers', sellerId), {
      isAgency: false,
      linkedAgencyId: null,
    }),
  ])
}

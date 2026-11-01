import { db } from './firebase'
import {
  collection,
  getDocs,
  getCountFromServer,
  doc,
  getDoc,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  documentId,
  updateDoc,
  addDoc,
  deleteField,
  collectionGroup,
  Timestamp,
  serverTimestamp,
} from 'firebase/firestore'
import type { DocumentData, Query, QueryDocumentSnapshot } from 'firebase/firestore'
import type { Dept } from './auth'
import { tickets as apiTickets } from './api'
import { getPlatformRevenueDays, getPlatformStats } from './finance'
import { getRates } from './rates'
import { fromSettled, isOk, ok, toFailure, type ReadResult } from './readState'

// ── Types ──────────────────────────────────────────────────────────────────

export interface UserRecord {
  uid: string
  /**
   * The CRM role denormalised onto the app document by `syncMyRoles`, or ''.
   *
   * ── FOR HIDING CONTROLS, NOT FOR DECIDING ACCESS ─────────────────────────
   *
   * An internal identity that has also signed into the Android app has a
   * `users/{uid}` document like anybody else, so all three Owners appear in
   * this list. This field lets the UI stop offering Ban and Suspend beside
   * their names.
   *
   * It is NOT the authority and must never be treated as one: it lives on a
   * document the app writes to, so a screen that trusted it would be
   * trusting client-reachable state. The real guard is
   * `users.ensure_ordinary_target` in the backend, which reads the Mongo
   * `staff` collection. This is the courtesy that stops a reviewer pressing
   * a button that was always going to 403.
   */
  crmRole: string
  name: string
  email: string
  phoneNumber: string
  photoUrl: string
  diamonds: number
  beans: number
  isHost: boolean
  isAgent: boolean
  isBanned: boolean
  isSeller: boolean
  /**
   * Which moderation state the account is in: `active`, `suspended`, `banned`,
   * `recovery_pending`, `permanently_deactivated`, or "" on a document written
   * before the field existed.
   *
   * ── WHY `isBanned` IS NOT ENOUGH ─────────────────────────────────────────
   *
   * `isBanned` is the app's "cannot use the app" gate, and the server sets it
   * for a SUSPENSION as well as a ban — so a screen reading it alone cannot
   * tell the two apart, and every suspended account was being offered Unban,
   * which the server refuses with "use Resume". The two operations are
   * genuinely different: a suspension never bars a device, so there is nothing
   * device-side for an unban to undo.
   */
  accountState: string
  /** True only for a suspension. The fallback when `accountState` is absent. */
  isSuspended: boolean
  /**
   * The USER ladder (0–20, XP-based) — `users/{uid}.level`.
   *
   * ── READ THIS BEFORE SHOWING IT NEXT TO A HOST ───────────────────────────
   *
   * There are TWO ladders and they are not interchangeable. This one is scored
   * on `totalXp` against `levelConfig/user/levels.xpRequired`; the host ladder
   * is scored on beans earned against `levelConfig/host/levels.beansRequired`
   * and lives in [hostLevel] below.
   *
   * This field also has NO WRITER anywhere on the platform — not the app, not
   * the Cloud Functions, not the Python API. It is absent on every user
   * document in existence, and it used to be read here as `?? 1`, which is
   * where "Level 1" on a brand-new account with zero XP came from. The value
   * was invented by this line.
   */
  level: number
  /**
   * The HOST ladder (0–10, beans-based) — `users/{uid}.hostLevel`.
   *
   * Server-maintained by `applyHostLevel` and the nightly `sweepHostLevels`,
   * and written ONLY when it changes — so a host who has earned nothing has no
   * field at all, and absent legitimately means 0. `functions/src/profiles.ts`
   * and `sweepHostLevels` both already default it to 0; so does this.
   *
   * Every host-facing surface in the CRM should show this, not [level].
   */
  hostLevel: number
  agencyId: string
  createdAt: Timestamp | null
}

export interface Transaction {
  id: string
  type: string
  amount: number
  reason: string
  reasonLabel: string
  timestamp: Timestamp | null
  relatedUserName: string
}

export interface LiveRoom {
  roomId: string
  hostUid: string
  hostName: string
  viewerCount: number
  isActive: boolean
  startedAt: Timestamp | null
  title: string
  totalGiftsReceived: number
}

export interface RevenueEntry {
  id: string
  amount: number
  type: string
  timestamp: Timestamp | null
}

/**
 * Dashboard KPIs, one independent read each.
 *
 * Every field is a `ReadResult`, not a number, because these ten reads are NOT
 * all available to every role and never were:
 *   • `kycSubmissions` is `isAdmin() || isSupport()`
 *   • `agencies`       is `isAdmin()` (plus per-document owner clauses that a
 *                       list/count query cannot satisfy)
 *   • `platformRevenue` is `isFinance() || isAdmin()`
 * so on an `app_member`, `ops_member` or `tech_member` account those legs are
 * refused. They used to sit in one `Promise.all`, which meant a single refusal
 * threw away all ten results and the page rendered nothing at all. Widening the
 * type is what forces every call site to say which figure is missing instead of
 * printing a zero it never measured.
 *
 * This generalises the `revenueUnavailable` flag that already guarded the one
 * leg somebody had noticed; the other nine now carry the same protection, and
 * a reason to go with it.
 */
export interface StatsResult {
  totalUsers: ReadResult<number>
  totalHosts: ReadResult<number>
  activeLives: ReadResult<number>
  /** ₹ gross from diamonds spent — same definition the Finance pages use. */
  estimatedRevenueINR: ReadResult<number>
  coinSellersOnline: ReadResult<number>
  totalSellers: ReadResult<number>
  pendingKyc: ReadResult<number>
  pendingAgencies: ReadResult<number>
  openTickets: ReadResult<number>
  bannedUsers: ReadResult<number>
}

// ── Helpers ────────────────────────────────────────────────────────────────

function tsToMs(ts: Timestamp | null | undefined): number {
  if (!ts) return 0
  return ts.toMillis ? ts.toMillis() : 0
}

/** Server-side count that never downloads documents. */
async function countOf(q: Query<DocumentData>): Promise<number> {
  const snap = await getCountFromServer(q)
  return snap.data().count
}

// ── Users ──────────────────────────────────────────────────────────────────

function mapUser(d: QueryDocumentSnapshot<DocumentData>): UserRecord {
  const data = d.data()
  return {
    uid: d.id,
    name: data.name ?? '',
    email: data.email ?? '',
    phoneNumber: data.phoneNumber ?? '',
    photoUrl: data.photoUrl ?? '',
    crmRole: typeof data.crmRole === 'string' ? data.crmRole : '',
    diamonds: data.diamonds ?? 0,
    beans: data.beans ?? 0,
    isHost: data.isHost ?? false,
    isAgent: data.isAgent ?? false,
    isSeller: data.isSeller ?? false,
    isBanned: data.isBanned ?? false,
    accountState: data.accountState ?? '',
    isSuspended: data.isSuspended ?? false,
    // 0, not 1. Nothing writes `level`, so `?? 1` reported every account on the
    // platform as Level 1 — including one with zero XP and zero earnings.
    level: data.level ?? 0,
    hostLevel: data.hostLevel ?? 0,
    agencyId: data.agencyId ?? '',
    createdAt: data.createdAt ?? null,
  }
}

/**
 * One page of users.
 *
 * Ordered by `documentId()` on purpose: it is the only key EVERY user document
 * is guaranteed to have, so the query can never silently drop a user the way an
 * `orderBy('createdAt')` would for any doc missing that field. It is also
 * totally deterministic, which is what makes `startAfter` cursors correct.
 */
export interface UsersPage {
  users: UserRecord[]
  /** Pass back as `cursor` to fetch the next page. null when the list is exhausted. */
  cursor: QueryDocumentSnapshot<DocumentData> | null
  hasMore: boolean
}

export async function getUsersPage(
  pageSize = 50,
  cursor: QueryDocumentSnapshot<DocumentData> | null = null
): Promise<UsersPage> {
  const usersRef = collection(db, 'users')
  const q = cursor
    ? query(usersRef, orderBy(documentId()), startAfter(cursor), limit(pageSize))
    : query(usersRef, orderBy(documentId()), limit(pageSize))
  const snap = await getDocs(q)
  return {
    users: snap.docs.map(mapUser),
    cursor: snap.docs.length ? snap.docs[snap.docs.length - 1] : null,
    hasMore: snap.docs.length === pageSize,
  }
}

/**
 * Legacy convenience wrapper — first page only.
 * `searchName` is a client-side filter over that page and therefore only sees
 * `pageSize` users. Prefer `getUsersPage` + `searchUsers`.
 */
export async function getUsers(pageSize = 50, searchName = ''): Promise<UserRecord[]> {
  const { users } = await getUsersPage(pageSize)
  if (!searchName.trim()) return users
  const lower = searchName.toLowerCase()
  return users.filter(
    (u) =>
      u.name.toLowerCase().includes(lower) ||
      u.phoneNumber.includes(lower) ||
      u.email.toLowerCase().includes(lower)
  )
}

/**
 * Server-side user lookup.
 *
 * Firestore has no substring/LIKE operator and user documents carry no
 * normalised lowercase field (see the Android `User` model — there is no
 * `nameLower`), so this does what Firestore can actually do against the data
 * that exists:
 *   • exact document-id (UID) lookup
 *   • exact + prefix match on `email`
 *   • exact + prefix match on `phoneNumber` (raw, digits-only and E.164 forms)
 *   • case-sensitive prefix match on `name`, retried across common casings
 *
 * Results are merged and de-duplicated. A term that only appears in the MIDDLE
 * of a name cannot be found server-side — callers must surface that limitation
 * rather than silently returning nothing.
 */
export async function searchUsers(term: string, max = 50): Promise<UserRecord[]> {
  const raw = term.trim()
  if (!raw) return []

  const usersRef = collection(db, 'users')
  const jobs: Promise<ReadResult<UserRecord[]>>[] = []

  const run = (q: Query<DocumentData>) =>
    getDocs(q)
      .then((s) => ok(s.docs.map(mapUser)))
      // A single failing variant (bad index / malformed range) must not kill
      // the search — but the failure is recorded, not discarded, so that "every
      // variant was refused" cannot masquerade as "no user matched".
      .catch((err) => toFailure(err, 'searchUsers variant'))

  // '\uf8ff' is the top of the BMP private-use area — the standard Firestore
  // idiom for "every value that starts with `value`".
  const HIGH = '\uf8ff'
  const prefix = (field: 'name' | 'email' | 'phoneNumber', value: string) =>
    run(
      query(
        usersRef,
        where(field, '>=', value),
        where(field, '<=', value + HIGH),
        limit(max)
      )
    )

  // Exact UID
  jobs.push(
    getDoc(doc(db, 'users', raw))
      .then((s) => ok(s.exists() ? [mapUser(s as QueryDocumentSnapshot<DocumentData>)] : []))
      .catch((err) => toFailure(err, 'searchUsers uid'))
  )

  if (raw.includes('@')) {
    jobs.push(prefix('email', raw.toLowerCase()))
  }

  const digits = raw.replace(/\D/g, '')
  if (digits.length >= 4 && /^[+\d][\d\s()\-.]*$/.test(raw)) {
    const variants = Array.from(new Set([raw, digits, `+${digits}`]))
    for (const v of variants) jobs.push(prefix('phoneNumber', v))
  }

  // Case-sensitive prefix on `name` — try the casings people actually type.
  const nameVariants = Array.from(
    new Set([raw, raw.toLowerCase(), raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase()])
  )
  for (const v of nameVariants) jobs.push(prefix('name', v))

  const settled = await Promise.all(jobs)

  // If NOT ONE variant came back, we learned nothing about whether this term
  // matches a user. Returning [] here would render "No users found", which is a
  // statement about the database we are in no position to make.
  const succeeded = settled.filter(isOk)
  if (succeeded.length === 0) {
    const firstFailed = settled.find((r) => !r.ok)
    throw new Error(
      firstFailed && !firstFailed.ok
        ? `Search could not be run. ${firstFailed.reason}`
        : 'Search could not be run.'
    )
  }

  const byUid = new Map<string, UserRecord>()
  for (const r of succeeded) {
    for (const u of r.value) if (!byUid.has(u.uid)) byUid.set(u.uid, u)
  }
  return Array.from(byUid.values()).slice(0, max)
}

export async function getUser(uid: string): Promise<UserRecord | null> {
  const snap = await getDoc(doc(db, 'users', uid))
  if (!snap.exists()) return null
  const d = snap.data()
  return {
    uid: snap.id,
    name: d.name ?? '',
    email: d.email ?? '',
    phoneNumber: d.phoneNumber ?? '',
    photoUrl: d.photoUrl ?? '',
    crmRole: typeof d.crmRole === 'string' ? d.crmRole : '',
    diamonds: d.diamonds ?? 0,
    beans: d.beans ?? 0,
    isHost: d.isHost ?? false,
    isAgent: d.isAgent ?? false,
    isSeller: d.isSeller ?? false,
    isBanned: d.isBanned ?? false,
    accountState: d.accountState ?? '',
    isSuspended: d.isSuspended ?? false,
    // See the note on UserRecord.level — absent means 0, never 1.
    level: d.level ?? 0,
    hostLevel: d.hostLevel ?? 0,
    agencyId: d.agencyId ?? '',
    createdAt: d.createdAt ?? null,
  }
}

export async function getUserDiamondTransactions(uid: string): Promise<Transaction[]> {
  const q = query(
    collection(db, 'users', uid, 'diamondTransactions'),
    orderBy('timestamp', 'desc'),
    limit(50)
  )
  const snap = await getDocs(q)
  return snap.docs.map((d) => ({
    id: d.id,
    type: d.data().type ?? '',
    amount: d.data().amount ?? 0,
    reason: d.data().reason ?? '',
    reasonLabel: d.data().reasonLabel ?? '',
    timestamp: d.data().timestamp ?? null,
    relatedUserName: d.data().relatedUserName ?? '',
  }))
}

export async function getUserBeanTransactions(uid: string): Promise<Transaction[]> {
  const q = query(
    collection(db, 'users', uid, 'beanTransactions'),
    orderBy('timestamp', 'desc'),
    limit(50)
  )
  const snap = await getDocs(q)
  return snap.docs.map((d) => ({
    id: d.id,
    type: d.data().type ?? '',
    amount: d.data().amount ?? 0,
    reason: d.data().reason ?? '',
    reasonLabel: d.data().reasonLabel ?? '',
    timestamp: d.data().timestamp ?? null,
    relatedUserName: d.data().relatedUserName ?? '',
  }))
}

/*
 * ── REMOVED: banUser / unbanUser ─────────────────────────────────────────────
 *
 * These wrote `isBanned` straight onto the user document from the browser. No
 * audit entry, no actor, no reason recorded on the unban, no device ban — a
 * second moderation system that happened to be reachable from the Hosts page,
 * producing accounts that had been banned by nobody as far as the log knew.
 *
 * Use `api.users.ban(uid, reason)` and `api.users.unban(uid, reason)`. Those go
 * through `backend/app/services/users.py`, which audits to Mongo with a named
 * actor and a mandatory reason, and handles the device side.
 *
 * DO NOT REINTRODUCE. `isBanned` is in `ownerProtectedFields()` so the account
 * cannot write it about itself, but `isStaff()` still can — and a rule cannot
 * tell a considered ban from an accidental one. That is exactly why this has to
 * go through somewhere that records who did it and why.
 */

/* ─────────────────────────────────────────────────────────────────────────────
 * DELETED — `addDiamonds` and `deductDiamonds`
 *
 * The same browser-side balance write as `addBeans` below, minus the commission
 * arithmetic: read `users/{uid}.diamonds`, add or subtract, write it back, and
 * log the movement against the literal string "Admin" so it could not be traced
 * to a person. Read-then-write, not `increment`, so two operators adjusting at
 * once silently lost one of the adjustments.
 *
 * Confirmed zero callers before deletion. `firestore.rules` now refuses browser
 * writes to `diamonds`, so both threw permission-denied.
 *
 * Replaced by api.users.requestBalanceChange(uid, 'diamonds', amount, reason)
 *   → POST /api/users/{uid}/balance-request. A positive amount credits, a
 *     negative one debits, and neither moves until an owner signs the card.
 *
 * DO NOT REINTRODUCE.
 * ───────────────────────────────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────────────────────────────────
 * DELETED — `addBeans(uid, amount, reason)`
 *
 * WHAT WAS HERE
 *   Three writes from the browser, in sequence, with no transaction:
 *     1. users/{uid}.beans = current + amount   (a read-then-write, so two
 *        operators crediting at once silently lost one of the credits)
 *     2. a beanTransactions row attributed to the literal string "Admin", so
 *        no credit could be traced to a person
 *     3. a commission accrual: it computed `payoutPerLakh = isForeign ? 10 : 1000`
 *        — a fourth hardcoded rate table, in the data layer, disagreeing with
 *        lib/rates.ts — multiplied by the agency's `commissionRate`, then wrote
 *        agencies/{id}.commissionBalance and a commissionLedger entry.
 *
 * WHY IT IS GONE
 *   Confirmed zero callers before deletion. Commission is not something a
 *   browser gets to decide: it is computed and accrued server-side from the
 *   ledger, where the rate and the slab are applied once, in one place, and the
 *   accrual is auditable against the movements that produced it. Computing it
 *   client-side meant the amount owed to an agency depended on which build of
 *   the CRM happened to be open in someone's tab.
 *
 *   `firestore.rules` now refuses browser writes to `beans`,
 *   `totalBeansEarned` and `commissionBalance`, so this threw permission-denied.
 *
 * WHAT REPLACES IT
 *   Crediting a host:
 *     api.users.requestBalanceChange(uid, 'beans', amount, reason)
 *       → POST /api/users/{uid}/balance-request — raises a card, moves nothing
 *         until an owner signs.
 *   Agency commission accrual (server-computed, not a browser arithmetic):
 *     api.partnerOps.accrueCommission(agencyId,
 *       { amount_minor, host_id, period, reason })
 *       → POST /api/partner-ops/agencies/{id}/commission-accruals
 *   Reading what an agency is owed:
 *     api.partners.agencyStatement(id) — commission_earned / paid / outstanding.
 *
 * DO NOT REINTRODUCE.
 * ───────────────────────────────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────────────────────────────────
 * DELETED — `deductBeans`
 *
 * The debit half of `addBeans`: read `users/{uid}.beans`, subtract, write back,
 * clamped at zero — so debiting more than a host held quietly succeeded at a
 * different amount than the one recorded in the transaction row beside it.
 *
 * Confirmed zero callers. `firestore.rules` refuses browser writes to `beans`.
 *
 * Replaced by api.users.requestBalanceChange(uid, 'beans', -amount, reason)
 *   → POST /api/users/{uid}/balance-request.
 *
 * DO NOT REINTRODUCE.
 * ───────────────────────────────────────────────────────────────────────────── */

/*
 * makeHost / removeHost — REMOVED (Phase 1A, SECURITY-004 / ROLE-001).
 *
 * They wrote `users.isHost` directly from the browser, skipping the role
 * eligibility matrix, the agency roster and the audit log. Host status now
 * changes only through the API: `api.users.grantHost` / `api.users.revokeHost`.
 * The Firestore rules refuse the direct write for every staff role.
 */

/**
 * Set a user's XP level by hand.
 *
 * ── HAS NEVER HAD A CALLER, AND SHOULD NOT GET ONE ───────────────────────────
 *
 * Kept only so the dead `level` field has one honest place naming what it would
 * take to make it real. A level that staff can type in is not a level: the app
 * computes the user ladder from `totalXp` against `levelConfig/user/levels`, so
 * a hand-set value would be overwritten by the next thing that recomputes it, or
 * — worse — would persist and disagree with the XP the user can see for
 * themselves. The host ladder solved this properly: `applyHostLevel` writes
 * `hostLevel` from earnings and nothing else is allowed to.
 *
 * If a user level is ever wanted in the CRM, mirror that: a writer driven by
 * `totalXp`, not a text box.
 */
// setUserLevel — REMOVED (Phase 1A): `level` is server-derived and staff-protected in the rules.

export async function warnUser(uid: string, reason: string): Promise<void> {
  const userRef = doc(db, 'users', uid)
  const snap = await getDoc(userRef)
  if (!snap.exists()) throw new Error('User not found')
  const current = snap.data().warnings ?? 0
  await updateDoc(userRef, { warnings: current + 1 })
  await addDoc(collection(db, 'users', uid, 'warnings'), {
    reason, issuedAt: Timestamp.now(), issuedBy: 'Admin',
  })
}

// ── Withdrawal Requests ────────────────────────────────────────────────────

export interface WithdrawalRequest {
  id: string
  uid: string
  hostName: string
  hostPhotoUrl: string
  phoneNumber: string
  agencyId: string
  beans: number
  inrAmount: number
  status: 'pending' | 'approved' | 'rejected' | 'paid'
  /** The host. Rules and the server read `hostUid`; older rows carry only `uid`. */
  hostUid?: string
  paymentType?: 'india' | 'foreign'
  bankName?: string
  accountNumber?: string
  ifscCode?: string
  upiId?: string
  binanceUid?: string
  requestedAt: Timestamp | null
  processedAt: Timestamp | null
  processedBy?: string
  rejectionReason?: string
  notes?: string
  // Transaction proof (filled when marking paid)
  utrNumber?: string
  transactionRef?: string
  transactionProofUrl?: string
  transactionDate?: string
  paymentMode?: string   // NEFT | IMPS | UPI | Binance | USDT
  // P0-7: written by the server when the card that pays this request executes.
  paidAt?: Timestamp | null
  paidVia?: 'card'
  cardId?: string
  paymentRef?: string
  beansDebited?: number
}

export async function getWithdrawalRequests(status?: string): Promise<WithdrawalRequest[]> {
  const q = status && status !== 'all'
    ? query(collection(db, 'withdrawalRequests'), where('status', '==', status), orderBy('requestedAt', 'desc'), limit(100))
    : query(collection(db, 'withdrawalRequests'), orderBy('requestedAt', 'desc'), limit(100))
  const snap = await getDocs(q)
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as WithdrawalRequest))
}

export async function approveWithdrawal(id: string, notes?: string): Promise<void> {
  await updateDoc(doc(db, 'withdrawalRequests', id), {
    status: 'approved',
    processedAt: Timestamp.now(),
    processedBy: 'Admin',
    ...(notes ? { notes } : {}),
  })
}

export interface PaymentProof {
  utrNumber?: string
  transactionRef?: string
  transactionProofUrl?: string
  transactionDate?: string
  paymentMode?: string
  notes?: string
}

// P0-7 (FIN-5): `markWithdrawalPaid` is gone. It wrote `status: 'paid'` with
// no bean debit and no ledger row. A request is paid only by executing the
// host-withdrawal card raised for it — see `api.partnerOps.executeHostWithdrawal`.

export async function rejectWithdrawal(id: string, reason: string): Promise<void> {
  await updateDoc(doc(db, 'withdrawalRequests', id), {
    status: 'rejected',
    rejectionReason: reason,
    processedAt: Timestamp.now(),
    processedBy: 'Admin',
  })
}

// ── Hosts ──────────────────────────────────────────────────────────────────

/** Cap on role-filtered CRM list views. */
const ROLE_LIST_LIMIT = 500

// NOTE: deliberately no `orderBy` on these role queries. Adding one would
// (a) require a composite index that is not declared in firestore.indexes.json
// and (b) silently drop any document missing the sort field. A plain `limit()`
// bounds the read without either risk. Callers already sort client-side.

export async function getHosts(): Promise<UserRecord[]> {
  const q = query(collection(db, 'users'), where('isHost', '==', true), limit(ROLE_LIST_LIMIT))
  const snap = await getDocs(q)
  return snap.docs.map(mapUser)
}

/** Server-side count of hosts — no documents downloaded. */
export async function countHosts(): Promise<number> {
  return countOf(query(collection(db, 'users'), where('isHost', '==', true)))
}

// ── Agents ─────────────────────────────────────────────────────────────────

export async function getAgents(): Promise<UserRecord[]> {
  const q = query(collection(db, 'users'), where('isAgent', '==', true), limit(ROLE_LIST_LIMIT))
  const snap = await getDocs(q)
  return snap.docs.map(mapUser)
}

// ── Live Rooms ─────────────────────────────────────────────────────────────

/** Cap on the live-room list view. Concurrent live rooms are far below this. */
const LIVE_ROOM_LIMIT = 300

export async function getActiveLiveRooms(): Promise<LiveRoom[]> {
  // Avoid compound query (where + orderBy) which requires a composite Firestore index.
  // Filter by isActive only, bound the read, then sort client-side.
  const q = query(
    collection(db, 'liveRooms'),
    where('isActive', '==', true),
    limit(LIVE_ROOM_LIMIT)
  )
  const snap = await getDocs(q)
  const rooms = snap.docs.map((d) => ({
    roomId:             d.id,
    hostUid:            d.data().hostUid            ?? '',
    hostName:           d.data().hostName           ?? '',
    viewerCount:        d.data().viewerCount        ?? 0,
    isActive:           d.data().isActive           ?? false,
    startedAt:          d.data().startedAt          ?? null,
    title:              d.data().title              ?? '',
    totalGiftsReceived: d.data().totalGiftsReceived ?? 0,
  }))
  // Sort newest-first client-side
  return rooms.sort((a, b) => {
    const aMs = a.startedAt?.toMillis?.() ?? 0
    const bMs = b.startedAt?.toMillis?.() ?? 0
    return bMs - aMs
  })
}

// ── Finance ────────────────────────────────────────────────────────────────

/**
 * Daily platform revenue in ₹, newest day first.
 *
 * The old implementation did `orderBy('timestamp')` + `sum(d.data().amount)`.
 * `platformRevenue` has two document shapes and NEITHER carries an `amount`
 * field, while only one of them carries `timestamp` — so that query dropped
 * every daily-rollup document and then summed a field that does not exist,
 * pinning revenue at ₹0 forever. See the schema note in lib/finance.ts.
 */
export async function getPlatformRevenue(): Promise<RevenueEntry[]> {
  const [days, rates] = await Promise.all([getPlatformRevenueDays(), getRates()])
  return days.slice(0, 100).map((d) => {
    const ms = Date.parse(`${d.date}T00:00:00Z`)
    return {
      id: d.date,
      // Wholesale — what Zipper received, not what the buyer paid the seller.
      amount: d.diamondSpend * rates.sellerWholesalePerDiamond,
      type: d.source,
      timestamp: Number.isFinite(ms) ? Timestamp.fromMillis(ms) : null,
    }
  })
}

export async function getWeeklyBeanResets(): Promise<Transaction[]> {
  // Avoid compound query (where + orderBy on collectionGroup) — needs composite index.
  const q = query(
    collectionGroup(db, 'beanTransactions'),
    // 'weekly_release', not 'weekly_reset'. Nothing has ever written the
    // latter — releaseBeansForWeek writes the former — so this returned
    // nothing for every week the platform has existed.
    where('reason', '==', 'weekly_release'),
    limit(100)
  )
  const snap = await getDocs(q)
  const rows = snap.docs.map((d) => ({
    id: d.id,
    type: d.data().type ?? '',
    amount: d.data().amount ?? 0,
    reason: d.data().reason ?? '',
    reasonLabel: d.data().reasonLabel ?? '',
    timestamp: d.data().timestamp ?? null,
    relatedUserName: d.data().relatedUserName ?? '',
  }))
  return rows.sort((a, b) => {
    const aMs = (a.timestamp as { toMillis?: () => number })?.toMillis?.() ?? 0
    const bMs = (b.timestamp as { toMillis?: () => number })?.toMillis?.() ?? 0
    return bMs - aMs
  })
}

// ── Sellers ────────────────────────────────────────────────────────────────

export interface SellerRecord {
  uid: string
  name: string
  photoUrl: string
  phoneNumber: string
  isOnline: boolean
  addedAt: Timestamp | null
}

// @deprecated — use getSellers() from lib/sellers.ts instead
export async function getLegacySellers(): Promise<SellerRecord[]> {
  const q = query(collection(db, 'users'), where('isSeller', '==', true), limit(ROLE_LIST_LIMIT))
  const snap = await getDocs(q)
  return snap.docs.map((d) => ({
    uid: d.id,
    name: d.data().name ?? '',
    photoUrl: d.data().photoUrl ?? '',
    phoneNumber: d.data().phoneNumber ?? '',
    isOnline: d.data().isOnline ?? false,
    addedAt: d.data().sellerAddedAt ?? null,
  })).sort((a, b) => (b.isOnline ? 1 : 0) - (a.isOnline ? 1 : 0))
}

// setSeller — REMOVED (Phase 1A): `users.isSeller` is a partner role; it is granted by the API, never from a browser.

export async function setSellerOnlineStatus(uid: string, online: boolean): Promise<void> {
  await updateDoc(doc(db, 'users', uid), { isOnline: online })
}

// removeSeller — REMOVED (Phase 1A): seller revocation goes through the partner API.

// ── Support Tickets ────────────────────────────────────────────────────────

export type SupportTicketStatus   = 'open' | 'in_progress' | 'replied' | 'closed'
export type SupportTicketPriority = 'critical' | 'high' | 'medium' | 'low'
export type SupportTicketCategory =
  | 'billing'
  | 'ban_appeal'
  | 'bug_report'
  | 'account_issue'
  | 'other'

export interface SupportTicketRecord {
  id: string
  userId: string
  userName: string
  userPhotoUrl: string
  subject: string
  message: string
  status: SupportTicketStatus
  priority: SupportTicketPriority
  category: SupportTicketCategory
  adminReply: string
  assignedTo: string        // uid of CRM staff member
  assignedToName: string
  escalatedToTech: boolean  // legacy flag — true when escalatedTeam === 'tech'
  escalatedTeam: Dept | ''  // department this ticket was routed to (via Team Tickets)
  escalatedAt: Timestamp | null
  escalationNote: string
  linkedTeamTicketId: string // id of the techTickets doc created by routing, if any
  createdAt: Timestamp | null
  repliedAt: Timestamp | null
}

function mapTicket(d: import('firebase/firestore').QueryDocumentSnapshot): SupportTicketRecord {
  const data = d.data()
  return {
    id: d.id,
    userId: data.userId ?? '',
    userName: data.userName ?? '',
    userPhotoUrl: data.userPhotoUrl ?? '',
    subject: data.subject ?? data.title ?? '',
    message: data.message ?? data.body ?? '',
    status: data.status ?? 'open',
    priority: data.priority ?? 'medium',
    category: data.category ?? 'other',
    adminReply: data.adminReply ?? '',
    assignedTo: data.assignedTo ?? '',
    assignedToName: data.assignedToName ?? '',
    escalatedToTech: data.escalatedToTech ?? false,
    escalatedTeam: data.escalatedTeam ?? (data.escalatedToTech ? 'tech' : ''),
    escalatedAt: data.escalatedAt ?? null,
    escalationNote: data.escalationNote ?? '',
    linkedTeamTicketId: data.linkedTeamTicketId ?? '',
    createdAt: data.createdAt ?? null,
    repliedAt: data.repliedAt ?? null,
  }
}

export async function getSupportTickets(): Promise<SupportTicketRecord[]> {
  const q = query(
    collection(db, 'supportTickets'),
    orderBy('createdAt', 'desc'),
    limit(200)
  )
  const snap = await getDocs(q)
  return snap.docs.map(mapTicket)
}

export async function getSupportTicketsByAssignee(uid: string): Promise<SupportTicketRecord[]> {
  const q = query(
    collection(db, 'supportTickets'),
    where('assignedTo', '==', uid),
    orderBy('createdAt', 'desc'),
    limit(200)
  )
  const snap = await getDocs(q)
  return snap.docs.map(mapTicket)
}

/**
 * Answer a ticket, and make the answer reachable by the person who asked.
 *
 * Two fields beyond the reply itself are load-bearing and neither was written
 * before:
 *
 *   * `updatedAt`. The Android app's ticket list is
 *     `whereEqualTo("userId", …).orderBy("updatedAt", DESCENDING)`, and
 *     Firestore excludes a document that does not carry the field being ordered
 *     on. Nothing wrote it, so a replied ticket was not merely un-rendered —
 *     it was not in the query result at all.
 *   * the reply is read from `adminReply` by the app now. It used to read
 *     `statusMessage`, which nothing in the system has ever written.
 *
 * The notification row beside it is a separate matter and is left as it was:
 * `users/{uid}/notifications` has no reader in the Android app either. It is
 * written because removing it would lose the record, not because anything sees
 * it.
 */
//
// P1-D — every write below goes through the API (`/api/tickets/support/...`).
// Firestore rules refuse client writes to `supportTickets` and `techTickets`.
// The server records the actor from the session, writes the audit entry
// before the ticket, stamps `updatedAt`, and sends the app user an in-app
// notice on a reply (to the top-level `notifications` collection the app
// reads — which replaces the `users/{uid}/notifications` row this used to
// write and nothing ever read).
//
// `userId` and `routedBy` are kept in the signatures so callers compile
// unchanged; the server ignores who the client says it is.

export async function respondToTicket(
  ticketId: string,
  _userId: string,
  reply: string
): Promise<void> {
  await apiTickets.update('support', ticketId, { adminReply: reply })
}

/** Closing and reopening need a `reason`; the API refuses them without one. */
export async function setSupportTicketStatus(
  ticketId: string,
  status: SupportTicketStatus,
  reason = ''
): Promise<void> {
  await apiTickets.update('support', ticketId, { status }, reason)
}

export async function setSupportTicketPriority(
  ticketId: string,
  priority: SupportTicketPriority
): Promise<void> {
  await apiTickets.update('support', ticketId, { priority })
}

export async function assignSupportTicket(
  ticketId: string,
  assignedTo: string,
  _assignedToName?: string
): Promise<void> {
  // The server sets the name from the assignee's staff record.
  await apiTickets.update('support', ticketId, { assignedTo })
}

/**
 * Route a support ticket to a CRM department (and optionally a specific
 * person) — the server creates a linked Team Ticket tagged `source: 'app'`,
 * marks the support ticket escalated and links the two. A ticket routes once.
 * A note of at least 3 characters is required (it is the audit reason).
 */
export async function routeSupportTicketToTeam(
  ticket: SupportTicketRecord,
  team: Dept,
  note: string,
  _routedBy?: { name: string },
  assignTo?: { uid: string; name: string }
): Promise<void> {
  await apiTickets.routeSupport(ticket.id, team, note, assignTo?.uid ?? '')
}

export async function closeTicket(ticketId: string, reason: string): Promise<void> {
  await apiTickets.update('support', ticketId, { status: 'closed' }, reason)
}

// ── Broadcasts ─────────────────────────────────────────────────────────────
//
// ── The two sides did not agree on the field names ───────────────────────────
//
// This CRM wrote `message`. The Android app has only ever read `title` and
// `body` (`ChatRepository.broadcastsFlow` → `BroadcastMessage`), so every
// broadcast ever sent from here rendered in the app as an empty card: an
// OFFICIAL chip, a timestamp, and two blank lines where the announcement should
// have been. Nothing failed and nothing logged; the message simply was not
// there.
//
// The app is the reader and its names are therefore the canonical ones — and
// fixing the writer is also much the smaller and safer change, because a writer
// change ships the moment the CRM deploys while a reader change waits on an APK
// release that the people already holding the old build will never get.
//
// So: the writer below emits `title` / `body` / `imageUrl` / `targetGender`,
// exactly what the app reads. `senderName` stays because this CRM's own history
// list shows it. `message` is NOT written any more — nothing has ever read it —
// and both readers tolerate its absence:
//
//   * here, `body ?? message`, so the documents already in the collection keep
//     rendering in the history below;
//   * in the app, the same fallback, so those same documents stop being blank
//     cards on any build that carries it.

export interface BroadcastRecord {
  id: string
  /** The headline. Empty on anything written before the writer was fixed. */
  title: string
  /** The announcement. Falls back to the legacy `message` field. */
  body: string
  imageUrl: string
  senderName: string
  createdAt: Timestamp | null
}

export async function getBroadcasts(): Promise<BroadcastRecord[]> {
  const q = query(
    collection(db, 'broadcasts'),
    orderBy('createdAt', 'desc'),
    limit(100)
  )
  const snap = await getDocs(q)
  return snap.docs.map((d) => {
    const data = d.data()
    return {
      id: d.id,
      title: data.title ?? '',
      // `message` is what every document written before this fix carries. Read
      // it rather than showing an empty history row beside a broadcast that was
      // genuinely sent.
      body: data.body ?? data.message ?? '',
      imageUrl: data.imageUrl ?? '',
      senderName: data.senderName ?? 'Zipper Team',
      createdAt: data.createdAt ?? null,
    }
  })
}

/**
 * Write a broadcast in the shape the Android app reads.
 *
 * `targetGender` is written as `'all'` — the app parses the field and defaults
 * to the same value, and it currently filters on nothing at all, so this
 * records the intended audience without claiming a filter that does not exist.
 * Give this screen an audience control and it becomes load-bearing; until then
 * it is documentation.
 */
export async function sendBroadcast(
  title: string,
  body: string,
  senderName: string,
): Promise<void> {
  await addDoc(collection(db, 'broadcasts'), {
    title,
    body,
    senderName,
    imageUrl: '',
    targetGender: 'all',
    createdAt: serverTimestamp(),
    type: 'admin',
  })
}

// ── Stats ──────────────────────────────────────────────────────────────────

/**
 * Dashboard KPIs.
 *
 * Every figure here is a COUNT, so each one uses `getCountFromServer`:
 * Firestore returns the count without shipping a single document. Previously
 * this downloaded up to 1,000 user docs just to read `.size`, which was both
 * ~1,000 wasted reads per dashboard load AND wrong the moment the platform
 * passed 1,000 users (the cap silently became the reported total).
 *
 * `allSettled`, not `all`. Only the revenue leg used to be guarded, so a
 * refused `kycSubmissions` or `agencies` count — which is what EVERY `*_member`
 * role gets, by the rules as written — rejected the whole `Promise.all` and
 * `app/page.tsx` rendered nothing: no stats, no skeleton, no error. Ten reads,
 * ten answers, each one either a number or the reason there isn't one.
 *
 * This function no longer rejects. There is nothing left for it to reject
 * about: a failure is a value now, and the page has to render it.
 */
export async function getStats(): Promise<StatsResult> {
  const usersRef = collection(db, 'users')

  const settled = await Promise.allSettled([
    countOf(query(usersRef)),
    countOf(query(usersRef, where('isHost', '==', true))),
    countOf(query(collection(db, 'liveRooms'), where('isActive', '==', true))),
    countOf(query(usersRef, where('isSeller', '==', true), where('isOnline', '==', true))),
    countOf(query(usersRef, where('isSeller', '==', true))),
    countOf(query(collection(db, 'kycSubmissions'), where('status', '==', 'pending'))),
    countOf(query(collection(db, 'agencies'), where('status', '==', 'pending'))),
    countOf(query(collection(db, 'supportTickets'), where('status', '==', 'open'))),
    countOf(query(usersRef, where('isBanned', '==', true))),
  ])

  const labels = [
    'getStats/totalUsers',
    'getStats/totalHosts',
    'getStats/activeLives',
    'getStats/coinSellersOnline',
    'getStats/totalSellers',
    'getStats/pendingKyc',
    'getStats/pendingAgencies',
    'getStats/openTickets',
    'getStats/bannedUsers',
  ]
  const [
    totalUsers,
    totalHosts,
    activeLives,
    coinSellersOnline,
    totalSellers,
    pendingKyc,
    pendingAgencies,
    openTickets,
    bannedUsers,
  ] = settled.map((r, i) => fromSettled(r, labels[i]))

  // Revenue is read separately because it is not a count and rounds to ₹.
  let estimatedRevenueINR: ReadResult<number>
  try {
    const revenue = await getPlatformStats()
    estimatedRevenueINR = { ok: true, value: Math.round(revenue.totalRevenue) }
  } catch (err) {
    estimatedRevenueINR = toFailure(err, 'getStats/estimatedRevenueINR')
  }

  return {
    totalUsers,
    totalHosts,
    activeLives,
    estimatedRevenueINR,
    coinSellersOnline,
    totalSellers,
    pendingKyc,
    pendingAgencies,
    openTickets,
    bannedUsers,
  }
}

// ── Server-side counts (no documents downloaded) ───────────────────────────

export async function countUsers(): Promise<number> {
  return countOf(query(collection(db, 'users')))
}

export async function countAgents(): Promise<number> {
  return countOf(query(collection(db, 'users'), where('isAgent', '==', true)))
}

export async function countSellers(): Promise<number> {
  return countOf(query(collection(db, 'users'), where('isSeller', '==', true)))
}

export async function countActiveLiveRooms(): Promise<number> {
  return countOf(query(collection(db, 'liveRooms'), where('isActive', '==', true)))
}

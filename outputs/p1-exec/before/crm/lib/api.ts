'use client'

/**
 * Client for the Zipper API — the business record and money core.
 *
 * Everything that moves money, and everything that must be audited, goes
 * through here. Firestore is still read directly for real-time app state
 * (live rooms, presence), but no balance is ever written from the browser.
 *
 * Session handling: the user signs in with Firebase as before, then we
 * exchange that ID token for an API session token. The session token is what
 * every subsequent call carries.
 */

import { getAuth } from 'firebase/auth'
import type { UserRoles } from './userRoleActions'

// In production the API is served from the same origin via a Hosting rewrite,
// so a relative path avoids CORS entirely. Locally it runs on its own port.
const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ??
  (typeof window !== 'undefined' && window.location.hostname === 'localhost'
    ? 'http://127.0.0.1:8080'
    : '')

const TOKEN_KEY = 'zipperApiSession'
const RENEW_AT_KEY = 'zipperApiSessionRenewAt'

// ── Session token ─────────────────────────────────────────────────────────────
//
// ── localStorage, not sessionStorage, and the trade-off is real ──────────────
//
// This was `sessionStorage`, which is scoped to one tab and cleared when that
// tab closes. Firebase's own session is not: it lives in IndexedDB and survives
// a closed tab, a closed browser and a restarted machine. So the two halves of
// one identity had different lifetimes, and the mismatch is half the bug —
// every new tab and every browser restart produced a Firebase-authenticated
// person with no API session, and the CRM had to mint a new one from scratch
// before a single money or audit screen could load.
//
// The case FOR sessionStorage is a shared machine: close the tab, and the token
// is gone. It is a real argument and it is why the original choice was made.
// It does not survive contact with this application, for one reason — **the
// Firebase refresh token is in IndexedDB either way**. Somebody who walks up to
// an unlocked machine with the tab closed opens the CRM, Firebase restores the
// session out of IndexedDB, and `signInWithFirebase()` mints a brand new API
// token for them. sessionStorage was buying nothing at all against that
// attacker, while costing the reload behaviour the owner is complaining about.
// Against XSS the two are identical: script on the page reads either one.
//
// So the token now lives where the identity it belongs to already lives, and
// what actually limits the damage is on the server: every renewal rotates the
// token and revokes the one it replaces, deactivation revokes every session for
// a uid, and each renewal is one audit entry with an IP on it.
//
// A cookie marked `HttpOnly` would beat both and is the right eventual answer.
// It is not this change: all three API clients here send `Authorization:
// Bearer`, the API is same-origin in production and cross-origin locally, and
// moving to cookies means CSRF protection on every mutating route. Worth doing
// deliberately, not as a side effect of fixing a session length.

let memoryToken: string | null = null
let renewAtMemory: number | null = null
let storageWorks = true

function store(): Storage | null {
  if (typeof window === 'undefined' || !storageWorks) return null
  try {
    return window.localStorage
  } catch {
    storageWorks = false // private browsing, or storage disabled
    return null
  }
}

/**
 * Carry a token written by the previous build out of `sessionStorage`.
 *
 * Without this, the deploy that changes where the token lives signs out
 * everybody who is signed in at that moment — which is precisely the thing
 * being fixed. Runs once, and removes the old key so it cannot come back.
 */
function migrateFromSessionStorage(target: Storage): void {
  try {
    const legacy = window.sessionStorage.getItem(TOKEN_KEY)
    if (legacy && !target.getItem(TOKEN_KEY)) target.setItem(TOKEN_KEY, legacy)
    if (legacy) window.sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    /* nothing to carry over */
  }
}

let migrated = false

/**
 * The session token as it stands **now**.
 *
 * Storage is read on every call rather than cached, and that is load-bearing:
 * renewal rotates the token, and two tabs share one localStorage. A tab holding
 * a remembered copy of a token another tab has already replaced would send a
 * revoked token and be signed out for it. The in-memory copy is only a fallback
 * for private browsing, where there is no shared storage to disagree with.
 */
export function getSessionToken(): string | null {
  const s = store()
  if (!s) return memoryToken
  if (!migrated) {
    migrated = true
    migrateFromSessionStorage(s)
  }
  try {
    memoryToken = s.getItem(TOKEN_KEY)
  } catch {
    storageWorks = false
  }
  return memoryToken
}

export function setSessionToken(token: string | null): void {
  memoryToken = token
  const s = store()
  if (!s) return
  try {
    if (token) s.setItem(TOKEN_KEY, token)
    else {
      s.removeItem(TOKEN_KEY)
      s.removeItem(RENEW_AT_KEY)
    }
  } catch {
    storageWorks = false
  }
}

/** When the server says this session should be renewed. Null if unknown. */
export function getSessionRenewAt(): number | null {
  const s = store()
  if (!s) return renewAtMemory
  try {
    const raw = s.getItem(RENEW_AT_KEY)
    renewAtMemory = raw ? Date.parse(raw) : null
  } catch {
    storageWorks = false
  }
  return Number.isFinite(renewAtMemory as number) ? renewAtMemory : null
}

function setSessionRenewAt(iso: string | null): void {
  renewAtMemory = iso ? Date.parse(iso) : null
  const s = store()
  if (!s) return
  try {
    if (iso) s.setItem(RENEW_AT_KEY, iso)
    else s.removeItem(RENEW_AT_KEY)
  } catch {
    storageWorks = false
  }
}

/**
 * Is it time to renew?
 *
 * True only when there is a session AND the server's `renew_at` for it has
 * passed. An unknown `renew_at` is deliberately **not** treated as due.
 *
 * That case is the token carried over from the build before this one, which
 * has no stored schedule. Renewing it on sight would be one pointless round
 * trip for everybody on the deploy — and, for the observer, worse than
 * pointless: their session cannot be renewed at all, so it would be refused
 * and would sign them out of a session that had hours left. Leaving it alone
 * costs nothing, because a token with no schedule is an old twelve-hour one
 * that will 401 within the day, and the 401 path renews it inside the grace
 * window without anybody noticing.
 *
 * For the observer, `renew_at` equals the expiry — the server says so — so
 * this only goes true once their session has genuinely ended.
 */
export function sessionNeedsRenewal(now: number = Date.now()): boolean {
  if (!getSessionToken()) return false
  const at = getSessionRenewAt()
  return at !== null && now >= at
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }

  /** A refusal by a business rule, not a system failure. Show it to the user. */
  get isRule(): boolean {
    return this.status === 400 || this.status === 403
  }

  get isAuth(): boolean {
    return this.status === 401
  }
}

// ── A 401 mid-session ─────────────────────────────────────────────────────────

/**
 * Dispatched on `window` when the API rejects a call with 401.
 *
 * Clearing the token was all that used to happen, and nothing was listening for
 * it. The result: the shell kept rendering a signed-in CRM — sidebar, name,
 * role badge, every link — while every call from that moment on threw
 * `Not signed in`. The session was gone and the only thing that said so was a
 * red banner on whichever screen the person happened to be looking at.
 *
 * `ApiError.isAuth` existed for exactly this and had no callers.
 */
export const API_UNAUTHORIZED_EVENT = 'zipper:api-unauthorized'

export interface ApiUnauthorizedDetail {
  /** What the server said, verbatim. Show it — do not paraphrase it. */
  message: string
  /** The API path that was refused. For the console, not for the screen. */
  path: string
}

/** The `CustomEvent` shape a listener receives. */
export type ApiUnauthorizedEvent = CustomEvent<ApiUnauthorizedDetail>

/**
 * Announce that a call carrying this session was refused.
 *
 * Called from the 401 branch of all three API clients — `lib/api.ts`,
 * `lib/apiPartners.ts` and `lib/apiReports.ts`.
 *
 * ── It no longer throws the token away, and that is the point ────────────────
 * It used to open with `setSessionToken(null)`. That made recovery impossible:
 * the refused token is the **evidence renewal is built on** — `/auth/refresh`
 * takes it, checks the revocation record behind it and re-reads the account —
 * so destroying it on the way past left `AuthProvider` with a 401, no token and
 * nothing to do but put a red banner on the screen. Which is the complaint.
 *
 * So the announcement is now just an announcement. `AuthProvider` listens,
 * renews once, and the session it gets back replaces this one. If renewal is
 * refused — deactivated, revoked, demoted, away too long — *that* is when the
 * token is cleared, by `endSession()` below, and only then is anybody asked
 * to sign in.
 *
 * Deliberately NOT called for the local `ApiError('Not signed in', 401)` thrown
 * before a request goes out, nor for a 401 on a call that carried no session at
 * all (a wrong password on `/auth/signin`, a refused `/auth/refresh`). Both say
 * nothing about a session that may still be perfectly good.
 */
export function reportUnauthorized(detail: ApiUnauthorizedDetail): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<ApiUnauthorizedDetail>(API_UNAUTHORIZED_EVENT, { detail }),
  )
}

/**
 * Throw the session away for good.
 *
 * The other half of the split above: this is what runs when renewal has been
 * *refused*, not merely when a call was rejected. After it, the CRM has no
 * credential and the person is asked to sign in.
 */
export function endSession(): void {
  setSessionToken(null)
}

// ── Core request ──────────────────────────────────────────────────────────────

async function request<T>(
  path: string,
  options: RequestInit & { auth?: boolean } = {},
): Promise<T> {
  const { auth = true, headers, ...rest } = options

  const finalHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((headers as Record<string, string>) ?? {}),
  }

  if (auth) {
    const token = getSessionToken()
    if (!token) throw new ApiError('Not signed in', 401)
    finalHeaders.Authorization = `Bearer ${token}`
  }

  let response: Response
  try {
    response = await fetch(`${API_BASE}/api${path}`, { ...rest, headers: finalHeaders })
  } catch (err) {
    throw new ApiError(
      'Could not reach the server. Check your connection and try again.',
      0,
      err,
    )
  }

  if (response.status === 204) return undefined as T

  let body: unknown = null
  const text = await response.text()
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }

  if (!response.ok) {
    const detail =
      (body as { detail?: unknown })?.detail ?? body ?? response.statusText
    const message =
      typeof detail === 'string'
        ? detail
        : Array.isArray(detail)
          ? // FastAPI validation errors
            detail
              .map((d: { loc?: string[]; msg?: string }) =>
                `${d.loc?.slice(1).join('.') ?? ''} ${d.msg ?? ''}`.trim(),
              )
              .join('; ')
          : 'Request failed'

    // Clears the token AND announces it, so the shell can stop pretending.
    //
    // `auth` is what makes this correct, and it is new. Before, ANY 401 from
    // this function cleared the session — including a 401 from `/auth/signin`
    // (a wrong password) and, once renewal existed, a 401 from `/auth/refresh`.
    // The second one is a loop: a refused renewal would clear the token, the
    // announcement would reach `AuthProvider`, and `AuthProvider`'s answer to
    // an announcement is to renew. It never gets the chance to run, because a
    // 401 on a call that carried no session is a **sign-in** failure and says
    // nothing about a session that may still be perfectly good.
    if (response.status === 401 && auth) reportUnauthorized({ message, path })
    throw new ApiError(message, response.status, detail)
  }

  return body as T
}

const get = <T>(path: string) => request<T>(path)
const post = <T>(path: string, body?: unknown, auth = true) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}), auth })
const patch = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) })

// ── Types ─────────────────────────────────────────────────────────────────────

export type ApiRole =
  | 'observer' | 'owner'
  | 'app_admin' | 'app_member'
  | 'ops_admin' | 'ops_member'
  | 'finance_admin' | 'finance_member'
  | 'tech_admin' | 'tech_member'
  | 'support_admin' | 'support_member'
  | 'marketing_admin' | 'marketing_member'
  | 'agency' | 'seller'

export type Team = 'app' | 'ops' | 'finance' | 'tech' | 'support' | 'marketing'

export type Stage =
  | 'requested' | 'under_review' | 'awaiting_signoff'
  | 'approved' | 'executed' | 'rejected' | 'failed'

export interface ApiUser {
  uid: string
  email: string
  name: string
  role: ApiRole
  team: Team | null
}

export interface Who {
  uid: string
  name: string
  role: string
  team: string | null
}

export interface Card {
  id: string
  type: string
  team: Team
  title: string
  amount: number
  currency: string
  reason: string
  subject: { type: string; id: string }
  payload: Record<string, unknown>
  evidence: { label?: string; url?: string }[]
  stage: Stage
  requested_by: Who
  created_at: string
  updated_at: string
  verified_by: Who | null
  verified_at: string | null
  verification_note: string | null
  auto_verified: boolean
  signed_by: Who | null
  signed_at: string | null
  executed_at: string | null
  execution_result: Record<string, unknown> | null
  rejected_by: Who | null
  rejected_at: string | null
  rejection_reason: string | null
}

export interface Inbox {
  to_verify: number
  to_sign: number
  mine_pending: number
  total: number
}

export interface AuditEntry {
  id: string
  at: string
  actor: Who
  action: string
  subject: { type: string; id: string }
  before: unknown
  after: unknown
  reason: string
  card_id: string | null
  meta: Record<string, unknown>
}

// Users and moderation. The profile itself lives in Firestore because the
// Android app reads it there; what the API owns is the record of what was done
// to an account — every call below is audited against a named actor.

export type DeviceType = 'android_id' | 'imei'
export type ReportAction = 'warn' | 'suspend' | 'ban' | 'deduct' | 'dismiss'

/**
 * Where an appeal ended up.
 *
 * `resolved` is not a verdict and nobody chose it. It is what the server writes
 * when an admin lifts the ban or suspension directly — through the user screen,
 * not through this queue — while an appeal about it is still waiting. The
 * restriction is gone, so there is nothing left to decide, but no reviewer ever
 * read the statement and the appeal was neither accepted nor refused.
 *
 * See `AppealStatus` in `backend/app/services/appeals.py`, and
 * `lib/appealStatus.ts` for how each one is shown.
 */
export type AppealStatus = 'pending' | 'upheld' | 'overturned' | 'resolved'
/**
 * What a reviewer may choose. A strict subset of `AppealStatus`, and that is
 * the point: `pending` is a state rather than a decision, and `resolved` is
 * something the system records rather than something anybody decides. Keeping
 * this type narrow is what makes both unselectable in the decide modal without
 * a runtime check that somebody could forget.
 */
export type AppealVerdict = 'upheld' | 'overturned'
export type AppealKind = 'ban' | 'report'

/** One appeal, as the raiser wrote it and the reviewer left it. */
/** UGP-F: one attachment of an appeal, as a short-lived signed link. */
export interface AppealEvidenceLink {
  url: string | null
  error: string
  kind: 'image' | 'video' | string
  contentType: string
  size: number
}

export interface Appeal {
  id: string
  /** `public_web` for an appeal filed on the public page (UGP-F). */
  source?: string
  /** The reference the appellant was given, on a public-web appeal. */
  reference?: string
  /** Private attachments (paths, not URLs) — read through `appealEvidence`. */
  evidence?: { path: string; contentType: string; kind: string; size: number }[]
  subjectUid: string
  subjectName?: string
  raisedByUid: string
  raisedByName?: string
  /** `self` when the account speaks for itself, `agency` when its agency does,
   *  `public` when it came through the public appeal page (UGP-F). */
  raisedByRole?: 'self' | 'agency' | 'public'
  agencyId?: string
  kind: AppealKind
  /** Set when a specific report decision is being contested. */
  reportId?: string
  statement: string
  evidenceUrls?: string[]
  status: AppealStatus
  createdAt?: string | { seconds: number } | null
  decisionReason?: string
  /**
   * The reviewer who decided it. Present only on `upheld` and `overturned` —
   * the server deliberately leaves it unset on `resolved`, because inventing a
   * reviewer for an administrative removal would also satisfy the four-eyes
   * check the next time anybody looked. Never fall back to a generic
   * "a reviewer" for a status that had none; ask `isReviewerDecision()` first.
   */
  decidedByName?: string
  decidedAt?: string | { seconds: number } | null
  /** Who removed the restriction, on a `resolved` appeal. Not a reviewer. */
  resolvedByName?: string
  resolvedAt?: string | { seconds: number } | null
  /** Which admin action closed it — `unban` or `resume`. */
  resolvedTrigger?: string
  autoResolved?: boolean
  /** What an overturn actually changed. */
  reversed?: string[]
  /** What it could not change, and needs a separate act. */
  outstanding?: string[]
}

export interface AppealOutcome {
  appeal_id: string
  /**
   * A verdict, not any status: this is the response to `decideAppeal`, and that
   * endpoint rejects anything outside `VERDICTS`. It can never come back
   * `pending` or `resolved`, so the banner that renders "Appeal {status}." is
   * typed to say so.
   */
  status: AppealVerdict
  subject_uid: string
  /**
   * What was reversed, and what was not.
   *
   * Both are shown to the reviewer. A ban lifts here and now; beans that have
   * already been paid out need a credit an owner signs, and reporting
   * "overturned" without saying so would be the same lie as a report marked
   * actioned that banned nobody.
   */
  reversed: string[]
  outstanding: string[]
  audit_id: string
}
export type ReportStatus = 'pending' | 'reviewed' | 'actioned' | 'dismissed'

/** The only currencies a user account can hold. Coins and commission cannot. */
export type UserCurrency = 'diamonds' | 'beans'

/** What a moderation call returns: the change it made, and the audit entry. */
export interface ModerationResult {
  uid: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  audit_id: string
  warning_id?: string
}

/** UGP-D: what `POST /users/{uid}/warn` answers. */
export interface WarnResult extends ModerationResult {
  /** True when this was a retry of a request the server had already done. */
  replayed?: boolean
  deduction?: {
    currency: UserCurrency
    amount: number
    card_id: string
    card_stage: string
    /** Always false: a deduction is a card an owner signs. */
    moved: boolean
    note: string
  } | null
}

/** UGP-B: `GET /users/{uid}/roles`. The shape lives in `lib/userRoleActions.ts`. */
export type UserRolesResponse = UserRoles

/**
 * What deciding a host application returns.
 *
 * `account` is the host grant or revocation that went with the decision, and it
 * is **null when none was needed** — refusing an invitation nobody has redeemed
 * changes no account, and refusing an applicant who never became a host changes
 * none either. Null is not a failure; `note` says which of those it was.
 */
export interface HostApplicationDecision {
  application_id: string
  /** The app account, or '' when nobody has redeemed the referral code yet. */
  uid: string
  before: { status: string; kycStatus: string }
  after: { status: string; kycStatus: string }
  audit_id: string
  account: ModerationResult | null
  /** Written to be shown. Empty when the decision did everything it implies. */
  note: string
}

/**
 * What applying or refusing a proposed change to a host's details did.
 *
 * `refused` is the list the server would not write. A proposal is data a
 * browser put into `pendingChanges`, and Firestore constrains which top-level
 * keys that write may occupy but says nothing about what is inside it — so the
 * server keeps its own allow-list of payout and identity fields, and anything
 * outside it comes back here named rather than applied. It is normally empty;
 * a non-empty list is worth reading out loud, because nothing in the product
 * puts those keys in a proposal.
 */
export interface HostPendingChangesDecision {
  application_id: string
  approved: boolean
  /** Fields written onto the live application. Empty on a refusal. */
  applied: string[]
  refused: string[]
  audit_id: string
  /** Written to be shown. */
  note: string
}

export interface UserWarning {
  id: string
  reason: string
  issuedAt: string | null
  issuedBy: string
  issuedByName: string
  issuedByRole: string
}

export interface BannedDevice {
  id: string
  deviceId: string
  deviceType: DeviceType
  reason: string
  userUids: string[]
  isActive: boolean
  bannedBy: string
  bannedByName: string
  bannedByRole: string
  bannedAt: string | null
}

export interface DeviceBanResult {
  device_id: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  audit_id: string
}

/** A report as the app wrote it, plus whatever the review added. */
export interface UserReport {
  id: string
  reporterUid?: string
  reporterName?: string
  targetUid?: string
  targetName?: string
  targetType?: string
  reason?: string
  description?: string
  status?: ReportStatus
  actionTaken?: string | null
  reviewReason?: string
  reviewedBy?: string
  reviewedByName?: string
  reviewedAt?: string | null
  outcomeAuditId?: string | null
  outcomeUid?: string | null
  createdAt?: string | null
}

/** The result of deciding a report — `enforced` says whether it was carried out. */
export interface ReportOutcome {
  report_id: string
  action: ReportAction
  status: ReportStatus
  target_uid: string | null
  /**
   * Whether the consequence has ALREADY happened.
   *
   * False for `deduct`, and that is not a failure: a deduction raises a card
   * and the beans move when an owner signs it. Telling a reviewer "done" about
   * money that has not moved is the same lie this queue was rebuilt to end.
   */
  enforced: boolean
  /** The money-board card a deduction raised. Null for every other action. */
  card_id: string | null
  outcome: ModerationResult | null
  audit_id: string
}

export interface StaffMember {
  uid: string
  email: string
  name: string
  phone?: string
  role: ApiRole
  team: Team | null
  field_charge?: string | null
  reports_to?: string
  is_active: boolean
  created_at?: string
  // ── The business fields ─────────────────────────────────────────────────────
  //
  // Set by an owner (pay) or by an owner or the person's own team admin (the
  // rest) through PATCH /staff/{uid}/employment, and read back by their holder
  // through GET /staff/me. Never on `CrmUser`: the Firestore `crmUsers`
  // document is readable by every member of staff, so a salary there would be a
  // salary published to the team.
  //
  // Optional on this interface because `GET /staff` — the roster — returns rows
  // that predate these fields, and because a row may simply have none of them
  // recorded yet.
  employment_id?: string | null
  /** Smallest currency unit, like every other money figure in this API. */
  salary_minor?: number | null
  salary_currency?: string | null
  joined_at?: string | null
}

/** What `PATCH /staff/{uid}/employment` accepts. Omit a field to leave it. */
export interface EmploymentChange {
  employment_id?: string
  salary_minor?: number
  salary_currency?: string
  joined_at?: string
  field_charge?: string
}

// ── Auth ──────────────────────────────────────────────────────────────────────

/** What every session endpoint returns. `renew_at` is when to come back. */
interface SessionResponse {
  token: string
  expires_at: string
  renew_at: string
  user: ApiUser
}

/** Adopt a freshly issued session. One place, so `renew_at` cannot be dropped. */
function adopt(res: SessionResponse): ApiUser {
  setSessionToken(res.token)
  setSessionRenewAt(res.renew_at ?? null)
  return res.user
}

/** Who the API says we are, on the token in storage right now. */
const fetchMe = () => get<ApiUser>('/auth/me')

export const auth = {
  /**
   * Exchange the current Firebase session for an API session.
   *
   * This **establishes** a session; `refresh` below extends one. The
   * distinction matters: this one is reachable whenever Firebase has a user,
   * and Firebase's session never expires, so it can never be the thing that
   * decides somebody has been away too long. It is what runs on a first
   * sign-in, and on a machine where the API token is genuinely absent.
   */
  async signInWithFirebase(): Promise<ApiUser> {
    const fbUser = getAuth().currentUser
    if (!fbUser) throw new ApiError('Sign in with Firebase first', 401)

    // ── FORCED REFRESH, AND IT IS NOT AN OPTIMISATION ──────────────────────
    //
    // `storage.rules` authorises on `request.auth.token.role`, a custom claim
    // set outside the browser — by the API for staff
    // (`services/storage_claims.py`) and by the `syncStorageRoleClaim`
    // trigger for agencies and sellers. A claim written after the token in
    // hand was minted is simply not in it, and Firebase will not notice for
    // up to an hour.
    //
    // Without `true` here, the people most affected are exactly the ones who
    // cannot work around it: a newly invited reviewer signs in, opens the KYC
    // queue and is refused every document in it, with nothing on screen
    // explaining why and nothing they can do but wait. Same for an agency the
    // moment it is created, and for anyone whose role just changed.
    //
    // The cost is one network round-trip on sign-in only. `getIdToken()`
    // elsewhere in this file stays cached.
    const idToken = await fbUser.getIdToken(true)
    return adopt(await post<SessionResponse>('/auth/signin', { id_token: idToken }, false))
  },

  /**
   * Replace the session in storage with a fresh one. Silent when it works.
   *
   * Sent unauthenticated on purpose — the token is in the body, not the header
   * — so that a refusal here does NOT go through `reportUnauthorized`. If it
   * did, a refused renewal would announce a lost session, `AuthProvider` would
   * answer the announcement by renewing, and the two would chase each other.
   *
   * The server refuses this when the account was deactivated, when its role
   * changed, when the session was revoked, when the holder is the observer,
   * and when the token expired longer ago than the grace window. Every one of
   * those means a password, and the caller must not paper over it by falling
   * back to `signInWithFirebase()` — which would succeed, because Firebase is
   * still perfectly happy, and would defeat all five refusals at once.
   */
  async refresh(): Promise<ApiUser> {
    const token = getSessionToken()
    if (!token) throw new ApiError('No session to renew', 401)
    try {
      return adopt(await post<SessionResponse>('/auth/refresh', { token }, false))
    } catch (err) {
      // Two tabs, one session. Renewal rotates and revokes, so whichever tab
      // arrives second sends a token the server has just killed and is refused
      // — even though the person is perfectly signed in and the live token is
      // already sitting in the localStorage both tabs share.
      //
      // So: if storage no longer holds what we sent, another tab won the race.
      // Its token and its `renew_at` are already stored; all this tab is
      // missing is the identity behind them. One extra call, and no second
      // renewal — otherwise two tabs could rotate each other in circles.
      const current = getSessionToken()
      if (err instanceof ApiError && err.isAuth && current && current !== token) {
        return await fetchMe()
      }
      throw err
    }
  },

  /**
   * Decision 16 (RC): why the API refuses the CURRENT Firebase login — asked
   * only by the CRM door for a partner login it already refuses as inactive,
   * so a rejected applicant sees the API's reason ("This application was not
   * approved: … You may apply again") instead of "deactivated" (lib/crmDoor).
   *
   * Never adopts a session. Should the API unexpectedly issue one, it is
   * revoked on the spot with its own token and nothing is stored. Returns ''
   * when the API cannot be asked or gave no refusal.
   */
  async refusalForCurrentLogin(): Promise<string> {
    const fbUser = getAuth().currentUser
    if (!fbUser) return ''
    let idToken: string
    try {
      idToken = await fbUser.getIdToken()
    } catch {
      return ''
    }
    try {
      const issued = await post<SessionResponse>('/auth/signin', { id_token: idToken }, false)
      await request('/auth/signout', {
        method: 'POST',
        body: '{}',
        auth: false,
        headers: { Authorization: `Bearer ${issued.token}` },
      }).catch(() => undefined)
      return ''
    } catch (err) {
      return err instanceof ApiError && (err.status === 401 || err.status === 403) ? err.message : ''
    }
  },

  /** Observer: ask for a one-time code. It is emailed, never returned. */
  requestObserverCode: () =>
    post<{ message: string; sent_to: string; expires_in_minutes: number }>(
      '/auth/observer/request-code',
      {},
      false,
    ),

  async verifyObserverCode(code: string): Promise<ApiUser> {
    return adopt(await post<SessionResponse>('/auth/observer/verify-code', { code }, false))
  },

  me: fetchMe,

  async signOut(): Promise<void> {
    try {
      await post('/auth/signout')
    } catch {
      /* the session is going away regardless */
    }
    setSessionToken(null)
  },
}

// ── Money board ───────────────────────────────────────────────────────────────

export const cards = {
  list: (stage?: Stage, limit = 100) =>
    get<Card[]>(`/cards?${stage ? `stage=${stage}&` : ''}limit=${limit}`),

  inbox: () => get<Inbox>('/cards/inbox'),

  awaitingSignature: () => get<Card[]>('/cards/awaiting-signature'),

  raise: (body: {
    type: string
    team: Team
    title: string
    amount: number
    currency: string
    reason: string
    subject_type: string
    subject_id: string
    payload?: Record<string, unknown>
    evidence?: unknown[]
  }) => post<Card>('/cards', body),

  startReview: (id: string) => post<Card>(`/cards/${id}/review`),
  verify: (id: string, note: string) => post<Card>(`/cards/${id}/verify`, { note }),
  sign: (id: string, note = '') => post<Card>(`/cards/${id}/sign`, { note }),
  reject: (id: string, reason: string) => post<Card>(`/cards/${id}/reject`, { reason }),

  signBulk: (ids: string[]) =>
    post<{ signed: number; failed: { card_id: string; error: string }[]; cards: Card[] }>(
      '/cards/sign-bulk',
      ids,
    ),
}

// ── Audit ─────────────────────────────────────────────────────────────────────

export const audit = {
  list: (params: {
    action?: string
    actor_uid?: string
    subject_type?: string
    subject_id?: string
    since?: string
    until?: string
    limit?: number
    skip?: number
  } = {}) => {
    const q = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
    })
    return get<AuditEntry[]>(`/audit?${q.toString()}`)
  },

  historyFor: (subjectType: string, subjectId: string) =>
    get<AuditEntry[]>(`/audit/history/${subjectType}/${subjectId}`),
}

// ── Staff ─────────────────────────────────────────────────────────────────────

export const staff = {
  list: (includeInactive = false) =>
    get<StaffMember[]>(`/staff?include_inactive=${includeInactive}`),

  /**
   * The caller's own record, including the fields /profile shows as locked.
   *
   * Takes no uid, because the one thing this must not do is let somebody read a
   * salary by naming an id. Refused to agency and coin seller sessions by the
   * API's partner-reachability gate — they have no staff record.
   *
   * Returns `{}` for a session with no row (the observer, by design). Callers
   * should treat an empty object as "nothing recorded", not as an error.
   */
  me: () => get<StaffMember>('/staff/me'),

  assignableRoles: () => get<{ roles: ApiRole[] }>('/staff/assignable-roles'),

  overview: () =>
    get<{ team: string; headcount: number; roles: string[] }[]>('/staff/overview'),

  invite: (body: {
    email: string
    name: string
    role: ApiRole
    phone?: string
    field_charge?: string
  }) => post<StaffMember>('/staff', body),

  changeRole: (uid: string, role: ApiRole, reason: string) =>
    patch<StaffMember>(`/staff/${uid}/role`, { role, reason }),

  deactivate: (uid: string, reason: string) =>
    post<StaffMember>(`/staff/${uid}/deactivate`, { reason }),

  /**
   * Set the business facts on somebody's record — salary, employment id,
   * joining date, field charge. The API refuses a team admin who names anyone
   * but their own direct report, and refuses anyone but an owner the two pay
   * fields, so a 400 from here is a rule and its message is worth showing.
   */
  setEmployment: (uid: string, changes: EmploymentChange, reason: string) =>
    patch<StaffMember>(`/staff/${uid}/employment`, { ...changes, reason }),
}

// ── Users and moderation ──────────────────────────────────────────────────────

/**
 * Moderation is direct — a ban takes effect on the call, no signature (5.6).
 * Money is not: a balance change raises a card and moves nothing until an owner
 * signs it, which is why `requestBalanceChange` returns a `Card`.
 *
 * Every mutating call takes a reason, and the API refuses without one. Collect
 * it in the UI rather than sending a request that is going to be rejected.
 */
export const users = {
  ban: (uid: string, reason: string) =>
    post<ModerationResult>(`/users/${uid}/ban`, { reason }),

  unban: (uid: string, reason: string) =>
    post<ModerationResult>(`/users/${uid}/unban`, { reason }),

  /**
   * Suspend an account — temporarily, and WITHOUT barring the device.
   *
   * `days` is what makes a suspension temporary. Without it the endpoint wrote
   * no `suspendedUntil`, so the nightly sweep that ends suspensions could never
   * see it and every CRM suspension was indefinite in practice while the copy
   * implied otherwise. Omit it deliberately for an indefinite one.
   */
  suspend: (uid: string, reason: string, days?: number) =>
    post<ModerationResult>(`/users/${uid}/suspend`, { reason, days }),

  /**
   * Resume a suspended account. NOT the same call as unban.
   *
   * Un-suspending used to go through `unban`, which wrote the wrong audit
   * action and lifted device bans a suspension never created. The server
   * refuses this on a banned account and refuses `unban` on a suspended one,
   * so the two cannot be used interchangeably by accident.
   */
  resume: (uid: string, reason: string) =>
    post<ModerationResult>(`/users/${uid}/resume`, { reason }),

  /**
   * A formal warning — optionally with a deduction (UGP-D).
   *
   * `requestId` is generated once per open dialog and reused on a retry, so a
   * timed-out request that is pressed again is the SAME warning on the server
   * (no second warning, count, card or notice). A deduction never moves money
   * here: it raises a `balance_debit` card linked to the warning, which an owner
   * signs on the money board. The server checks the currency against the
   * person's roles, the amount against the live balance, and asks for
   * `can_adjust_balance`.
   */
  warn: (
    uid: string,
    reason: string,
    opts: { requestId?: string; deduction?: { currency: UserCurrency; amount: number } } = {},
  ) =>
    post<WarnResult>(`/users/${uid}/warn`, {
      reason,
      ...(opts.requestId ? { request_id: opts.requestId } : {}),
      ...(opts.deduction ? { deduction: opts.deduction } : {}),
    }),

  /**
   * What this person holds, from the authoritative records, with the ROLE
   * actions the server allows on each (UGP-B). The user page renders Revoke /
   * Restore from this and from nothing else.
   */
  roles: (uid: string) => get<UserRolesResponse>(`/users/${encodeURIComponent(uid)}/roles`),

  /** Restore a revoked Host role from the person's existing records (UGP-B). */
  restoreHost: (uid: string, reason: string) =>
    post<ModerationResult>(`/users/${uid}/restore-host`, { reason }),

  grantHost: (uid: string, reason: string, agencyId = '') =>
    post<ModerationResult>(`/users/${uid}/grant-host`, {
      reason,
      agency_id: agencyId,
    }),

  revokeHost: (uid: string, reason: string) =>
    post<ModerationResult>(`/users/${uid}/revoke-host`, { reason }),

  /**
   * Decide one host application — the only writer of that decision.
   *
   * A `hostApplications` document used to be decided by three different screens
   * and only one of them wrote both of its status fields, so `status` and
   * `kycStatus` drifted apart and no screen agreed with any other about whether
   * an application had been decided. This call writes both together, with who
   * decided, when and why, and it is the only thing that writes either.
   *
   * It also does what the decision is for: approving makes the applicant's
   * account a host attached to the inviting agency, refusing takes that back.
   * One call, because the failure it closes is somebody doing one without the
   * other.
   *
   * **Approving is refused until the applicant has redeemed their referral code
   * in the app**, since until then there is no account to grant anything to. The
   * API says so in a sentence written to be shown. Rejecting works either way —
   * it cancels the invitation and the code stops working.
   */
  decideHostApplication: (applicationId: string, approve: boolean, reason: string) =>
    post<HostApplicationDecision>(
      `/users/host-applications/${encodeURIComponent(applicationId)}/decide`,
      { approve, reason },
    ),

  /**
   * Apply or refuse a change PROPOSED to a host's payout or identity details.
   *
   * Not the same call as `decideHostApplication`, and the separation is the
   * point: that one decides whether the applicant becomes a host, this one
   * decides whether their bank account moves. An approved host whose account
   * number changes has not been re-approved, and recording it as though they
   * had would hide the interesting fact inside an approval nobody disputes.
   *
   * **Nothing in a browser can do what this does.** `firestore.rules` refuses
   * every client a write to a host's bank details, documents or legal identity;
   * a change to any of them is parked in `pendingChanges` with the live fields
   * untouched, and this is the only thing that moves them.
   *
   * Approving writes the proposed values onto the application and clears the
   * proposal. Refusing clears it, touches no live field, and stores the reason
   * on the record so the change is not simply resubmitted.
   *
   * **The proposer cannot be the approver.** A host has no dashboard, so every
   * proposal here was written by staff or by the recruiting agency on the
   * host's behalf; the API refuses when the two uids match, with a sentence
   * written to be shown.
   */
  decideHostPendingChanges: (applicationId: string, approve: boolean, reason: string) =>
    post<HostPendingChangesDecision>(
      `/users/host-applications/${encodeURIComponent(applicationId)}/pending-changes/decide`,
      { approve, reason },
    ),

  setSellerFlag: (uid: string, isSeller: boolean, reason: string) =>
    post<ModerationResult>(`/users/${uid}/seller-flag`, {
      is_seller: isSeller,
      reason,
    }),

  /** Raises a card. Nothing moves until an owner signs it. */
  requestBalanceChange: (
    uid: string,
    currency: UserCurrency,
    amount: number,
    reason: string,
  ) => post<Card>(`/users/${uid}/balance-request`, { currency, amount, reason }),

  /**
   * Move the money for a signed balance card. **Owners only.**
   *
   * `requestBalanceChange` raises the card and an owner signs it; the card then
   * sits at Approved and the balance is still untouched. This is the call that
   * moves it. Without it a correction goes Requested → verified → signed →
   * Approved and stops there forever, which reads on the board as done.
   *
   * Verified against `backend/app/routers/users.py:143` →
   * `services/users.py:539`. It returns the **card**, at stage `executed`
   * (`services/cards.py:282` `mark_executed`).
   *
   * Failure is not neutral, and there are two kinds:
   *
   *   * Insufficient balance — the card is set to `failed` server-side and
   *     *then* a 400 is raised. The money did not move and the card is visibly
   *     stuck. Re-read the board after any failure: the card has changed stage
   *     even though this call threw.
   *   * Already applied — the ledger already holds this card's movement, so the
   *     card is closed as `executed` and a 400 is still raised. The money DID
   *     move. The message says so; show it verbatim rather than treating it as
   *     a plain failure.
   *
   * The card id is the idempotency key, so a retry after a timeout cannot
   * double-apply.
   */
  executeBalanceCard: (cardId: string) =>
    post<Card>(`/users/balance-cards/${encodeURIComponent(cardId)}/execute`),

  warnings: (uid: string, limit = 100) =>
    get<UserWarning[]>(`/users/${uid}/warnings?limit=${limit}`),

  /** Everything ever done to this account, from the append-only audit log. */
  history: (uid: string, limit = 200) =>
    get<AuditEntry[]>(`/users/${uid}/history?limit=${limit}`),

  // Device bans. The document is keyed by device id, which is the path the
  // Android app reads — lifting one deletes it, because the app only checks
  // that it exists.
  bannedDevices: (limit = 200) =>
    get<BannedDevice[]>(`/users/devices/bans?limit=${limit}`),

  /**
   * Bar a device by hand.
   *
   * `manual: true` marks it as Ops's own decision rather than a side effect of
   * an account ban — which matters when an account is later unbanned, because
   * that lifts only the device bans its own ban created and leaves a manual one
   * standing. Sent explicitly so the intent is in the request rather than in a
   * server-side default nobody reading this can see.
   */
  banDevice: (body: {
    device_id: string
    device_type: DeviceType
    reason: string
    user_uids?: string[]
  }) => post<DeviceBanResult>('/users/devices/bans', { ...body, manual: true }),

  unbanDevice: (deviceId: string, reason: string) =>
    post<DeviceBanResult>(
      `/users/devices/bans/${encodeURIComponent(deviceId)}/unban`,
      { reason },
    ),

  // ── Appeals ─────────────────────────────────────────────────────────────
  //
  // Raised by the account itself from the app, or by its agency from the
  // dashboard — both write Firestore directly, gated by rules. Only the
  // DECISION comes through here, because only the server can reverse anything.

  appeals: (status?: AppealStatus, limit = 100) => {
    const q = new URLSearchParams({ limit: String(limit) })
    if (status) q.set('status', status)
    return get<Appeal[]>(`/users/appeals?${q.toString()}`)
  },

  decideAppeal: (appealId: string, verdict: AppealVerdict, reason: string) =>
    post<AppealOutcome>(`/users/appeals/${appealId}/decide`, { verdict, reason }),

  /**
   * UGP-F: fifteen-minute signed links to an appeal's PRIVATE attachments
   * (public-web appeals store object paths, never download URLs).
   */
  appealEvidence: (appealId: string) =>
    get<{ evidence: AppealEvidenceLink[] }>(`/users/appeals/${encodeURIComponent(appealId)}/evidence`),

  // Reports queue.
  reports: (status?: ReportStatus, limit = 200) => {
    const q = new URLSearchParams({ limit: String(limit) })
    if (status) q.set('status', status)
    return get<UserReport[]>(`/users/reports?${q.toString()}`)
  },

  /** Decides a report *and* carries the decision out. `ban` bans the user. */
  /**
   * Decide a report and carry the decision out.
   *
   * `days` belongs to `suspend` and `beans` to `deduct`, and the server refuses
   * either anywhere else rather than ignoring it — a number typed into the
   * wrong box means the reviewer has misunderstood what they are about to do,
   * and silently dropping it confirms the misunderstanding.
   *
   * `deduct` RAISES A CARD. No beans move until an owner signs it, so the
   * response comes back `enforced: false` with a `card_id`.
   */
  actionReport: (
    reportId: string,
    action: ReportAction,
    reason: string,
    extra: { days?: number; beans?: number } = {},
  ) =>
    post<ReportOutcome>(`/users/reports/${reportId}/action`, {
      action,
      reason,
      ...(extra.days !== undefined ? { days: extra.days } : {}),
      ...(extra.beans !== undefined ? { beans: extra.beans } : {}),
    }),
}

// ── Host identity verification ────────────────────────────────────────────────

/**
 * The review queue and the verdict, transcribed from
 * `backend/app/services/verification.py` — `list_pending`, `get_for_review` and
 * `review`. Field names are Firestore's camelCase because the records are
 * Firestore documents the API passes through, not API-shaped payloads.
 *
 * Approving is not cosmetic: it sets `users/{uid}.isVerifiedHost`, which
 * `releaseBeansForWeek` checks before releasing a week's earnings and which
 * `functions/src/calls.ts` checks before letting a host earn at their own call
 * rate rather than the base one. So an approval here is the moment a host
 * becomes payable and the moment their rate ladder starts.
 */
export interface PendingVerification {
  uid: string
  hostName: string
  agencyId: string
  status: string
  attemptCount: number
  /** The comparator's score, or null when no comparator ran at all. */
  aiScore: number | null
  aiThreshold: number | null
  aiProvider: string | null
  /** `below_threshold` or `no_ai` — a reviewer reads the two differently. */
  manualReason: string
  capturedAt: string | null
  lastRejectedAt: string | null
}

/**
 * One case, with both photographs behind signed URLs.
 *
 * ── The two URLs are biometric data and are treated as such ──────────────────
 *
 * A face is biometric data under the DPDP Act. The server mints these per
 * review and they expire in fifteen minutes (`SIGNED_URL_TTL`), so they are
 * deliberately NOT cached, NOT logged, and NOT put anywhere but the `src` of
 * the image the reviewer is looking at. Re-open the case to get fresh ones.
 *
 * Either may be null. `agencyPhotoMissing` tells the two absences apart: the
 * agency never uploaded one, versus the signing failed. The first is itself the
 * finding — a host cannot be compared against a picture that does not exist.
 */
export interface VerificationCase extends PendingVerification {
  applicationId: string
  agencyPhotoSignedUrl: string | null
  captureSignedUrl: string | null
  agencyPhotoMissing: boolean
  captureMissing: boolean
  /**
   * Why an image that EXISTS could not be linked to. Empty in the ordinary
   * case.
   *
   * This is not a fact about the host. Signing runs on the API's own runtime
   * credentials, so when it fails it fails for the whole queue — and it did,
   * silently, until the server started reporting it: every face rendered as a
   * grey box reading "could not be read", which is indistinguishable from a
   * host who uploaded nothing and is exactly the mistake that gets somebody
   * rejected for an outage.
   */
  signingError: string
  /** The note from the last review, if this host has been rejected before. */
  previousNote: string
}

/** What `POST /host-verification/{uid}/review` returns. */
export interface VerificationVerdict {
  uid: string
  before: { status: string; isVerifiedHost: boolean }
  after: { status: string; isVerifiedHost: boolean }
  audit_id: string
  /**
   * True on a rejection, and it means what it says: unreleased weeks are
   * SKIPPED by the weekly payout run, not discarded. A host who passes a later
   * attempt is paid everything they earned while unverified. Say so on screen —
   * a reviewer who believes rejecting destroys a week's earnings will approve
   * cases they should not.
   */
  beansHeldNotLost: boolean
}

/** One document behind a short-lived signed URL. */
export interface SignedDocument {
  /** Which document on the record: `doc1`..`doc3`, `photo`, `proof`, `qr`. */
  slot: string
  label: string
  /** A 15-minute signed URL, or `null` when it could not be signed. */
  url: string | null
  /** Why it could not be signed. Empty when `url` is set. */
  error: string
}

export interface SignedDocumentBatch {
  /** Keyed `"{kind}:{id}"`. A record the caller may not see is absent. */
  documents: Record<string, SignedDocument[]>
  expires_in_seconds: number
}

export interface SignedDocumentSet {
  kind: DocumentKind
  id: string
  documents: SignedDocument[]
  expires_in_seconds: number
}

export type DocumentKind = 'agency' | 'seller' | 'host' | 'coin_purchase'

/**
 * KYC and identity documents, behind short-lived signed URLs.
 *
 * ── WHY THIS EXISTS RATHER THAN RENDERING THE STORED URL ───────────────────
 *
 * Every KYC document was stored as the string `getDownloadURL()` returned —
 * `.../o/<object>?alt=media&token=<uuid>`. That is a permanent bearer
 * credential: Storage Security Rules are not consulted when one is used, so
 * whoever holds the string reads the file, forever, unauthenticated, from
 * anywhere. Tightening `storage.rules` does not touch it, because a download
 * URL does not take the SDK path.
 *
 * The API authorises the caller and mints a fifteen-minute URL instead. The
 * permanent string never reaches a browser.
 *
 * Fetch when the reviewer opens the record and throw the result away when
 * they close it — same contract as `hostVerification.get`.
 */
export const documents = {
  forRecord: (kind: DocumentKind, recordId: string) =>
    get<SignedDocumentSet>(`/documents/${kind}/${encodeURIComponent(recordId)}`),

  /**
   * Many records, one request. Keys are `"{kind}:{id}"`.
   *
   * For list views. Through `forRecord` a fifty-row host list would be fifty
   * HTTP requests to draw one page, which is why those lists were still
   * rendering the permanent stored URL — the secure path was too expensive to
   * adopt. This is the version that is not.
   *
   * `slots` narrows what gets signed. A list showing one reference photograph
   * per row passes `['photo']` so the server does not also sign three KYC
   * documents per row that the row will never render.
   *
   * A record the caller may not see is simply absent from the result, and the
   * call still succeeds — so a list containing one unreachable row renders the
   * other forty-nine.
   */
  batch: (refs: { kind: DocumentKind; id: string }[], slots: string[] = []) => {
    const q = new URLSearchParams()
    for (const r of refs) if (r.id) q.append('ref', `${r.kind}:${r.id}`)
    for (const s of slots) q.append('slot', s)
    return get<SignedDocumentBatch>(`/documents/batch?${q.toString()}`)
  },
}

export const hostVerification = {
  /** Oldest first, server-side — whoever has waited longest cannot withdraw. */
  pending: (limit = 50) =>
    get<PendingVerification[]>(`/host-verification/pending?limit=${limit}`),

  /**
   * One case. Fetch it when the reviewer opens it and throw the result away
   * when they close it — the signed URLs it carries are short-lived by design.
   */
  get: (uid: string) =>
    get<VerificationCase>(`/host-verification/${encodeURIComponent(uid)}`),

  /**
   * Approve or reject. Immediate, attributed and audited.
   *
   * `reason` is mandatory on BOTH verdicts and the API refuses fewer than three
   * characters — a rejected host is told to ask their agency to re-upload, so
   * somebody has to be able to find out what was wrong with the last attempt.
   */
  review: (uid: string, verdict: 'verified' | 'rejected', reason: string) =>
    post<VerificationVerdict>(
      `/host-verification/${encodeURIComponent(uid)}/review`,
      { verdict, reason },
    ),
}

// ── Partners ──────────────────────────────────────────────────────────────────

export const partners = {
  agencyStatement: (id: string, params: { since?: string; until?: string } = {}) => {
    const q = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => v && q.set(k, v))
    return get<{
      agency_id: string
      name: string
      commission_earned: number
      commission_paid: number
      commission_outstanding: number
      host_count: number
      entries: Record<string, unknown>[]
    }>(`/partners/agencies/${id}/statement?${q}`)
  },

  /**
   * Per-host earnings for one agency.
   *
   * `since` matters more than it looks. Without it the endpoint returns standing
   * lifetime earnings, so a screen showing "week of 4 Aug" alongside these rows
   * would be putting a lifetime number under a weekly heading. Pass the start of
   * the period you are displaying.
   */
  agencyHosts: (id: string, opts?: { since?: string; limit?: number }) => {
    const q = new URLSearchParams()
    if (opts?.since) q.set('since', opts.since)
    if (opts?.limit) q.set('limit', String(opts.limit))
    const qs = q.toString()
    return get<{ host_id: string; beans_earned: number; movements: number }[]>(
      `/partners/agencies/${id}/hosts${qs ? `?${qs}` : ''}`,
    )
  },

  sellerStatement: (id: string) =>
    get<{
      seller_id: string
      name: string
      coins_purchased: number
      coins_lent: number
      coins_sold: number
      coins_on_hand: number
      /** Cash recorded against this seller, in minor units (paise). */
      cash_paid_minor: number
      credit_outstanding: number
      credit_standing: CreditStanding
      credit_due_at: string | null
      entries: Record<string, unknown>[]
    }>(`/partners/sellers/${id}/statement`),

  creditExposure: () =>
    get<{ total_outstanding: number; sellers_with_credit: number; total_sellers: number }>(
      '/partners/credit/exposure',
    ),

  overdueSellers: () =>
    get<{ id: string; name: string; outstanding: number; days_overdue: number }[]>(
      '/partners/credit/overdue',
    ),
}

// ── Partner operations ────────────────────────────────────────────────────────

export type PartnerKind = 'agency' | 'sub_agency' | 'seller'
export type PartnerStatus = 'pending' | 'approved' | 'rejected' | 'suspended'
export type CreditStanding = 'none' | 'current' | 'due_soon' | 'overdue' | 'written_off'

export interface PartnerRecord {
  id: string
  kind: PartnerKind
  name: string
  status: PartnerStatus
  parent_id?: string | null
  rejection_reason?: string | null
  credit?: {
    outstanding: number
    due_at?: string | null
    terms?: string
  }
  credit_standing?: CreditStanding
  coins_on_hand?: number
  commission_outstanding?: number
  created_at?: string
}

/**
 * One earlier card carrying the same payment reference.
 *
 * The endpoint returns a plain array of these — NOT an object with a `matches`
 * field. An earlier version of this type said otherwise, which would have made
 * `.matches` undefined and reported every duplicate as clean. On a screen whose
 * whole job is catching a reused UTR, that failure would have been silent and
 * would have looked like the check working.
 */
export interface PaymentRefMatch {
  card_id: string
  type: string
  stage: Stage
  amount: number
  /** The seller the earlier card belonged to. */
  subject_id: string
  created_at: string
}

export type SaleStatus = 'pending' | 'approved' | 'failed'

/**
 * A filed sale. Verified against `record_sale` / `approve_sale` in
 * `backend/app/services/partner_ops.py:1203` and `:1264` — these are the
 * fields the documents actually carry, not what the name suggests.
 *
 * Filing one moves nothing. Approving it debits the seller's coin inventory
 * **first** and only then credits the buyer's diamonds, so a seller short of
 * stock stops the sale before any diamonds exist.
 */
export interface Sale {
  id: string
  seller_id: string
  buyer_uid: string
  /** Diamonds sold. The same number is debited from the seller in coins. */
  diamonds: number
  /** What the buyer paid, in INR minor units (paise). */
  amount_paid_minor: number
  status: SaleStatus
  reason: string
  recorded_by: Who
  created_at: string
  updated_at: string
  approved_by: Who | null
  approved_at: string | null
  /** Set once approved. */
  approval_reason?: string
  /**
   * Set only in the one state that needs a human: the seller was debited and
   * the buyer could not be credited. It is not a refusal — value has moved.
   */
  failure?: string
}

/** What `POST /partner-ops/sales/{id}/approve` adds on top of the sale. */
export interface SaleApproval extends Sale {
  /** The seller's coin balance after the debit. */
  seller_coins_after: number
  /** The buyer's diamond balance after the credit. */
  buyer_diamonds_after: number
  total_coins_sold: number
  /** False means Mongo moved but the Firestore replica did not. */
  replica_synced: boolean
}

/**
 * A sub-agency payout, tracked as two legs.
 *
 * Leg 1 is us paying the parent agency. Leg 2 is the parent paying the sub.
 * A payout is not closed until leg 2 is confirmed — leg 1 paid with leg 2 still
 * pending means our money has left against a sub-agency that may not have been
 * paid, which is exactly the state worth surfacing.
 */
export interface SubAgencyPayout {
  id: string
  parent_id: string
  sub_id: string
  amount_minor: number
  status: string
  card_id?: string
  leg1: {
    description: string
    status: string
    paid_at: string | null
    payment_ref: string | null
    by: Who | null
  }
  leg2: {
    description: string
    status: string
    confirmed_at: string | null
    reason: string | null
    by: Who | null
  }
  created_at: string
  updated_at: string
}

// ── UGP-F: the public appeal (no session) ──────────────────────────────────

export interface PublicAppealLookup {
  state: 'appealable' | 'appeal_pending' | 'not_found'
  /** Masked ("G**** y****"). Nothing else about the account is ever returned
   *  without a session — not ban versus suspension, not a pending appeal's
   *  reference (UGP review). */
  name_hint?: string
  message?: string
}

export const publicAppeals = {
  /** Which account these details name, masked — or "not found" (also for an unrestricted one). */
  lookup: (accountId: string, displayName: string) =>
    post<PublicAppealLookup>(
      '/public/appeals/lookup',
      { account_id: accountId, display_name: displayName },
      false,
    ),

  /** File the appeal. Multipart, because of the attachments. Never signed in. */
  submit: async (form: {
    accountId: string
    displayName: string
    statement: string
    files: File[]
  }): Promise<{ reference: string; status: string }> => {
    const fd = new FormData()
    fd.append('account_id', form.accountId)
    fd.append('display_name', form.displayName)
    fd.append('statement', form.statement)
    for (const f of form.files) fd.append('files', f)
    let response: Response
    try {
      response = await fetch(`${API_BASE}/api/public/appeals`, { method: 'POST', body: fd })
    } catch (err) {
      throw new ApiError('Could not reach the server. Check your connection and try again.', 0, err)
    }
    const text = await response.text()
    let body: unknown = null
    if (text) {
      try { body = JSON.parse(text) } catch { body = text }
    }
    if (!response.ok) {
      const detail = (body as { detail?: unknown })?.detail ?? body ?? response.statusText
      throw new ApiError(typeof detail === 'string' ? detail : 'The appeal could not be sent.', response.status, detail)
    }
    return body as { reference: string; status: string }
  },
}

export const partnerOps = {
  list: (params: { kind?: PartnerKind; status?: PartnerStatus; limit?: number } = {}) => {
    const q = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => v !== undefined && q.set(k, String(v)))
    return get<PartnerRecord[]>(`/partner-ops/partners?${q}`)
  },
  get: (id: string) => get<PartnerRecord>(`/partner-ops/partners/${id}`),

  approve: (id: string, reason: string) =>
    post(`/partner-ops/partners/${id}/approve`, { reason }),
  reject: (id: string, reason: string) =>
    post(`/partner-ops/partners/${id}/reject`, { reason }),
  deactivate: (id: string, reason: string) =>
    post(`/partner-ops/partners/${id}/deactivate`, { reason }),
  reactivate: (id: string, reason: string) =>
    post(`/partner-ops/partners/${id}/reactivate`, { reason }),

  /**
   * Check a payment reference before raising a purchase.
   *
   * A hit does not block the card — it flags it, so an owner sees the reuse
   * before signing. The same UTR could previously be submitted indefinitely.
   */
  checkPaymentRef: (ref: string) =>
    get<PaymentRefMatch[]>(`/partner-ops/payment-references/${encodeURIComponent(ref)}`),

  requestCoinPurchase: (
    sellerId: string,
    body: {
      coins: number
      amount_paid_minor: number
      payment_ref: string
      evidence_url?: string
      reason: string
    },
  ) => post<Card>(`/partner-ops/sellers/${sellerId}/coin-purchases`, body),
  executeCoinPurchase: (cardId: string) =>
    post(`/partner-ops/coin-purchases/${cardId}/execute`),

  requestLending: (
    sellerId: string,
    body: { coins: number; due_at: string; terms?: string; reason: string },
  ) => post<Card>(`/partner-ops/sellers/${sellerId}/lending`, body),
  executeLending: (cardId: string) => post(`/partner-ops/lending/${cardId}/execute`),

  requestRepayment: (
    sellerId: string,
    body: { coins: number; payment_ref?: string; reason: string },
  ) => post<Card>(`/partner-ops/sellers/${sellerId}/repayments`, body),
  executeRepayment: (cardId: string) => post(`/partner-ops/repayments/${cardId}/execute`),

  requestRecovery: (
    sellerId: string,
    body: { coins: number; penalty_coins?: number; reason: string },
  ) => post<Card>(`/partner-ops/sellers/${sellerId}/recoveries`, body),
  executeRecovery: (cardId: string) => post(`/partner-ops/recoveries/${cardId}/execute`),

  requestWriteOff: (partnerId: string, body: { coins: number; reason: string }) =>
    post<Card>(`/partner-ops/partners/${partnerId}/write-off`, body),
  executeWriteOff: (cardId: string) => post(`/partner-ops/write-offs/${cardId}/execute`),

  /**
   * File a sale. Nothing moves — the sale sits at `pending` until it is
   * approved. `backend/app/routers/partner_ops.py:377`.
   *
   * `reason` is not optional in practice: the service refuses a blank one on
   * approval and generates a fallback here, so send a real one.
   */
  recordSale: (body: {
    seller_id: string
    buyer_uid: string
    diamonds: number
    /** Cash taken, in INR minor units (paise). */
    amount_paid_minor: number
    reason: string
  }) => post<Sale>('/partner-ops/sales', body),

  /**
   * Sales, newest first. `backend/app/routers/partner_ops.py:393`.
   *
   * Scoped by the server: staff see everything, a seller account sees only its
   * own rows regardless of what `seller_id` says.
   */
  /**
   * PUBLIC. Which partner role (if any) already holds this email / phone —
   * `{ email: 'agency' | 'seller' | null, phone: … }`. For the signup forms to
   * flag a registered address as soon as it is typed.
   */
  registrationAvailability: (email: string, phone: string, kind: '' | 'agency' | 'seller' = '') =>
    request<{ email: 'agency' | 'seller' | null; phone: 'agency' | 'seller' | null }>(
      `/partner-ops/registration/availability?email=${encodeURIComponent(email)}&phone=${encodeURIComponent(phone)}`
        + (kind ? `&kind=${kind}` : ''),
      { auth: false },
    ),

  /**
   * Find a buyer by EXACT uid, email or phone — the CRM cannot list `users`.
   * Contact details come back masked. `GET /partner-ops/buyers/lookup`.
   */
  lookupBuyers: (q: string) =>
    get<{ uid: string; name: string; email: string; phone: string }[]>(
      `/partner-ops/buyers/lookup?q=${encodeURIComponent(q)}`,
    ),

  listSales: (params: { seller_id?: string; status?: SaleStatus; limit?: number } = {}) => {
    const q = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => v !== undefined && q.set(k, String(v)))
    return get<Sale[]>(`/partner-ops/sales?${q}`)
  },

  /**
   * Approve a sale. **Owners only, and this is where inventory moves.**
   * `backend/app/routers/partner_ops.py:406` → `services/partner_ops.py:1264`.
   *
   * The seller is debited before the buyer is credited, on purpose. If the
   * debit fails nothing was created and the sale stays `pending`. If the debit
   * succeeds and the credit fails the sale is marked `failed` and carries
   * `failure` — the seller has lost stock the buyer never received, and that
   * needs a correction card, not a retry.
   */
  approveSale: (saleId: string, reason: string) =>
    post<SaleApproval>(`/partner-ops/sales/${encodeURIComponent(saleId)}/approve`, {
      reason,
    }),

  requestCommissionPayout: (
    agencyId: string,
    body: { amount_minor: number; reason: string },
  ) => post<Card>(`/partner-ops/agencies/${agencyId}/commission-payouts`, body),
  executeCommissionPayout: (cardId: string, payment_ref: string) =>
    post(`/partner-ops/commission-payouts/${cardId}/execute`, { payment_ref }),
  accrueCommission: (
    agencyId: string,
    body: { amount_minor: number; host_id: string; period: string; reason: string },
  ) => post(`/partner-ops/agencies/${agencyId}/commission-accruals`, body),

  /**
   * Raise a host bean withdrawal card. `backend/app/routers/partner_ops.py:1143`.
   *
   * `hostUid` is a **Firebase uid, not a partner record id** — a host is a user
   * of the app and their beans live on `users/{uid}`. Passing an agency id here
   * is a 400 saying no such users document exists.
   *
   * `beans`, not rupees, because the wallet is denominated in beans and the
   * conversion to cash happens at the rate in force when the transfer is made.
   *
   * Refused outright if the amount exceeds the host's **current**
   * `beansAvailable`, which the service reads live from Firestore. Beans are
   * released a week in arrears, so "they earned it" and "they may be paid it"
   * are different figures and the refusal says which one it applied.
   *
   * Nothing moves. The card goes to the board, an owner signs it, and
   * `executeHostWithdrawal` below is what debits the wallet. The response may
   * carry a `warnings` array — an unverified host, or one whose user document
   * names no agency so the payout will bill no commission — which is advisory,
   * not a refusal, and is worth showing before anybody signs.
   */
  requestHostWithdrawal: (
    hostUid: string,
    body: {
      beans: number
      reason: string
      /** P0-7: the queued request this card pays; executing it marks that request paid. */
      request_collection?: 'withdrawalRequests' | 'salaryRequests'
      request_id?: string
    },
  ) =>
    post<Card & { warnings?: string[] }>(
      `/partner-ops/hosts/${encodeURIComponent(hostUid)}/withdrawals`,
      body,
    ),

  /**
   * Pay a signed host withdrawal. **Owners only.**
   * `backend/app/routers/partner_ops.py:1160` → `services/partner_ops.py:4226`.
   *
   * This is the call that moves the beans, and the Firestore debit runs first
   * under a transaction that re-reads `beansAvailable`. Three failures matter
   * and they are not the same:
   *
   *   * the host has spent or converted some of it since the card was raised —
   *     nothing was paid, nothing was debited, the card is `failed`, raise a
   *     fresh one for what is actually available;
   *   * Firestore was unreachable — nothing was paid, card `failed`;
   *   * the wallet WAS debited and the ledger row could not be written — the
   *     beans have gone, the card is `failed` carrying `firestore_debited`, and
   *     it needs a manual correction rather than a retry.
   *
   * All three raise a 400 whose message says which one it was. Show it verbatim
   * and re-read the board afterwards: the card has changed stage even though
   * this call threw. A failed card cannot be executed again, so there is no
   * retry that could debit a wallet twice.
   */
  executeHostWithdrawal: (cardId: string, payment_ref: string) =>
    post<Card>(`/partner-ops/host-withdrawals/${encodeURIComponent(cardId)}/execute`, {
      payment_ref,
    }),

  /**
   * Raise a sub-agency payout, recording both legs from the start.
   *
   * This returns `{card, payout, payout_id}`, **not** a bare card — verified
   * against `backend/app/services/partner_ops.py:1851`. It was typed `Card`
   * here, so `.id` read the card id and any caller that used it as the payout
   * id would have confirmed leg 2 against a document that does not exist.
   * `lib/apiPartners.ts` has always had this right.
   */
  requestSubAgencyPayout: (body: {
    parent_id: string
    sub_id: string
    /** Paise. */
    amount_minor: number
    reason: string
  }) =>
    post<{ card: Card; payout: SubAgencyPayout; payout_id: string }>(
      '/partner-ops/subagency-payouts',
      body,
    ),
  executeSubAgencyPayout: (cardId: string, payment_ref: string) =>
    post(`/partner-ops/subagency-payouts/${cardId}/execute`, { payment_ref }),
  confirmSubAgencyLeg: (payoutId: string, reason: string) =>
    post(`/partner-ops/subagency-payouts/${payoutId}/confirm-leg`, { reason }),
  openSubAgencyPayouts: () =>
    get<SubAgencyPayout[]>('/partner-ops/subagency-payouts/open'),
}

// ── Reports ───────────────────────────────────────────────────────────────────

/**
 * The one envelope every report endpoint returns.
 *
 * Verified against `Report.as_dict()` in `backend/app/services/reports.py:394`.
 * The previous shape here — `name` / `since` / `until` / `provisional` /
 * `rate_note` — matched no response the API has ever produced: the real keys
 * are `report`, `period`, `columns` and `empty`. Reading `.since` off one of
 * these gave `undefined`, and `.rows` happened to work, which is why it went
 * unnoticed.
 *
 * `lib/apiReports.ts` carries the richer per-report row and totals types. This
 * exists for `partnersSummary` and `auditSummary`, which have no wrapper there.
 */
export interface ReportEnvelope<
  Row = Record<string, unknown>,
  Totals = Record<string, unknown>,
> {
  report: string
  title: string
  generated_at: string
  period: Record<string, unknown>
  currency_unit: string
  /** Empty object on reports that value nothing. */
  rates: Record<string, unknown>
  definitions: Record<string, string>
  columns: { key: string; header: string }[]
  rows: Row[]
  totals: Totals
  warnings: string[]
  /** True when the period genuinely had no activity. Never render 0 as a fact. */
  empty: boolean
  /** Only the dashboard, which is not tabular. */
  sections?: Record<string, unknown>
}

/**
 * `GET /reports/definitions` — the published meaning of each figure.
 *
 * Not a report and not an envelope: it has no rows, no period and no totals.
 * Verified against `backend/app/routers/reports.py:462`.
 */
export interface ReportDefinitions {
  /** revenue, payout, commission, margin, bean_payout_ratio, channel, currency */
  definitions: Record<string, string>
  units: {
    money: string
    commission: string
    diamonds_per_lakh: number
  }
  window: { default_days: number; max_days: number; bounds: string }
  rate_fallbacks: Record<string, number | string>
  export: { format: string; logged: string }
}

type Range = { since?: string; until?: string }

function rangeQuery(params: Record<string, unknown>): string {
  const q = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
  })
  return q.toString()
}

export const reports = {
  cashPosition: (r: Range = {}) =>
    get<ReportEnvelope>(`/reports/cash-position?${rangeQuery(r)}`),
  revenue: (r: Range & { group_by?: 'day' | 'week' | 'month' } = {}) =>
    get<ReportEnvelope>(`/reports/revenue?${rangeQuery(r)}`),
  payouts: (r: Range = {}) => get<ReportEnvelope>(`/reports/payouts?${rangeQuery(r)}`),
  margin: (r: Range = {}) => get<ReportEnvelope>(`/reports/margin?${rangeQuery(r)}`),
  channels: (r: Range = {}) => get<ReportEnvelope>(`/reports/channels?${rangeQuery(r)}`),
  agencyStatement: (id: string, r: Range = {}) =>
    get<ReportEnvelope>(`/reports/agencies/${id}/statement?${rangeQuery(r)}`),
  sellerStatement: (id: string, r: Range = {}) =>
    get<ReportEnvelope>(`/reports/sellers/${id}/statement?${rangeQuery(r)}`),
  partnersSummary: (r: Range & { kind?: PartnerKind } = {}) =>
    get<ReportEnvelope>(`/reports/partners/summary?${rangeQuery(r)}`),
  liabilities: () => get<ReportEnvelope>('/reports/liabilities'),
  teamThroughput: (r: Range & { team?: Team } = {}) =>
    get<ReportEnvelope>(`/reports/team-throughput?${rangeQuery(r)}`),
  auditSummary: (r: Range = {}) =>
    get<ReportEnvelope>(`/reports/audit-summary?${rangeQuery(r)}`),
  dashboard: () => get<ReportEnvelope>('/reports/dashboard'),
  definitions: () => get<ReportDefinitions>('/reports/definitions'),

  /**
   * Download any report as CSV.
   *
   * Goes through fetch rather than a plain link so the session token travels in
   * the header, and so a failure surfaces as an error instead of a downloaded
   * HTML error page.
   */
  async downloadCsv(
    path: string,
    params: Record<string, unknown> = {},
    filename?: string,
  ): Promise<void> {
    const token = getSessionToken()
    if (!token) throw new ApiError('Not signed in', 401)

    const q = rangeQuery({ ...params, format: 'csv' })
    const res = await fetch(`${API_BASE}/api/reports/${path}?${q}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const message = text || 'Export failed'
      // This fetch bypasses `request()`, so it needs the 401 handling itself.
      if (res.status === 401) reportUnauthorized({ message, path: `/reports/${path}` })
      throw new ApiError(message, res.status)
    }

    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download =
      filename ??
      res.headers.get('content-disposition')?.match(/filename="?([^"]+)"?/)?.[1] ??
      `${path}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  },
}

// ── Health ────────────────────────────────────────────────────────────────────

export const health = () =>
  request<{ status: string; environment: string }>('/health', { auth: false })

const api = {
  auth, cards, audit, staff, users, hostVerification, documents, partners,
  partnerOps, reports, health,
}
export default api

/**
 * Reinstatement requests (GOV C2) and transfer requests (GOV C3) — what the
 * CRM may OFFER, decided in one place.
 *
 * Pure — no imports, no React, no Firebase — so `npm run test:govrequests`
 * compiles and runs the shipped module.
 *
 * ── THE RULE BOTH OF THESE ENFORCE ──────────────────────────────────────────
 *
 * Turning a REVOKED role back on, and moving a Host or a Sub-agency to another
 * agency, are the Owner's decisions. Reviewers recommend; the Owner decides.
 * The server refuses anybody else with a 403 whatever this module says — this
 * is the courtesy that stops a reviewer pressing a button that was always
 * going to be refused, and that tells them where the decision IS made.
 *
 * Every response shape below is read defensively: the endpoints are new, a
 * list may come back bare or wrapped, and a missing field must not crash a
 * screen or be read as a value.
 */

// ── Shared ──────────────────────────────────────────────────────────────────

/** The minimum a recommendation or a decision note must say. */
export const MIN_NOTE = 10

/** '' when the note is long enough, else the sentence to show. */
export function noteProblem(note: string, min: number = MIN_NOTE): string {
  const n = (note ?? '').trim().length
  if (n >= min) return ''
  return `At least ${min} characters — it is what the Owner reads and what the audit log keeps` +
    (n > 0 ? ` (${n} so far).` : '.')
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * The list inside a response: a bare array, or the array under `key` (or one
 * of the usual wrappers). Anything else is an empty list, never a crash.
 */
export function listFrom<T>(body: unknown, key: string): T[] {
  if (Array.isArray(body)) return body as T[]
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>
    for (const k of [key, 'items', 'results', 'requests']) {
      if (Array.isArray(o[k])) return o[k] as T[]
    }
  }
  return []
}

/** A record's id, whichever spelling the server used. */
export function idOf(row: { id?: unknown; _id?: unknown } | null | undefined): string {
  return text(row?.id) || text(row?._id)
}

// ── C2: reinstatement of a revoked role ─────────────────────────────────────

export type RoleKind = 'host' | 'agency' | 'sub_agency' | 'seller'
export type RoleAppealStatus = 'pending' | 'recommended' | 'restored' | 'kept_revoked'
export type RoleAppealOutcome = 'restore' | 'keep_revoked'

export const ROLE_KIND_LABEL: Record<RoleKind, string> = {
  host: 'Host',
  agency: 'Agency',
  sub_agency: 'Sub-agency',
  seller: 'Coin Seller',
}

export const OUTCOME_LABEL: Record<RoleAppealOutcome, string> = {
  restore: 'Restore the role',
  keep_revoked: 'Keep it revoked',
}

/** Still waiting on the Owner: recommendable and decidable. */
export function roleAppealIsOpen(status: unknown): boolean {
  const s = text(status)
  return s === 'pending' || s === 'recommended'
}

export interface AppealStatusView {
  label: string
  tone: string
  /** One sentence on what this status means for the person. */
  note: string
}

export function presentRoleAppealStatus(status: unknown): AppealStatusView {
  switch (text(status)) {
    case 'pending':
      return {
        label: 'Waiting for a review',
        tone: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30',
        note: 'Nobody has recommended anything yet. The role stays revoked until the Owner decides.',
      }
    case 'recommended':
      return {
        label: 'Recommended — waiting for the Owner',
        tone: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
        note: 'A reviewer has recommended an outcome. Only the Owner turns it into a decision.',
      }
    case 'restored':
      return {
        label: 'Restored',
        tone: 'bg-green-500/15 text-green-300 border-green-500/30',
        note: 'The Owner restored the role on its existing record.',
      }
    case 'kept_revoked':
      return {
        label: 'Kept revoked',
        tone: 'bg-slate-700 text-slate-300 border-slate-600',
        note: 'The Owner decided the role stays revoked. The request is kept as history.',
      }
    default:
      return {
        label: text(status) || 'Unknown',
        tone: 'bg-slate-800 text-slate-400 border-slate-700',
        note: 'This status is not one the CRM knows. Nothing is offered on it.',
      }
  }
}

/**
 * The permission that may RECOMMEND on a request of this kind — the same pair
 * the server checks: `can_approve_kyc` for a Host, Agency or Sub-agency,
 * `can_approve_seller` for a Coin Seller.
 */
export function reviewPermissionFor(kind: unknown): 'can_approve_kyc' | 'can_approve_seller' {
  return text(kind) === 'seller' ? 'can_approve_seller' : 'can_approve_kyc'
}

export interface RoleAppealActions {
  /** A reviewer of this kind (or the Owner) may recommend now. */
  recommend: boolean
  /** The Owner may decide now. Never true for anybody else. */
  decide: boolean
  /** Shown beside a request a non-Owner cannot decide. '' when none. */
  hint: string
}

export const OWNER_DECIDES_REINSTATEMENT =
  'Only the Owner can decide a reinstatement. Recommend an outcome and the Owner is told.'

export function roleAppealActions(
  appeal: { status?: unknown; kind?: unknown },
  me: { isOwner: boolean; permissions: readonly string[] },
): RoleAppealActions {
  const open = roleAppealIsOpen(appeal.status)
  const canReview = me.isOwner || me.permissions.includes(reviewPermissionFor(appeal.kind))
  return {
    recommend: open && canReview,
    decide: open && me.isOwner,
    hint: open && !me.isOwner ? OWNER_DECIDES_REINSTATEMENT : '',
  }
}

/** Where a request's record lives in the CRM. '' when there is no page for it. */
export function roleRecordHref(kind: unknown, recordId: unknown, uid: unknown): string {
  const k = text(kind)
  const id = text(recordId)
  if (k === 'host') return text(uid) ? `/users/${text(uid)}` : ''
  if (!id) return ''
  if (k === 'seller') return `/sellers/${id}`
  if (k === 'agency' || k === 'sub_agency') return `/agencies/${id}`
  return ''
}

// ── Restoring a REVOKED role directly is the Owner's (C2) ───────────────────

export const REVOKED_RESTORE_HINT =
  "Restoring a revoked role is the Owner's decision — use Reinstatement requests"

/**
 * Whether a Restore control on a role in this status needs the Owner.
 *
 * `revoked` → yes (Host restore, partner reactivate, and Approve on a revoked
 * record all turn a revoked role back on). `suspended` → no: lifting a
 * role-level suspension keeps its current permission.
 */
export function restoreNeedsOwner(status: unknown): boolean {
  return text(status) === 'revoked'
}

export interface RestoreGate {
  allowed: boolean
  /** '' when allowed; otherwise the sentence to show beside the control. */
  hint: string
}

export function restoreGate(status: unknown, isOwner: boolean): RestoreGate {
  if (restoreNeedsOwner(status) && !isOwner) return { allowed: false, hint: REVOKED_RESTORE_HINT }
  return { allowed: true, hint: '' }
}

// ── C3: transfers ───────────────────────────────────────────────────────────

export type TransferKind = 'host' | 'sub_agency'
export type TransferStatus = 'pending' | 'approved' | 'rejected'

export function transferIsOpen(status: unknown): boolean {
  return text(status) === 'pending'
}

export function presentTransferStatus(status: unknown): { label: string; tone: string } {
  switch (text(status)) {
    case 'pending':
      return { label: 'Waiting for the Owner', tone: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30' }
    case 'approved':
      return { label: 'Approved — moved', tone: 'bg-green-500/15 text-green-300 border-green-500/30' }
    case 'rejected':
      return { label: 'Rejected — not moved', tone: 'bg-slate-700 text-slate-300 border-slate-600' }
    default:
      return { label: text(status) || 'Unknown', tone: 'bg-slate-800 text-slate-400 border-slate-700' }
  }
}

export const OWNER_DECIDES_TRANSFER =
  'Transfers are decided by the Owner. This request waits for them.'

/** Who may RECOMMEND a transfer: a KYC approver or the Owner (the server's rule). */
export function canRecommendTransfer(me: { isOwner: boolean; permissions: readonly string[] }): boolean {
  return me.isOwner || me.permissions.includes('can_approve_kyc')
}

/** A partner record as the destination picker needs it. */
export interface AgencyOption {
  id: string
  kind: string
  status: string
  is_active: boolean
  parent_id?: string | null
  name?: string
}

function live(p: AgencyOption | undefined): boolean {
  return !!p && text(p.status) === 'approved' && p.is_active === true
}

/**
 * The agencies a subject may be recommended to move to — the server's rule,
 * so the picker offers nothing it would refuse:
 *
 *   sub_agency → an approved, active MAIN agency;
 *   host       → an approved, active main agency, or an approved, active
 *                sub-agency whose main agency is itself approved and active;
 *
 * and never the agency the subject is already under (nor, for a sub-agency,
 * itself). Main agencies first, then by name.
 */
export function transferDestinations(
  kind: TransferKind,
  subject: { id: string; currentAgencyId: string },
  agencies: readonly AgencyOption[],
): AgencyOption[] {
  const byId = new Map(agencies.map((a) => [text(a.id), a]))
  const current = text(subject.currentAgencyId)
  const self = text(subject.id)
  const out = agencies.filter((a) => {
    const id = text(a.id)
    if (!id || id === current || id === self) return false
    if (!live(a)) return false
    if (text(a.kind) === 'agency') return true
    if (kind === 'host' && text(a.kind) === 'sub_agency') {
      const parent = byId.get(text(a.parent_id))
      return !!parent && text(parent.kind) === 'agency' && live(parent)
    }
    return false
  })
  return out.sort((a, b) => {
    const rank = (x: AgencyOption) => (text(x.kind) === 'agency' ? 0 : 1)
    return rank(a) - rank(b) || text(a.name).localeCompare(text(b.name))
  })
}

/** '' when a recommendation may be sent, else the sentence to show. */
export function transferRequestProblem(input: {
  toAgencyId: string
  note: string
  destinations: readonly AgencyOption[]
}): string {
  const to = text(input.toAgencyId)
  if (!to) return 'Choose the agency to move to.'
  if (!input.destinations.some((d) => text(d.id) === to)) {
    return 'That agency is not an eligible destination for this move.'
  }
  return noteProblem(input.note)
}

// ── Revocation that moves dependents (C3) ───────────────────────────────────

/**
 * What the revoke dialog says to a non-Owner when the revocation would move
 * dependents. '' when there is nothing to say — no dependents, or the Owner.
 * The server refuses the non-Owner with 403 either way.
 */
export function revokeTransferNote(
  dependents: { subAgencies: number; hosts: number },
  isOwner: boolean,
): string {
  const n = Math.max(0, dependents.subAgencies) + Math.max(0, dependents.hosts)
  if (n === 0 || isOwner) return ''
  const parts: string[] = []
  if (dependents.hosts > 0) parts.push(`${dependents.hosts} host${dependents.hosts === 1 ? '' : 's'}`)
  if (dependents.subAgencies > 0) {
    parts.push(`${dependents.subAgencies} sub-agenc${dependents.subAgencies === 1 ? 'y' : 'ies'}`)
  }
  return `This revocation moves ${parts.join(' and ')}. Transfers are decided by the Owner — ` +
    'file a transfer recommendation instead. The server refuses this revocation for anyone else.'
}

/**
 * Spec §10 — state-aware actions on user, partner and role rows.
 *
 * Imports only `./crmRoles` and `./backendFeatures` (both import-free), so
 * `npm run test:rolestate` compiles the three and runs the shipped module.
 *
 * ── THE STATE MACHINE ───────────────────────────────────────────────────────
 *
 *   ROLE (one row per role the person holds — a revoked Agency never hides an
 *   active Coin Seller; each row carries its own status and its own actions)
 *
 *     pending                → Review · Approve · Reject
 *     awaiting_verification  → Review · Check and start   (approved, not started;
 *                              starts by itself once both contacts are verified —
 *                              never bypasses them)
 *     approved               → Suspend role · Revoke role
 *     suspended              → Resume role · Revoke role
 *     revoked                → Request reinstatement / Review reinstatement
 *                              (+ Reinstate: the Owner's decision, nobody else's)
 *                              — NEVER an ordinary Activate
 *     rejected               → View
 *
 *   ACCOUNT (the moderation subject, from `crmRoles.userRowActionKeys`)
 *
 *     active     → Ban · Suspend
 *     suspended  → Resume · Ban  (+ Review appeal when one is open)
 *     banned     → Unban ONLY via an authorised appeal (the appeals queue
 *                  decides it) or an Owner's decision; everybody else sees
 *                  why and where
 *
 * ── WHAT THE SERVER STILL DECIDES ───────────────────────────────────────────
 *
 * `revoke` and `restore` are taken from `GET /users/{uid}/roles` (`actions`),
 * which applies the one-role rule — a person's only role is not revoked on
 * its own, the account is suspended instead — and knows whether a revoked
 * Host is restorable. This module never infers either; it only decides what
 * to SHOW for each state, and every call is re-checked on the server.
 *
 * ── THE HOST ROLE ON ITS OWN ─────────────────────────────────────────────────
 *
 * Suspending and resuming the HOST role without touching the account is
 * `POST /users/{uid}/suspend-host` / `resume-host` — the same capability as
 * revoking a Host (`can_approve_kyc`). It was a disabled stub until that route
 * shipped; `backendFeatures.hostRoleSuspension` is now on, and a context that
 * says the reviewer lacks the capability (`canManageHostRole: false`) gets the
 * control disabled with the reason — the server refuses it either way.
 */

import { restrictionOf, userRowActionKeys, type UserRowSubject } from './crmRoles'
import { BACKEND_FEATURES, NEXT_RELEASE_NOTE, type BackendFeatures } from './backendFeatures'

// ── Roles ───────────────────────────────────────────────────────────────────

export type RoleKind = 'host' | 'agency' | 'sub_agency' | 'seller'

/** One role as `GET /users/{uid}/roles` reports it (`services/user_roles.py`). */
export interface RoleRow {
  role: RoleKind
  label?: string
  /** Partner record id; absent for Host. */
  id?: string
  name?: string
  /** Host: `active | suspended | pending | revoked`. Partner: the `PartnerStatus` string. */
  status: string
  is_active?: boolean
  /** What the server allows on this role: `revoke`, `restore`. */
  actions?: string[]
  restorable?: boolean
  application_id?: string
  pending_application_id?: string
  /** A suspended Host role: when it lifts itself (ISO), or null for "until resumed". */
  suspended_until?: string | null
  /** A suspended Host role: why — the sentence the host and their agency were told. */
  suspension_reason?: string
}

export type RoleState =
  | 'pending' | 'awaiting_verification' | 'approved' | 'suspended' | 'revoked' | 'rejected' | 'unknown'

export const ROLE_LABEL: Record<RoleKind, string> = {
  host: 'Host',
  agency: 'Agency',
  sub_agency: 'Sub-agency',
  seller: 'Coin Seller',
}

export const ROLE_STATE_LABEL: Record<RoleState, string> = {
  pending: 'Pending review',
  awaiting_verification: 'Approved — awaiting contact verification',
  approved: 'Active',
  suspended: 'Suspended',
  revoked: 'Revoked',
  rejected: 'Rejected',
  unknown: 'Unknown',
}

/** The lifecycle state of one role row, whichever record family it came from. */
export function roleStateOf(r: RoleRow): RoleState {
  const s = String(r.status ?? '').trim()
  if (r.role === 'host') {
    if (s === 'active') return 'approved'
    // `suspend-host`: the Host role paused on its own, the account untouched.
    if (s === 'pending' || s === 'revoked' || s === 'suspended') return s
    return 'unknown'
  }
  if (s === 'approved') return r.is_active === false ? 'suspended' : 'approved'
  if (s === 'pending' || s === 'awaiting_verification' || s === 'suspended' || s === 'revoked' || s === 'rejected') return s
  return 'unknown'
}

export type RoleActionKind =
  | 'review' | 'approve' | 'reject'
  | 'check_and_start'
  | 'suspend_role' | 'resume_role' | 'revoke_role'
  | 'request_reinstatement' | 'review_reinstatement' | 'reinstate'
  | 'view'

export interface RoleRowAction {
  key: string
  kind: RoleActionKind
  role: RoleKind
  /** Partner record id, or '' for Host. */
  targetId: string
  /** The host application this acts on, when there is one. */
  applicationId: string
  label: string
  /** `link` opens a page; `api` calls the backend; `stub` waits for the next backend release. */
  via: 'link' | 'api' | 'stub'
  href: string
  /** GOV C2: the Owner's decision; disabled for everybody else, with the way forward. */
  ownerOnly: boolean
  disabled: boolean
  hint: string
}

export interface RoleActionContext {
  isOwner: boolean
  /**
   * Open reinstatement request ids by role kind. `undefined` = not known
   * (the read failed or was not made): both Request and Review are offered,
   * which is safe because filing is idempotent on the server.
   */
  openReinstatement?: Partial<Record<RoleKind, string>>
  features?: BackendFeatures
  /**
   * Whether this reviewer holds `can_approve_kyc` — what suspending, resuming
   * and revoking a Host costs on the server. `false` disables Suspend / Resume
   * Host role with the reason; `undefined` (not known) offers them and lets
   * the server answer.
   */
  canManageHostRole?: boolean
}

export const HOST_ROLE_PERMISSION_HINT =
  'Suspending or resuming the Host role needs the KYC-approval permission — the same as revoking it.'

/** Where a role row's record is reviewed. */
export function roleRecordHref(r: RoleRow): string {
  const id = String(r.id ?? '').trim()
  if (r.role === 'host') return '/kyc'
  if (!id) return ''
  return r.role === 'seller' ? `/sellers/${encodeURIComponent(id)}` : `/agencies/${encodeURIComponent(id)}`
}

export const REINSTATEMENT_HINT =
  'A revoked role is never simply re-activated. The person (or a team admin on their behalf) ' +
  'asks for it back; reviewers recommend; the Owner decides on Reinstatement requests.'

export const ONLY_ROLE_HINT =
  'This is the person’s only active role. A single role is not revoked on its own — ' +
  'suspend the account instead.'

function action(
  r: RoleRow,
  kind: RoleActionKind,
  label: string,
  via: RoleRowAction['via'],
  extra: Partial<Pick<RoleRowAction, 'href' | 'ownerOnly' | 'disabled' | 'hint'>> = {},
): RoleRowAction {
  const targetId = r.role === 'host' ? '' : String(r.id ?? '').trim()
  return {
    key: `${kind}:${r.role}:${targetId || r.application_id || ''}`,
    kind,
    role: r.role,
    targetId,
    applicationId: String(r.application_id ?? r.pending_application_id ?? '').trim(),
    label,
    via,
    href: extra.href ?? '',
    ownerOnly: extra.ownerOnly ?? false,
    disabled: extra.disabled ?? false,
    hint: extra.hint ?? '',
  }
}

/** The actions one role row may offer, for its state. */
export function roleRowActions(r: RoleRow, ctx: RoleActionContext): RoleRowAction[] {
  const features = ctx.features ?? BACKEND_FEATURES
  const state = roleStateOf(r)
  const label = ROLE_LABEL[r.role] ?? r.label ?? r.role
  const serverActions = new Set(r.actions ?? [])
  const href = roleRecordHref(r)
  const out: RoleRowAction[] = []

  // A partner record with no id cannot be approved, suspended or revoked by
  // anything — only Host rows legitimately have none.
  const addressable = r.role === 'host' || !!String(r.id ?? '').trim()

  switch (state) {
    case 'pending':
      if (href) out.push(action(r, 'review', 'Review', 'link', { href }))
      if (addressable) {
        out.push(action(r, 'approve', `Approve ${label}`, 'api',
          { hint: r.role === 'host' ? 'Refused until the applicant has redeemed their code in the app.' : '' }))
        out.push(action(r, 'reject', 'Reject', 'api'))
      }
      break
    case 'awaiting_verification':
      if (href) out.push(action(r, 'review', 'Review', 'link', { href }))
      if (addressable && r.role !== 'host') {
        out.push(action(r, 'check_and_start', 'Check and start', 'api',
          { hint: 'Approved; starts once both contacts on the login are verified. Never bypasses them.' }))
      }
      break
    case 'approved':
    case 'suspended': {
      // POST /users/{uid}/suspend-host | resume-host (`can_approve_kyc`).
      const hostLive = features.hostRoleSuspension
      const hostBlocked = hostLive && ctx.canManageHostRole === false
      const hostHint = (live: string) => !hostLive ? NEXT_RELEASE_NOTE : hostBlocked ? HOST_ROLE_PERMISSION_HINT : live
      if (state === 'approved') {
        if (r.role === 'host') {
          out.push(action(r, 'suspend_role', `Suspend ${label} role`, hostLive ? 'api' : 'stub', {
            disabled: !hostLive || hostBlocked,
            hint: hostHint('Only the Host role is paused — the account and its other roles stay. The person and their agency are told.'),
          }))
        } else if (addressable) {
          out.push(action(r, 'suspend_role', `Suspend ${label} role`, 'api',
            { hint: 'Temporary. The record keeps its place; the person is told.' }))
        }
      } else {
        if (r.role === 'host') {
          out.push(action(r, 'resume_role', `Resume ${label} role`, hostLive ? 'api' : 'stub', {
            disabled: !hostLive || hostBlocked,
            hint: hostHint('Lifts the Host-role suspension — the same role, re-activated. The person and their agency are told.'),
          }))
        } else if (addressable) {
          out.push(action(r, 'resume_role', `Resume ${label} role`, 'api',
            { hint: 'Lifts the role-level suspension. The same record, re-activated.' }))
        }
      }
      if (addressable) {
        const may = serverActions.has('revoke')
        out.push(action(r, 'revoke_role', `Revoke ${label} role`, 'api',
          { disabled: !may, hint: may ? 'Only this role is taken away; the account and its other roles stay.' : ONLY_ROLE_HINT }))
      }
      break
    }
    case 'revoked': {
      const known = ctx.openReinstatement !== undefined
      const open = ctx.openReinstatement?.[r.role]
      if (!known || open) {
        out.push(action(r, 'review_reinstatement', 'Review reinstatement', 'link',
          { href: '/role-appeals', hint: REINSTATEMENT_HINT }))
      }
      if (!known || !open) {
        out.push(action(r, 'request_reinstatement', 'Request reinstatement', 'api',
          { hint: 'Files a reinstatement request on the person’s behalf. Reviewers recommend; the Owner decides.' }))
      }
      // The Owner's decision, taken here only when the server says the record
      // can be restored. Never offered to anybody else as an "Activate".
      if (serverActions.has('restore') && (r.role !== 'host' || r.restorable === true)) {
        out.push(action(r, 'reinstate', `Reinstate ${label} (Owner decision)`, 'api',
          { ownerOnly: true, disabled: !ctx.isOwner, hint: ctx.isOwner ? 'Restores the SAME record. Your decision is audited.' : REINSTATEMENT_HINT }))
      }
      break
    }
    case 'rejected':
      if (href) out.push(action(r, 'view', 'View', 'link', { href, hint: 'Rejected. The person may apply again; a new application is reviewed on its own.' }))
      break
    default:
      if (href && r.role !== 'host') out.push(action(r, 'view', 'View', 'link', { href }))
  }
  return out
}

export interface RoleRowView {
  row: RoleRow
  state: RoleState
  label: string
  stateLabel: string
  actions: RoleRowAction[]
}

/** Every role the person holds, EACH with its own status and actions. */
export function roleRows(
  roles: { roles?: RoleRow[] } | RoleRow[] | null | undefined,
  ctx: RoleActionContext,
): RoleRowView[] {
  const list = Array.isArray(roles) ? roles : roles?.roles
  if (!Array.isArray(list)) return []
  return list.map((row) => {
    const state = roleStateOf(row)
    return {
      row,
      state,
      label: ROLE_LABEL[row.role] ?? row.label ?? String(row.role),
      stateLabel: ROLE_STATE_LABEL[state],
      actions: roleRowActions(row, ctx),
    }
  })
}

// ── Accounts ────────────────────────────────────────────────────────────────

export type AccountActionKind = 'ban' | 'suspend' | 'resume' | 'unban' | 'review_appeal'

export interface AccountAction {
  kind: AccountActionKind
  label: string
  via: 'api' | 'link'
  href: string
  ownerOnly: boolean
  disabled: boolean
  hint: string
}

export interface AccountActionContext {
  actorUid?: string | null
  isOwner: boolean
  /** The open appeal from this account, if known. */
  openAppealId?: string
}

export const UNBAN_HINT =
  'A ban is lifted only through an authorised appeal (decided on the appeals queue) or by an ' +
  'Owner’s decision — never as an ordinary action.'

/** `/operations/appeals`, scoped to one account when the queue supports it. */
export function appealsHref(uid: string): string {
  const u = (uid ?? '').trim()
  return u ? `/operations/appeals?uid=${encodeURIComponent(u)}` : '/operations/appeals'
}

/**
 * The account-level actions, from the shared policy, with the banned state
 * gated as the spec says: Unban only via an appeal or an Owner's decision.
 */
export function accountActions(u: UserRowSubject, ctx: AccountActionContext): AccountAction[] {
  const keys = userRowActionKeys(u, ctx.actorUid)
  const out: AccountAction[] = []
  const restriction = restrictionOf(u)
  for (const key of keys) {
    switch (key) {
      case 'ban':
        out.push({ kind: 'ban', label: 'Ban', via: 'api', href: '', ownerOnly: false, disabled: false, hint: '' })
        break
      case 'suspend':
        out.push({ kind: 'suspend', label: 'Suspend', via: 'api', href: '', ownerOnly: false, disabled: false, hint: '' })
        break
      case 'resume':
        out.push({ kind: 'resume', label: 'Resume', via: 'api', href: '', ownerOnly: false, disabled: false, hint: '' })
        break
      case 'unban':
        if (ctx.openAppealId) {
          // The appeal IS the decision: `overturned` lifts the ban server-side.
          out.push({ kind: 'review_appeal', label: 'Review appeal', via: 'link', href: appealsHref(u.uid),
            ownerOnly: false, disabled: false, hint: 'An appeal from this account is open. Deciding it in their favour lifts the ban.' })
        } else {
          out.push({ kind: 'unban', label: ctx.isOwner ? 'Unban (Owner decision)' : 'Unban', via: 'api', href: '',
            ownerOnly: true, disabled: !ctx.isOwner,
            hint: ctx.isOwner ? 'Cite the appeal or decision that authorises this in the reason.' : UNBAN_HINT })
        }
        break
    }
  }
  if (restriction === 'suspended' && ctx.openAppealId) {
    out.push({ kind: 'review_appeal', label: 'Review appeal', via: 'link', href: appealsHref(u.uid),
      ownerOnly: false, disabled: false, hint: 'An appeal from this account is open.' })
  }
  return out
}

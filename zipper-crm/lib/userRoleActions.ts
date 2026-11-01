/**
 * The ROLE actions the user page may offer, and the warning-deduction checks
 * (UGP-B / UGP-D). Pure — no imports, no React — so `npm run test:userroles`
 * runs the shipped module.
 *
 * ── WHERE THE ANSWER COMES FROM ─────────────────────────────────────────────
 *
 * `GET /api/users/{uid}/roles` reads the authoritative records (Mongo
 * `partners`, the Host flag and `hostApplications`) and returns every role
 * with its status and the actions the server allows on it:
 *
 *   * no role                → nothing (a guest sees no "Revoke host");
 *   * ONE active role        → no revoke — suspend the account instead;
 *   * two or more            → "Revoke <role>" on each held role;
 *   * suspended / revoked    → "Restore <role>" (a revoked Host only when its
 *                              application and agency make it restorable).
 *
 * This module turns that answer into buttons and NOTHING ELSE: it never
 * infers a role from the app's display flags (`isHost`, `isSeller`), which is
 * how "Revoke host" and "Remove seller" came to be offered on every account.
 * While the answer is loading, or if it failed, there are no role buttons.
 */

export type RoleKind = 'host' | 'agency' | 'sub_agency' | 'seller'
export type RoleAction = 'revoke' | 'restore'

export interface RoleRecord {
  role: RoleKind
  label: string
  /** Partner record id; absent for Host. */
  id?: string
  name?: string
  /** `active | pending | revoked` for Host; the partner status otherwise. */
  status: string
  actions: RoleAction[]
  restorable?: boolean
  verified?: boolean
  agency_id?: string
}

export interface UserRoles {
  uid: string
  held_count: number
  roles: RoleRecord[]
  /** Which currency a warning deduction may take, for this person. */
  deduction_currencies: string[]
  verified_contact: boolean
}

export interface RoleButton {
  key: string
  kind: RoleAction
  role: RoleKind
  /** Partner record id, or '' for Host. */
  targetId: string
  label: string
  title: string
  effect: string
  confirmLabel: string
  /**
   * GOV C2: true for a RESTORE of a REVOKED role. Turning a revoked role back
   * on is the Owner's decision — the server answers anybody else with 403 —
   * so the page disables it for everybody else and points them at
   * Reinstatement requests. Lifting a role-level SUSPENSION is not this and
   * keeps its current permission.
   */
  ownerOnly: boolean
}

const LABEL: Record<RoleKind, string> = {
  host: 'Host',
  agency: 'Agency',
  sub_agency: 'Sub-agency',
  seller: 'Coin Seller',
}

export function roleButtons(roles: UserRoles | null | undefined): RoleButton[] {
  if (!roles || !Array.isArray(roles.roles)) return []
  const out: RoleButton[] = []
  for (const r of roles.roles) {
    const label = LABEL[r.role] ?? r.label ?? r.role
    for (const kind of r.actions ?? []) {
      if (kind !== 'revoke' && kind !== 'restore') continue
      const targetId = r.role === 'host' ? '' : String(r.id ?? '')
      if (r.role !== 'host' && !targetId) continue
      out.push({
        key: `${kind}:${r.role}:${targetId}`,
        kind,
        role: r.role,
        targetId,
        label: `${kind === 'revoke' ? 'Revoke' : 'Restore'} ${label}`,
        title: `${kind === 'revoke' ? 'Revoke the' : 'Restore the'} ${label} role`,
        effect: kind === 'revoke'
          ? `Only the ${label} role is taken away. The account, its other roles, its balances and ` +
            `all history stay. The person is told, with your reason.`
          : `The person's EXISTING ${label} record is re-activated — no new application. ` +
            `The role table and the parent agency are re-checked first.`,
        confirmLabel: kind === 'revoke' ? `Revoke ${label}` : `Restore ${label}`,
        ownerOnly: kind === 'restore' && r.status === 'revoked',
      })
    }
  }
  return out
}

/** One line for the page: what the person holds, by role and status. */
export function heldSummary(roles: UserRoles | null | undefined): string {
  if (!roles) return ''
  // A SUSPENDED Host still holds the role (`user_roles.HELD_HOST_STATUSES`):
  // the record and the slot are kept while it is paused, as for a partner.
  const held = roles.roles.filter((r) =>
    r.role === 'host' ? r.status === 'active' || r.status === 'suspended' : r.status === 'approved' || r.status === 'suspended')
  if (held.length === 0) return 'No partner or host role.'
  const parts = held.map((r) => `${LABEL[r.role] ?? r.role}${r.status === 'suspended' ? ' (suspended)' : ''}`)
  return held.length === 1
    ? `${parts[0]} is this person's only role — to restrict it, suspend the account.`
    : `Holds ${parts.join(' + ')}.`
}

// ── Warning deduction ───────────────────────────────────────────────────────

export interface Balances {
  diamonds: number
  /** The RELEASED beans a deduction may take (`beansAvailable`). */
  beansAvailable: number
}

/** The live balance a deduction in this currency is checked against. */
export function liveBalanceFor(currency: string, b: Balances): number {
  return currency === 'beans' ? b.beansAvailable : b.diamonds
}

/** '' when the deduction is acceptable, otherwise the sentence to show. */
export function deductionProblem(
  amountText: string, currency: string, allowed: string[], b: Balances,
): string {
  if (!allowed.includes(currency)) {
    return `A deduction from this account is taken in ${allowed.join(' or ') || 'nothing'}.`
  }
  const n = Number(amountText)
  if (!amountText.trim() || !Number.isInteger(n) || n < 1) {
    return 'Enter a whole number of at least 1.'
  }
  const live = liveBalanceFor(currency, b)
  if (n > live) {
    return `The account holds ${live.toLocaleString('en-IN')} ${currency === 'beans' ? 'released beans' : 'diamonds'}; ` +
      `${n.toLocaleString('en-IN')} cannot be deducted.`
  }
  return ''
}

/** The sentence shown BEFORE confirmation — amount, currency, whom, and the balance. */
export function deductionSummary(name: string, amountText: string, currency: string, b: Balances): string {
  const n = Number(amountText)
  const live = liveBalanceFor(currency, b)
  const what = currency === 'beans' ? 'beans' : 'diamonds'
  return `Deduct ${n.toLocaleString('en-IN')} ${what} from ${name} — current ${
    currency === 'beans' ? 'released beans' : 'balance'} ${live.toLocaleString('en-IN')}. ` +
    'This raises a card; an owner signs before anything is taken.'
}

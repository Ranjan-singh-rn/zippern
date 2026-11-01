/**
 * Which partner capabilities a login holds, and where each one belongs.
 *
 * One person can be an agency AND a coin seller on a single login. Underneath
 * they are still two partner records with two balances in two ledgers — this
 * module is only about the login: what it may open, and where it lands.
 *
 * ── The shape on `crmUsers` ──────────────────────────────────────────────────
 *
 *   role        the capability the account was CREATED with. Unchanged, and
 *               still the field every existing screen and every Firestore rule
 *               reads. Nothing here rewrites it.
 *   status      that capability's status. Unchanged.
 *   roles       every capability the login holds, once it holds more than one.
 *               Absent on every account that exists today — which is exactly
 *               why the fallback is `[role]` rather than `[]`.
 *   roleStatus  per-capability status, for the ones `status` cannot describe.
 *
 * A legacy document carries only `role` and `status`, and produces precisely the
 * routing it produced before this file existed. That is asserted case by case in
 * `partnerRouting.spec.ts`, against the exact predicate the old code used.
 *
 * ── Why `roles` cannot escalate anything ─────────────────────────────────────
 *
 * `partnerRolesOf` returns nothing at all unless `role` is already 'agency' or
 * 'seller'. So `roles` can only ever ADD a partner capability to an account that
 * is already a partner. It cannot turn a staff account into a partner, it cannot
 * turn a partner into staff, and a partner writing their own `roles` array (the
 * one write the security rules permit them, bound to an application that names
 * their verified email) can reach nothing they could not reach by applying.
 *
 * No imports on purpose: this is the routing table, and it is exercised by a
 * standalone spec that compiles and runs it directly.
 */

export type PartnerRole = 'agency' | 'seller'
/**
 * `awaiting_verification` — Decision 15 (RC): the Owner approved the role
 * while the login did not yet hold BOTH a verified phone and a verified email.
 * It routes exactly like `pending` (the waiting room, never the dashboard);
 * the waiting room shows the verification steps instead of "under review".
 */
export type PartnerRoleStatus = 'pending' | 'awaiting_verification' | 'approved' | 'rejected'

/** Both capabilities, in the order a dual-role partner sees them. */
export const PARTNER_ROLES: readonly PartnerRole[] = ['agency', 'seller']

/** The dashboard each capability owns. */
export const PARTNER_HOME: Readonly<Record<PartnerRole, string>> = {
  agency: '/agency-dashboard',
  seller: '/seller-dashboard',
}

/** The waiting room each capability uses while it is under review. */
export const PARTNER_PENDING: Readonly<Record<PartnerRole, string>> = {
  agency: '/agency-pending',
  seller: '/seller-pending',
}

export const PARTNER_ROLE_LABEL: Readonly<Record<PartnerRole, string>> = {
  agency: 'Agency',
  seller: 'Coin Seller',
}

/**
 * Paths a partner login may sit on that belong to no capability.
 *
 * Everything else in this table is capability-scoped: a dashboard or a waiting
 * room, owned by 'agency' or by 'seller'. /profile is neither. It is the one
 * screen every person in the CRM has — staff, agency and coin seller alike —
 * and it shows the caller their own record and nothing else, so there is no
 * capability to scope it by and nothing for a partner to reach on it that is
 * not already theirs.
 *
 * Kept OUT of `allowedPartnerPaths`, which answers a different question:
 * "which of this login's capabilities are open, and where do they live". That
 * answer is what `resolvePartnerRedirect` picks a landing from, and a landing
 * must always be a dashboard or a waiting room — never this. Adding /profile
 * there would have made it a possible destination for a redirect, which is the
 * one thing it must not be: a pending agency bounced to /profile would never
 * reach the page telling them they are still under review.
 *
 * Matched on a SEGMENT boundary, not by bare prefix — see `onSharedPath`.
 */
export const PARTNER_SHARED_PATHS: readonly string[] = ['/profile']

/**
 * Is this path one of the shared screens?
 *
 * `pathname.startsWith(prefix)` — the test every capability path in this file
 * uses — would also admit `/profiles`, `/profile-export` and anything else that
 * merely begins with those eight characters. For a dashboard prefix that is
 * harmless, because the thing it admits is the partner's own dashboard either
 * way. Here it is not: this is the one clause that lets a partner off the
 * capability leash, so what it admits has to be exactly what it names.
 *
 * The path itself, or the path followed by a separator. Nothing else.
 */
function onSharedPath(pathname: string): boolean {
  return PARTNER_SHARED_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  )
}

/**
 * The subset of a `crmUsers` document this module reads. Structural on purpose,
 * so `CrmUser` can carry it without this file depending on `lib/auth`.
 */
export interface PartnerRoleHolder {
  role: string
  status?: string
  roles?: readonly string[]
  roleStatus?: Readonly<Partial<Record<PartnerRole, string>>>
  agencyId?: string
  sellerId?: string
  sellerUid?: string
}

export function isPartnerRole(value: string | undefined): value is PartnerRole {
  return value === 'agency' || value === 'seller'
}

/** The capability the account was created with, or null for staff. */
export function primaryPartnerRole(
  user: PartnerRoleHolder | null | undefined,
): PartnerRole | null {
  return user && isPartnerRole(user.role) ? user.role : null
}

/**
 * Every capability this login holds, primary first.
 *
 * Empty for staff, for the superadmin and for the observer — none of whom this
 * module has anything to say about, and all of whom must fall straight through
 * to the behaviour they already had.
 */
export function partnerRolesOf(
  user: PartnerRoleHolder | null | undefined,
): PartnerRole[] {
  const primary = primaryPartnerRole(user)
  if (!user || !primary) return []

  const declared = Array.isArray(user.roles) ? user.roles : []
  const held: PartnerRole[] = [primary]
  for (const role of PARTNER_ROLES) {
    if (role !== primary && declared.includes(role)) held.push(role)
  }
  return held
}

/**
 * How one capability stands.
 *
 * The fallback for the primary capability is the exact predicate the old
 * redirect used — `!status || status === 'pending'` means pending, anything else
 * means approved — so a legacy document routes identically. The one addition is
 * that an explicit 'rejected' is reported as rejected rather than read as
 * approved; nothing in the CRM has ever written that value to `crmUsers`, so no
 * existing account changes behaviour.
 *
 * A capability held with nothing recorded about it is pending. Never approved:
 * an unknown answer about money is a no.
 */
export function partnerRoleStatus(
  user: PartnerRoleHolder | null | undefined,
  role: PartnerRole,
): PartnerRoleStatus {
  if (!user) return 'pending'

  const explicit = user.roleStatus?.[role]
  if (explicit === 'approved' || explicit === 'pending' || explicit === 'rejected'
      || explicit === 'awaiting_verification') {
    return explicit
  }
  /*
   * Phase 1A (role-revocation leak): ANY other explicit per-role value —
   * 'revoked', 'suspended', or something this build does not know — is a
   * refusal. It used to fall through to the legacy single `status`, which on a
   * login whose agency role had been revoked still said 'approved', so the
   * revoked capability kept routing to its dashboard.
   */
  if (typeof explicit === 'string' && explicit !== '') return 'rejected'

  if (role === primaryPartnerRole(user)) {
    const legacy = user.status
    if (!legacy || legacy === 'pending') return 'pending'
    if (legacy === 'rejected') return 'rejected'
    // Decision 15 (RC): approved but NOT started. Without this a login whose
    // only status said so would have read as approved — "anything else means
    // approved" is the legacy predicate — and opened the dashboard.
    if (legacy === 'awaiting_verification') return 'awaiting_verification'
    return 'approved'
  }

  return 'pending'
}

/** Holds both capabilities — the only case that gets a switcher. */
export function isDualRolePartner(
  user: PartnerRoleHolder | null | undefined,
): boolean {
  return partnerRolesOf(user).length > 1
}

/** The capabilities this login may actually open a dashboard for. */
export function approvedPartnerRoles(
  user: PartnerRoleHolder | null | undefined,
): PartnerRole[] {
  return partnerRolesOf(user).filter((r) => partnerRoleStatus(user, r) === 'approved')
}

/** The record id behind one capability, or '' if the login is not linked yet. */
export function partnerRecordId(
  user: PartnerRoleHolder | null | undefined,
  role: PartnerRole,
): string {
  if (!user) return ''
  return (role === 'agency' ? user.agencyId : user.sellerId ?? user.sellerUid) ?? ''
}

/**
 * Every path this login is entitled to sit on.
 *
 * A capability's waiting room is always allowed, including after approval —
 * that is the old behaviour, kept: an approved agency sitting on
 * /agency-pending was never bounced off it.
 */
export function allowedPartnerPaths(
  user: PartnerRoleHolder | null | undefined,
): string[] {
  const allowed: string[] = []
  for (const role of partnerRolesOf(user)) {
    allowed.push(PARTNER_PENDING[role])
    if (partnerRoleStatus(user, role) === 'approved') allowed.push(PARTNER_HOME[role])
  }
  return allowed
}

/**
 * Where this login belongs when it is somewhere it may not be.
 *
 * The first APPROVED capability's dashboard, primary first — so a partner whose
 * original capability is still under review but whose second one has been
 * approved lands on the one that works, rather than on a waiting room they have
 * already finished waiting in. With nothing approved, the primary capability's
 * waiting room.
 *
 * Deliberately not remembered between visits. A landing that depends on
 * `localStorage` cannot be read during render without breaking server
 * rendering, and reading it afterwards would mean redirecting twice. Moving
 * between dashboards is what the switcher is for.
 */
export function partnerLanding(
  user: PartnerRoleHolder | null | undefined,
): string | null {
  const held = partnerRolesOf(user)
  if (held.length === 0) return null

  const approved = held.find((r) => partnerRoleStatus(user, r) === 'approved')
  return approved ? PARTNER_HOME[approved] : PARTNER_PENDING[held[0]]
}

/**
 * Where this partner must be sent, or null if they may stay.
 *
 * Returns null for anyone who is not a partner, so staff, the superadmin and
 * the observer are untouched.
 *
 * **Every path terminates.** The landing is always one of the allowed prefixes,
 * so the redirect it produces evaluates to null on the next call. There is no
 * ordering of capabilities and statuses that can bounce a user between two
 * pages, and `partnerRouting.spec.ts` proves it by re-running the resolver on
 * its own answer for every combination.
 */
export function resolvePartnerRedirect(
  user: PartnerRoleHolder | null | undefined,
  pathname: string,
): string | null {
  const allowed = allowedPartnerPaths(user)
  if (allowed.length === 0) return null
  // Checked before the capability paths and after the "is this a partner at
  // all" test above, so a shared screen is reachable whatever the state of the
  // capabilities — including by a partner with nothing approved yet, who has a
  // profile to keep current exactly like everybody else.
  if (onSharedPath(pathname)) return null
  if (allowed.some((prefix) => pathname.startsWith(prefix))) return null
  return partnerLanding(user)
}

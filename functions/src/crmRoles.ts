/**
 * The CRM role vocabulary, and what it means for an app account.
 *
 * ── WHY THIS IS ITS OWN FILE ─────────────────────────────────────────────
 *
 * Same reason `pricing.ts` is: it is pure, and it is the part worth testing.
 * Importing `social.ts` runs `admin.firestore()` at module load and needs a
 * live app, so the mapping could only ever be exercised by deploying it. It is
 * now the one thing standing between a CRM role and what the app believes
 * about a person, so it is tested instead.
 *
 * ── THE VOCABULARY IS THE CRM'S, NOT A COPY OF IT ────────────────────────
 *
 * There is exactly one authoritative source for somebody's role: the
 * `crmUsers/{uid}` document, keyed on the uid they authenticated as. This file
 * translates what is stored there into the four flags the app reads. It does
 * not invent, flatten, merge or rename a role, and it must never grow an
 * `admin` or a `team`.
 *
 * What it replaced was a six-value list —
 * `['superadmin','admin','ops','tech','finance','support']` — matched against
 * a `verifiedIdentities` join keyed on phone numbers and emails. Both halves
 * were wrong. The list predated the split of each department into admin and
 * member tiers, so `ops_admin`, `finance_member`, `marketing_admin` and nine
 * others matched NOTHING: every one of those people opened the app as an
 * ordinary user with no badge, while `resolveIdentity` — reading `crmUsers`
 * and seeing the real role — disagreed on every call. And a phone string is
 * not an identity: it went stale the moment somebody changed their number.
 */

/** The two external capabilities. Everything else internal is "official". */
export const PARTNER_ROLES: ReadonlySet<string> = new Set(['agency', 'seller'])

/** The twelve department roles, exactly as `crmUsers.role` spells them. */
export const DEPARTMENT_ROLES: ReadonlySet<string> = new Set([
  'app_admin', 'app_member',
  'ops_admin', 'ops_member',
  'finance_admin', 'finance_member',
  'tech_admin', 'tech_member',
  'support_admin', 'support_member',
  'marketing_admin', 'marketing_member',
])

/**
 * What the CRM calls an owner.
 *
 * There is no `owner` string in `crmUsers` — `crm_directory.CRM_ROLE` maps
 * `Role.OWNER` to `superadmin`, and has since before the department split.
 * Worth knowing before going to look for one.
 */
export const OWNER_ROLE = 'superadmin'

/** Read-only, CRM-only, and never present in `crmUsers` at all by design. */
export const OBSERVER_ROLE = 'observer'

/**
 * Role strings that predate the department split, and what they became.
 *
 * Transcribed from `LEGACY_ROLE_MAP` in `zipper-crm/lib/auth.ts`. A document
 * still carrying one of these is normalised the next time its holder signs in
 * to the CRM — but somebody who only ever opens the app would never be
 * normalised at all, so the same mapping has to exist on this side.
 */
export const LEGACY_ROLE: Readonly<Record<string, string>> = {
  admin: 'app_admin',
  ops: 'ops_member',
  tech: 'tech_member',
  finance: 'finance_member',
  support: 'support_member',
}

export function normaliseCrmRole(raw: unknown): string {
  const role = String(raw ?? '').trim()
  return LEGACY_ROLE[role] ?? role
}

/** The four fields the app reads, and the role string it displays. */
export interface RoleFlags {
  /** The exact role, or '' — empty for a partner, so they are never staff. */
  crmRole: string
  isAgent: boolean
  isSeller: boolean
  isOfficial: boolean
  /** Every capability held, normalised. For the caller's own logging. */
  held: string[]
}

/**
 * Turn a `crmUsers` document's role fields into the app's flags.
 *
 * @param role     `crmUsers.role` — the capability the account was created with.
 * @param roles    `crmUsers.roles` — every partner capability, once a login
 *                 holds more than one (an agency that also sells coins).
 *                 Absent on staff documents and on everything written before
 *                 the field existed, so it falls back to `[role]`.
 * @param isActive `crmUsers.isActive`. A deactivated CRM account holds no role.
 * @param exists   whether the document is there at all. Absent IS the CRM
 *                 saying this person has no role — see the revocation note in
 *                 `syncMyRoles`.
 */
export function deriveRoleFlags(
  role: unknown,
  roles: unknown,
  isActive: boolean,
  exists: boolean,
  /**
   * `crmUsers.roleStatus` — per-capability state on a login that can hold two
   * (`{agency: 'approved', seller: 'revoked'}`). A capability whose status is
   * revoked, rejected or suspended is not HELD, even though it is still listed
   * in `roles` (the list is history; the status is the decision). Absent on
   * older documents, where `roles` alone decides as before.
   */
  roleStatus?: unknown,
  /**
   * `crmUsers.status` — the LOGIN's state. A capability with no `roleStatus`
   * entry (single-role and legacy documents) takes this; absent too, it is
   * treated as approved (pre-status documents were approved by construction).
   */
  status?: unknown,
): RoleFlags {
  const normalised = normaliseCrmRole(role)

  // The observer is CRM-only and has no `crmUsers` document by design, so this
  // should be unreachable. It is here because "should be unreachable" is how
  // the last observer hole was described too.
  const usable =
    exists && isActive && normalised !== '' && normalised !== OBSERVER_ROLE

  const statuses = (roleStatus && typeof roleStatus === 'object')
    ? roleStatus as Record<string, unknown>
    : {}
  // A capability earns its tag only when APPROVED — not pending, revoked,
  // rejected or suspended. Identical to `crm_directory.app_role_flags`.
  const stateOf = (cap: string) =>
    String(statuses[cap] ?? '').trim() || String(status ?? '').trim() || 'approved'
  const withdrawn = (cap: string) => stateOf(cap) !== 'approved'

  const held: string[] = usable
    ? (Array.isArray(roles) && roles.length > 0 ? roles : [normalised])
        .map(normaliseCrmRole)
        .filter((r) => r !== '' && !withdrawn(r))
    : []

  const isAgent = held.includes('agency')
  const isSeller = held.includes('seller')

  // Staff carry the official badge; a partner does not — they are external.
  // Identical to the rule in `_attach_app_identity`, which writes these same
  // fields from the CRM side. The two must agree or the badge flickers
  // depending on which wrote last.
  const isOfficial =
    usable && (normalised === OWNER_ROLE || DEPARTMENT_ROLES.has(normalised))

  return {
    crmRole: usable && !PARTNER_ROLES.has(normalised) ? normalised : '',
    isAgent,
    isSeller,
    isOfficial,
    held,
  }
}

/**
 * Why this login may NOT become a Host, or '' if it may. Pure.
 *
 * The role table (backend `partner_applications._ALLOWS`) forbids a Host who
 * also holds — or is applying for — an Agency or Sub-agency, and ZIPPER staff
 * hold no partner role at all. The backend enforces both at application and
 * approval; this is the same rule for the one path that grants Host without
 * the backend, `activateHost` (redeeming an agency's referral code).
 *
 * An agency capability counts while it is pending, approved, suspended or
 * REVOKED — held, like the backend's HELD_STATUSES — and stops counting only
 * once rejected. C1 (B04): a revoked record still constrains the role table
 * exactly like a held one, because restoring it must never produce a
 * forbidden pair (Agency + Host). Per-capability `roleStatus` wins, then the
 * login `status`.
 */
export function hostBlockedBy(crm: Record<string, unknown> | undefined | null): string {
  if (!crm) return ''
  const role = normaliseCrmRole(crm.role)
  if (role === OWNER_ROLE || role === OBSERVER_ROLE || DEPARTMENT_ROLES.has(role)) {
    return 'ZIPPER staff accounts cannot hold partner roles.'
  }
  const roles = Array.isArray(crm.roles) && crm.roles.length > 0 ? crm.roles.map(normaliseCrmRole) : [role]
  if (!roles.includes('agency')) return ''
  const statuses = (crm.roleStatus && typeof crm.roleStatus === 'object')
    ? crm.roleStatus as Record<string, unknown> : {}
  const state = String(statuses.agency ?? '').trim() || String(crm.status ?? '').trim() || 'approved'
  if (state === 'rejected') return ''
  return AGENCY_HOST_REFUSAL
}

export const AGENCY_HOST_REFUSAL = 'An Agency or Sub-agency cannot also be a Host.'

/**
 * RC (confirmed role rule): `hostBlockedBy`, with the one exception the rule
 * makes — a Sub-agency under main Agency X may ALSO be a Host directly under
 * X, and nowhere else (not under another agency, not under any sub-agency).
 * Pure. `subParentId` is the main agency of the login's Sub-agency (blank for
 * a main agency or no agency); `invitationAgencyIsMain` says whether the
 * agency issuing the invitation is a MAIN agency.
 */
export function hostBlockedFor(
  crm: Record<string, unknown> | undefined | null,
  ctx: { subParentId: string; invitationAgencyId: string; invitationAgencyIsMain: boolean },
): string {
  const base = hostBlockedBy(crm)
  if (base !== AGENCY_HOST_REFUSAL) return base
  const sub = String(ctx.subParentId ?? '').trim()
  if (!sub) return base
  if (ctx.invitationAgencyIsMain && sub === String(ctx.invitationAgencyId ?? '').trim()) return ''
  return 'As a Sub-agency, you may be a Host only directly under your own main agency — not under ' +
    'another agency and not under any sub-agency.'
}

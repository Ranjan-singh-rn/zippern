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
): RoleFlags {
  const normalised = normaliseCrmRole(role)

  // The observer is CRM-only and has no `crmUsers` document by design, so this
  // should be unreachable. It is here because "should be unreachable" is how
  // the last observer hole was described too.
  const usable =
    exists && isActive && normalised !== '' && normalised !== OBSERVER_ROLE

  const held: string[] = usable
    ? (Array.isArray(roles) && roles.length > 0 ? roles : [normalised])
        .map(normaliseCrmRole)
        .filter((r) => r !== '')
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

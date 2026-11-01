/**
 * Who is an INTERNAL identity, and which ordinary-user actions a row may offer.
 *
 * ── Why this is its own file ────────────────────────────────────────────────
 *
 * The internal-role set lived as a module-private `const` inside
 * `app/users/[uid]/UserActions.tsx`. The detail screen used it and hid Ban,
 * Suspend and Grant host for staff; the `/users` LIST screen, which renders the
 * same actions from its own `actionsFor`, could not see it and offered all of
 * them beside every Owner and Super Admin in production.
 *
 * A guard that exists on one of two screens is not a guard. One definition,
 * imported by both.
 *
 * No React, no Firebase, no imports at all — the same shape as
 * `partnerRouting.ts`, `sessionGate.ts` and `secondRoleRule.ts`, so the real
 * module compiles and runs standalone and `crmRoles.spec.ts` exercises shipped
 * code rather than a copy of it.
 *
 * ── THIS IS DEFENCE IN DEPTH, NOT THE CONTROL ───────────────────────────────
 *
 * `crmRole` is DENORMALISED onto the `users/{uid}` app document, and the app
 * can write that document. A screen trusting it is trusting client-reachable
 * state. The authority is the Mongo `staff` row, read server-side on every one
 * of these endpoints by `users.ensure_ordinary_target` — live on Cloud Run
 * revision zipper-api-00039-656. Hiding a button only stops a reviewer
 * pressing something that was always going to come back 403.
 */

/**
 * Internal roles, in the spelling `crmUsers` uses.
 *
 * Note `superadmin`: that is how `crm_directory.CRM_ROLE` writes `Role.OWNER`.
 * `observer` is listed for completeness although it never reaches a user row —
 * the Observer has no Firebase account and so no app document at all.
 *
 * Partner roles (`agency`, `seller`) are deliberately ABSENT. A partner is an
 * ordinary moderation subject and must keep its actions.
 */
export const INTERNAL_CRM_ROLES: ReadonlySet<string> = new Set([
  'superadmin', 'observer',
  'app_admin', 'app_member',
  'ops_admin', 'ops_member',
  'finance_admin', 'finance_member',
  'tech_admin', 'tech_member',
  'support_admin', 'support_member',
  'marketing_admin', 'marketing_member',
])

/** Is this `crmRole` value an internal identity? Tolerates undefined/padding. */
export function isInternalCrmRole(role: string | null | undefined): boolean {
  return INTERNAL_CRM_ROLES.has((role ?? '').trim())
}

/**
 * The ordinary-user actions the `/users` list can offer on one row.
 *
 * MODERATION ONLY. `grant_host` was here and is gone: a Host — like an
 * Agency, a Sub-agency and a Coin Seller — is obtained through an application
 * that a reviewer decides on `/kyc`, never by a button on a user row. The
 * backend route behind the button (`POST /users/{uid}/grant-host`) no longer
 * exists, so offering it would be offering a 404. Pending applications are
 * shown on the user's detail page with Review / Approve / Reject instead.
 */
export type UserRowActionKey = 'ban' | 'unban' | 'suspend' | 'resume'

/** Only the fields the decision reads. Keeps the rule testable without a row. */
export interface UserRowSubject {
  uid: string
  crmRole?: string | null
  accountState?: string | null
  isBanned?: boolean
  isSuspended?: boolean
  isHost?: boolean
}

/** `active` / `suspended` / `banned`, from the three fields that can say so. */
export type Restriction = 'active' | 'suspended' | 'banned'

/**
 * Which restriction an account is under.
 *
 * `isBanned` is the app's "cannot use the app" gate and it is TRUE for a
 * suspension as well as a ban, so it cannot pick the reversal on its own —
 * the list used to offer Unban on every suspended account and the server
 * refused it with "use Resume", because a suspension never barred a device.
 * `accountState` is what distinguishes them; the booleans are the fallback
 * for documents written before that field existed.
 */
export function restrictionOf(u: UserRowSubject): Restriction {
  if (u.accountState === 'suspended' || u.accountState === 'banned') {
    return u.accountState
  }
  if (u.isSuspended === true) return 'suspended'
  if (u.isBanned === true) return 'banned'
  return 'active'
}

/**
 * Is this somebody the ordinary user-moderation controls may act on at all?
 *
 * False for an internal identity and for the signed-in actor's own row. Both
 * screens ask this before anything else, because every rule below it is about
 * account STATE and none is about whose account it is — which is exactly how
 * the list came to offer Ban beside three Owners.
 */
export function isOrdinaryTarget(
  u: UserRowSubject,
  actorUid: string | null | undefined,
): boolean {
  if (isInternalCrmRole(u.crmRole)) return false
  // Separate from the check above on purpose. Today every CRM actor is staff,
  // so the internal check happens to cover self as well — but that is a
  // coincidence of the current role model, not the rule. Stated on its own, it
  // keeps holding if a non-internal login ever reaches this screen.
  const actor = (actorUid ?? '').trim()
  if (actor !== '' && u.uid === actor) return false
  return true
}

/**
 * THE action policy. One function, both screens.
 *
 * ── WHY THIS IS CENTRAL ─────────────────────────────────────────────────────
 *
 * `/users` and `/users/[uid]` each decided this for themselves and drifted:
 * the list offered a suspended account Resume + Make host, while the detail
 * page offered Resume + Ban. Same account, same reviewer, two different sets
 * of buttons depending on which screen they were looking at. The internal-role
 * guard had already drifted the same way — written on the detail page only,
 * so production showed Ban beside three Owners.
 *
 * So the policy lives here and the screens render it. A component may decide
 * how a button looks; it may not decide whether the button is lawful.
 *
 * ── THE POLICY ──────────────────────────────────────────────────────────────
 *
 *   internal role, any state   →  (none)
 *   the actor's own row        →  (none)
 *   active (host or not)       →  ban, suspend
 *   suspended (host or not)    →  resume, ban
 *   banned                     →  unban
 *
 * Suspended offers Ban because a suspension can be escalated — the server
 * accepts it, and the detail page has always exposed it. It does NOT offer
 * Suspend (already suspended).
 *
 * Banned offers only Unban. Ban is already in force and Suspend is a lighter
 * restriction the server refuses on a banned account.
 *
 * Nothing here grants a role. See the note on `UserRowActionKey`.
 */
export function userRowActionKeys(
  u: UserRowSubject,
  actorUid: string | null | undefined,
): UserRowActionKey[] {
  if (!isOrdinaryTarget(u, actorUid)) return []

  switch (restrictionOf(u)) {
    case 'banned':
      return ['unban']
    case 'suspended':
      return ['resume', 'ban']
    default:
      return ['ban', 'suspend']
  }
}

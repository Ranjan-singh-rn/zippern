/**
 * QA #41 (3 Nov 2026) — which moderation controls a staff member is SHOWN.
 *
 * A Support member opening a user record was offered Ban, Suspend and Adjust
 * balance, pressed one, filled in the reason and was then refused by the API
 * ("does not have the 'can_ban_users' permission"). The refusal was right; the
 * offer was not. A control is now drawn only for somebody whose permission
 * list holds what the route behind it asks for.
 *
 * THE SERVER STAYS THE BOUNDARY. Every route below still checks the same
 * permission on every call (`backend/app/routers/users.py`), and the list read
 * here (`crmUsers.permissions`) is the mirror the backend writes from
 * `app/core/roles.PERMISSIONS`. Hiding a button grants and removes nothing.
 *
 * The map is what each route's decorator asks for; `moderationAccess.spec.ts`
 * reads the router (when the backend sits beside this repo) so the two cannot
 * drift. No imports, so the shipped module runs standalone.
 */

export type ModerationControl =
  | 'ban' | 'unban' | 'suspend' | 'resume'
  | 'review_appeal'
  | 'warn'
  | 'balance'

/** The permission the route behind each control requires. */
export const CONTROL_PERMISSION: Readonly<Record<ModerationControl, string>> = Object.freeze({
  // POST /users/{uid}/ban | unban | suspend | resume — `_BAN_USERS`.
  ban: 'can_ban_users',
  unban: 'can_ban_users',
  suspend: 'can_ban_users',
  resume: 'can_ban_users',
  // Recommending or deciding an appeal — `can_ban_users` on both routes.
  review_appeal: 'can_ban_users',
  // POST /users/{uid}/warn — `can_view_users` (Support issues most warnings).
  warn: 'can_view_users',
  // POST /users/{uid}/balance-request — `can_adjust_balance`.
  balance: 'can_adjust_balance',
})

function isControl(key: string): key is ModerationControl {
  return Object.prototype.hasOwnProperty.call(CONTROL_PERMISSION, key)
}

/**
 * May this control be drawn for somebody whose permission check is `has`?
 * A key this module does not know (a role row's action, say) is not its
 * business and passes through — those carry their own gates.
 */
export function mayOffer(key: string, has: (permission: string) => boolean): boolean {
  if (!isControl(key)) return true
  return has(CONTROL_PERMISSION[key])
}

/** The controls in `keys` that may be drawn, in their original order. */
export function offeredControls<T extends string>(keys: readonly T[], has: (permission: string) => boolean): T[] {
  return keys.filter((k) => mayOffer(k, has))
}

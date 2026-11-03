/**
 * Decision 16 (RC) — what an INACTIVE login is told at the CRM door.
 *
 * `resolveCrmUser` (lib/auth.ts) refuses a `crmUsers` login whose `isActive`
 * is false, before the API is ever asked. A rejection leaves a partner's login
 * inactive too, so a rejected Sub-agency applicant — entitled to the reason
 * and to apply again — was told "This account has been deactivated", which is
 * untrue for them. The API already knows the difference: `/auth/signin`
 * answers a rejected-only login with "This application was not approved: …
 * You may apply again" (`backend/app/core/security.py::_rejection_of_login`).
 *
 * So the door asks the API why (without opening a session —
 * `api.auth.refusalForLogin`, with the token of the sign-in being refused) and
 * shows that sentence; QA #44 extended it from partners to staff. Any case where
 * the API cannot be asked keeps the old sentence. Nobody is let in either way:
 * the door still signs the browser out.
 *
 * Pure — `crmDoor.spec.ts` runs it.
 */

export const DEACTIVATED_MESSAGE = 'This account has been deactivated.'

/**
 * Which inactive logins the door asks the API about: every login with a role.
 *
 * Decision 16 asked only for partners (a rejection). QA #44: a SUSPENDED member
 * of staff was told "This account has been deactivated" too — the API knows the
 * difference (`core/security.py::inactive_staff_message`) and the door did not,
 * so staff are asked as well. A blank role (no record behind it) is not asked.
 */
export function asksApiWhyInactive(role: string | undefined | null): boolean {
  return String(role ?? '').trim() !== ''
}

/**
 * The sentence for an inactive login: the API's own refusal when it gave one
 * (a rejection with its reason, a suspension), otherwise the deactivation
 * sentence.
 */
export function inactiveLoginMessage(
  role: string | undefined | null,
  apiRefusal: string | undefined | null,
): string {
  if (!asksApiWhyInactive(role)) return DEACTIVATED_MESSAGE
  const said = String(apiRefusal ?? '').trim()
  return said || DEACTIVATED_MESSAGE
}

/**
 * QA #49 — a refusal decided AT THE DOOR (an inactive or restricted login),
 * thrown as its own type so the login page shows the sentence as it is.
 *
 * The page used to sort errors by substring — `msg.includes('deactivated')`,
 * `msg.includes('not found')` — and a rejection reason that happened to contain
 * "not found" ("the registration document was not found") would have been shown
 * as "Invalid email or password". A type cannot be confused with the words.
 */
export class CrmDoorRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CrmDoorRefusal'
  }
}

/** What the login page shows for a door refusal. */
export function doorRefusalText(message: string): string {
  const m = String(message ?? '').trim()
  if (!m || m === DEACTIVATED_MESSAGE) return 'This account has been deactivated. Contact your administrator.'
  return m
}

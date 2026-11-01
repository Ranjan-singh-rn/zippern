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
 * So for a PARTNER login the door asks the API why (without opening a
 * session — `api.auth.refusalForCurrentLogin`) and shows that sentence. Staff
 * logins, and any case where the API cannot be asked, keep the old sentence.
 * Nobody is let in either way: the door still signs the browser out.
 *
 * Pure — `crmDoor.spec.ts` runs it.
 */

export const DEACTIVATED_MESSAGE = 'This account has been deactivated.'

/** Only partner logins (agency / seller capability) are worth asking the API about. */
export function asksApiWhyInactive(role: string | undefined | null): boolean {
  const r = String(role ?? '').trim()
  return r === 'agency' || r === 'seller'
}

/**
 * The sentence for an inactive login: the API's own refusal for a partner when
 * it gave one, otherwise the deactivation sentence.
 */
export function inactiveLoginMessage(
  role: string | undefined | null,
  apiRefusal: string | undefined | null,
): string {
  if (!asksApiWhyInactive(role)) return DEACTIVATED_MESSAGE
  const said = String(apiRefusal ?? '').trim()
  return said || DEACTIVATED_MESSAGE
}

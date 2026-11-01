/**
 * What the backend serving this CRM offers — the feature flags behind every
 * `TODO(B2 API)` stub.
 *
 * Pure — no imports — so the modules that read it stay standalone.
 *
 * ── WHY FLAGS AND NOT CALLS ─────────────────────────────────────────────────
 *
 * The moderation backend (B2) is adding routes this CRM already has screens
 * for: per-role suspension of a Host, a department-vacancy view, and so on.
 * Until each route is released the screen must still BUILD and must say
 * "available after the next backend release" rather than offer a button that
 * answers 404. Each flag is `false` here and is flipped to `true` in the CRM
 * release that follows the backend one — one line, one review.
 *
 * Everything that exists on the backend working tree TODAY is NOT a flag:
 * warning history (`GET /users/{uid}/warnings`), reinstatement requests with
 * a recommendation (`/partner-ops/role-appeals/{id}/recommend`), transfer
 * approval with a note (`/partner-ops/transfers/{id}/decide`), the held-money
 * queue (`/partner-ops/frozen-money`) and per-record partner suspension
 * (`/partner-ops/partners/{id}/deactivate|reactivate`) are called directly.
 */

export interface BackendFeatures {
  /**
   * TODO(B2 API): suspend / resume the HOST role on its own, without touching
   * the account. Assumed:
   *   POST /users/{uid}/suspend-host {reason, days?} → ModerationResult
   *   POST /users/{uid}/resume-host  {reason}        → ModerationResult
   * Today a Host is either revoked (`/revoke-host`) or the ACCOUNT is
   * suspended; agencies, sub-agencies and sellers already have a per-record
   * suspension (`/partner-ops/partners/{id}/deactivate`).
   */
  hostRoleSuspension: boolean
  /**
   * TODO(B2 API): departments with no active admin. Assumed:
   *   GET /staff/vacancies → { vacancies: [{ team, role, since, last_holder_uid? }] }
   */
  departmentVacancy: boolean
}

export const BACKEND_FEATURES: Readonly<BackendFeatures> = Object.freeze({
  hostRoleSuspension: false,
  departmentVacancy: false,
})

/** The sentence every flagged control shows while its route is not released. */
export const NEXT_RELEASE_NOTE = 'Available after the next backend release.'

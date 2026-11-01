/**
 * What the backend serving this CRM offers — the feature flags behind the
 * screens that were built before their routes shipped.
 *
 * Pure — no imports — so the modules that read it stay standalone.
 *
 * ── WHY FLAGS AND NOT CALLS ─────────────────────────────────────────────────
 *
 * The moderation backend (B2) added routes this CRM already had screens for.
 * Until each route was released the screen still had to BUILD and had to say
 * "available after the next backend release" rather than offer a button that
 * answers 404. Each flag was `false` and is flipped to `true` in the CRM
 * release that follows the backend one — one line, one review. Both are on
 * now; the flags stay so a screen can be rolled back to its stub in one line
 * if a backend release is rolled back.
 *
 * Everything else that exists on the backend is NOT a flag and is called
 * directly: warning history (`GET /users/{uid}/warnings`), reinstatement
 * requests with a recommendation (`/partner-ops/role-appeals/{id}/recommend`),
 * transfer approval with a note (`/partner-ops/transfers/{id}/decide`), the
 * held-money queue (`/partner-ops/frozen-money`), per-record partner
 * suspension (`/partner-ops/partners/{id}/deactivate|reactivate`), appeal
 * recommendations, sessions, held items, replica drift and Owner notices.
 */

export interface BackendFeatures {
  /**
   * Suspend / resume the HOST role on its own, without touching the account:
   *   POST /users/{uid}/suspend-host {reason ≥ 10, days?}
   *   POST /users/{uid}/resume-host  {reason}
   *     → {uid, host: {status, suspendedUntil, reason}, notified: {host, agency}, audit_id}
   * Same capability as `/revoke-host` (`can_approve_kyc`). Agencies,
   * sub-agencies and sellers have their own per-record suspension
   * (`/partner-ops/partners/{id}/deactivate`).
   */
  hostRoleSuspension: boolean
  /**
   * §9 department Admin state, including a vacant seat:
   *   GET /staff/departments → { departments: [{ team, label, admins, vacancy,
   *                                              vacancy_since, vacancy_cause }] }
   * and `reports_to_resolved` on every `GET /staff` row ("Owner (vacancy)").
   * (The stub assumed a `GET /staff/vacancies` route, which never shipped.)
   */
  departmentVacancy: boolean
}

export const BACKEND_FEATURES: Readonly<BackendFeatures> = Object.freeze({
  hostRoleSuspension: true,
  departmentVacancy: true,
})

/** The sentence a flagged control shows while its route is not released. */
export const NEXT_RELEASE_NOTE = 'Available after the next backend release.'

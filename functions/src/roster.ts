/**
 * FX-10 (RF-15) — whether a row of an agency's roster is a CURRENT host.
 *
 * `agencies/{agencyId}/agencyHosts/{uid}` is what the weekly payout report,
 * the agency's app screen and the backend's revoke-with-dependents cascade
 * read as "this agency's hosts". Nothing removed or flagged a row when the
 * role ended — `revoke_host` and the account purge both left it — so every
 * one of those readers went on counting a revoked or purged Host.
 *
 * A row now says whether it is current: `active: false`, with when and why
 * (`removedAt`, `removedReason`). Marked rather than deleted, because the row
 * is the record of who was on the roster, and a restore re-activates the same
 * row. An ABSENT `active` is a row written before this existed and is current,
 * exactly as every reader always treated it.
 *
 * The backend writes the same three fields (`users.roster_removal_fields`,
 * `users.roster_current_fields`); the names must not drift apart.
 */

export const ROSTER_ACTIVE = 'active'
export const ROSTER_REMOVED_AT = 'removedAt'
export const ROSTER_REMOVED_REASON = 'removedReason'

/** Why a row stopped being current. */
export type RosterRemoval = 'revoked' | 'purged'

/** Is this roster row a CURRENT host? A missing `active` is a legacy row: yes. */
export function rosterRowIsCurrent(row: Record<string, unknown> | undefined | null): boolean {
  return (row ?? {})[ROSTER_ACTIVE] !== false
}

/** The fields that mark a row as no longer current. */
export function rosterRemovalFields(why: RosterRemoval, when: unknown): Record<string, unknown> {
  return { [ROSTER_ACTIVE]: false, [ROSTER_REMOVED_AT]: when, [ROSTER_REMOVED_REASON]: why }
}

/**
 * FX-11 (RF-16) — the agency dashboard's own host list, from the source an
 * agency login is allowed to read.
 *
 * The dashboard listed `users where agencyId == <its agency>`. `firestore.rules`
 * lets a signed-in account GET one user document but LIST them only as staff
 * (`allow list: if isStaff()`), so for every agency login that query was
 * refused and the screen showed "hosts could not be read" — for exactly the
 * people the screen exists for.
 *
 * The roster subcollection `agencies/{id}/agencyHosts` IS readable by the
 * agency (`isAgencyCrmUser() && crmUserAgencyId() == agencyId`). So the list
 * comes from there — current rows only (FX-10: `active: false` is history) —
 * and each row is completed from its user document with a single `get`, which
 * the rules allow.
 *
 * Pure: no Firebase, no React. `app/agency-dashboard/page.tsx` does the reads;
 * `agencyDashboardHosts.spec.ts` runs this.
 */

/** One roster row, as plain data. */
export interface RosterRowDoc {
  id: string
  data: Record<string, unknown>
}

/** What a user document read came back as: its data, or null (missing or refused). */
export type UserRead = Record<string, unknown> | null

/** Is this roster row a CURRENT host? A row with no `active` predates the marker: yes. */
export function rosterRowIsCurrent(row: Record<string, unknown> | null | undefined): boolean {
  return (row ?? {}).active !== false
}

/** The uid a roster row is about: its `uid` field, else the document id. */
export function rosterRowUid(row: RosterRowDoc): string {
  const v = row.data.uid
  return typeof v === 'string' && v.trim() ? v.trim() : row.id
}

/** The rows to show, in order: current only, one per uid. */
export function currentRosterRows(rows: readonly RosterRowDoc[]): RosterRowDoc[] {
  const seen = new Set<string>()
  const out: RosterRowDoc[] = []
  for (const r of rows) {
    if (!rosterRowIsCurrent(r.data)) continue
    const uid = rosterRowUid(r)
    if (seen.has(uid)) continue
    seen.add(uid)
    out.push(r)
  }
  return out
}

/**
 * One dashboard host per current roster row: the user document's fields where
 * it could be read, the roster row's own `name` / `callRateBeans` otherwise.
 * The uid is always the roster's. `T` is the dashboard's `Host` shape.
 */
export function hostsFromRoster<T extends { uid: string; name: string }>(
  rows: readonly RosterRowDoc[],
  usersByUid: ReadonlyMap<string, UserRead>,
): T[] {
  return currentRosterRows(rows).map((r) => {
    const uid = rosterRowUid(r)
    const user = usersByUid.get(uid) ?? null
    const rowName = typeof r.data.name === 'string' ? r.data.name : ''
    const merged: Record<string, unknown> = {
      ...(typeof r.data.callRateBeans === 'number' ? { callRateBeans: r.data.callRateBeans } : {}),
      ...(user ?? {}),
      uid,
      name: (typeof user?.name === 'string' && user.name) || rowName || uid,
    }
    return merged as T
  })
}

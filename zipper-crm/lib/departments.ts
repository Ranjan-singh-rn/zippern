/**
 * §9 — departments and their Admin seat, as `/team` reads them.
 *
 *   GET /staff/departments → { departments: [{ team, label, admins, vacancy,
 *                                              vacancy_since, vacancy_cause }] }
 *   GET /staff             → every row carries `reports_to_resolved`
 *
 * "If an Admin is deactivated, members report to Owner until a replacement
 * Admin is appointed, then revert." The server holds the vacancy state and
 * resolves "Reports to" from positions; a member of a vacant department reads
 * `Owner (vacancy)`. This module only shapes what the server said for the
 * screen — it never computes who reports to whom itself, because a second
 * copy of that rule is how the two would come to disagree.
 *
 * This replaces the stub that assumed a `GET /staff/vacancies` route which
 * never shipped (`backendFeatures.departmentVacancy`).
 *
 * Pure — no imports — so `npm run test:departments` runs the shipped module.
 */

export interface DepartmentAdmin {
  uid: string
  name: string
  email: string
}

export interface DepartmentRow {
  team: string
  label: string
  admins: DepartmentAdmin[]
  vacancy: boolean
  /** Milliseconds, or null when the server recorded no opening moment. */
  vacancySinceMs: number | null
  vacancyCause: string
}

/** What a vacant department means for its members, in one sentence. */
export const VACANCY_NOTE =
  'Its members report to the Owner until a new Admin is appointed. The Owners were told when the seat fell vacant.'

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function millis(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

/**
 * The departments in a response, tolerant of shape: `{departments: [...]}` or
 * a bare array. A row without a team is dropped (it names nothing); anything
 * else missing reads as empty, never as a crash.
 */
export function departmentsFrom(body: unknown): DepartmentRow[] {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as { departments?: unknown }).departments)
      ? (body as { departments: unknown[] }).departments
      : []
  const out: DepartmentRow[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const d = raw as Record<string, unknown>
    const team = text(d.team)
    if (!team) continue
    const admins = Array.isArray(d.admins)
      ? d.admins
          .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
          .map((a) => ({ uid: text(a.uid), name: text(a.name), email: text(a.email) }))
          .filter((a) => a.uid || a.name || a.email)
      : []
    out.push({
      team,
      label: text(d.label) || team,
      admins,
      // The server judges the vacancy from the ACTIVE Admin rows. Only an
      // explicit `true` is a vacancy; anything else is not asserted.
      vacancy: d.vacancy === true,
      vacancySinceMs: d.vacancy === true ? millis(d.vacancy_since) : null,
      vacancyCause: d.vacancy === true ? text(d.vacancy_cause) : '',
    })
  }
  return out
}

export function vacantDepartments(rows: readonly DepartmentRow[]): DepartmentRow[] {
  return rows.filter((r) => r.vacancy)
}

/** "Asha Rao", "Asha Rao and Vikram S", or '' — the Admins by name (email, then uid, as fallback). */
export function adminNames(row: DepartmentRow): string {
  const names = row.admins.map((a) => a.name || a.email || a.uid)
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export interface ReportsToView {
  /** What follows "Reports to:". The server's label, verbatim. */
  label: string
  /** True only for a member of a department with no active Admin. */
  vacancy: boolean
  /** False when the server sent no `reports_to_resolved` (an older backend). */
  known: boolean
}

/**
 * "Reports to" for one staff row, from `reports_to_resolved`. The label is
 * the server's — `Owner (vacancy)`, `Owner`, `Observer`, the Admin's name —
 * and is shown as written.
 */
export function reportsToOf(member: { reports_to_resolved?: unknown } | null | undefined): ReportsToView {
  const r = member?.reports_to_resolved
  if (r && typeof r === 'object') {
    const label = text((r as { label?: unknown }).label)
    if (label) return { label, vacancy: (r as { vacancy?: unknown }).vacancy === true, known: true }
  }
  return { label: 'Not reported by this server', vacancy: false, known: false }
}

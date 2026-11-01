/**
 * FX-13 (RF-19 / DUP-09) — an agency's contest of a report decision: one
 * PENDING contest per (agency, report).
 *
 * "Contest this" stayed on screen after sending and wrote `appeals/{auto}`
 * with no check, so an agency could file any number of contests against one
 * decision, each a separate item in the reviewers' queue. Now:
 *
 *   * a contest goes to `contest_{agencyId}_{reportId}` (slot 1) with CREATE
 *     semantics — `firestore.rules` allows no update on `appeals`, so a write
 *     to an id that already exists is refused; a DECIDED contest keeps its id
 *     (history) and a later one takes the next slot (`…_2`): whether an agency
 *     may contest again after a decision is unchanged (decision 15 in the
 *     investigation, not this fix);
 *   * the button is hidden while one is pending, and right after sending.
 *
 * The self-appeal ids (`self_{uid}_{restriction}`) are derived in
 * `functions/src/appealIds.ts` and `util/AppealIds.kt`.
 *
 * Pure: no Firebase, no React. `appealIds.spec.ts` runs it.
 */

/** Deterministic slots tried before falling back to an automatic id. */
export const MAX_APPEAL_SLOTS = 50

/** `contest_{agencyId}_{reportId}` for slot 1; `…_{n}` after it. */
export function contestAppealId(agencyId: string, reportId: string, slot: number): string {
  const base = `contest_${agencyId}_${reportId}`
  return slot <= 1 ? base : `${base}_${slot}`
}

/** A pending appeal occupies its slot; a decided one is history. */
export function appealIsPending(status: unknown): boolean {
  return String(status ?? 'pending') === 'pending'
}

export type AppealSlotOutcome =
  | { created: true }
  | { created: false; existing: Record<string, unknown> }

export interface AppealPlacementSteps {
  createIfAbsent: (id: string) => Promise<AppealSlotOutcome>
}

export type AppealPlacement =
  | { ok: true; id: string; slot: number }
  | { ok: false; reason: 'pending' | 'needs_new' | 'exhausted'; id: string }

/** RC: the comparison the rules and the servers make — case and spacing ignored. */
export function normaliseStatement(text: unknown): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Place a contest at the first free slot, stepping past decided ones.
 *
 * RC (confirmed): "another appeal after a decision only with new evidence or
 * a valid reason" — a contest after a DECIDED one that repeats its statement
 * (and brings no evidence) is not filed (`needs_new`); the rules refuse it
 * too. The pinned ids are the only ids the rules accept, so there is no
 * automatic-id fallback any more (`exhausted`).
 */
export async function placeContest(
  agencyId: string,
  reportId: string,
  steps: AppealPlacementSteps,
  statement = '',
  evidenceCount = 0,
): Promise<AppealPlacement> {
  let decided: string | null = null
  for (let slot = 1; slot <= MAX_APPEAL_SLOTS; slot += 1) {
    const id = contestAppealId(agencyId, reportId, slot)
    if (decided !== null && evidenceCount === 0 && normaliseStatement(statement) === normaliseStatement(decided)) {
      return { ok: false, reason: 'needs_new', id }
    }
    const outcome = await steps.createIfAbsent(id)
    if (outcome.created) return { ok: true, id, slot }
    if (appealIsPending(outcome.existing.status)) return { ok: false, reason: 'pending', id }
    decided = String(outcome.existing.statement ?? '')
  }
  return { ok: false, reason: 'exhausted', id: '' }
}

/** An agency's appeal, as its own `appeals where agencyId ==` read returns it. */
export interface AgencyAppealRow {
  kind?: unknown
  reportId?: unknown
  status?: unknown
  raisedByRole?: unknown
}

/** The reports this agency has a PENDING contest against — their button is hidden. */
export function pendingContestReportIds(rows: readonly AgencyAppealRow[]): Set<string> {
  const out = new Set<string>()
  for (const r of rows) {
    if (r.kind !== 'report' || r.raisedByRole !== 'agency') continue
    if (!appealIsPending(r.status)) continue
    if (typeof r.reportId === 'string' && r.reportId) out.add(r.reportId)
  }
  return out
}

export const CONTEST_ALREADY_PENDING =
  'You have already contested this decision, and a reviewer has it. Nothing new was sent.'

export const CONTEST_NEEDS_NEW =
  'This decision was already contested and decided. To contest it again, explain what is new since ' +
  'that decision — repeating the earlier statement is not enough. Nothing was sent.'

export const CONTEST_EXHAUSTED = 'This decision has been contested too many times. Contact ZIPPER staff.'

/** RC: reports whose agency contest was decided OVERTURNED — nothing is left to contest. */
export function overturnedContestReportIds(rows: readonly AgencyAppealRow[]): Set<string> {
  const out = new Set<string>()
  for (const r of rows) {
    if (r.kind !== 'report' || r.raisedByRole !== 'agency') continue
    if (String(r.status ?? '') !== 'overturned') continue
    if (typeof r.reportId === 'string' && r.reportId) out.add(r.reportId)
  }
  return out
}

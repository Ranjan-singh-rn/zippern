/**
 * FX-13 (RF-19 / DUP-09) — deterministic appeal ids, so one restriction has at
 * most one PENDING self-appeal however many devices or paths file it.
 *
 * Account appeals were check-then-add: `appeals/{auto}` from the app
 * (`AppealRepository.appealMyBan`, a read then `add`) and from the device-key
 * path here (`appealStateFor`, then `add`). Two devices, or the app and the
 * device-key path at the same moment, both read "none pending" and both added
 * one; a failed read counted as "none".
 *
 * An appeal now goes to `self_{uid}_{restriction}` — slot 1 — written with
 * CREATE semantics: a transaction here, and on the client a write the rules
 * refuse when the document exists (`appeals` allows no update). A DECIDED
 * appeal keeps its id (it is history), so a new appeal for the same
 * restriction takes the next slot (`…_2`, `…_3`): whether a person may appeal
 * again after a refusal is unchanged (that is decision 15 in the
 * investigation, not this fix).
 *
 * The same derivation is in the app (`util/AppealIds.kt`) and the CRM
 * (`lib/appealIds.ts`); the three must not drift apart.
 */

/** Deterministic slots tried before falling back to an automatic id. */
export const MAX_APPEAL_SLOTS = 50

function millisOf(v: unknown): number | null {
  if (v == null) return null
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (v instanceof Date) return v.getTime()
  const t = v as { toMillis?: () => number }
  if (typeof t.toMillis === 'function') return t.toMillis()
  return null
}

/**
 * Which restriction an appeal is about, from the account document: the
 * suspension (when suspended) or the ban, stamped with when it was imposed —
 * so a later, separate restriction is a new key.
 */
export function restrictionKeyOf(u: Record<string, unknown>): string {
  const suspended = u.isSuspended === true || u.accountState === 'suspended'
  const banned = u.isBanned === true || u.accountState === 'banned'
  const kind = suspended ? 'suspension' : banned ? 'ban' : 'restriction'
  const at = millisOf(suspended ? u.suspendedAt : u.bannedAt)
  return at == null ? kind : `${kind}-${at}`
}

/** `self_{uid}_{restriction}` for slot 1; `…_{n}` after it. */
export function selfAppealId(uid: string, restrictionKey: string, slot: number): string {
  const base = `self_${uid}_${restrictionKey}`
  return slot <= 1 ? base : `${base}_${slot}`
}

/** A pending appeal occupies its slot; a decided one is history. */
export function appealIsPending(data: Record<string, unknown> | undefined): boolean {
  return String((data ?? {}).status ?? 'pending') === 'pending'
}

// ── RC (confirmed): another appeal after a decision ─────────────────────────
//
// "Permit another appeal after a decision only with new evidence or a valid
// reason." The same rule as backend `appeal_policy.reappeal_problem` and the
// `appeals` create rule in firestore.rules: once an appeal for the restriction
// has been DECIDED, the next one is accepted only with new evidence (at least
// one file this time) or a statement that is not one already decided.

export const REAPPEAL_REFUSAL =
  'This was already decided. To appeal again, add new evidence, or explain what is new ' +
  'since the decision — repeating the earlier statement is not enough.'

function normalise(text: unknown): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** Pure: '' when allowed; otherwise the refusal. */
export function reappealProblem(
  previousDecidedStatements: readonly unknown[], statement: string, evidenceCount = 0,
): string {
  const decided = previousDecidedStatements.map(normalise)
  if (decided.length === 0) return ''
  if (evidenceCount > 0) return ''
  return decided.includes(normalise(statement)) ? REAPPEAL_REFUSAL : ''
}

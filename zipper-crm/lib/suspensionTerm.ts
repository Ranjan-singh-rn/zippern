/**
 * How long a suspension runs — the pure half of `components/SuspendDuration`.
 *
 * QA #52 (3 Nov 2026): the days box opened FILLED with "7" (it looked like the
 * "e.g. 7" hint), so an operator who typed 2 suspended for 72 days; the end
 * date was never shown before confirming; and the field accepted whatever a
 * number input accepts ("1e2", "-3", "2.5"). Now:
 *
 *   * the box starts EMPTY and the term must be chosen;
 *   * only digits can be typed, at most three (`normaliseDaysInput`);
 *   * 1–365 is checked here and by the server (`suspend_user`,
 *     `suspend_host`), with a sentence for each failure;
 *   * the end — date AND time, in IST — is shown before the confirm button
 *     (`suspensionPreview`), and indefinite says it never ends by itself.
 *
 * Used by the account suspension (users list and account page), the Host-role
 * suspension (same dialog) and the reports queue. Pure: `suspensionTerm.spec.ts`
 * runs it.
 */

import { formatIst } from './istTime'

export const MIN_SUSPEND_DAYS = 1
export const MAX_SUSPEND_DAYS = 365
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * What the dialog is holding. `days` is the raw text, because the field is
 * legitimately mid-edit — empty, or "1" on the way to "14".
 */
export interface SuspensionTerm {
  timed: boolean
  days: string
}

/** Timed, with NO number filled in: the operator chooses it (QA #52). */
export const DEFAULT_SUSPENSION: SuspensionTerm = { timed: true, days: '' }

/** What the box keeps of what was typed or pasted: digits only, at most three. */
export function normaliseDaysInput(raw: string): string {
  return String(raw ?? '').replace(/[^0-9]/g, '').slice(0, 3)
}

/** What to send as `days`. `undefined` is the indefinite case the API expects. */
export function suspensionDays(term: SuspensionTerm): number | undefined {
  return term.timed ? Number(term.days) : undefined
}

/** The sentence to show, or null when the term is good. */
export function suspensionProblem(term: SuspensionTerm): string | null {
  if (!term.timed) return null
  if (String(term.days ?? '').trim() === '') {
    return `Enter how many days (${MIN_SUSPEND_DAYS}–${MAX_SUSPEND_DAYS}), or choose Indefinite.`
  }
  if (!/^[0-9]+$/.test(term.days.trim())) {
    return `The number of days is a whole number from ${MIN_SUSPEND_DAYS} to ${MAX_SUSPEND_DAYS}.`
  }
  const n = Number(term.days)
  if (!Number.isInteger(n) || n < MIN_SUSPEND_DAYS || n > MAX_SUSPEND_DAYS) {
    return (
      `A suspension runs from ${MIN_SUSPEND_DAYS} to ${MAX_SUSPEND_DAYS} days. ` +
      'For longer than that, choose Indefinite and lift it with Resume.'
    )
  }
  return null
}

/**
 * The line shown BEFORE confirming: when it ends, in IST, or that it does not.
 * Null while the term is not valid yet (the problem sentence is shown instead).
 */
export function suspensionPreview(term: SuspensionTerm, nowMs: number = Date.now()): string | null {
  if (!term.timed) return 'No end date — it stays in force until somebody presses Resume.'
  if (suspensionProblem(term)) return null
  const days = Number(term.days)
  const end = formatIst(nowMs + days * DAY_MS)
  return `Ends ${end} — ${days} day${days === 1 ? '' : 's'} from now. It lifts itself then.`
}

/**
 * What just happened, from what the server sent back. `suspendedUntil` is the
 * server's ISO 8601 string, or '' for indefinite.
 */
export function suspensionResult(days: number | undefined, suspendedUntil?: string): string {
  if (!days) {
    return 'Suspended with no end date. It stays in force until somebody presses Resume.'
  }
  const until = suspendedUntil ? formatIst(suspendedUntil) : ''
  return (
    `Suspended for ${days} day${days === 1 ? '' : 's'}${until ? `, until ${until}` : ''}. ` +
    'It lifts itself on the scheduled sweep — nobody has to remember.'
  )
}

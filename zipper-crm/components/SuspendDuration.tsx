'use client'

/**
 * How long a suspension runs.
 *
 * Two screens suspend an account — the account page (`app/users/[uid]`) and the
 * row action on the list (`app/users`) — and for a while only one of them asked
 * this question. The list sent `api.users.suspend(uid, reason)` with no `days`,
 * which the API reads as "indefinite", so suspending from the list produced a
 * restriction that nothing will ever lift on its own. Nobody chose that: the
 * dialog simply never offered the choice, and the two screens disagreed about
 * what "Suspend" means.
 *
 * So the control, its bounds and its validation live here rather than being
 * written twice. A second copy is how they drift back apart — and the drift is
 * invisible, because both copies keep working.
 *
 * The bounds are the server's, restated: `suspend_user` in
 * `backend/app/services/users.py` accepts `days: int | None` between 1 and 365,
 * and omitting it is the indefinite case. They are checked here as well as
 * there because a refused suspension is a round trip that tells the operator
 * nothing they could not have been told while they were still typing.
 */

export const MIN_SUSPEND_DAYS = 1
export const MAX_SUSPEND_DAYS = 365

/**
 * What the dialog is holding.
 *
 * `days` is the raw string from the input and not a number, because the field
 * is legitimately mid-edit — empty, or "1" on the way to "14" — and coercing it
 * to a number would make every one of those states read as a bad value.
 */
export interface SuspensionTerm {
  timed: boolean
  days: string
}

/**
 * A suspension is timed by default. An indefinite one is a real decision —
 * "off the platform while we investigate" — but it is the one that needs
 * somebody to remember to come back, so it is chosen rather than defaulted to.
 */
export const DEFAULT_SUSPENSION: SuspensionTerm = { timed: true, days: '7' }

/** What to send as `days`. `undefined` is the indefinite case the API expects. */
export function suspensionDays(term: SuspensionTerm): number | undefined {
  return term.timed ? Number(term.days) : undefined
}

/** The sentence to show, or null when the term is good. */
export function suspensionProblem(term: SuspensionTerm): string | null {
  if (!term.timed) return null
  const n = Number(term.days)
  if (!Number.isInteger(n) || n < MIN_SUSPEND_DAYS || n > MAX_SUSPEND_DAYS) {
    return (
      `A suspension runs from ${MIN_SUSPEND_DAYS} to ${MAX_SUSPEND_DAYS} days. ` +
      'For longer than that, choose indefinite and lift it with Resume.'
    )
  }
  return null
}

/**
 * What just happened, in one sentence, from what the server sent back.
 *
 * Shared for the same reason the control is: the difference between the two
 * outcomes — one ends by itself, one waits for a person — is the thing the
 * operator most needs to have understood, and a screen that reports it in
 * vaguer words than the other is the screen that gets it wrong.
 *
 * `suspendedUntil` is the server's ISO 8601 string, or '' for indefinite.
 */
export function suspensionResult(days: number | undefined, suspendedUntil?: string): string {
  if (!days) {
    return 'Suspended with no end date. It stays in force until somebody presses Resume.'
  }
  const when = suspendedUntil ? new Date(suspendedUntil) : null
  const until = when && !isNaN(when.getTime()) ? `, until ${when.toLocaleString('en-IN')}` : ''
  return (
    `Suspended for ${days} day${days === 1 ? '' : 's'}${until}. ` +
    'It lifts itself on the scheduled sweep — nobody has to remember.'
  )
}

/**
 * The control itself. The caller owns the state, so a dialog can reset it with
 * the rest of its fields and validate it alongside the reason.
 */
export function SuspendDuration({
  value,
  onChange,
}: {
  value: SuspensionTerm
  onChange: (term: SuspensionTerm) => void
}) {
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-slate-400 text-xs font-medium mb-1.5">How long</label>
        <div className="flex gap-2">
          {[
            { value: true, label: 'For a set number of days' },
            { value: false, label: 'Indefinite' },
          ].map((option) => (
            <button
              key={String(option.value)}
              type="button"
              onClick={() => onChange({ ...value, timed: option.value })}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                value.timed === option.value
                  ? 'bg-pink-500 border-pink-400 text-white'
                  : 'bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-600'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        {/* The one line that tells the two apart. It is a real difference — a
            timed suspension writes `suspendedUntil` and the scheduled sweep
            resumes the account off it, so the date is a fact about what will
            happen rather than a label on a screen. */}
        <p className="text-slate-500 text-xs mt-2">
          A timed suspension <strong className="text-slate-300">ends by itself</strong> on the
          scheduled sweep. An indefinite one{' '}
          <strong className="text-slate-300">waits for somebody to press Resume</strong> — nothing
          will lift it on its own.
        </p>
      </div>

      {value.timed && (
        <div>
          <label className="block text-slate-400 text-xs font-medium mb-1.5">
            Days ({MIN_SUSPEND_DAYS}–{MAX_SUSPEND_DAYS})
          </label>
          <input
            type="number"
            min={MIN_SUSPEND_DAYS}
            max={MAX_SUSPEND_DAYS}
            value={value.days}
            onChange={(e) => onChange({ ...value, days: e.target.value })}
            placeholder="e.g. 7"
            className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2.5 text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
          />
        </div>
      )}
    </div>
  )
}

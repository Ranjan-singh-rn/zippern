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
 *
 * QA #52: the rules themselves (empty start, digits only, 1–365, the end date
 * shown in IST before confirming) are in `lib/suspensionTerm.ts`, which has no
 * React and runs in a spec; this file re-exports them for the existing callers.
 */

import {
  DEFAULT_SUSPENSION, MAX_SUSPEND_DAYS, MIN_SUSPEND_DAYS, normaliseDaysInput,
  suspensionDays, suspensionPreview, suspensionProblem, suspensionResult,
  type SuspensionTerm,
} from '@/lib/suspensionTerm'

export {
  DEFAULT_SUSPENSION, MAX_SUSPEND_DAYS, MIN_SUSPEND_DAYS, suspensionDays, suspensionProblem, suspensionResult,
}
export type { SuspensionTerm }

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
  const preview = suspensionPreview(value)
  const problem = value.timed && value.days !== '' ? suspensionProblem(value) : null
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-slate-400 text-xs font-medium mb-1.5">How long</label>
        <div className="flex gap-2">
          {[
            { value: true, label: 'Temporary — a set number of days' },
            { value: false, label: 'Indefinite — until Resume' },
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
          A temporary suspension <strong className="text-slate-300">ends by itself</strong> on the
          scheduled sweep. An indefinite one{' '}
          <strong className="text-slate-300">waits for somebody to press Resume</strong> — nothing
          will lift it on its own.
        </p>
      </div>

      {value.timed && (
        <div>
          <label className="block text-slate-400 text-xs font-medium mb-1.5">
            Number of days ({MIN_SUSPEND_DAYS}–{MAX_SUSPEND_DAYS})
          </label>
          {/* A text box, not a number input: a number input accepts "1e2", "-3"
              and "2.5", and its spinner nudges the value. Digits only, at most
              three; and it starts EMPTY — a pre-filled 7 turned a typed 2 into 72
              (QA #52). */}
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            value={value.days}
            onChange={(e) => onChange({ ...value, days: normaliseDaysInput(e.target.value) })}
            placeholder="Number of days"
            aria-describedby="suspend-duration-preview"
            className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2.5 text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
          />
          {problem && <p className="text-red-400 text-xs mt-1.5">{problem}</p>}
        </div>
      )}

      {preview && (
        <p
          id="suspend-duration-preview"
          className="text-xs rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-slate-200"
        >
          {preview}
        </p>
      )}
    </div>
  )
}

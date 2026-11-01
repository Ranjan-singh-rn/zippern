/**
 * WHAT AN APPEAL STATUS MEANS, AND WHO IT SAYS DECIDED IT.
 *
 * ── WHY THIS IS A MODULE AND NOT A COUPLE OF MAPS ON THE PAGE ────────────────
 *
 * The appeals page had three statuses hard-coded in four separate places — a
 * tab list, a tone map, a badge, and an `a.status === 'pending' ? … : …` that
 * decided whether to render a verdict. A fourth status, `resolved`, now exists
 * server-side, and every one of those four places got it wrong in a different
 * way. The worst was not the missing tab or the unstyled badge:
 *
 *     {a.decidedByName || 'A reviewer'} said: {a.decisionReason}
 *
 * `resolved` is written with NO `decidedByName`, deliberately — `appeals.py`
 * refuses to invent a reviewer for an administrative removal, because a
 * fabricated one would also satisfy the four-eyes check next time anybody
 * looked. So the fallback fired and the CRM attributed the removal to
 * "A reviewer" who had never read the appeal. The backend took care not to lie;
 * the UI said it anyway.
 *
 * One module, one answer per question, so the page cannot disagree with itself.
 *
 * ── NO IMPORTS, ON PURPOSE ───────────────────────────────────────────────────
 *
 * Same contract as `lib/partnerRouting.ts` and `lib/sessionGate.ts`: no React,
 * no Next, no `@/` paths. That is what lets `appealStatus.spec.ts` compile the
 * REAL module with plain `tsc` and run it under node — the shipped code, not a
 * copy of it. See `npm run test:appeals`.
 *
 * ── THE INVARIANT WORTH KEEPING ──────────────────────────────────────────────
 *
 * A status is a FACT about an appeal. A verdict is a CHOICE a reviewer makes.
 * They are different sets and must stay different types: `AppealStatus` has
 * four members and `AppealVerdict` has two, so `resolved` is unselectable in
 * the decide modal by construction rather than by a runtime check somebody
 * could forget.
 */

/** Every status the server can put on an appeal. Mirrors `AppealStatus` in `backend/app/services/appeals.py`. */
export const APPEAL_STATUSES = ['pending', 'upheld', 'overturned', 'resolved'] as const

export type AppealStatusValue = (typeof APPEAL_STATUSES)[number]

/** The two a reviewer may choose. Deliberately a strict subset. */
export const APPEAL_VERDICTS = ['upheld', 'overturned'] as const

export type AppealVerdictValue = (typeof APPEAL_VERDICTS)[number]

export interface AppealStatusPresentation {
  /** What the badge says. */
  readonly label: string
  /** Tailwind classes for the badge. */
  readonly tone: string
  /**
   * One line explaining the state, shown where a reviewer needs it.
   * Empty when the status speaks for itself.
   */
  readonly note: string
  /** Did a reviewer decide this? Governs whether we may attribute it to one. */
  readonly isReviewerDecision: boolean
  /** Is there still work for a reviewer here? */
  readonly isActionable: boolean
}

const UNKNOWN: AppealStatusPresentation = Object.freeze({
  label: 'unknown',
  // Neutral slate. Never green (reads as success) and never red (reads as a
  // refusal) — this build cannot tell which it would be.
  tone: 'bg-slate-800 text-slate-300 border-slate-700',
  note: 'This build does not recognise this status. The record is shown unchanged.',
  isReviewerDecision: false,
  isActionable: false,
})

/**
 * Frozen, not merely `readonly`. `presentAppealStatus` hands back the shared
 * entry rather than a copy, so `readonly` — which is erased at runtime — would
 * let one careless caller restyle every badge in the CRM. Freezing makes the
 * annotation true in the shipped bundle.
 */
const TABLE: Record<AppealStatusValue, AppealStatusPresentation> = Object.freeze({
  pending: Object.freeze({
    label: 'pending',
    tone: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30',
    note: '',
    isReviewerDecision: false,
    isActionable: true,
  }),
  upheld: Object.freeze({
    label: 'upheld',
    tone: 'bg-slate-700 text-slate-300 border-slate-600',
    note: '',
    isReviewerDecision: true,
    isActionable: false,
  }),
  overturned: Object.freeze({
    label: 'overturned',
    tone: 'bg-green-500/15 text-green-300 border-green-500/30',
    note: '',
    isReviewerDecision: true,
    isActionable: false,
  }),
  resolved: Object.freeze({
    label: 'resolved',
    // Blue, and deliberately neither of the two decision colours. Green would
    // read as "the appeal succeeded" and slate would read as "it was refused";
    // this was neither, and the badge should not imply either one.
    tone: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
    note: 'The restriction was removed administratively without an appeal decision.',
    // The whole point. Nothing may attribute this to a reviewer.
    isReviewerDecision: false,
    // Nothing left to decide: the restriction is gone and the appeal is closed.
    // It is not in the Waiting queue and must not be.
    isActionable: false,
  }),
})

/** Is this one of the statuses this build knows? */
export function isKnownAppealStatus(status: string | null | undefined): status is AppealStatusValue {
  return (APPEAL_STATUSES as readonly string[]).includes((status ?? '').trim())
}

/**
 * How to show a status. Total over every string, including ones that do not
 * exist yet — a future fifth status renders neutrally rather than falling into
 * whichever branch happened to be the `else`.
 */
export function presentAppealStatus(status: string | null | undefined): AppealStatusPresentation {
  const s = (status ?? '').trim()
  if (!isKnownAppealStatus(s)) return Object.freeze({ ...UNKNOWN, label: s || 'unknown' })
  return TABLE[s]
}

/**
 * May this status be attributed to a reviewer?
 *
 * `false` for `resolved`, which is the fix: the page used to print
 * "A reviewer said:" for anything that was not pending.
 */
export function isReviewerDecision(status: string | null | undefined): boolean {
  return presentAppealStatus(status).isReviewerDecision
}

/** Is a reviewer still expected to do something? Only `pending`. */
export function isActionable(status: string | null | undefined): boolean {
  return presentAppealStatus(status).isActionable
}

/** May a reviewer choose this as a verdict? Only the two. */
export function isSelectableVerdict(value: string | null | undefined): value is AppealVerdictValue {
  return (APPEAL_VERDICTS as readonly string[]).includes((value ?? '').trim())
}

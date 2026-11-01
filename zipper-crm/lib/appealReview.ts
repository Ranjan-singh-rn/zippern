/**
 * §5 — ban and suspension appeals: reviewers RECOMMEND, the Owner DECIDES,
 * and four eyes always.
 *
 *   POST /users/appeals/{id}/recommend  {outcome: uphold|overturn, note ≥ 10}
 *        `can_ban_users`; never by whoever made the decision being appealed.
 *        Lifts nothing — the appeal stays pending and the Owners are told.
 *   POST /users/appeals/{id}/decide     {verdict: upheld|overturned, reason ≥ 10}
 *        the Owner only (403 with OWNER_ONLY_DECIDE for anybody else); four
 *        eyes hold for the Owner too.
 *
 * And beside every appeal, the restriction it is about — who decided it, why,
 * the ban's category, evidence and scope — and the recommendation, so the
 * person deciding sees the original decision, the evidence and the notes side
 * by side (`appeals.restriction_summary`).
 *
 * ── WHAT THIS MODULE MAY AND MAY NOT DECIDE ──────────────────────────────────
 *
 * It decides what to OFFER. The server decides what happens, and its refusals
 * are sentences shown verbatim. The one refusal pre-empted here is the
 * four-eyes case the CRM can see for itself (`restriction.decidedBy` is the
 * reviewer), with the server's own sentence; the server also checks things
 * the CRM cannot see — the decider of a contested report — and those arrive
 * as its refusal.
 *
 * Imports only `./banDetails` (import-free), so `npm run test:appealreview`
 * compiles both and runs the shipped code.
 */

import { banCategoryLabel, banScopeLabel } from './banDetails'

/** `AppealRecommendation.note: min_length=10`. */
export const MIN_RECOMMENDATION_NOTE = 10
/** `AppealDecision.reason: min_length=10` — it is the whole answer the person gets. */
export const MIN_DECISION_REASON = 10

export const RECOMMENDATION_OUTCOMES = ['uphold', 'overturn'] as const
export type RecommendationOutcome = (typeof RECOMMENDATION_OUTCOMES)[number]

export const OUTCOME_LABEL: Readonly<Record<RecommendationOutcome, string>> = Object.freeze({
  uphold: 'Uphold — the decision stands',
  overturn: 'Overturn — the decision was wrong',
})

/** `OWNER_ONLY_DECIDE` in `backend/app/services/appeals.py`, verbatim. */
export const OWNER_ONLY_DECIDE =
  'Only the Owner decides a ban or suspension appeal. Record your recommendation ' +
  'on it instead; the Owners are told.'

/** `FOUR_EYES_REFUSAL` in `backend/app/services/appeals.py`, verbatim. */
export const FOUR_EYES_REFUSAL =
  'You made the decision being appealed, so you cannot decide the appeal. ' +
  'Someone else has to look at it.'

/** Shown to a reviewer who may read the queue and may neither recommend nor decide. */
export const RECOMMEND_NEEDS_PERMISSION =
  'Recommending on an appeal needs the ban permission, and only the Owner decides. ' +
  'You can read the appeal and open the account.'

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function isRecommendationOutcome(v: unknown): v is RecommendationOutcome {
  return (RECOMMENDATION_OUTCOMES as readonly string[]).includes(text(v))
}

/** The verdict a recommendation argues for — what the Owner's dialog pre-selects. */
export function verdictFor(outcome: unknown): 'upheld' | 'overturned' | null {
  const o = text(outcome)
  if (o === 'uphold') return 'upheld'
  if (o === 'overturn') return 'overturned'
  return null
}

export interface AppealReviewer {
  /** The API session's role is `owner`. */
  isOwner: boolean
  /** `can_ban_users` — the reviewer's tier on the server. */
  canBan: boolean
  uid?: string | null
}

export interface AppealReviewActions {
  /** May file (or replace) a recommendation now. */
  recommend: boolean
  /** May decide now. Never true for anybody but the Owner. */
  decide: boolean
  /** The restriction under appeal was decided by this reviewer (as far as the CRM can see). */
  ownDecision: boolean
  /** The sentence beside the controls; '' when there is nothing to say. */
  hint: string
}

/**
 * What one reviewer is offered on one appeal.
 *
 *   not pending          → nothing (the appeal is decided or resolved)
 *   own decision         → nothing, with the server's four-eyes sentence
 *   the Owner            → Decide
 *   `can_ban_users`      → Recommend, with "only the Owner decides"
 *   anybody else         → nothing, and why
 */
export function appealReviewActions(
  appeal: { status?: unknown; restriction?: { decidedBy?: unknown } | null },
  me: AppealReviewer,
): AppealReviewActions {
  const open = text(appeal.status) === 'pending'
  const decidedBy = text(appeal.restriction?.decidedBy)
  const mine = text(me.uid)
  const ownDecision = !!decidedBy && !!mine && decidedBy === mine
  if (!open) return { recommend: false, decide: false, ownDecision, hint: '' }
  if (ownDecision) return { recommend: false, decide: false, ownDecision, hint: FOUR_EYES_REFUSAL }
  if (me.isOwner) return { recommend: false, decide: true, ownDecision, hint: '' }
  if (me.canBan) return { recommend: true, decide: false, ownDecision, hint: OWNER_ONLY_DECIDE }
  return { recommend: false, decide: false, ownDecision, hint: RECOMMEND_NEEDS_PERMISSION }
}

/** '' when a recommendation may be sent; otherwise the sentence to show first. */
export function recommendationProblem(outcome: unknown, note: unknown): string {
  if (!isRecommendationOutcome(outcome)) return 'Choose: uphold the decision, or overturn it.'
  const n = text(note).length
  if (n >= MIN_RECOMMENDATION_NOTE) return ''
  return `At least ${MIN_RECOMMENDATION_NOTE} characters — the note is the record the Owner decides on` +
    (n > 0 ? ` (${n} so far).` : '.')
}

/** '' when a decision reason may be sent; otherwise the sentence to show first. */
export function decisionReasonProblem(reason: unknown): string {
  const n = text(reason).length
  if (n >= MIN_DECISION_REASON) return ''
  return `At least ${MIN_DECISION_REASON} characters. This is shown to the person who appealed — ` +
    'it is the whole answer they get.'
}

/** A Firestore timestamp, `{seconds}`, or an ISO string, in milliseconds. */
export function millisOf(value: unknown): number | null {
  if (!value) return null
  if (typeof value === 'string') {
    const t = Date.parse(value)
    return Number.isNaN(t) ? null : t
  }
  if (typeof value === 'object') {
    const s = (value as { seconds?: unknown; _seconds?: unknown }).seconds
      ?? (value as { _seconds?: unknown })._seconds
    return typeof s === 'number' && Number.isFinite(s) ? s * 1000 : null
  }
  return null
}

/** "Name (role)", or the uid, or "not recorded" — never an invented person. */
export function whoLabel(name: unknown, role: unknown, uid: unknown): string {
  const n = text(name)
  const r = text(role).replace(/_/g, ' ')
  const u = text(uid)
  if (n) return r ? `${n} (${r})` : n
  if (u) return r ? `${u} (${r})` : u
  return 'not recorded'
}

export interface RestrictionView {
  isBan: boolean
  /** "Banned", "Suspended until …" is composed by the page from `untilMs`. */
  stateLabel: string
  untilMs: number | null
  decidedBy: string
  decidedByUid: string
  decidedAtMs: number | null
  reason: string
  /** A ban's category label ('' on a suspension). */
  category: string
  scope: string
  evidence: string[]
}

/**
 * The restriction beside an appeal, ready to print. `null` when the server
 * sent none — an unrestricted account, or one that could not be read — which
 * the page says in words rather than leaving a gap.
 */
export function presentRestriction(r: unknown): RestrictionView | null {
  if (!r || typeof r !== 'object') return null
  const o = r as Record<string, unknown>
  const state = text(o.state)
  if (!state) return null
  const isBan = state === 'banned'
  return {
    isBan,
    stateLabel: isBan ? 'Banned' : state === 'suspended' ? 'Suspended' : state,
    untilMs: isBan ? null : millisOf(o.suspendedUntil),
    decidedBy: whoLabel(o.decidedByName, o.decidedByRole, o.decidedBy),
    decidedByUid: text(o.decidedBy),
    decidedAtMs: millisOf(o.decidedAt),
    reason: text(o.reason),
    category: isBan ? banCategoryLabel(o.category) : '',
    scope: isBan
      ? banScopeLabel(o.scope)
      : 'Account only — a suspension never bars a device',
    evidence: isBan && Array.isArray(o.evidence)
      ? o.evidence.map((e) => text(e)).filter(Boolean)
      : [],
  }
}

export interface RecommendationView {
  outcome: RecommendationOutcome | null
  /** "Recommends overturning" — or the raw outcome when this build does not know it. */
  label: string
  by: string
  byUid: string
  atMs: number | null
  note: string
}

export function presentRecommendation(rec: unknown): RecommendationView | null {
  if (!rec || typeof rec !== 'object') return null
  const o = rec as Record<string, unknown>
  const raw = text(o.outcome)
  if (!raw && !text(o.note)) return null
  const outcome = isRecommendationOutcome(raw) ? raw : null
  return {
    outcome,
    label: outcome === 'overturn'
      ? 'Recommends overturning'
      : outcome === 'uphold'
        ? 'Recommends upholding'
        : `Recommends: ${raw || 'not stated'}`,
    by: whoLabel(o.byName, o.byRole, o.byUid),
    byUid: text(o.byUid),
    atMs: millisOf(o.at),
    note: text(o.note),
  }
}

/**
 * On a decided appeal: the recommendation it was decided on, and whether the
 * Owner followed it. '' when it was decided without one.
 */
export function decidedOnRecommendationLine(d: unknown): string {
  if (!d || typeof d !== 'object') return ''
  const o = d as Record<string, unknown>
  const outcome = text(o.outcome)
  if (!outcome) return ''
  const what = outcome === 'overturn' ? 'overturn' : outcome === 'uphold' ? 'uphold' : outcome
  const followed = o.followed === true ? 'followed' : o.followed === false ? 'not followed' : 'outcome not recorded'
  return `Decided on a recommendation to ${what} — ${followed}.`
}

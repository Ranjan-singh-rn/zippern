/**
 * §8 — one Owner may raise, verify, sign and execute a money card alone.
 * What the board offers an Owner, and how it reports that the other Owners
 * were told.
 *
 *   POST /cards/{id}/owner-fast-path
 *        {verification_note ≥ 3, signature_note?, execute?, payment_ref?}
 *        → the card + `fast_path: {steps: [{stage, action}], executed}`
 *
 * The server runs every remaining stage IN ORDER, each with its own audit
 * entry — review → verification → signature → (execution) — and each is
 * conditional on the stage it expects, so a step that fails leaves the card at
 * the stage it reached and the error names it. `fastPathPlan` is the list the
 * confirmation shows BEFORE anything is sent: which stages will run, from
 * where the card is now, and whether the money will move.
 *
 * Mirrored from `backend/app/services/cards.py` (and checked against it by the
 * spec when the backend sits beside this repo):
 *
 *   * `owner_fast_path` refuses a card already executed, rejected or failed
 *     ("Card is already …");
 *   * `sign` refuses an Owner the card that pays THEM
 *     (`SELF_SUBJECT_NEEDS_ANOTHER_OWNER`) — under §8 that is the one thing an
 *     Owner still cannot sign alone; raising or verifying it no longer bars
 *     them (`OWNER_ALONE`);
 *   * execution runs only for a type with a registered executor
 *     (`cards.EXECUTORS`) — and for any other type the server SIGNS first and
 *     then refuses, so this module never asks it to;
 *   * a payout (`commission_payout`, `host_withdrawal`, `subagency_payout`)
 *     and a running cost (`operating_expense`) need their bank reference to
 *     execute, exactly as their own routes do.
 *
 * Pure — no imports — so `npm run test:fastpath` runs the shipped module.
 */

export type CardStageValue =
  | 'requested' | 'under_review' | 'awaiting_signoff'
  | 'approved' | 'executed' | 'rejected' | 'failed'

/** The card types with a registered executor (`cards.register_executor`). */
export const EXECUTABLE_TYPES: ReadonlySet<string> = new Set([
  'seller_coin_purchase',
  'lending_issue',
  'lending_repay',
  'lending_recover',
  'bad_debt_write_off',
  'commission_payout',
  'host_withdrawal',
  'subagency_payout',
  'balance_credit',
  'balance_debit',
  'operating_expense',
  'owner_capital_in',
  'owner_drawings',
])

/**
 * The executors that pass a bank reference on — and whose execution refuses
 * without one: the three payouts, and a running cost (`execute_expense`).
 */
export const PAYMENT_REF_TYPES: ReadonlySet<string> = new Set([
  'commission_payout',
  'host_withdrawal',
  'subagency_payout',
  'operating_expense',
])

/** `OwnerFastPath.payment_ref: max_length=128`. */
export const MAX_PAYMENT_REF = 128
/** `OwnerFastPath.verification_note: min_length=3, max_length=1000`. */
export const MIN_VERIFICATION_NOTE = 3
export const MAX_NOTE = 1000

/** `sign`'s refusal for the card that pays the signer, verbatim. */
export const SELF_SUBJECT_REFUSAL = 'This card pays you. Another owner must sign it.'

/** `verify`'s refusal for an empty note, verbatim. */
export const VERIFICATION_NOTE_REQUIRED = 'Verification requires a note describing what was checked.'

const TERMINAL: ReadonlySet<string> = new Set(['executed', 'rejected', 'failed'])

export interface FastPathStep {
  /** The stage the card is in AFTER this step. */
  stage: CardStageValue
  /** What the Owner is doing at this step. */
  label: string
  /** The audit action the server records for it. */
  action: string
}

const STEP: Readonly<Record<'under_review' | 'awaiting_signoff' | 'approved' | 'executed', FastPathStep>> = Object.freeze({
  under_review: { stage: 'under_review', label: 'Start the review', action: 'card.review_started' },
  awaiting_signoff: { stage: 'awaiting_signoff', label: 'Verify it — your note is the verification', action: 'card.verified' },
  approved: { stage: 'approved', label: 'Sign it', action: 'card.signed' },
  executed: { stage: 'executed', label: 'Execute it — the money moves', action: 'card.executed' },
})

export const STAGE_LABEL: Readonly<Record<CardStageValue, string>> = Object.freeze({
  requested: 'Requested',
  under_review: 'Under review',
  awaiting_signoff: 'Awaiting sign-off',
  approved: 'Approved',
  executed: 'Executed',
  rejected: 'Rejected',
  failed: 'Failed',
})

export interface FastPathPlan {
  /** Every stage the server will run, in order. Empty when there is nothing to run. */
  steps: FastPathStep[]
  /** The card's type has an executor. */
  canExecute: boolean
  /** Execution was asked for AND can happen — the money moves in this call. */
  executes: boolean
  /** Executing needs the bank reference. */
  needsPaymentRef: boolean
  /** Why the fast path cannot run at all; '' when it can. */
  refusal: string
  /** Something the Owner should know that does not stop it; '' when none. */
  note: string
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * The plan for one card, from where it stands now.
 *
 * `execute` is what the Owner ticked; it is dropped (with a note) for a type
 * that has no executor rather than sent — the server would sign the card and
 * only then refuse, leaving an approved card the Owner thought was paid.
 */
export function fastPathPlan(
  card: { stage?: unknown; type?: unknown; subject?: { id?: unknown } | null },
  opts: { execute: boolean; myUid: string },
): FastPathPlan {
  const stage = text(card.stage)
  const type = text(card.type)
  const canExecute = EXECUTABLE_TYPES.has(type)
  const executes = opts.execute && canExecute
  const needsPaymentRef = executes && PAYMENT_REF_TYPES.has(type)
  const base = { canExecute, executes, needsPaymentRef }

  if (TERMINAL.has(stage)) {
    return { ...base, executes: false, needsPaymentRef: false, steps: [], refusal: `Card is already ${stage}.`, note: '' }
  }

  const steps: FastPathStep[] = []
  if (stage === 'requested') steps.push(STEP.under_review, STEP.awaiting_signoff, STEP.approved)
  else if (stage === 'under_review') steps.push(STEP.awaiting_signoff, STEP.approved)
  else if (stage === 'awaiting_signoff') steps.push(STEP.approved)
  else if (stage !== 'approved') {
    return { ...base, executes: false, needsPaymentRef: false, steps: [], refusal: `This build does not know the stage "${stage || 'none'}". Nothing is offered on it.`, note: '' }
  }

  // §8 still keeps one signature from an Owner alone: the card that pays them.
  const subjectId = text(card.subject?.id)
  const signs = steps.some((s) => s.stage === 'approved')
  if (signs && subjectId && subjectId === text(opts.myUid)) {
    return { ...base, executes: false, needsPaymentRef: false, steps: [], refusal: SELF_SUBJECT_REFUSAL, note: '' }
  }

  if (executes) steps.push(STEP.executed)

  let note = ''
  if (opts.execute && !canExecute) {
    note = `A ${type || 'card of this'} card is executed from its own screen, not from here — the fast path stops at the signature.`
  } else if (!opts.execute && canExecute) {
    note = 'The money does not move unless you also tick Execute — the card stops at Approved.'
  }

  if (steps.length === 0) {
    return {
      ...base,
      steps,
      refusal: canExecute
        ? 'The card is already signed. Tick Execute to move the money, or execute it from its own screen.'
        : 'The card is already signed. It is executed from its own screen.',
      note: '',
    }
  }
  return { ...base, steps, refusal: '', note }
}

/** '' when the fast path may be sent; otherwise the sentence to show first. */
export function fastPathProblem(
  plan: FastPathPlan,
  input: { verificationNote: string; signatureNote?: string; paymentRef?: string },
): string {
  if (plan.refusal) return plan.refusal
  const note = text(input.verificationNote)
  if (note.length < MIN_VERIFICATION_NOTE) return VERIFICATION_NOTE_REQUIRED
  if (note.length > MAX_NOTE || text(input.signatureNote).length > MAX_NOTE) {
    return `A note is at most ${MAX_NOTE} characters.`
  }
  const ref = text(input.paymentRef)
  if (plan.needsPaymentRef && !ref) {
    return 'This card needs its bank reference (UTR or transaction id) to execute — exactly as its own screen does.'
  }
  if (ref.length > MAX_PAYMENT_REF) return `A payment reference is at most ${MAX_PAYMENT_REF} characters.`
  return ''
}

/**
 * Why an Owner may not sign this card, or '' when nothing the CRM can see
 * stops them. Under §8 an Owner signs a card they raised or verified; the
 * card that pays them still needs another Owner. The server decides; this is
 * only so the button does not offer what it will refuse.
 */
export function ownerSignBlock(card: { subject?: { id?: unknown } | null }, myUid: string): string {
  const subjectId = text(card.subject?.id)
  return subjectId && subjectId === text(myUid) ? SELF_SUBJECT_REFUSAL : ''
}

// ── Were the other Owners told? ──────────────────────────────────────────────

export interface OwnerNoticeLine {
  tone: 'ok' | 'warn' | 'error' | 'unknown'
  text: string
}

/** One sentence for an `owner_notice` (`owner_mail.notify_other_owners`). */
export function ownerNoticeLine(notice: unknown): OwnerNoticeLine {
  if (!notice || typeof notice !== 'object') {
    return { tone: 'unknown', text: 'The server did not say whether the other Owners were told.' }
  }
  const n = notice as Record<string, unknown>
  const status = text(n.status)
  const recipients = typeof n.recipients === 'number' ? n.recipients : null
  switch (status) {
    case 'sent':
      return {
        tone: 'ok',
        text: n.already === true
          ? 'The other Owners had already been told.'
          : `The other Owners were told${recipients ? ` (${recipients})` : ''}, in-app and by email.`,
      }
    case 'no_recipients':
      return { tone: 'ok', text: 'There is no other active Owner to tell.' }
    case 'pending':
      return {
        tone: 'warn',
        text: 'Not every other Owner could be told yet. It is retried every 15 minutes, and from ' +
          'Money integrity → Owner notices.',
      }
    case 'failed':
      return {
        tone: 'error',
        text: `The other Owners could not be told${text(n.error) ? `: ${text(n.error)}` : ''}. ` +
          'The action stands; retry it from Money integrity → Owner notices.',
      }
    default:
      return { tone: 'unknown', text: `Owner notice: ${status || 'no status'}.` }
  }
}

/** For a bulk signature: how many signatures reached every other Owner. */
export function ownerNoticeTally(cards: readonly unknown[]): string {
  let told = 0
  let pending = 0
  let unknown = 0
  for (const c of cards) {
    const notice = c && typeof c === 'object' ? (c as { owner_notice?: unknown }).owner_notice : undefined
    const tone = ownerNoticeLine(notice).tone
    if (tone === 'ok') told += 1
    else if (tone === 'warn' || tone === 'error') pending += 1
    else unknown += 1
  }
  if (cards.length === 0) return ''
  const parts = [`Other Owners told for ${told} of ${cards.length} signature${cards.length === 1 ? '' : 's'}`]
  if (pending) parts.push(`${pending} not yet — retried every 15 minutes (Money integrity → Owner notices)`)
  if (unknown) parts.push(`${unknown} not reported`)
  return `${parts.join('; ')}.`
}

export interface FastPathOutcome {
  /** The stages the server says it ran, by label. */
  ran: string[]
  executed: boolean
  /** The execution's notice when there was one; the signature's is in the Owner-notice queue. */
  notice: OwnerNoticeLine | null
}

/** What the fast path did, from its answer. */
export function fastPathOutcome(result: unknown): FastPathOutcome {
  const r = result && typeof result === 'object' ? (result as Record<string, unknown>) : {}
  const fp = r.fast_path && typeof r.fast_path === 'object' ? (r.fast_path as Record<string, unknown>) : {}
  const steps = Array.isArray(fp.steps) ? fp.steps : []
  const ran = steps.map((s) => {
    const stage = text((s as { stage?: unknown })?.stage) as CardStageValue
    return STAGE_LABEL[stage] ?? (stage || 'unknown stage')
  })
  const executed = !!fp.executed && typeof fp.executed === 'object'
  const notice = executed
    ? (fp.executed as { owner_notice?: unknown }).owner_notice ?? r.owner_notice
    : r.owner_notice
  return { ran, executed, notice: notice === undefined ? null : ownerNoticeLine(notice) }
}

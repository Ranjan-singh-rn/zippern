'use client'

/**
 * Operating expenditure client — `/api/expenses`.
 *
 * This is the half of "profit" the CRM could not write down. The owner's
 * definition is *"the money we received for selling coin − our all
 * expenditure"*, and until `backend/app/services/expenses.py` existed there was
 * no card type, no collection and no screen for a salary, a server bill or a
 * gateway fee — so every profit figure the business produced was gross
 * contribution before the cost of running the company, and the P&L said so on
 * its own face. This client is what lets a person put those costs in.
 *
 * Three facts about this API are load-bearing and are the reason for the shapes
 * below. Each is transcribed from the service, not guessed from a route name.
 *
 * **Raising moves nothing.** `POST /expenses` creates a card in `requested`.
 * It is verified by a second person at `POST /cards/{id}/verify` and signed by
 * an owner at `POST /cards/{id}/sign` — neither of which is in this file,
 * deliberately, because there is exactly one implementation of separation of
 * duties and it lives on the board. `pay` is the fifth stage and the only
 * moment money is recorded as having left.
 *
 * **An empty category is unknown, never ₹0.** `REPORTED_CATEGORIES` is the
 * seven lines the profit statement expects an entry for every period. A month
 * with nothing under `staff_salaries` does not mean nobody was paid; it means
 * nobody entered the payroll. `missingReportedCategories` below answers that
 * question from a list that was actually read, and callers must not ask it of a
 * read that failed.
 *
 * **Money is integer paise, everywhere.** `amount_inr_minor` is paise on the
 * wire; `_minor_amount` on the server refuses a float outright rather than
 * rounding it. `paiseFromRupees` is the one place a typed rupee figure becomes
 * paise, and it refuses anything it cannot convert exactly. Display goes
 * through `formatInrMinor` in `lib/apiReports`, which is the single division by
 * 100 — nothing here divides.
 */

import {
  ApiError,
  getSessionToken,
  reportUnauthorized,
  type Stage,
  type Who,
} from '@/lib/api'

// Mirrors lib/api.ts — in production the API is same-origin via a Hosting
// rewrite, locally it runs on its own port.
const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ??
  (typeof window !== 'undefined' && window.location.hostname === 'localhost'
    ? 'http://127.0.0.1:8080'
    : '')

// ── Core request ──────────────────────────────────────────────────────────────

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getSessionToken()
  if (!token) throw new ApiError('Not signed in', 401)

  let response: Response
  try {
    response = await fetch(`${API_BASE}/api${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...((options.headers as Record<string, string>) ?? {}),
      },
    })
  } catch (err) {
    throw new ApiError(
      'Could not reach the server. Check your connection and try again.',
      0,
      err,
    )
  }

  if (response.status === 204) return undefined as T

  let body: unknown = null
  const text = await response.text()
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }

  if (!response.ok) {
    const detail =
      (body as { detail?: unknown } | null)?.detail ?? body ?? response.statusText
    const message =
      typeof detail === 'string'
        ? detail
        : Array.isArray(detail)
          ? detail
              .map((d: { loc?: string[]; msg?: string }) =>
                `${d.loc?.slice(1).join('.') ?? ''} ${d.msg ?? ''}`.trim(),
              )
              .join('; ')
          : 'Request failed'
    // Same 401 handling as the other three clients: announce it so the shell
    // can renew, and never leave a token the server has already rejected in
    // play without saying so.
    if (response.status === 401) reportUnauthorized({ message, path })
    throw new ApiError(message, response.status, detail)
  }

  return body as T
}

const get = <T>(path: string) => request<T>(path)
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })

function query(params: Record<string, string | number | undefined | null>) {
  const q = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
  })
  const s = q.toString()
  return s ? `?${s}` : ''
}

// ── The categories ────────────────────────────────────────────────────────────

/**
 * The eight values of `ExpenseCategory` in
 * `backend/app/services/expenses.py:111`, character for character.
 *
 * They are not labels — they *are* the line keys the profit statement groups by
 * and subtracts, with no mapping table in between. An invented one is money the
 * report cannot place, and the API refuses it.
 */
export type ExpenseCategory =
  | 'staff_salaries'
  | 'infrastructure'
  | 'marketing'
  | 'gateway_fees'
  | 'binance_fees'
  | 'taxes'
  | 'refunds_to_users'
  | 'other'

/**
 * The seven the profit statement expects to see **every period**, in the
 * server's own order (`REPORTED_CATEGORIES`, `expenses.py:134`).
 *
 * `other` is deliberately not among them: an empty `other` is genuinely no
 * information, whereas an empty `staff_salaries` means nobody entered the
 * payroll. That difference is the whole reason the costs screen exists.
 */
export const REPORTED_CATEGORIES: readonly ExpenseCategory[] = [
  'gateway_fees',
  'binance_fees',
  'taxes',
  'staff_salaries',
  'infrastructure',
  'marketing',
  'refunds_to_users',
]

/** Every category, reported ones first, then `other`. For a form's options. */
export const ALL_CATEGORIES: readonly ExpenseCategory[] = [
  ...REPORTED_CATEGORIES,
  'other',
]

/** `CATEGORY_LABELS` from `expenses.py:144`, so both sides read alike. */
export const CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  staff_salaries: 'Staff salaries and contractor pay',
  infrastructure: 'Servers, Firebase, hosting and tooling',
  marketing: 'Marketing, campaigns and promoter spend',
  gateway_fees: 'Payment gateway fees',
  binance_fees: 'Binance / foreign settlement fees',
  taxes: 'Taxes',
  refunds_to_users: 'Refunds to users',
  other: 'Other operating expenditure',
}

/** A short form for a chip or a column, where the full label will not fit. */
export const CATEGORY_SHORT: Record<ExpenseCategory, string> = {
  staff_salaries: 'Salaries',
  infrastructure: 'Infrastructure',
  marketing: 'Marketing',
  gateway_fees: 'Gateway fees',
  binance_fees: 'Binance fees',
  taxes: 'Taxes',
  refunds_to_users: 'Refunds',
  other: 'Other',
}

/** `MIN_REASON` — `expenses.py:95`. An unstated reason is not auditable. */
export const MIN_REASON = 3

// ── The card ──────────────────────────────────────────────────────────────────

/**
 * An operating-expense card as this screen reads it.
 *
 * The same document every other card is, from `cards.raise_card` — the expense
 * router adds no envelope of its own. `payload` is left open because a card
 * payload is untyped on the wire; `expensePayload` below is the one place the
 * `unknown` casts live.
 */
export interface ExpenseCard {
  id: string
  type: string
  team: string
  title: string
  /** INR minor units (paise). ₹45,000.00 of salary is 4500000. */
  amount: number
  /** Always `inr_minor` for an expense — `expenses.CURRENCY`. */
  currency: string
  reason: string
  subject: { type: string; id: string }
  payload: Record<string, unknown>
  evidence: { kind?: string; ref?: string; url?: string }[]
  stage: Stage
  requested_by: Who
  created_at: string
  updated_at: string
  verified_by: Who | null
  verified_at: string | null
  verification_note: string | null
  auto_verified?: boolean
  signed_by: Who | null
  signed_at: string | null
  executed_at: string | null
  execution_result: Record<string, unknown> | null
  rejected_by: Who | null
  rejected_at: string | null
  rejection_reason: string | null
  /**
   * Set by `raise_expense` when this invoice reference already appears on an
   * earlier card. It is **not** a refusal — the same reference legitimately
   * reappears — and it is written to be shown, before anybody signs.
   */
  warning?: string
}

/** The facts an expense card carries, pulled out of the untyped payload once. */
export interface ExpensePayload {
  /** Empty only on a malformed card. Never defaulted to a category. */
  category: ExpenseCategory | ''
  /** The month the cost is *for*, `2026-08`. A label, not a second ledger. */
  period: string
  payee: string
  invoice_ref: string
  recurring: boolean
  note: string
  /** `cash` — the statement counts this in the period it was PAID. */
  basis: string
  duplicate_reference: boolean
  /** Set by `repeat` — the card this one was raised from. */
  repeats_card_id: string
  repeats_period: string
  /** What the same cost was last time, so a change is visible. Null if new. */
  previous_amount_inr_minor: number | null
}

function str(payload: Record<string, unknown>, key: string): string {
  const v = payload[key]
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

function bool(payload: Record<string, unknown>, key: string): boolean {
  return payload[key] === true
}

function maybeNum(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return null
}

function asCategory(value: string): ExpenseCategory | '' {
  return (ALL_CATEGORIES as readonly string[]).includes(value)
    ? (value as ExpenseCategory)
    : ''
}

export function expensePayload(card: ExpenseCard): ExpensePayload {
  const p = card.payload ?? {}
  return {
    category: asCategory(str(p, 'category')),
    period: str(p, 'period'),
    payee: str(p, 'payee'),
    invoice_ref: str(p, 'invoice_ref'),
    recurring: bool(p, 'recurring'),
    note: str(p, 'note'),
    basis: str(p, 'basis'),
    duplicate_reference: bool(p, 'duplicate_reference'),
    repeats_card_id: str(p, 'repeats_card_id'),
    repeats_period: str(p, 'repeats_period'),
    previous_amount_inr_minor: maybeNum(p, 'previous_amount_inr_minor'),
  }
}

/** The invoice or receipt behind a card, if one was attached. */
export function invoiceUrl(card: ExpenseCard): string {
  return card.evidence?.find((e) => !!e.url)?.url ?? ''
}

// ── The recurring worklist ────────────────────────────────────────────────────

/**
 * One recurring cost, as `recurring_worklist` reports it.
 *
 * A cost is on this list because somebody previously raised it and ticked
 * recurring. Nothing invents one, and nothing raises next month's card on its
 * own: a figure nobody looked at is not a figure an owner should be signing.
 */
export interface RecurringCost {
  category: string
  category_label: string
  payee: string
  last_period: string
  last_card_id: string
  last_amount_inr_minor: number
  last_stage: Stage | string
}

export interface RecurringWorklist {
  period: string
  /** Recurring costs with no card for this period yet. The manual worklist. */
  due: RecurringCost[]
  already_raised: RecurringCost[]
  /** The server's own explanation of the list. Written to be shown. */
  note: string
}

// ── Request bodies ────────────────────────────────────────────────────────────

export interface NewExpenseBody {
  category: ExpenseCategory
  /** Integer paise, greater than zero. Use `paiseFromRupees`. */
  amount_inr_minor: number
  /** `YYYY-MM`. */
  period: string
  payee: string
  invoice_ref: string
  reason: string
  evidence_url?: string
  recurring?: boolean
  note?: string
}

/**
 * Next period's card from a previous one.
 *
 * Amount, invoice reference and reason are **not** inherited on purpose: a
 * salary that changed, a server bill that doubled and a supplier who was not
 * paid at all are all things a person notices while typing them and a scheduler
 * would not.
 */
export interface RepeatExpenseBody {
  period: string
  amount_inr_minor: number
  invoice_ref: string
  reason: string
  payee?: string
  evidence_url?: string
  note?: string
}

// ── Calls ─────────────────────────────────────────────────────────────────────

export const expenses = {
  /**
   * The expense register at every stage — including what is owed and not paid.
   * `require_internal`, so a refusal here is a session problem, not a role one.
   */
  list: (
    params: {
      period?: string
      category?: ExpenseCategory
      stage?: Stage
      limit?: number
    } = {},
  ) =>
    get<ExpenseCard[]>(
      `/expenses${query({
        period: params.period,
        category: params.category,
        stage: params.stage,
        limit: params.limit ?? 200,
      })}`,
    ),

  /** What repeats every month and has no card for this one. */
  recurringDue: (period: string) =>
    get<RecurringWorklist>(`/expenses/recurring-due${query({ period })}`),

  /**
   * Stage 1 of 5. Any team member. **Nothing has moved.**
   *
   * What exists afterwards is a request in `requested` that a second person has
   * to verify and an owner has to sign before anybody can pay it. The card is
   * raised on the Finance board whoever raises it, so a marketing spend is not
   * verified by the marketing admin who asked for it.
   */
  raise: (body: NewExpenseBody) =>
    post<ExpenseCard>('/expenses', {
      evidence_url: '',
      recurring: false,
      note: '',
      ...body,
    }),

  /** Raise this period's card from a previous one. Still stage 1 of 5. */
  repeat: (cardId: string, body: RepeatExpenseBody) =>
    post<ExpenseCard>(`/expenses/${encodeURIComponent(cardId)}/repeat`, {
      payee: '',
      evidence_url: '',
      note: '',
      ...body,
    }),

  /**
   * Stage 5 of 5 — record that the money left. **Owners only.**
   *
   * Refuses anything not already signed, so an owner cannot pay a card that no
   * second person verified, and refuses a card that is already executed, so a
   * replayed request pays nothing twice.
   */
  pay: (cardId: string, paymentRef: string) =>
    post<ExpenseCard>(`/expenses/${encodeURIComponent(cardId)}/pay`, {
      payment_ref: paymentRef,
    }),
}

// ── Periods ───────────────────────────────────────────────────────────────────

/** `PERIOD_PATTERN` — `expenses.py:104`. The month a cost belongs to. */
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/

export function isPeriod(value: string): boolean {
  return PERIOD.test(value.trim())
}

/** This month, as the API wants it. Local time, because the user is local. */
export function currentPeriod(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

/** `shiftPeriod('2026-01', -1)` → `'2025-12'`. Returns '' on a bad input. */
export function shiftPeriod(period: string, months: number): string {
  if (!isPeriod(period)) return ''
  const [year, month] = period.split('-').map(Number)
  // Day 1 keeps the arithmetic away from month lengths entirely.
  const d = new Date(year, month - 1 + months, 1)
  return currentPeriod(d)
}

/** `2026-08` → `August 2026`, for a heading. Falls through unrecognised text. */
export function periodLabel(period: string): string {
  if (!isPeriod(period)) return period
  const [year, month] = period.split('-').map(Number)
  return new Date(year, month - 1, 1).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
  })
}

// ── Money in, money out ───────────────────────────────────────────────────────

/**
 * A typed rupee amount as integer paise, or null when it cannot be converted
 * exactly.
 *
 * Null is a refusal, not a zero. The server refuses a float rather than
 * rounding it — "₹1,250.05 is 125005, not 1250.05" — and this is the browser
 * side of the same rule: three decimal places, a negative, a stray letter and
 * an empty box all come back null and the form says so rather than sending
 * something the API will reject or, worse, something it will accept as a
 * different number.
 *
 * This multiplies. Nothing in this module divides by 100 — display is
 * `formatInrMinor` in `lib/apiReports`, which is the single division.
 */
export function paiseFromRupees(input: string): number | null {
  const text = input.trim().replace(/[₹,\s]/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null
  const [whole, fraction = ''] = text.split('.')
  const paise = Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2))
  if (!Number.isSafeInteger(paise) || paise <= 0) return null
  return paise
}

// ── What is missing, and what that means ──────────────────────────────────────

/**
 * Which of the seven reported categories have **no card at all** in this list.
 *
 * Rejected cards do not count as an entry — a refused payroll card leaves the
 * payroll unrecorded — and neither does an empty list from a read that failed,
 * which is why this takes cards a caller has actually got back and why no
 * caller may hand it `[]` from a `.catch`.
 *
 * Every stage other than `rejected` does count, including `requested`. The
 * question this answers is "has anybody written this cost down", not "has it
 * been paid": an unpaid cost is visible on the board, an unrecorded one is
 * invisible everywhere.
 */
export function missingReportedCategories(cards: ExpenseCard[]): ExpenseCategory[] {
  const seen = new Set<string>()
  for (const card of cards) {
    if (card.stage === 'rejected') continue
    const { category } = expensePayload(card)
    if (category) seen.add(category)
  }
  return REPORTED_CATEGORIES.filter((c) => !seen.has(c))
}

/** Cards for one category, newest first, as `list_expenses` already sorts. */
export function cardsInCategory(
  cards: ExpenseCard[],
  category: ExpenseCategory,
): ExpenseCard[] {
  return cards.filter((c) => expensePayload(c).category === category)
}

/**
 * What has actually been **paid** in a set of cards, in paise.
 *
 * Executed only, because that is the only stage at which money left. A total
 * over `approved` cards would be a figure for money still sitting in the bank.
 * Callers must not show this without also showing what is unrecorded — a
 * complete-looking total over an incomplete set of categories is the exact
 * mistake this screen exists to prevent.
 */
export function paidTotalMinor(cards: ExpenseCard[]): number {
  return cards.reduce((sum, c) => (c.stage === 'executed' ? sum + c.amount : sum), 0)
}

/** Raised, verified, signed — recorded and not yet paid out. In paise. */
export function unpaidTotalMinor(cards: ExpenseCard[]): number {
  const open = new Set<Stage>(['requested', 'under_review', 'awaiting_signoff', 'approved'])
  return cards.reduce((sum, c) => (open.has(c.stage) ? sum + c.amount : sum), 0)
}

// ── The five stages, in this domain's words ───────────────────────────────────

/** The order a cost card travels in. `rejected` / `failed` leave the track. */
export const EXPENSE_STAGE_TRACK: Stage[] = [
  'requested',
  'under_review',
  'awaiting_signoff',
  'approved',
  'executed',
]

/**
 * What each stage means **for a cost**. The pair that gets confused is
 * `approved` and `executed`: an owner has signed, and the supplier has not been
 * paid. Every label says so.
 */
export const EXPENSE_STAGE_LABEL: Record<Stage, string> = {
  requested: 'Raised — nothing has moved',
  under_review: 'Under review — nothing has moved',
  awaiting_signoff: 'Verified — waiting for an owner',
  approved: 'Signed — not paid yet',
  executed: 'Paid — the money left',
  rejected: 'Rejected — no cost was recorded',
  failed: 'Failed — nothing was paid',
}

/** The same in two or three words, for a chip beside an amount. */
export const EXPENSE_STAGE_SHORT: Record<Stage, string> = {
  requested: 'Raised',
  under_review: 'In review',
  awaiting_signoff: 'Awaiting sign-off',
  approved: 'Signed, unpaid',
  executed: 'Paid',
  rejected: 'Rejected',
  failed: 'Failed',
}

export const STAGE_TONE: Record<Stage, string> = {
  requested: 'bg-slate-700 text-slate-300',
  under_review: 'bg-blue-500/15 text-blue-300',
  awaiting_signoff: 'bg-amber-500/15 text-amber-300',
  approved: 'bg-green-500/15 text-green-300',
  executed: 'bg-slate-700/60 text-slate-400',
  rejected: 'bg-red-500/15 text-red-300',
  failed: 'bg-red-500/20 text-red-300',
}

const apiExpenses = { expenses }
export default apiExpenses

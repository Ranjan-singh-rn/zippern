'use client'

/**
 * Client for `/api/reports` — the reporting side of the business API.
 *
 * Kept apart from `lib/api.ts` on purpose: reports share one response envelope
 * that nothing else in the API uses, and that envelope is the whole point.
 * Every report carries the period it covers, the rates it valued things at,
 * the definition of every figure in it, any warnings, and whether the period
 * was empty. A screen that reads a number out of `totals` and throws the rest
 * away puts a guess on the wall as a fact.
 *
 * Two flags in particular must reach the screen:
 *
 *   `rates.provisional` — a rate was missing and a documented fallback was
 *     used. The number is an estimate and must be labelled as one.
 *   `empty` — nothing happened in the period. The zeroes are the absence of
 *     data, not a measurement, and must not be rendered as a result.
 *
 * Units: every money figure is INR **minor units** (paise) unless the field
 * name says otherwise. Divide by 100 for rupees — or use `formatInrMinor`,
 * which does it once, correctly, with Indian digit grouping.
 */

import { ApiError, getSessionToken, reportUnauthorized } from './api'

// Same derivation as lib/api.ts: production serves the API from this origin
// through a Hosting rewrite, local development runs it on its own port.
const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ??
  (typeof window !== 'undefined' && window.location.hostname === 'localhost'
    ? 'http://127.0.0.1:8080'
    : '')

// ── The envelope every report shares ──────────────────────────────────────────

export interface ReportPeriod {
  /** Absent on point-in-time reports such as liabilities. */
  since?: string
  until?: string
  days?: number
  /** Present instead of since/until when the report has no date range. */
  as_at?: string
  bounds: string
}

export interface ReportRates {
  diamond_pack_price_inr_per_lakh: number
  diamonds_per_lakh: number
  bean_to_inr: number
  /** 'firestore' | 'firestore_partial' | 'fallback' */
  source: string
  /** True when any figure in the report used a fallback rate. */
  provisional: boolean
  /** Which rate keys were missing from appConfig/economy. */
  missing: string[]
  note: string
  fetched_at: string
}

export interface ReportEnvelope<Row, Totals> {
  report: string
  title: string
  generated_at: string
  period: ReportPeriod
  currency_unit: string
  /** Empty object on reports that value nothing (team throughput). */
  rates: Partial<ReportRates>
  definitions: Record<string, string>
  columns: { key: string; header: string }[]
  rows: Row[]
  totals: Totals
  warnings: string[]
  /** True when the period genuinely had no activity. Never render 0 as a fact. */
  empty: boolean
  sections?: Record<string, unknown>
}

/** A report whose rows we do not need to name individually. */
export type AnyReport = ReportEnvelope<Record<string, unknown>, Record<string, unknown>>

export interface NonCashCredits {
  movements: number
  by_currency: Record<string, { amount: number; movements: number }>
}

// ── Cash position ─────────────────────────────────────────────────────────────

export type CashLine =
  | 'receipt'
  | 'payment_out'
  | 'total_receipts'
  | 'total_payments_out'
  | 'net_cash_position'

export interface CashPositionRow {
  line: CashLine
  /** Channel for receipts, card type for payments out, 'all' on total lines. */
  channel: string
  detail: string
  movements: number | null
  inr_minor: number
  inr: number | null
}

export interface CashPositionTotals {
  receipts_inr_minor: number
  payments_out_inr_minor: number
  net_inr_minor: number
  net_inr: number | null
  receipts_by_channel: Record<string, number>
  non_cash_credits_excluded: NonCashCredits
}

export type CashPositionReport = ReportEnvelope<CashPositionRow, CashPositionTotals>

// ── Revenue over time ─────────────────────────────────────────────────────────

export type GroupBy = 'day' | 'week' | 'month'

export interface RevenueRow {
  period_start: string | null
  period_label: string
  channel: string
  movements: number
  revenue_inr_minor: number
  revenue_inr: number | null
  valuation: string
}

export interface RevenueTotals {
  group_by: GroupBy
  revenue_inr_minor: number
  revenue_inr: number | null
  by_channel: Record<string, number>
  buckets: number
  non_cash_credits_excluded: NonCashCredits
}

export type RevenueReport = ReportEnvelope<RevenueRow, RevenueTotals>

// ── Payouts ───────────────────────────────────────────────────────────────────

export interface PayoutRow {
  card_type: string
  currency: string
  amount_native: number
  cards: number
  inr_minor: number
  inr: number | null
  rate_applied: string
}

export interface PayoutTotals {
  payouts_inr_minor: number
  payouts_inr: number | null
  cards_executed: number
  by_card_type: Record<string, number>
}

export type PayoutReport = ReportEnvelope<PayoutRow, PayoutTotals>

// ── Margin ────────────────────────────────────────────────────────────────────

export interface MarginRow {
  metric: string
  value: number | null
  /** 'inr_minor' | 'percent' | 'ratio' | 'beans' */
  unit: string
  value_inr: number | null
  note: string
}

export interface MarginTotals {
  revenue_inr_minor: number
  payouts_inr_minor: number
  commission_accrued_inr_minor: number
  commission_paid_inr_minor: number
  net_margin_inr_minor: number
  net_margin_inr: number | null
  /** Null when revenue is zero — a percentage of nothing is not zero. */
  net_margin_pct: number | null
  /** Null when no diamonds were consumed. Lower is better. */
  bean_payout_ratio: number | null
  bean_payout_ratio_pct: number | null
  diamonds_consumed: number
  beans_created: number
  beans_paid_out: number
}

export type MarginReport = ReportEnvelope<MarginRow, MarginTotals>

// ── Channels ──────────────────────────────────────────────────────────────────

export interface ChannelRow {
  /** 'reseller' | 'direct' | 'unattributed' */
  channel: string
  receipts_inr_minor: number
  receipts_inr: number | null
  receipt_count: number
  share_of_receipts_pct: number | null
  attributed_payouts_inr_minor: number
  payout_cards: number
  contribution_inr_minor: number
  contribution_inr: number | null
}

export interface ChannelTotals {
  receipts_inr_minor: number
  unattributed_payouts_inr_minor: number
  non_cash_credits_excluded: NonCashCredits
}

export type ChannelReport = ReportEnvelope<ChannelRow, ChannelTotals>

// ── Liabilities ───────────────────────────────────────────────────────────────

export interface LiabilityRow {
  liability: string
  description: string
  /** Seller coin stock and the seller receivable are listed but do not count. */
  counts_as_liability: boolean
  holders: number
  native_amount: number
  native_currency: string
  largest_single_holder: number | null
  inr_minor: number
  inr: number | null
  rate_applied: string
}

export interface LiabilityTotals {
  total_owed_inr_minor: number
  total_owed_inr: number | null
  seller_credit_receivable_minor: number
  /** receivable − owed. Negative means the business owes more than it is owed. */
  net_position_inr_minor: number
  sellers_overdue: number
}

export type LiabilityReport = ReportEnvelope<LiabilityRow, LiabilityTotals>

// ── Team throughput ───────────────────────────────────────────────────────────

export type ReportTeam = 'app' | 'ops' | 'finance' | 'tech' | 'support' | 'marketing'

export const REPORT_TEAMS: ReportTeam[] = [
  'app', 'ops', 'finance', 'tech', 'support', 'marketing',
]

export interface ThroughputRow {
  measure: string
  kind: 'count' | 'duration' | 'queue'
  value: number | null
  unit: string
  detail: string
}

export interface OldestOpenItem {
  card_id: string
  title?: string
  type?: string
  stage?: string
  team?: string
  amount?: number
  currency?: string
  created_at: string
  requested_by?: string
  age_days: number
}

export interface ThroughputTotals {
  team: string
  counts: {
    raised: number
    verified: number
    signed: number
    executed: number
    rejected: number
  }
  /** Null for a transition no card completed in the period — never zero. */
  median_hours: Record<string, number | null>
  open_by_stage: Record<string, number>
  open_total: number
  oldest_open_item: OldestOpenItem | null
}

export type ThroughputReport = ReportEnvelope<ThroughputRow, ThroughputTotals>

// ── Definitions ───────────────────────────────────────────────────────────────

export interface DefinitionsResponse {
  /** revenue, payout, commission, margin, bean_payout_ratio, channel, currency */
  definitions: Record<string, string>
  units: {
    money: string
    commission: string
    diamonds_per_lakh: number
  }
  window: { default_days: number; max_days: number; bounds: string }
  rate_fallbacks: {
    diamondPackPriceInr: number
    'giftRates.beanToInrRate': number
    note: string
  }
  export: { format: string; logged: string }
}

// ── Requests ──────────────────────────────────────────────────────────────────

export type QueryParams = Record<string, string | number | boolean | undefined | null>

function buildQuery(params: QueryParams): string {
  const q = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
  })
  const s = q.toString()
  return s ? `?${s}` : ''
}

/** The API's error body, turned into a message worth showing a person. */
function messageFrom(body: unknown, fallback: string): string {
  const detail = (body as { detail?: unknown })?.detail ?? body
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map((d: { loc?: string[]; msg?: string }) =>
        `${d.loc?.slice(1).join('.') ?? ''} ${d.msg ?? ''}`.trim(),
      )
      .join('; ')
  }
  // A failed job trigger answers with a structured detail rather than a string:
  // `{job, spec, message, recorded, where_to_look}` — see
  // `backend/app/routers/notifications.py:139-158`. Flattening it to the
  // fallback would throw away the only account of what went wrong.
  if (detail && typeof detail === 'object') {
    const d = detail as { message?: unknown; where_to_look?: unknown }
    const parts = [d.message, d.where_to_look].filter(
      (p): p is string => typeof p === 'string' && p.trim() !== '',
    )
    if (parts.length) return parts.join(' ')
  }
  return fallback
}

/**
 * One request against the business API, for any of the routers this module
 * covers.
 *
 * `prefix` is the router mount point — `/api/reports` or `/api/notifications`
 * (`backend/app/main.py:71,73`). Both routers answer with the same error body
 * shape, so `messageFrom` is the only place an error is turned into a sentence
 * and `ApiError.message` always carries what the server actually said.
 */
async function callApi<T>(
  prefix: string,
  path: string,
  params: QueryParams = {},
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const token = getSessionToken()
  if (!token) throw new ApiError('Not signed in', 401)

  const method = init.method ?? 'GET'

  let response: Response
  try {
    response = await fetch(`${API_BASE}${prefix}${path}${buildQuery(params)}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
  } catch (err) {
    throw new ApiError(
      'Could not reach the business API. Check your connection and try again.',
      0,
      err,
    )
  }

  const text = await response.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }

  if (!response.ok) {
    const message = messageFrom(body, response.statusText || 'The request was refused.')
    // Same behaviour as lib/api.ts and lib/apiPartners.ts. This client used to
    // leave a rejected token in place, so a session that expired while someone
    // was reading a report stayed "signed in" until they navigated somewhere
    // backed by a different client.
    if (response.status === 401) reportUnauthorized({ message, path: `${prefix}${path}` })
    throw new ApiError(message, response.status, body)
  }
  return body as T
}

async function getReport<T>(path: string, params: QueryParams = {}): Promise<T> {
  return callApi<T>('/api/reports', path, params)
}

// ── CSV export ────────────────────────────────────────────────────────────────

function filenameFrom(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback
  const match = /filename="?([^";]+)"?/i.exec(disposition)
  return match?.[1]?.trim() || fallback
}

/**
 * Download a report as CSV straight from the API.
 *
 * Deliberately not built in the browser from the rows on screen: the API's
 * `?format=csv` renders the same rows through the same code that produced the
 * JSON, so an export can never quietly disagree with the figures a person was
 * looking at when they pressed the button. It is also logged — the API refuses
 * to issue an export it cannot write to the audit log, and that refusal comes
 * back here as an error rather than a silently missing file.
 */
export async function downloadReportCsv(
  path: string,
  params: QueryParams,
  fallbackName: string,
): Promise<void> {
  const token = getSessionToken()
  if (!token) throw new ApiError('Not signed in', 401)

  let response: Response
  try {
    response = await fetch(
      `${API_BASE}/api/reports${path}${buildQuery({ ...params, format: 'csv' })}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
  } catch (err) {
    throw new ApiError('Could not reach the reporting API to produce the export.', 0, err)
  }

  if (!response.ok) {
    const text = await response.text()
    let body: unknown = text
    try {
      body = JSON.parse(text)
    } catch {
      /* a plain-text error is still an error */
    }
    const message = messageFrom(body, 'The export was refused.')
    // This fetch bypasses `callApi`, so it needs the 401 handling itself.
    if (response.status === 401) {
      reportUnauthorized({ message, path: `/api/reports${path}` })
    }
    throw new ApiError(message, response.status, body)
  }

  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filenameFrom(
    response.headers.get('Content-Disposition'),
    `${fallbackName}-${new Date().toISOString().slice(0, 10)}.csv`,
  )
  a.click()
  URL.revokeObjectURL(url)
}

// ── The endpoints ─────────────────────────────────────────────────────────────

export interface RangeParams {
  since?: string
  until?: string
}

export const reports = {
  /** Receipts by channel, payments out, net — actual cash from the ledger. */
  cashPosition: (p: RangeParams = {}) =>
    getReport<CashPositionReport>('/cash-position', { ...p }),

  /** Revenue bucketed by day, week or month. Grouping happens in the database. */
  revenue: (p: RangeParams & { group_by?: GroupBy } = {}) =>
    getReport<RevenueReport>('/revenue', { ...p }),

  /** One definition of payout: value that actually left, from executed cards. */
  payouts: (p: RangeParams = {}) => getReport<PayoutReport>('/payouts', { ...p }),

  /** Revenue, payouts, commission, net margin and the bean-payout ratio. */
  margin: (p: RangeParams = {}) => getReport<MarginReport>('/margin', { ...p }),

  /** Reseller versus direct — never added together into one number. */
  channels: (p: RangeParams = {}) => getReport<ChannelReport>('/channels', { ...p }),

  /** Point in time; takes no date range. */
  liabilities: () => getReport<LiabilityReport>('/liabilities'),

  /** Omit `team` for every team — only owners and the Observer may. */
  teamThroughput: (p: RangeParams & { team?: string } = {}) =>
    getReport<ThroughputReport>('/team-throughput', { ...p }),

  /** The one definition of each figure, published by the API. */
  definitions: () => getReport<DefinitionsResponse>('/definitions'),

  /** Export paths, so a screen names its endpoint once. */
  csv: {
    cashPosition: (p: RangeParams) =>
      downloadReportCsv('/cash-position', { ...p }, 'cash-position'),
    revenue: (p: RangeParams & { group_by?: GroupBy }) =>
      downloadReportCsv('/revenue', { ...p }, 'revenue'),
    margin: (p: RangeParams) => downloadReportCsv('/margin', { ...p }, 'margin'),
    channels: (p: RangeParams) => downloadReportCsv('/channels', { ...p }, 'channels'),
    liabilities: () => downloadReportCsv('/liabilities', {}, 'liabilities'),
    teamThroughput: (p: RangeParams & { team?: string }) =>
      downloadReportCsv('/team-throughput', { ...p }, 'team-throughput'),
  },
}

// ── Money formatting ──────────────────────────────────────────────────────────
//
// One place. The old Finance pages each did their own `toLocaleString`, some
// on rupees and some on paise, and nothing said which — so two screens showed
// the same figure a hundred times apart and both looked plausible.

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
})

const INR_WHOLE = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
})

const PLAIN = new Intl.NumberFormat('en-IN')

/** Paise → "₹1,23,456.78". Null in, "—" out — never "₹0.00". */
export function formatInrMinor(minor: number | null | undefined): string {
  if (minor === null || minor === undefined || Number.isNaN(minor)) return '—'
  return INR.format(minor / 100)
}

/** Paise → "₹1,23,457", for headline figures where the paise are noise. */
export function formatInrMinorShort(minor: number | null | undefined): string {
  if (minor === null || minor === undefined || Number.isNaN(minor)) return '—'
  return INR_WHOLE.format(minor / 100)
}

/** Indian digit grouping for a count of things that are not money. */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return PLAIN.format(n)
}

/**
 * An amount in whatever the ledger called it, with its unit stated.
 *
 * `commission` is paise and reads as rupees; beans and diamonds are counted,
 * not valued, and say so. No figure is ever shown without its currency.
 */
export function formatNativeAmount(
  amount: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (amount === null || amount === undefined) return '—'
  const c = String(currency ?? '').toLowerCase()
  if (c === 'commission' || c === 'inr_minor' || c === 'paise') return formatInrMinor(amount)
  if (c === 'inr' || c === 'rupees' || c === 'rs') return INR.format(amount)
  if (!c) return formatCount(amount)
  return `${formatCount(amount)} ${c}`
}

/** A percentage the API computed. Null stays null — it is not zero. */
export function formatPct(pct: number | null | undefined, digits = 1): string {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return '—'
  return `${pct.toFixed(digits)}%`
}

/** A ratio the API computed, e.g. the bean-payout ratio. */
export function formatRatio(ratio: number | null | undefined, digits = 3): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '—'
  return ratio.toFixed(digits)
}

/** Hours as the median stage durations report them. Null means "nobody did". */
export function formatHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || Number.isNaN(hours)) return '—'
  if (hours < 1) return `${Math.round(hours * 60)} min`
  if (hours < 48) return `${hours.toFixed(1)} h`
  return `${(hours / 24).toFixed(1)} days`
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleDateString('en-IN', { dateStyle: 'medium' })
}

// ── Reading the envelope ──────────────────────────────────────────────────────

/**
 * The sentence to show when a report used fallback rates.
 *
 * Returns null when the rates are real. A provisional figure presented as a
 * fact is worse than no figure, so callers render this above the numbers, not
 * in a tooltip under them.
 */
export function provisionalNote(report: {
  rates: Partial<ReportRates>
}): string | null {
  if (!report.rates?.provisional) return null
  return (
    report.rates.note ??
    'PROVISIONAL — a rate was missing and a documented fallback was used. ' +
      'These figures are estimates, not authoritative.'
  )
}

/** The rate line every screen shows, so a reader knows what valued what. */
export function rateSummary(report: { rates: Partial<ReportRates> }): string | null {
  const r = report.rates
  if (!r || r.diamond_pack_price_inr_per_lakh === undefined) return null
  const perLakh = INR_WHOLE.format(r.diamond_pack_price_inr_per_lakh)
  const perBean = r.bean_to_inr === undefined ? '—' : `₹${r.bean_to_inr}`
  const lakh = formatCount(r.diamonds_per_lakh ?? 100000)
  return `Valued at ${perLakh} per ${lakh} diamonds and ${perBean} per bean (source: ${r.source ?? 'unknown'}).`
}

/**
 * Warnings the API raised, minus the provisional note if it is already shown
 * on its own. Showing the same sentence twice trains people to skip both.
 */
export function otherWarnings(report: {
  rates: Partial<ReportRates>
  warnings: string[]
}): string[] {
  const note = provisionalNote(report)
  return (report.warnings ?? []).filter((w) => w !== note)
}

/**
 * The sentence that explains an empty period — the LAST warning, not the first.
 *
 * Screens were reading `warnings[0]` as the empty-state explanation. That is
 * the wrong end of the list, and reliably so. Every report in
 * `backend/app/services/reports.py` builds its warnings in this order and no
 * other:
 *
 *   1. whatever the computation itself had to say (unvalued currencies,
 *      unreadable stores, undefined ratios) — accumulated first;
 *   2. `rt.note`, appended only when a fallback rate was used;
 *   3. the empty-state message, appended LAST by `note_if_empty` (`:433`) or
 *      `mark_empty` (`:439`), which are the final statement before `return
 *      report` in every single case — verified across all nineteen call sites
 *      (`reports.py:1009, 1107, 1164, 1399, 1551, 1719, 1826, 2020, 2190,
 *      2472, 2641, 3826, 4121, 4128, 4437, 4442, 4672, 4679, 4685, 5177`).
 *
 * The margin report makes the consequence concrete: `margin_report` seeds its
 * list with `warnings = list(cash.warnings)` (`reports.py:1299`), so
 * `warnings[0]` on /finance/profit was the CASH POSITION report's "no receipts
 * in this period" — printed under a margin heading, describing a different
 * report entirely.
 *
 * The provisional-rate note is skipped defensively: it is appended before the
 * empty message in every path above, but a report that ends up `empty` without
 * calling `note_if_empty` would otherwise surface it as the explanation, and a
 * note about rates is not an account of why a period was empty.
 *
 * Returns `fallback` when there is nothing usable, so a caller never renders an
 * empty period with no explanation at all.
 */
export function emptyExplanation(
  report: { rates: Partial<ReportRates>; warnings: string[] },
  fallback: string,
): string {
  const note = provisionalNote(report)
  const usable = (report.warnings ?? []).filter(
    (w) => typeof w === 'string' && w.trim() !== '' && w !== note,
  )
  return usable[usable.length - 1] ?? fallback
}

// ══════════════════════════════════════════════════════════════════════════════
//  PART 8A — the weekly business report, alerts, deliveries and job health
// ══════════════════════════════════════════════════════════════════════════════
//
// Everything below is typed against the backend it actually talks to, field by
// field, not from the shape a name suggests. The endpoints and the lines they
// were read from are named on each block. Nothing here is inferred.

// ── The owner's weekly business report ────────────────────────────────────────
//
// `backend/app/services/scheduling.py:1708` builds five sections and stores
// them; `_stored_section` (:1604) decides what each stored entry looks like.
// Exactly one of `ok: true` with an `envelope` and `ok: false` with an `error`
// is ever present. There is no third state, and an empty period is a *section
// that succeeded* — `envelope.empty` — not a failure and not a zero.

/** The envelope a stored section keeps — a `Report.as_dict()` plus a title. */
export interface WeeklySectionEnvelope {
  report: string
  title: string
  generated_at: string
  period: ReportPeriod
  currency_unit: string
  rates: Partial<ReportRates>
  definitions: Record<string, string>
  columns: { key: string; header: string }[]
  rows: Record<string, unknown>[]
  totals: Record<string, unknown>
  warnings: string[]
  /** True when the period genuinely had nothing in it. Never render this as ₹0. */
  empty: boolean
  sections?: Record<string, unknown>
  /** Present only when the section produced more rows than were stored inline. */
  rows_trimmed?: { kept: number; total: number; note: string }
}

/** One stored section. `scheduling.py:1604 _stored_section`. */
export interface WeeklyStoredSection {
  title: string
  ok: boolean
  /** The report's own explanation of why it could not be computed. */
  error: string | null
  /** Only on a failed section: says in words that this is not a zero. */
  note?: string
  /** Only on a section that succeeded. */
  row_count?: number
  trimmed?: boolean
  attachment?: string | null
  envelope?: WeeklySectionEnvelope
}

/** One stored revision of one week. `scheduling.py:1786`, `reports.py:600`. */
export interface WeeklyBusinessDoc {
  /** The `_id`, renamed by the router: `week_label`, or `week_label#rN`. */
  id: string
  week_label: string
  revision: number
  since: string
  until: string
  window_note: string
  generated_at: string
  sections: WeeklyStoredSection[]
  failed_sections: string[]
  needs_a_person: string[]
  immutable: string
}

/** `GET /api/reports/weekly-business/{week}` — `reports.py:570`. */
export interface WeeklyBusinessRead {
  week: string
  /** Oldest first — `read_week` sorts on `revision` ascending. */
  revisions: WeeklyBusinessDoc[]
  /** The API's own name for `revisions[0]`, i.e. revision 0, the original. */
  current: WeeklyBusinessDoc
  note: string
}

/** Who a scheduled report resolved to. `notify.py Resolution.summary()`. */
export interface RecipientSummary {
  count: number
  resolved: Record<string, unknown>
  missing: string[]
  muted: string[]
  subscribed: string[]
}

/** One report's send result. `scheduling.py:376 _send_report`. */
export interface SendResult {
  report: string
  spec: string
  cadence?: string
  period?: string
  sections?: { title: string; ok: boolean; error: string | null }[]
  failed_sections?: string[]
  recipients?: RecipientSummary
  sent: number
  outcomes?: string[]
  error: string | null
  note?: string
}

/** What `record_run` stamps onto every job summary. `scheduling.py:535`. */
export interface RunStamp {
  /** 'ok' | 'degraded'. A raised job is written as 'failed' by `record_failure`. */
  status?: string
  ok?: boolean
  problems?: string[]
  /** 'schedule' when a service credential fired it, 'person' when someone did. */
  trigger?: string
  triggered_by?: TriggeredBy
  /** False when the run happened and could NOT be written to the run log. */
  recorded?: boolean
  record_error?: string
}

export interface TriggeredBy {
  uid: string
  name: string
  role: string
  service_credential?: string | null
}

/** `POST /api/reports/jobs/weekly-business` — `scheduling.py:1836`. */
export interface WeeklyBusinessRun extends RunStamp {
  job: string
  started_at: string
  finished_at: string
  week_label: string
  revision: number
  report_id: string
  period: { since: string; until: string }
  stored: boolean
  regenerated: boolean
  reused_stored_report: boolean
  failed_sections: string[]
  needs_a_person: string[]
  emails_accepted: number
  reports: SendResult[]
  errors: string[]
}

// ── Alerts ────────────────────────────────────────────────────────────────────

/** `alerts.py:1222 catalogue()`. */
export interface AlertDetector {
  id: string
  spec: string
  watches: string
  audience: string[]
  /** 'warning' | 'critical' — the only two values `Detector.severity` takes. */
  severity: string
  threshold: string
  threshold_setting: string
  repeat_hours: number
}

export interface AlertCatalogue {
  detectors: AlertDetector[]
  suppression: string
}

/**
 * One row of `alert_state` — a condition that has been raised.
 * `alerts.py:249 recent_state`, written by `claim()` at :182.
 *
 * There is no severity on this row. It has to be joined to the catalogue on
 * `alert`, which is the detector id.
 */
export interface RaisedAlert {
  key: string
  alert: string
  spec: string
  fingerprint: string
  last_sent_at: string | null
  first_seen_at: string | null
  window_hours: number
  occurrences: number
  meta: Record<string, unknown>
}

export interface RaisedAlerts {
  raised: RaisedAlert[]
}

/**
 * One entry from `alerts.py:1428 open_findings()`.
 *
 * `status` is 'ok' (the condition is true right now), 'failed' (the detector
 * could not run — unknown, NOT clear) or 'not_applicable' (it cannot be
 * evaluated in this deployment at all).
 */
export interface OpenFinding {
  id: string
  spec: string
  status: string
  /** Only on status 'ok'. */
  severity?: string
  key?: string
  headline?: string
  action?: string
  meta?: Record<string, unknown>
  /** Only on 'failed' and 'not_applicable'. */
  reason?: string
}

/** `GET /api/notifications/alerts/open` — `notifications.py:464`. */
export interface OpenAlerts {
  findings: OpenFinding[]
  /** Count of findings with status 'ok' — conditions that are true now. */
  open: number
  did_not_run: OpenFinding[]
  not_applicable: OpenFinding[]
}

// ── Email delivery ────────────────────────────────────────────────────────────

/** One provider event applied to a delivery. `email.py:1035`. */
export interface DeliveryEvent {
  event: string
  at: string
  reason: string
  email: string
  sg_event_id: string
}

/** One row of `email_deliveries`. `email.py:640 _record_doc`, closed at :920. */
export interface Delivery {
  id: string
  /** What was sent — e.g. 'report.weekly_business', 'alert.execution_failed'. */
  kind: string
  spec: string
  to: string
  to_name: string
  to_role: string | null
  to_uid: string | null
  authorised_by: string | null
  /** The subject line is stored; the body never is. */
  subject: string
  sensitivity: string
  dedupe_key: string | null
  queued_at: string
  sent_at: string | null
  outcome: string
  provider: string
  provider_message_id: string | null
  provider_status: number | string | null
  provider_reason?: string | null
  provider_headers?: Record<string, string>
  /**
   * **The provider's rejection, byte for byte.** `str()` on the SendGrid SDK's
   * exception is the constant "HTTP Error 400: Bad Request" — identical for a
   * bad MIME type, an empty attachment and a payload that is too large — while
   * the sentence naming the broken field arrives on `exc.body`. This is that
   * body, unedited. `error` contains it too, plus a hint; this field is the
   * evidence with nothing added.
   */
  provider_error_body?: string | null
  /** The exact field the provider named, e.g. `attachments.0.type`. */
  provider_error_fields?: string[]
  /** The provider's own response, or the reason nothing was sent. */
  error: string | null
  attempts: number
  attachments: { filename: string; content_type: string; bytes: number }[]
  /** Files deliberately left off, each with the reason a reader can act on. */
  attachments_omitted?: { filename: string; bytes: number; reason: string }[]
  /** True for scheduled reports and alerts — carries List-Unsubscribe. */
  bulk?: boolean
  headers_sent?: string[]
  /** Whether this From can pass DMARC at all, and why not when it cannot. */
  sender?: {
    from: string
    domain: string
    reply_to: string
    aligned: boolean
    why: string
  }
  meta: Record<string, unknown>
  events: DeliveryEvent[]
  last_provider_event?: string
}

/** `GET /api/notifications/deliveries` — `notifications.py:362`. */
export interface DeliveryList {
  deliveries: Delivery[]
  count: number
  note: string
}

/** `GET /api/notifications/deliveries/failures` — `notifications.py:395`. */
export interface DeliveryFailures {
  failures: Delivery[]
  count: number
  window_hours: number
  /** `queued` is in here: an unknown outcome is not a delivered one. */
  outcomes_counted_as_failure: string[]
}

/** `GET /api/notifications/deliveries/summary` — `email.py:1113`. */
export interface DeliverySummary {
  since: string
  by_outcome: Record<string, number>
  sent: number
  failed: number
  withheld: number
  in_flight: number
}

// ── Scheduled jobs ────────────────────────────────────────────────────────────

/** One row of `scheduling.SCHEDULE` — `scheduling.py:1941`. */
export interface ScheduleEntry {
  job: string
  run_job: string
  spec: string
  endpoint: string
  function: string
  cron: string
  timezone: string
  when: string
  covers: string
}

/** `GET /api/notifications/schedule` — `notifications.py:504`. */
export interface ScheduleResponse {
  timezone: string
  clock: string
  statement_periods: Record<string, string>
  jobs: ScheduleEntry[]
  last_run: string
}

/**
 * One job's health. `scheduling.py:2069 last_runs()`.
 *
 * `status` is one of:
 *   ok        — it ran and everything in it worked
 *   degraded  — it ran, delivered what it could, and something did not
 *   failed    — it raised and sent nothing
 *   never     — no run has ever been recorded: the schedule was never wired up
 *   unknown   — the run log itself could not be read; says nothing either way
 *
 * `stalled` is set independently of all five and only when a run exists: a job
 * whose last run was `ok` three weeks ago is not a healthy job.
 */
export interface JobHealth extends ScheduleEntry {
  status: string
  last_run_at: string | null
  as_at: string
  detail?: string
  /** Present only when a run exists. */
  ok?: boolean
  finished_at?: string | null
  age_hours?: number | null
  trigger?: string | null
  triggered_by?: TriggeredBy | null
  emails_accepted?: number | null
  problems?: string[]
  recorded?: boolean
  stalled?: boolean
}

/** `GET /api/notifications/runs/last` — `notifications.py:529`. */
export interface LastRuns {
  jobs: JobHealth[]
  healthy: string[]
  needs_attention: string[]
  timezone: string
  note: string
}

/**
 * One row of `scheduled_runs`. The fields differ per job — a sweep carries
 * `sections`, a report run carries `reports` — so only what every row is
 * stamped with by `record_run` is named. Anything else is read defensively.
 */
export interface RunRow extends RunStamp {
  job: string
  started_at?: string
  finished_at?: string
  spec?: string
  emails_accepted?: number
  errors?: string[]
  failed_sections?: string[]
  failed_sweeps?: string[]
  failed_detectors?: string[]
  week_label?: string
  revision?: number
  note?: string
  [key: string]: unknown
}

/** `GET /api/notifications/runs` — `notifications.py:568`. */
export interface RunList {
  runs: RunRow[]
}

/**
 * What a job trigger answers with. Every job builds its own summary and they
 * do not share a shape beyond the run stamp, so only the common fields are
 * named. A 200 here means the job *ran*, not that everything worked — read
 * `problems`, `errors` and `failed_*`.
 */
export interface JobRunResult extends RunRow {
  emails_accepted?: number
}

// ── The requests ──────────────────────────────────────────────────────────────

const NOTIF = '/api/notifications'

export const notifications = {
  /** Job health for every scheduled job, run or not. Oversight roles only. */
  lastRuns: () => callApi<LastRuns>(NOTIF, '/runs/last'),

  /** What is scheduled, in whose clock, and which Cloud Function fires it. */
  schedule: () => callApi<ScheduleResponse>(NOTIF, '/schedule'),

  /** The run log. `job` is the value in `scheduled_runs.job`, e.g. reports.daily. */
  runs: (p: { job?: string; limit?: number } = {}) =>
    callApi<RunList>(NOTIF, '/runs', { ...p }),

  /** Every detector: what it watches, its threshold, who is told. */
  alertCatalogue: () => callApi<AlertCatalogue>(NOTIF, '/alerts'),

  /** The suppression state read directly — what has been raised, and when. */
  alertsRaised: (p: { limit?: number } = {}) =>
    callApi<RaisedAlerts>(NOTIF, '/alerts/raised', { ...p }),

  /** Everything currently wrong, without sending anything. */
  alertsOpen: () => callApi<OpenAlerts>(NOTIF, '/alerts/open'),

  /**
   * Forget one raised condition so it can alert again. Owners only
   * (`require_owner`, `notifications.py:482`).
   *
   * The endpoint takes a key and nothing else — there is no reason field on it.
   */
  releaseAlert: (key: string) =>
    callApi<{ released: string }>(
      NOTIF,
      `/alerts/raised/${encodeURIComponent(key)}`,
      {},
      { method: 'DELETE' },
    ),

  /** Every attempted send: what, to whom, when, and how it ended. */
  deliveries: (
    p: { kind?: string; outcome?: string; to?: string; since?: string; limit?: number } = {},
  ) => callApi<DeliveryList>(NOTIF, '/deliveries', { ...p }),

  /** Everything that did not arrive, in the last `hours`. */
  deliveryFailures: (p: { hours?: number; limit?: number } = {}) =>
    callApi<DeliveryFailures>(NOTIF, '/deliveries/failures', { ...p }),

  /** Counts by outcome, in the last `hours`. */
  deliverySummary: (p: { hours?: number } = {}) =>
    callApi<DeliverySummary>(NOTIF, '/deliveries/summary', { ...p }),

  /**
   * The manual triggers. Each is a team admin or the schedule's own service
   * credential (`deps.py:139-158`), so an observer cannot reach any of them —
   * and a run fired from here is recorded with `trigger: "person"`.
   */
  jobs: {
    daily: () => callApi<JobRunResult>(NOTIF, '/jobs/daily', {}, { method: 'POST' }),
    monthly: (p: { with_statements?: boolean } = {}) =>
      callApi<JobRunResult>(NOTIF, '/jobs/monthly', { ...p }, { method: 'POST' }),
    partnerStatements: (
      p: { period?: string; since?: string; until?: string; cadence?: string; kind?: string } = {},
    ) => callApi<JobRunResult>(NOTIF, '/jobs/partner-statements', { ...p }, { method: 'POST' }),
    alerts: (p: { only?: string } = {}) =>
      callApi<JobRunResult>(NOTIF, '/jobs/alerts', { ...p }, { method: 'POST' }),
    transactionalSweep: (p: { only?: string } = {}) =>
      callApi<JobRunResult>(NOTIF, '/jobs/transactional-sweep', { ...p }, { method: 'POST' }),
  },
}

export const weeklyBusiness = {
  /**
   * Re-read a stored week. The figures are the ones that were stored, not a
   * recomputation. A 404 means the job did not run for that week — which the
   * API says in words, and which is not the same as an empty week.
   */
  read: (week: string) =>
    callApi<WeeklyBusinessRead>('/api/reports', `/weekly-business/${encodeURIComponent(week)}`),

  /**
   * Build, store and email the week. `force` stores a NEW revision beside the
   * original rather than re-using it; it never edits what was already stored.
   * Team admin or owner only (`reports.py:509`).
   */
  run: (body: { week?: string; force?: boolean; top_n?: number } = {}) =>
    callApi<WeeklyBusinessRun>('/api/reports', '/jobs/weekly-business', {}, {
      method: 'POST',
      body,
    }),
}

// ── ISO weeks, computed the way the backend computes them ─────────────────────
//
// The report is keyed on an ISO week label, e.g. "2026-W33", and there is no
// endpoint that lists which weeks have a stored report — so the picker has to
// generate the labels. These mirror `scheduling.last_closed_iso_week`
// (`scheduling.py:1549`), which takes the ISO week of the instant seven days
// ago, in UTC. All arithmetic below is UTC for the same reason: a local-time
// week boundary would name a different week for anyone east of Greenwich.

const DAY_MS = 86_400_000

function isoWeekParts(d: Date): { year: number; week: number } {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const weekday = t.getUTCDay() || 7          // ISO: Monday 1 … Sunday 7
  t.setUTCDate(t.getUTCDate() + 4 - weekday)  // the Thursday of this ISO week
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((t.getTime() - yearStart) / DAY_MS + 1) / 7)
  return { year: t.getUTCFullYear(), week }
}

/** The ISO week label an instant falls in, e.g. "2026-W33". */
export function isoWeekLabel(d: Date): string {
  const { year, week } = isoWeekParts(d)
  return `${year}-W${String(week).padStart(2, '0')}`
}

/** The most recent ISO week that has completely finished. */
export function lastClosedIsoWeek(now: Date = new Date()): string {
  return isoWeekLabel(new Date(now.getTime() - 7 * DAY_MS))
}

/** The Monday an ISO week label starts on, in UTC. Null if the label is not one. */
export function isoWeekStart(label: string): Date | null {
  const m = /^(\d{4})-W(\d{1,2})$/.exec(label.trim())
  if (!m) return null
  const week = Number(m[2])
  if (week < 1 || week > 53) return null
  // 4 January is in ISO week 1 of its year, always.
  const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4))
  const weekOneMonday = jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * DAY_MS
  return new Date(weekOneMonday + (week - 1) * 7 * DAY_MS)
}

/** `label` moved by `weeks`. Null if the label is not an ISO week. */
export function shiftIsoWeek(label: string, weeks: number): string | null {
  const start = isoWeekStart(label)
  if (!start) return null
  return isoWeekLabel(new Date(start.getTime() + weeks * 7 * DAY_MS))
}

/** `count` ISO week labels ending at `from`, most recent first. */
export function recentIsoWeeks(count: number, from: string = lastClosedIsoWeek()): string[] {
  const out: string[] = []
  for (let i = 0; i < count; i += 1) {
    const label = i === 0 ? from : shiftIsoWeek(from, -i)
    if (label) out.push(label)
  }
  return out
}

/** "Mon 11 Aug – Sun 17 Aug 2026" for an ISO week label, or the label itself. */
export function isoWeekRangeLabel(label: string): string {
  const start = isoWeekStart(label)
  if (!start) return label
  const end = new Date(start.getTime() + 6 * DAY_MS)
  const fmt = (d: Date) =>
    d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })
  return `${fmt(start)} – ${fmt(end)} ${end.getUTCFullYear()}`
}

// ── Reading a stored section ──────────────────────────────────────────────────

/**
 * Rupees the API already divided.
 *
 * A report row carries both `payout_due_inr_minor` (paise) and
 * `payout_due_inr` (rupees, from `reports.inr()`). Dividing the second by 100
 * as well is the mistake this pair of helpers exists to make impossible.
 */
export function formatInrRupees(rupees: number | null | undefined): string {
  if (rupees === null || rupees === undefined || Number.isNaN(rupees)) return '—'
  return INR.format(rupees)
}

/** True when a column key holds INR minor units (paise). */
export function isMinorUnitKey(key: string): boolean {
  return key === 'inr_minor' || key.endsWith('_inr_minor')
}

/** True when a column key holds rupees the API already converted. */
export function isRupeeKey(key: string): boolean {
  return key === 'inr' || (key.endsWith('_inr') && !isMinorUnitKey(key))
}

/**
 * One cell of a stored report row, rendered.
 *
 * Null is "—", never 0: across these reports a null means "not recorded" or
 * "could not be read", and a zero would be read as a measurement.
 */
export function formatReportCell(key: string, value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') {
    if (isMinorUnitKey(key)) return formatInrMinor(value)
    if (isRupeeKey(key)) return formatInrRupees(value)
    return formatCount(value)
  }
  if (typeof value === 'string') {
    // A timestamp column the report emitted as an ISO string.
    if (/(_at|_from)$/.test(key) && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
      return formatDateTime(value)
    }
    return value
  }
  return JSON.stringify(value)
}

/** The scalar behind a cell, for sorting and for a client-side CSV export. */
export function reportCellValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' || typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return JSON.stringify(value)
}

/** A number out of an untyped `totals` map. Absent or non-numeric stays null. */
export function totalNumber(
  totals: Record<string, unknown>,
  key: string,
): number | null {
  const v = totals[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** A boolean out of an untyped `totals` map. Absent stays null, never false. */
export function totalBoolean(
  totals: Record<string, unknown>,
  key: string,
): boolean | null {
  const v = totals[key]
  return typeof v === 'boolean' ? v : null
}

/** A string out of an untyped `totals` map. */
export function totalText(totals: Record<string, unknown>, key: string): string | null {
  const v = totals[key]
  return typeof v === 'string' && v !== '' ? v : null
}

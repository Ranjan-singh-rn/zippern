'use client'

/**
 * The reporting hub.
 *
 * One date range, applied to every report on the page, and one Download CSV
 * button per report that goes through the API rather than being rebuilt in the
 * browser. Nothing here is computed client-side: every figure shown is a field
 * the API already published, so this screen cannot disagree with the CSV a
 * person downloads two seconds later.
 *
 * The envelope flags are honoured deliberately:
 *
 *   `empty`       — nothing happened in the period. Rendered as "no data for
 *                   this period", never as ₹0. A confident zero is worse than
 *                   an error, because nobody checks it.
 *   `provisional` — a rate was missing and a documented fallback was used. Said
 *                   out loud, above the number, not in a tooltip below it.
 *   `warnings`    — shown as written by the API.
 *
 * Each report is fetched independently. A 403 on one — a team admin asking for
 * another team's throughput, say — leaves the other seven readable instead of
 * blanking the page.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Activity, BookOpen, Building2, ChevronRight, Download, Loader2,
  Receipt, Scale, ShieldCheck, TrendingUp, Users, Wallet, type LucideIcon,
} from 'lucide-react'

import { useAuth } from '@/components/AuthProvider'
import { canAccess, CrmRole } from '@/lib/auth'
import api, { ApiError } from '@/lib/api'
import { DateRangePicker, Range, defaultRange, toParams } from '@/components/ui/DateRange'
import { Denied, ErrorState, Loading, Warning } from '@/components/ui/States'
import {
  AnyReport, CashPositionReport, ChannelReport, DefinitionsResponse,
  LiabilityReport, MarginReport, QueryParams, ReportPeriod, ReportRates,
  RevenueReport, ThroughputReport,
  downloadReportCsv, formatCount, formatHours, formatInrMinorShort, formatPct,
  formatRatio, otherWarnings, provisionalNote, reports,
} from '@/lib/apiReports'

/**
 * The API decides who may actually read each report — a member gets a 403 on
 * business-wide money and it is shown on the card that asked for it. This list
 * only keeps the page off the screen of someone with no reporting role at all.
 */
const REPORT_ROLES: CrmRole[] = [
  'superadmin',
  'finance_admin', 'finance_member',
  'app_admin', 'ops_admin', 'tech_admin', 'support_admin', 'marketing_admin',
]

// ── Loading state per report ──────────────────────────────────────────────────

type Slot<T> =
  | { status: 'loading' }
  | { status: 'ok'; value: T }
  | { status: 'error'; message: string }

const LOADING: Slot<never> = { status: 'loading' }

/** The parts of the envelope every card reads, whatever its rows look like. */
interface EnvelopeLike {
  empty: boolean
  warnings: string[]
  rates: Partial<ReportRates>
  period: ReportPeriod
}

function messageOf(err: unknown, what: string): string {
  if (err instanceof ApiError) return err.message
  return `The ${what} report could not be produced.`
}

/** A number out of an untyped `totals` map. Absent or non-numeric stays null. */
function num(totals: Record<string, unknown>, key: string): number | null {
  const v = totals[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

// ── Presentation ──────────────────────────────────────────────────────────────

function Line({
  label, value, tone = 'text-white',
}: {
  label: string
  value: string
  tone?: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-slate-500 text-xs">{label}</span>
      <span className={`text-sm font-semibold tabular-nums ${tone}`}>{value}</span>
    </div>
  )
}

function ReportCard({
  title, blurb, icon: Icon, slot, figures, emptyHint, href, hrefLabel,
  exporting, onExport,
}: {
  title: string
  blurb: string
  icon: LucideIcon
  slot: Slot<EnvelopeLike>
  /** Rendered only when the report loaded and is not empty. */
  figures?: React.ReactNode
  emptyHint: string
  href?: string
  hrefLabel?: string
  exporting: boolean
  onExport: () => void
}) {
  const provisional = slot.status === 'ok' ? provisionalNote(slot.value) : null
  const notes = slot.status === 'ok' ? otherWarnings(slot.value) : []

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <Icon size={18} className="text-slate-600 mt-0.5 shrink-0" />
        <div className="min-w-0">
          <h3 className="text-white font-semibold">{title}</h3>
          <p className="text-slate-500 text-sm mt-1 leading-relaxed">{blurb}</p>
        </div>
      </div>

      <div className="flex-1">
        {slot.status === 'loading' ? (
          <div className="flex items-center gap-2 text-slate-600 text-sm py-5">
            <Loader2 size={14} className="animate-spin" /> Producing…
          </div>
        ) : slot.status === 'error' ? (
          <div className="bg-red-500/10 border border-red-500/25 rounded-lg px-3.5 py-3">
            <p className="text-red-300 text-sm font-medium">Not available</p>
            <p className="text-slate-400 text-sm mt-1 leading-relaxed">{slot.message}</p>
          </div>
        ) : slot.value.empty ? (
          <div className="bg-slate-800/60 border border-slate-700 rounded-lg px-3.5 py-3">
            <p className="text-slate-200 text-sm font-medium">No data for this period</p>
            <p className="text-slate-500 text-xs mt-1 leading-relaxed">
              {slot.value.warnings[0] ?? emptyHint}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {provisional && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3.5 py-2.5">
                <p className="text-amber-100 text-xs leading-relaxed">
                  <span className="font-semibold">Provisional.</span> {provisional}
                </p>
              </div>
            )}
            <div className="divide-y divide-slate-800/70">{figures}</div>
            {notes.map((w, i) => (
              <p key={i} className="text-amber-200/80 text-xs leading-relaxed">
                {w}
              </p>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 pt-3 border-t border-slate-800">
        {href ? (
          <Link
            href={href}
            className="flex items-center gap-1 text-slate-400 hover:text-white text-xs transition-colors"
          >
            {hrefLabel ?? 'Open'} <ChevronRight size={13} />
          </Link>
        ) : (
          <span className="text-slate-700 text-xs">Report only</span>
        )}
        <button
          onClick={onExport}
          disabled={exporting}
          title="Download this report as CSV, produced by the API and logged"
          className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300 rounded-lg px-3 py-1.5 text-xs transition-colors"
        >
          {exporting ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
          Download CSV
        </button>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ReportsHubPage() {
  const { crmUser, apiUser, loading: authLoading, apiReady, apiError } = useAuth()
  // The observer has no Firestore `crmUser` by design, so a `canAccess` check
  // alone would lock the one role that exists to watch the money out of the
  // money. They are admitted here and the API's `can_read_all` does the rest.
  const isObserver = apiUser?.role === 'observer'
  const allowed = isObserver || canAccess(crmUser, REPORT_ROLES)

  const [range, setRange] = useState<Range>(defaultRange)

  const [cash, setCash] = useState<Slot<CashPositionReport>>(LOADING)
  const [revenue, setRevenue] = useState<Slot<RevenueReport>>(LOADING)
  const [margin, setMargin] = useState<Slot<MarginReport>>(LOADING)
  const [channels, setChannels] = useState<Slot<ChannelReport>>(LOADING)
  const [liabilities, setLiabilities] = useState<Slot<LiabilityReport>>(LOADING)
  const [partners, setPartners] = useState<Slot<AnyReport>>(LOADING)
  const [throughput, setThroughput] = useState<Slot<ThroughputReport>>(LOADING)
  const [auditSummary, setAuditSummary] = useState<Slot<AnyReport>>(LOADING)
  const [defs, setDefs] = useState<Slot<DefinitionsResponse>>(LOADING)

  const [busy, setBusy] = useState('')
  const [exportError, setExportError] = useState('')

  const load = useCallback(() => {
    if (!allowed || !apiReady) return
    const p = toParams(range)

    function run<T>(
      promise: Promise<T>,
      set: (s: Slot<T>) => void,
      what: string,
    ): void {
      set(LOADING)
      promise
        .then((value) => set({ status: 'ok', value }))
        .catch((err: unknown) => set({ status: 'error', message: messageOf(err, what) }))
    }

    run(reports.cashPosition(p), setCash, 'cash position')
    run(reports.revenue({ ...p, group_by: 'day' }), setRevenue, 'revenue')
    run(reports.margin(p), setMargin, 'margin')
    run(reports.channels(p), setChannels, 'channel')
    run(reports.liabilities(), setLiabilities, 'liabilities')
    run(reports.teamThroughput(p), setThroughput, 'team throughput')
    run(reports.definitions(), setDefs, 'definitions')

    // `/reports/partners/summary` and `/reports/audit-summary` have no wrapper
    // in lib/apiReports, so they are called through lib/api. Their runtime body
    // is the same envelope every other report returns — lib/api's older
    // `ReportEnvelope` type predates it, which is why the result is re-typed
    // here rather than read through that stale shape.
    run(
      api.reports
        .partnersSummary({ ...p, kind: 'agency' })
        .then((r) => r as unknown as AnyReport),
      setPartners,
      'partner summary',
    )
    run(
      api.reports.auditSummary(p).then((r) => r as unknown as AnyReport),
      setAuditSummary,
      'audit summary',
    )
  }, [allowed, apiReady, range])

  useEffect(() => { load() }, [load])

  async function exportCsv(
    key: string,
    path: string,
    params: QueryParams,
    name: string,
  ) {
    setBusy(key)
    setExportError('')
    try {
      await downloadReportCsv(path, params, name)
    } catch (err) {
      setExportError(
        err instanceof ApiError
          ? err.message
          : 'The export failed and no file was produced.',
      )
    } finally {
      setBusy('')
    }
  }

  if (authLoading) return <Loading label="Checking your access…" />
  if (!allowed) return <Denied what="reporting" />

  const p = toParams(range)

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white">Reports</h1>
          <p className="text-slate-400 mt-1 text-sm max-w-2xl leading-relaxed">
            Every report below covers{' '}
            <span className="text-slate-200">{range.label.toLowerCase()}</span> and
            exports as CSV produced by the API — the same code that rendered these
            figures, so an export can never quietly disagree with the screen. Money is
            in Indian rupees (₹); the API reports paise and it is converted once, here.
          </p>
        </div>
        <div className="shrink-0">
          <DateRangePicker value={range} onChange={setRange} />
        </div>
      </div>

      {apiReady && apiError && <Warning>{apiError}</Warning>}
      {exportError && <Warning onDismiss={() => setExportError('')}>{exportError}</Warning>}

      {!apiReady && apiError ? (
        <ErrorState message={apiError} />
      ) : !apiReady ? (
        <Loading label="Waiting for the API session…" />
      ) : (
        <>
          <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {/* Cash position */}
            <ReportCard
              icon={Wallet}
              title="Cash position"
              blurb="Money actually received, by channel, less what actually left. Not imputed diamond consumption — receipts with payment evidence on them."
              slot={cash}
              emptyHint="No receipt and no executed payout falls in this period."
              href="/finance"
              hrefLabel="Open Finance"
              exporting={busy === 'cash'}
              onExport={() => exportCsv('cash', '/cash-position', p, 'cash-position')}
              figures={
                cash.status === 'ok' ? (
                  <>
                    <Line
                      label="Receipts"
                      value={formatInrMinorShort(cash.value.totals.receipts_inr_minor)}
                      tone="text-emerald-300"
                    />
                    <Line
                      label="Payments out"
                      value={formatInrMinorShort(cash.value.totals.payments_out_inr_minor)}
                      tone="text-orange-300"
                    />
                    <Line
                      label="Net"
                      value={formatInrMinorShort(cash.value.totals.net_inr_minor)}
                      tone={
                        cash.value.totals.net_inr_minor < 0 ? 'text-red-300' : 'text-white'
                      }
                    />
                    <Line
                      label="Non-cash credits excluded"
                      value={`${formatCount(
                        cash.value.totals.non_cash_credits_excluded.movements,
                      )} movements`}
                      tone="text-slate-400"
                    />
                  </>
                ) : null
              }
            />

            {/* Revenue */}
            <ReportCard
              icon={Receipt}
              title="Revenue"
              blurb="Cash received in the period, bucketed by day. Grouping by week or month is on the profit screen."
              slot={revenue}
              emptyHint="No cash receipt falls between these dates."
              href="/finance/profit"
              hrefLabel="Revenue over time"
              exporting={busy === 'revenue'}
              onExport={() =>
                exportCsv('revenue', '/revenue', { ...p, group_by: 'day' }, 'revenue')
              }
              figures={
                revenue.status === 'ok' ? (
                  <>
                    <Line
                      label="Revenue"
                      value={formatInrMinorShort(revenue.value.totals.revenue_inr_minor)}
                      tone="text-emerald-300"
                    />
                    <Line
                      label="Buckets with activity"
                      value={formatCount(revenue.value.totals.buckets)}
                      tone="text-slate-300"
                    />
                    {Object.entries(revenue.value.totals.by_channel).map(([c, v]) => (
                      <Line
                        key={c}
                        label={`via ${c}`}
                        value={formatInrMinorShort(v)}
                        tone="text-slate-300"
                      />
                    ))}
                  </>
                ) : null
              }
            />

            {/* Margin */}
            <ReportCard
              icon={TrendingUp}
              title="Margin"
              blurb="Revenue less payouts less the change in commission owed, plus the bean-payout ratio — cash out as a share of diamond value consumed."
              slot={margin}
              emptyHint="Nothing moved between these dates — no revenue, no payout, no commission."
              href="/finance/profit"
              hrefLabel="Profitability"
              exporting={busy === 'margin'}
              onExport={() => exportCsv('margin', '/margin', p, 'margin')}
              figures={
                margin.status === 'ok' ? (
                  <>
                    <Line
                      label="Net margin"
                      value={formatInrMinorShort(margin.value.totals.net_margin_inr_minor)}
                      tone={
                        margin.value.totals.net_margin_inr_minor < 0
                          ? 'text-red-300'
                          : 'text-white'
                      }
                    />
                    <Line
                      label="Margin %"
                      value={formatPct(margin.value.totals.net_margin_pct)}
                      tone="text-pink-400"
                    />
                    <Line
                      label="Bean-payout ratio"
                      value={
                        margin.value.totals.bean_payout_ratio === null
                          ? '—'
                          : `${formatPct(margin.value.totals.bean_payout_ratio_pct, 2)} (${formatRatio(
                              margin.value.totals.bean_payout_ratio,
                            )})`
                      }
                      tone="text-pink-400"
                    />
                    <Line
                      label="Commission accrued"
                      value={formatInrMinorShort(
                        margin.value.totals.commission_accrued_inr_minor,
                      )}
                      tone="text-sky-300"
                    />
                  </>
                ) : null
              }
            />

            {/* Channels */}
            <ReportCard
              icon={Building2}
              title="Channels"
              blurb="Reseller versus direct, reported separately and never folded into one number — they carry different margin, growth and risk."
              slot={channels}
              emptyHint="No receipts on either channel between these dates."
              href="/finance/profit"
              hrefLabel="Channel detail"
              exporting={busy === 'channels'}
              onExport={() => exportCsv('channels', '/channels', p, 'channels')}
              figures={
                channels.status === 'ok' ? (
                  <>
                    {channels.value.rows.map((r) => (
                      <Line
                        key={r.channel}
                        label={`${r.channel} · ${formatPct(r.share_of_receipts_pct)}`}
                        value={formatInrMinorShort(r.receipts_inr_minor)}
                        tone="text-emerald-300"
                      />
                    ))}
                    <Line
                      label="Payouts attributed to no channel"
                      value={formatInrMinorShort(
                        channels.value.totals.unattributed_payouts_inr_minor,
                      )}
                      tone="text-slate-400"
                    />
                  </>
                ) : null
              }
            />

            {/* Liabilities */}
            <ReportCard
              icon={Scale}
              title="Liabilities"
              blurb="What is owed to agencies and hosts right now. A point-in-time figure, so it ignores the date range above."
              slot={liabilities}
              emptyHint="No positive agency, host or seller balance exists. If that is unexpected, treat it as a data problem, not as nothing being owed."
              href="/finance"
              hrefLabel="Open Finance"
              exporting={busy === 'liabilities'}
              onExport={() => exportCsv('liabilities', '/liabilities', {}, 'liabilities')}
              figures={
                liabilities.status === 'ok' ? (
                  <>
                    <Line
                      label="Total owed"
                      value={formatInrMinorShort(liabilities.value.totals.total_owed_inr_minor)}
                      tone="text-orange-300"
                    />
                    <Line
                      label="Seller receivable"
                      value={formatInrMinorShort(
                        liabilities.value.totals.seller_credit_receivable_minor,
                      )}
                      tone="text-sky-300"
                    />
                    <Line
                      label="Net position"
                      value={formatInrMinorShort(
                        liabilities.value.totals.net_position_inr_minor,
                      )}
                      tone={
                        liabilities.value.totals.net_position_inr_minor < 0
                          ? 'text-red-300'
                          : 'text-white'
                      }
                    />
                    <Line
                      label="Sellers overdue"
                      value={formatCount(liabilities.value.totals.sellers_overdue)}
                      tone={
                        liabilities.value.totals.sellers_overdue > 0
                          ? 'text-red-300'
                          : 'text-slate-300'
                      }
                    />
                  </>
                ) : null
              }
            />

            {/* Partner summary */}
            <ReportCard
              icon={Users}
              title="Partner summary"
              blurb="One row per agency for the period — the weekly payout run. An agency with no movement has no row, which means no activity, not a zero balance."
              slot={partners}
              emptyHint="No agency had any movement in this period."
              href="/finance/reports"
              hrefLabel="Payout runs"
              exporting={busy === 'partners'}
              onExport={() =>
                exportCsv(
                  'partners',
                  '/partners/summary',
                  { ...p, kind: 'agency' },
                  'agency-summary',
                )
              }
              figures={
                partners.status === 'ok' ? (
                  <>
                    <Line
                      label="Agencies with movement"
                      value={formatCount(num(partners.value.totals, 'partners_with_movement'))}
                      tone="text-slate-200"
                    />
                    <Line
                      label="Agencies on file"
                      value={formatCount(num(partners.value.totals, 'partners_on_file'))}
                      tone="text-slate-400"
                    />
                    <Line
                      label="Commission earned"
                      value={formatInrMinorShort(num(partners.value.totals, 'credits_total'))}
                      tone="text-sky-300"
                    />
                    <Line
                      label="Commission paid"
                      value={formatInrMinorShort(num(partners.value.totals, 'debits_total'))}
                      tone="text-orange-300"
                    />
                    <Line
                      label="Still outstanding"
                      value={formatInrMinorShort(num(partners.value.totals, 'closing_total'))}
                      tone="text-white"
                    />
                  </>
                ) : null
              }
            />

            {/* Team throughput */}
            <ReportCard
              icon={Activity}
              title="Team throughput"
              blurb="Cards raised, verified, signed and executed, the median time in each stage, and the oldest item still open. Medians, so one stuck card cannot move the number."
              slot={throughput}
              emptyHint="No card moved through any stage in this period."
              href="/throughput"
              hrefLabel="Throughput detail"
              exporting={busy === 'throughput'}
              onExport={() =>
                exportCsv('throughput', '/team-throughput', p, 'team-throughput')
              }
              figures={
                throughput.status === 'ok' ? (
                  <>
                    <Line
                      label="Scope"
                      value={throughput.value.totals.team || 'all teams'}
                      tone="text-slate-300"
                    />
                    <Line
                      label="Raised"
                      value={formatCount(throughput.value.totals.counts.raised)}
                      tone="text-slate-200"
                    />
                    <Line
                      label="Executed"
                      value={formatCount(throughput.value.totals.counts.executed)}
                      tone="text-emerald-300"
                    />
                    <Line
                      label="Still open"
                      value={formatCount(throughput.value.totals.open_total)}
                      tone={
                        throughput.value.totals.open_total > 0
                          ? 'text-amber-300'
                          : 'text-slate-300'
                      }
                    />
                    <Line
                      label="Median raised → executed"
                      value={formatHours(
                        throughput.value.totals.median_hours.raised_to_executed,
                      )}
                      tone="text-slate-200"
                    />
                    {throughput.value.totals.oldest_open_item && (
                      <Line
                        label="Oldest open item"
                        value={`${throughput.value.totals.oldest_open_item.age_days.toFixed(
                          1,
                        )} days`}
                        tone="text-amber-300"
                      />
                    )}
                  </>
                ) : null
              }
            />

            {/* Audit summary */}
            <ReportCard
              icon={ShieldCheck}
              title="Audit summary"
              blurb="Every money action in the period, by actor and by type — the monthly governance review. Only actions that move money or authorise it are counted."
              slot={auditSummary}
              emptyHint="No money action was recorded in this period by anyone in scope. Over a month-long window that is itself worth checking."
              href="/audit"
              hrefLabel="Full audit log"
              exporting={busy === 'audit'}
              onExport={() => exportCsv('audit', '/audit-summary', p, 'audit-summary')}
              figures={
                auditSummary.status === 'ok' ? (
                  <>
                    <Line
                      label="Money actions"
                      value={formatCount(num(auditSummary.value.totals, 'money_actions'))}
                      tone="text-slate-200"
                    />
                    <Line
                      label="Distinct actors"
                      value={formatCount(num(auditSummary.value.totals, 'distinct_actors'))}
                      tone="text-slate-200"
                    />
                    <Line
                      label="Scope"
                      value={
                        typeof auditSummary.value.totals.scope === 'string'
                          ? auditSummary.value.totals.scope
                          : '—'
                      }
                      tone="text-slate-400"
                    />
                  </>
                ) : null
              }
            />
          </section>

          {/* Definitions — published by the API, stated once, in the open. */}
          <section className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-800 flex items-start gap-3">
              <BookOpen size={17} className="text-slate-600 mt-0.5 shrink-0" />
              <div>
                <h2 className="text-white font-semibold">What each figure means</h2>
                <p className="text-slate-500 text-sm mt-1 max-w-3xl leading-relaxed">
                  Published by the API at <code className="text-slate-400">/reports/definitions</code>{' '}
                  and read from there, not written here. Every report on this page and every
                  Finance screen uses these definitions, which is what stops &ldquo;total
                  payout&rdquo; meaning four different things again.
                </p>
              </div>
            </div>

            <div className="px-5 py-4">
              {defs.status === 'loading' ? (
                <div className="flex items-center gap-2 text-slate-600 text-sm py-3">
                  <Loader2 size={14} className="animate-spin" /> Loading the definitions…
                </div>
              ) : defs.status === 'error' ? (
                <div className="bg-red-500/10 border border-red-500/25 rounded-lg px-3.5 py-3">
                  <p className="text-red-300 text-sm font-medium">
                    The definitions could not be loaded
                  </p>
                  <p className="text-slate-400 text-sm mt-1">{defs.message}</p>
                  <p className="text-slate-500 text-xs mt-2">
                    The figures above are still the API&rsquo;s own — only the accompanying
                    wording is missing.
                  </p>
                </div>
              ) : (
                <div className="space-y-5">
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-5">
                    {Object.entries(defs.value.definitions).map(([key, text]) => (
                      <div key={key}>
                        <p className="text-slate-200 text-sm font-medium capitalize">
                          {key.replace(/_/g, ' ')}
                        </p>
                        <p className="text-slate-500 text-sm mt-1 leading-relaxed">{text}</p>
                      </div>
                    ))}
                  </div>

                  <div className="pt-4 border-t border-slate-800 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2 text-xs text-slate-500">
                    <p>
                      <span className="text-slate-400">Money:</span> {defs.value.units.money}
                    </p>
                    <p>
                      <span className="text-slate-400">Commission:</span>{' '}
                      {defs.value.units.commission}
                    </p>
                    <p>
                      <span className="text-slate-400">Diamonds per lakh:</span>{' '}
                      {formatCount(defs.value.units.diamonds_per_lakh)}
                    </p>
                    <p>
                      <span className="text-slate-400">Window:</span> defaults to{' '}
                      {defs.value.window.default_days} days, capped at{' '}
                      {defs.value.window.max_days}. Bounds are {defs.value.window.bounds}.
                    </p>
                    <p>
                      <span className="text-slate-400">Rate fallbacks:</span> ₹
                      {defs.value.rate_fallbacks.diamondPackPriceInr} per lakh diamonds, ₹
                      {defs.value.rate_fallbacks['giftRates.beanToInrRate']} per bean.{' '}
                      {defs.value.rate_fallbacks.note}
                    </p>
                    <p>
                      <span className="text-slate-400">Exports:</span>{' '}
                      {defs.value.export.format}. {defs.value.export.logged}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

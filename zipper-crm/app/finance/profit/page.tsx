'use client'

/**
 * Profitability — margin, the bean-payout ratio, revenue over time, and the
 * channel split.
 *
 * Three reports, one date range:
 *
 *   `/reports/margin`   revenue, payouts, commission, net margin and the
 *                       bean-payout ratio for the whole window.
 *   `/reports/revenue`  receipts bucketed by day, week or month. The bucketing
 *                       happens in the database — the toggle just asks for a
 *                       different bucket, it does not re-add anything here.
 *   `/reports/channels` reseller versus direct, kept apart because they carry
 *                       different margin, growth and risk.
 *
 * A deliberate omission: the API buckets revenue but does not bucket payouts,
 * because a payout belongs to the day its card executed and that has no
 * relationship to the days the money came in. So payouts, margin and margin
 * percentage are stated once, for the whole range, and the per-period table
 * shows revenue only. Splitting payouts across periods here would mean
 * inventing a figure the business has not defined — which is how "total payout"
 * came to mean four different things in the first place.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, ArrowUpRight, Download, Loader2, Percent, Receipt,
  TrendingDown, TrendingUp, Users,
} from 'lucide-react'
import {
  Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'

import { useAuth } from '@/components/AuthProvider'
import { canAccess, CrmRole } from '@/lib/auth'
import { ApiError } from '@/lib/api'
import { Column, DataTable } from '@/components/ui/DataTable'
import { DateRangePicker, Range, defaultRange, toParams } from '@/components/ui/DateRange'
import { Denied, Empty, ErrorState, Loading, Warning } from '@/components/ui/States'
import {
  ChannelReport, ChannelRow, GroupBy, MarginReport, MarginRow, RevenueReport,
  RevenueRow,
  downloadReportCsv, formatCount, formatInrMinor, formatInrMinorShort,
  formatNativeAmount, formatPct, formatRatio, otherWarnings, provisionalNote,
  rateSummary, reports,
} from '@/lib/apiReports'

/**
 * Who may see business-wide money.
 *
 * `_require_business_financials` in backend/app/routers/reports.py admits
 * `can_read_all` (owner, Observer) or `is_team_admin` — and every report this
 * screen asks for goes through it. `finance_member` is a MEMBER role
 * (backend/app/core/roles.py), so it is refused: the router's own docstring
 * says "a member gets a 403 on business-wide financial reports". It used to be
 * listed here, which let a finance member onto a screen where every figure came
 * back red.
 */
const FINANCE_ROLES: CrmRole[] = ['superadmin', 'finance_admin']

const GROUPINGS: { key: GroupBy; label: string }[] = [
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
]

const CHANNEL_LABELS: Record<string, string> = {
  reseller: 'Reseller',
  direct: 'Direct',
  unattributed: 'Unattributed',
}

const CHANNEL_COLORS: Record<string, string> = {
  reseller: '#8b5cf6',
  direct: '#10b981',
  unattributed: '#64748b',
}

type KeyedRevenueRow = RevenueRow & { _key: string }
type KeyedMarginRow = MarginRow & { _key: string }

/** One bar per period, one stack segment per channel. Rupees, for the axis. */
type ChartPoint = { period: string } & Record<string, number | string>

/**
 * A margin metric in whatever unit the API declared it in.
 *
 * The report states the unit per row rather than assuming rupees, because the
 * same table carries paise, percentages, ratios and bean counts. Rendering a
 * bean count with a ₹ in front of it is exactly the class of mistake this
 * screen exists to stop.
 */
function marginValue(row: MarginRow): string {
  if (row.value === null || row.value === undefined) return '—'
  switch (row.unit) {
    case 'inr_minor':
      return formatInrMinor(row.value)
    case 'percent':
      return formatPct(row.value, 2)
    case 'ratio':
      return formatRatio(row.value)
    case 'beans':
      return `${formatCount(row.value)} beans`
    case 'diamonds':
      return `${formatCount(row.value)} diamonds`
    default:
      return `${formatCount(row.value)} ${row.unit}`
  }
}

export default function ProfitPage() {
  const { crmUser, apiUser, loading: authLoading, apiReady, apiError } = useAuth()
  // The Observer has no Firestore `crmUser` on purpose, so `canAccess` alone
  // locks the one role that exists to watch the money out of the money. The API
  // grants them `can_read_all`; they are admitted here and the API decides the
  // rest. Same pattern as app/reports/page.tsx.
  const isObserver = apiUser?.role === 'observer'
  const allowed = isObserver || canAccess(crmUser, FINANCE_ROLES)

  const [range, setRange] = useState<Range>(defaultRange)
  const [groupBy, setGroupBy] = useState<GroupBy>('day')

  const [margin, setMargin] = useState<MarginReport | null>(null)
  const [revenue, setRevenue] = useState<RevenueReport | null>(null)
  const [channels, setChannels] = useState<ChannelReport | null>(null)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [exportError, setExportError] = useState('')

  const load = useCallback(() => {
    if (!allowed || !apiReady) return
    setLoading(true)
    setError('')
    const params = toParams(range)
    Promise.all([
      reports.margin(params),
      reports.revenue({ ...params, group_by: groupBy }),
      reports.channels(params),
    ])
      .then(([m, r, c]) => {
        setMargin(m)
        setRevenue(r)
        setChannels(c)
      })
      .catch((err: unknown) => {
        setError(
          err instanceof ApiError
            ? err.message
            : 'The profitability figures could not be produced.',
        )
      })
      .finally(() => setLoading(false))
  }, [allowed, apiReady, range, groupBy])

  useEffect(() => { load() }, [load])

  async function exportCsv(key: string, path: string, name: string) {
    setBusy(key)
    setExportError('')
    try {
      await downloadReportCsv(
        path,
        path === '/revenue'
          ? { ...toParams(range), group_by: groupBy }
          : toParams(range),
        name,
      )
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

  const revenueRows = useMemo<KeyedRevenueRow[]>(
    () =>
      (revenue?.rows ?? []).map((r, i) => ({
        ...r,
        _key: `${r.period_label}-${r.channel}-${i}`,
      })),
    [revenue],
  )

  const marginRows = useMemo<KeyedMarginRow[]>(
    () => (margin?.rows ?? []).map((r, i) => ({ ...r, _key: `${r.metric}-${i}` })),
    [margin],
  )

  const channelsPresent = useMemo(
    () => Array.from(new Set(revenueRows.map((r) => r.channel))).sort(),
    [revenueRows],
  )

  // A pivot for the chart, not a recalculation: each row's own revenue figure is
  // placed under its period and its channel, and recharts stacks them.
  const chartData = useMemo<ChartPoint[]>(() => {
    const byPeriod = new Map<string, ChartPoint>()
    for (const r of revenueRows) {
      const point = byPeriod.get(r.period_label) ?? { period: r.period_label }
      point[r.channel] = ((point[r.channel] as number) ?? 0) + r.revenue_inr_minor / 100
      byPeriod.set(r.period_label, point)
    }
    return Array.from(byPeriod.values())
  }, [revenueRows])

  if (authLoading) return <Loading label="Checking your access…" />
  if (!allowed) return <Denied what="Finance reporting" />

  const t = margin?.totals
  const provisional = margin ? provisionalNote(margin) : null
  const rates = margin ? rateSummary(margin) : null
  const notes = margin ? otherWarnings(margin) : []
  const unit = revenue?.totals.group_by ?? groupBy

  const marginColumns: Column<KeyedMarginRow>[] = [
    {
      key: 'metric',
      header: 'Metric',
      render: (r) => (
        <span className="text-white font-medium capitalize">
          {r.metric.replace(/_/g, ' ')}
        </span>
      ),
    },
    {
      key: 'value',
      header: 'Value',
      align: 'right',
      value: (r) => r.value,
      render: (r) => (
        <span className="text-slate-100 font-semibold tabular-nums">
          {marginValue(r)}
        </span>
      ),
    },
    {
      key: 'value_inr',
      header: 'In rupees',
      align: 'right',
      hideOnMobile: true,
      value: (r) => r.value_inr,
      // The API supplies the rupee figure directly; it is formatted, not recomputed.
      render: (r) => (
        <span className="text-slate-400 tabular-nums">
          {formatNativeAmount(r.value_inr, 'inr')}
        </span>
      ),
    },
    {
      key: 'note',
      header: 'What it means',
      sortable: false,
      hideOnMobile: true,
      render: (r) => (
        <span className="text-slate-500 text-xs leading-relaxed">{r.note}</span>
      ),
    },
  ]

  const revenueColumns: Column<KeyedRevenueRow>[] = [
    {
      key: 'period_label',
      header: unit === 'month' ? 'Month' : unit === 'week' ? 'Week' : 'Day',
      render: (r) => (
        <span className="text-white font-medium whitespace-nowrap">{r.period_label}</span>
      ),
    },
    {
      key: 'channel',
      header: 'Channel',
      render: (r) => (
        <span className="text-slate-300">{CHANNEL_LABELS[r.channel] ?? r.channel}</span>
      ),
    },
    {
      key: 'movements',
      header: 'Receipts',
      align: 'right',
      hideOnMobile: true,
      render: (r) => <span className="tabular-nums">{formatCount(r.movements)}</span>,
    },
    {
      key: 'revenue_inr_minor',
      header: 'Revenue (INR)',
      align: 'right',
      value: (r) => r.revenue_inr_minor,
      render: (r) => (
        <span className="text-emerald-300 font-medium tabular-nums">
          {formatInrMinor(r.revenue_inr_minor)}
        </span>
      ),
    },
    {
      key: 'valuation',
      header: 'Rate applied',
      hideOnMobile: true,
      sortable: false,
      render: (r) => (
        <span className="text-slate-500 text-xs">
          {r.valuation || 'recorded cash amounts'}
        </span>
      ),
    },
  ]

  const channelColumns: Column<ChannelRow>[] = [
    {
      key: 'channel',
      header: 'Channel',
      render: (r) => (
        <span className="text-white font-medium">
          {CHANNEL_LABELS[r.channel] ?? r.channel}
        </span>
      ),
    },
    {
      key: 'receipts_inr_minor',
      header: 'Receipts (INR)',
      align: 'right',
      value: (r) => r.receipts_inr_minor,
      render: (r) => (
        <span className="text-emerald-300 tabular-nums">
          {formatInrMinor(r.receipts_inr_minor)}
        </span>
      ),
    },
    {
      key: 'receipt_count',
      header: 'Receipts',
      align: 'right',
      hideOnMobile: true,
      render: (r) => <span className="tabular-nums">{formatCount(r.receipt_count)}</span>,
    },
    {
      key: 'share_of_receipts_pct',
      header: 'Share',
      align: 'right',
      hideOnMobile: true,
      value: (r) => r.share_of_receipts_pct,
      render: (r) => (
        <span className="tabular-nums">{formatPct(r.share_of_receipts_pct)}</span>
      ),
    },
    {
      key: 'attributed_payouts_inr_minor',
      header: 'Attributed payouts (INR)',
      align: 'right',
      value: (r) => r.attributed_payouts_inr_minor,
      render: (r) => (
        <span className="text-orange-300 tabular-nums">
          {formatInrMinor(r.attributed_payouts_inr_minor)}
        </span>
      ),
    },
    {
      key: 'contribution_inr_minor',
      header: 'Margin (INR)',
      align: 'right',
      value: (r) => r.contribution_inr_minor,
      render: (r) => (
        <span
          className={`font-semibold tabular-nums ${
            r.contribution_inr_minor < 0 ? 'text-red-300' : 'text-white'
          }`}
        >
          {formatInrMinor(r.contribution_inr_minor)}
        </span>
      ),
    },
  ]

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
        <div>
          <Link
            href="/finance"
            className="inline-flex items-center gap-1.5 text-slate-500 hover:text-slate-300 text-sm mb-2 transition-colors"
          >
            <ArrowLeft size={14} /> Finance
          </Link>
          <h1 className="text-2xl sm:text-3xl font-bold text-white">Profitability</h1>
          <p className="text-slate-400 mt-1 text-sm max-w-2xl leading-relaxed">
            Margin, the bean-payout ratio, revenue over time and the reseller/direct
            split for{' '}
            <span className="text-slate-200">{range.label.toLowerCase()}</span>. All
            amounts are in Indian rupees (₹).
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <DateRangePicker value={range} onChange={setRange} />
          <button
            onClick={() => exportCsv('margin', '/margin', 'margin')}
            disabled={busy === 'margin'}
            title="Download the margin report as CSV, exactly as the API produced it"
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300 rounded-lg px-3.5 py-2.5 text-sm transition-colors"
          >
            {busy === 'margin' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Download size={14} />
            )}
            Export margin
          </button>
        </div>
      </div>

      {apiReady && apiError && <Warning>{apiError}</Warning>}
      {exportError && <Warning onDismiss={() => setExportError('')}>{exportError}</Warning>}

      {!apiReady && apiError ? (
        <ErrorState message={apiError} />
      ) : loading || !apiReady ? (
        <Loading label="Producing the margin report…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !margin ? (
        <ErrorState message="No margin report came back." onRetry={load} />
      ) : (
        <>
          {provisional && (
            <Warning>
              <span className="font-semibold">These figures are provisional.</span>{' '}
              {provisional}{' '}
              {margin.rates.missing?.length
                ? `Missing rate${margin.rates.missing.length > 1 ? 's' : ''}: ${margin.rates.missing.join(', ')}.`
                : ''}{' '}
              Fix the rate in the economy config before quoting any of this.
            </Warning>
          )}

          {margin.empty ? (
            <Empty
              title="No data for this period"
              hint={
                margin.warnings[0] ??
                'Nothing moved between these dates — no revenue, no payout, no commission. There is nothing to report, which is not the same as a result of zero.'
              }
            />
          ) : (
            <>
              {/* Headline */}
              <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                  <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide mb-2">
                    <Receipt size={13} /> Revenue (INR)
                  </div>
                  <p className="text-2xl font-bold text-emerald-300 tabular-nums">
                    {formatInrMinorShort(t?.revenue_inr_minor)}
                  </p>
                  <p className="text-slate-500 text-xs mt-1.5 leading-relaxed">
                    Cash actually received, with payment evidence on the movement.
                  </p>
                </div>

                <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                  <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide mb-2">
                    <ArrowUpRight size={13} /> Payouts (INR)
                  </div>
                  <p className="text-2xl font-bold text-orange-300 tabular-nums">
                    {formatInrMinorShort(t?.payouts_inr_minor)}
                  </p>
                  <p className="text-slate-500 text-xs mt-1.5 leading-relaxed">
                    Value that actually left — executed cards only. Signed but unexecuted
                    is not a payout.
                  </p>
                </div>

                <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                  <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide mb-2">
                    <Users size={13} /> Commission (INR)
                  </div>
                  <p className="text-2xl font-bold text-sky-300 tabular-nums">
                    {formatInrMinorShort(t?.commission_accrued_inr_minor)}
                  </p>
                  <p className="text-slate-500 text-xs mt-1.5 leading-relaxed">
                    Accrued by agencies this period;{' '}
                    {formatInrMinorShort(t?.commission_paid_inr_minor)} of it was settled.
                    Commission is recorded in paise and divided by 100 for display.
                  </p>
                </div>

                <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                  <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide mb-2">
                    {t && t.net_margin_inr_minor < 0 ? (
                      <TrendingDown size={13} />
                    ) : (
                      <TrendingUp size={13} />
                    )}{' '}
                    Net margin (INR)
                  </div>
                  <p
                    className={`text-2xl font-bold tabular-nums ${
                      t && t.net_margin_inr_minor < 0 ? 'text-red-300' : 'text-white'
                    }`}
                  >
                    {formatInrMinorShort(t?.net_margin_inr_minor)}
                  </p>
                  <p className="text-slate-500 text-xs mt-1.5 leading-relaxed">
                    {t?.net_margin_pct === null || t?.net_margin_pct === undefined
                      ? 'Margin percentage is undefined — there was no revenue to take a share of. Shown as “—”, never as zero.'
                      : `${formatPct(t.net_margin_pct)} of revenue. Revenue − payouts − the change in commission owed.`}
                  </p>
                </div>
              </section>

              {/* Bean-payout ratio */}
              <section className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                <div className="flex flex-col lg:flex-row lg:items-center gap-5">
                  <div className="shrink-0">
                    <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide mb-2">
                      <Percent size={13} /> Bean-payout ratio
                    </div>
                    <p
                      className={`text-3xl sm:text-4xl font-bold tabular-nums ${
                        t?.bean_payout_ratio === null ? 'text-slate-500' : 'text-pink-400'
                      }`}
                    >
                      {formatPct(t?.bean_payout_ratio_pct, 2)}
                    </p>
                    <p className="text-slate-600 text-xs mt-1 tabular-nums">
                      ratio {formatRatio(t?.bean_payout_ratio)}
                    </p>
                  </div>
                  <div className="text-sm text-slate-400 leading-relaxed max-w-3xl">
                    <p className="text-slate-200">
                      The bean-payout ratio is cash out as a share of diamond value
                      consumed — of every rupee of diamonds users spent, this much left
                      the business as host payouts. Lower is better, and it is the real
                      profitability measure here.
                    </p>
                    <p className="mt-2">
                      {t?.bean_payout_ratio === null
                        ? 'No diamonds were consumed in this period, so the ratio is undefined. It is shown as “—”, never as zero: a zero here would read as perfect margin.'
                        : `${formatCount(t?.beans_paid_out)} beans became cash against ${formatCount(t?.diamonds_consumed)} diamonds consumed. Returned diamonds are recirculated inventory and are not a cost — only beans become cash.`}
                    </p>
                    <p className="mt-2 text-slate-500 text-xs">
                      {formatCount(t?.beans_created)} beans were created this period —
                      future cash liability, not yet paid.
                    </p>
                  </div>
                </div>
              </section>

              {notes.length > 0 && (
                <div className="space-y-2">
                  {notes.map((w, i) => (
                    <Warning key={i}>{w}</Warning>
                  ))}
                </div>
              )}

              {/* Every metric the margin report carries */}
              <section>
                <h2 className="text-lg font-semibold text-white mb-1">
                  Every figure in the margin report
                </h2>
                <p className="text-slate-500 text-sm mb-3 max-w-3xl">
                  Stated in the unit the API declared for each row — paise, a percentage,
                  a ratio or a count of beans — with the note the API attached. A row
                  whose value is null stays &ldquo;—&rdquo;; it is undefined, not zero.
                </p>
                <DataTable<KeyedMarginRow>
                  rows={marginRows}
                  columns={marginColumns}
                  rowKey={(r) => r._key}
                  searchPlaceholder="Search metrics…"
                  searchKeys={['metric', 'note']}
                  onExport={() => exportCsv('margin', '/margin', 'margin')}
                  exportName="margin"
                  pageSize={30}
                  emptyTitle="No metrics came back"
                />
              </section>
            </>
          )}

          {/* ── Revenue over time ─────────────────────────────────────────── */}
          <section className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-white">Revenue over time</h2>
                <p className="text-slate-500 text-sm mt-0.5 max-w-2xl">
                  Cash received, bucketed by {unit}. The grouping happens in the database
                  — switching the toggle asks the API for a different bucket rather than
                  re-adding anything here.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <div className="inline-flex bg-slate-900 border border-slate-800 rounded-lg p-1">
                  {GROUPINGS.map((g) => (
                    <button
                      key={g.key}
                      onClick={() => setGroupBy(g.key)}
                      className={`px-3.5 py-1.5 rounded-md text-sm transition-colors ${
                        groupBy === g.key
                          ? 'bg-pink-500 text-white'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {g.label}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => exportCsv('revenue', '/revenue', `revenue-${groupBy}`)}
                  disabled={busy === 'revenue'}
                  className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300 rounded-lg px-3.5 py-2 text-sm transition-colors"
                >
                  {busy === 'revenue' ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Download size={14} />
                  )}
                  Export
                </button>
              </div>
            </div>

            {!revenue ? (
              <ErrorState message="The revenue report did not come back." onRetry={load} />
            ) : revenue.empty ? (
              <Empty
                title="No data for this period"
                hint={
                  revenue.warnings[0] ??
                  'No cash receipt falls between these dates. There is nothing to plot — this is not a measured zero.'
                }
              />
            ) : (
              <>
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 sm:p-5">
                  <p className="text-slate-500 text-xs mb-4">
                    Stacked by channel, in rupees. Each segment is the figure the API
                    reported for that {unit} and channel — total{' '}
                    {formatInrMinorShort(revenue.totals.revenue_inr_minor)} across{' '}
                    {formatCount(revenue.totals.buckets)} {unit}
                    {revenue.totals.buckets === 1 ? '' : 's'} with activity.
                  </p>
                  <div className="w-full overflow-x-auto">
                    <div style={{ minWidth: Math.max(320, chartData.length * 42) }}>
                      <ResponsiveContainer width="100%" height={260}>
                        <BarChart
                          data={chartData}
                          margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                          <XAxis
                            dataKey="period"
                            tick={{ fill: '#64748b', fontSize: 11 }}
                            tickLine={false}
                            axisLine={false}
                          />
                          <YAxis
                            tick={{ fill: '#64748b', fontSize: 11 }}
                            tickLine={false}
                            axisLine={false}
                            width={70}
                            tickFormatter={(v: number) =>
                              `₹${new Intl.NumberFormat('en-IN', {
                                notation: 'compact',
                                maximumFractionDigits: 1,
                              }).format(v)}`
                            }
                          />
                          <Tooltip
                            contentStyle={{
                              background: '#0f172a',
                              border: '1px solid #1e293b',
                              borderRadius: 8,
                              fontSize: 12,
                            }}
                            labelStyle={{ color: '#e2e8f0' }}
                            formatter={(value: number, name: string) => [
                              new Intl.NumberFormat('en-IN', {
                                style: 'currency',
                                currency: 'INR',
                                maximumFractionDigits: 2,
                              }).format(value),
                              CHANNEL_LABELS[name] ?? name,
                            ]}
                          />
                          <Legend
                            wrapperStyle={{ fontSize: 12, color: '#94a3b8' }}
                            formatter={(name: string) => CHANNEL_LABELS[name] ?? name}
                          />
                          {channelsPresent.map((channel) => (
                            <Bar
                              key={channel}
                              dataKey={channel}
                              stackId="revenue"
                              fill={CHANNEL_COLORS[channel] ?? '#ec4899'}
                              radius={[2, 2, 0, 0]}
                            />
                          ))}
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>

                <div>
                  <p className="text-slate-500 text-sm mb-3">
                    One row per {unit} and channel. A {unit} with no receipts has no row —
                    an absent row means no activity, not a zero.
                  </p>
                  <DataTable<KeyedRevenueRow>
                    rows={revenueRows}
                    columns={revenueColumns}
                    rowKey={(r) => r._key}
                    searchPlaceholder={`Search ${unit}s or channels…`}
                    searchKeys={['period_label', 'channel']}
                    onExport={() => exportCsv('revenue', '/revenue', `revenue-${groupBy}`)}
                    exportName={`revenue-${unit}`}
                    pageSize={50}
                    emptyTitle="No data for this period"
                  />
                </div>

                {otherWarnings(revenue).map((w, i) => (
                  <Warning key={i}>{w}</Warning>
                ))}
              </>
            )}
          </section>

          {/* ── Channel split ─────────────────────────────────────────────── */}
          <section className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold text-white">Reseller versus direct</h2>
                <p className="text-slate-500 text-sm mt-0.5 max-w-2xl">
                  Different margin, different growth, different risk — so they are
                  reported separately and never added into one number. Margin here is
                  receipts less the payouts the card attributed to that channel; payouts
                  attributed to no channel are held out rather than spread across both.
                </p>
              </div>
              <button
                onClick={() => exportCsv('channels', '/channels', 'channels')}
                disabled={busy === 'channels'}
                className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300 rounded-lg px-3.5 py-2 text-sm transition-colors shrink-0"
              >
                {busy === 'channels' ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Download size={14} />
                )}
                Export channels
              </button>
            </div>

            {!channels ? (
              <ErrorState message="The channel report did not come back." onRetry={load} />
            ) : channels.empty ? (
              <Empty
                title="No data for this period"
                hint={
                  channels.warnings[0] ??
                  'No receipts on either channel between these dates.'
                }
              />
            ) : (
              <>
                <DataTable<ChannelRow>
                  rows={channels.rows}
                  columns={channelColumns}
                  rowKey={(r) => r.channel}
                  searchPlaceholder="Search channels…"
                  searchKeys={['channel']}
                  onExport={() => exportCsv('channels', '/channels', 'channels')}
                  exportName="channels"
                  emptyTitle="No data for this period"
                />
                <p className="text-slate-600 text-xs">
                  {formatInrMinorShort(channels.totals.unattributed_payouts_inr_minor)} of
                  payouts could not be attributed to a channel and is excluded from both
                  rows above.
                </p>
                {otherWarnings(channels).map((w, i) => (
                  <Warning key={i}>{w}</Warning>
                ))}
              </>
            )}
          </section>

          {rates && (
            <p className="text-slate-600 text-xs">
              {rates} Period {margin.period.bounds}.
            </p>
          )}
        </>
      )}
    </div>
  )
}

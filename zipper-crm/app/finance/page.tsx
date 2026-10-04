'use client'

/**
 * Finance — the hub Finance actually opens in the morning.
 *
 * It answers four questions that were previously unanswerable on any screen:
 *
 *   How much money came in this week?  → /reports/cash-position, date-ranged.
 *   What do we owe right now?          → /reports/liabilities, point in time.
 *   What is waiting on us?             → /cards/inbox, linking to the board.
 *   What is overdue or stuck?          → overdue sellers, and payout cards that
 *                                        were signed and never executed.
 *
 * Nothing on this page is computed in the browser. Revenue, payout, commission
 * and margin have exactly one definition each, published by the API at
 * `/reports/definitions`, and every figure here is a field that came back from
 * a report — so this screen cannot drift away from the CSV or from the other
 * Finance screens.
 *
 * The envelope flags are load-bearing. `empty: true` is rendered as "no data
 * for this period", never as ₹0, because a confident zero is worse than an
 * error: nobody double-checks a zero. `provisional: true` means a rate was
 * missing and a documented fallback was used, and it is said above the number
 * rather than hidden under it.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, ArrowDownLeft, ArrowUpRight, BookOpen, ChevronRight, Clock,
  Download, Loader2, PenLine, Scale, TrendingUp, Users, Wallet,
  type LucideIcon,
} from 'lucide-react'

import { useAuth } from '@/components/AuthProvider'
import { canAccess, CrmRole } from '@/lib/auth'
import api, { ApiError, type Card, type Inbox } from '@/lib/api'
import { Column, DataTable } from '@/components/ui/DataTable'
import { DateRangePicker, Range, defaultRange, toParams } from '@/components/ui/DateRange'
import { Denied, Empty, ErrorState, Loading, Warning } from '@/components/ui/States'
import {
  CashPositionReport, CashPositionRow, DefinitionsResponse, LiabilityReport,
  LiabilityRow,
  downloadReportCsv, formatCount, formatDateTime, formatInrMinor,
  formatInrMinorShort, formatNativeAmount, otherWarnings, provisionalNote,
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

/**
 * The card types the API counts as a payout — copied from the reports service,
 * not guessed. A card of one of these types sitting in `approved` is money that
 * an owner signed for and that never left.
 */
const PAYOUT_CARD_TYPES = [
  'commission_payout',
  'subagency_payout',
  'host_withdrawal',
  'weekly_payout',
  'salary_request',
]

interface OverdueSeller {
  id: string
  name: string
  outstanding: number
  days_overdue: number
}

function ageDays(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 86_400_000
}

function Figure({
  label, value, sub, tone = 'text-white', icon: Icon,
}: {
  label: string
  value: string
  sub?: string
  tone?: string
  icon: LucideIcon
}) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 sm:p-5">
      <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide mb-2">
        <Icon size={13} />
        {label}
      </div>
      <p className={`text-xl sm:text-2xl font-bold tabular-nums ${tone}`}>{value}</p>
      {sub && <p className="text-slate-500 text-xs mt-1.5 leading-relaxed">{sub}</p>}
    </div>
  )
}

export default function FinanceHubPage() {
  const { crmUser, apiUser, loading: authLoading, apiReady, apiError } = useAuth()
  // The Observer has no Firestore `crmUser` on purpose, so `canAccess` alone
  // locks the one role that exists to watch the money out of the money. The API
  // grants them `can_read_all`; they are admitted here and the API decides the
  // rest. Same pattern as app/reports/page.tsx.
  const isObserver = apiUser?.role === 'observer'
  const allowed = isObserver || canAccess(crmUser, FINANCE_ROLES)

  const [range, setRange] = useState<Range>(defaultRange)

  const [cash, setCash] = useState<CashPositionReport | null>(null)
  const [liabilities, setLiabilities] = useState<LiabilityReport | null>(null)
  const [defs, setDefs] = useState<DefinitionsResponse | null>(null)
  const [inbox, setInbox] = useState<Inbox | null>(null)
  const [stuck, setStuck] = useState<Card[]>([])
  const [overdue, setOverdue] = useState<OverdueSeller[]>([])

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  /** Non-fatal: the cash position still renders if the queue call failed. */
  const [sideError, setSideError] = useState('')
  const [busy, setBusy] = useState('')
  const [exportError, setExportError] = useState('')

  const load = useCallback(() => {
    if (!allowed || !apiReady) return
    setLoading(true)
    setError('')
    setSideError('')
    const params = toParams(range)

    Promise.all([
      reports.cashPosition(params),
      reports.liabilities(),
      reports.definitions(),
    ])
      .then(([c, l, d]) => {
        setCash(c)
        setLiabilities(l)
        setDefs(d)
      })
      .catch((err: unknown) => {
        setError(
          err instanceof ApiError
            ? err.message
            : 'The cash position could not be produced.',
        )
      })
      .finally(() => setLoading(false))

    // The queue and the overdue lists are secondary — a failure here must not
    // blank the money figures, and must not look like an empty queue either.
    Promise.all([
      api.cards.inbox(),
      api.cards.list('approved', 200),
      api.partners.overdueSellers(),
    ])
      .then(([i, approved, od]) => {
        setInbox(i)
        setStuck(approved.filter((c) => PAYOUT_CARD_TYPES.includes(c.type)))
        setOverdue(od)
      })
      .catch((err: unknown) => {
        setInbox(null)
        setStuck([])
        setOverdue([])
        setSideError(
          err instanceof ApiError
            ? `The queue and overdue lists could not be loaded: ${err.message}`
            : 'The queue and overdue lists could not be loaded. Treat them as unknown, not as empty.',
        )
      })
  }, [allowed, apiReady, range])

  useEffect(() => { load() }, [load])

  async function exportCsv(key: string, path: string, name: string) {
    setBusy(key)
    setExportError('')
    try {
      await downloadReportCsv(
        path,
        path === '/liabilities' ? {} : toParams(range),
        name,
      )
    } catch (err) {
      setExportError(
        err instanceof ApiError ? err.message : 'The export failed and no file was produced.',
      )
    } finally {
      setBusy('')
    }
  }

  if (authLoading) return <Loading label="Checking your access…" />
  if (!allowed) return <Denied what="Finance" />

  const receipts = (cash?.rows ?? []).filter((r) => r.line === 'receipt')
  const paymentsOut = (cash?.rows ?? []).filter((r) => r.line === 'payment_out')
  const provisional = cash ? provisionalNote(cash) : null
  const notes = cash ? otherWarnings(cash) : []
  const rates = cash ? rateSummary(cash) : null
  const definitions = defs?.definitions ?? cash?.definitions ?? {}

  const stuckTotalByCurrency = stuck.reduce<Record<string, number>>((acc, c) => {
    acc[c.currency] = (acc[c.currency] ?? 0) + Math.abs(c.amount)
    return acc
  }, {})

  const receiptColumns: Column<CashPositionRow>[] = [
    {
      key: 'channel',
      header: 'Channel',
      render: (r) => <span className="text-white font-medium">{r.channel}</span>,
    },
    {
      key: 'movements',
      header: 'Receipts',
      align: 'right',
      hideOnMobile: true,
      render: (r) => <span className="tabular-nums">{formatCount(r.movements)}</span>,
    },
    {
      key: 'detail',
      header: 'Valued at',
      sortable: false,
      hideOnMobile: true,
      render: (r) => <span className="text-slate-500 text-xs">{r.detail}</span>,
    },
    {
      key: 'inr_minor',
      header: 'Amount (INR)',
      align: 'right',
      value: (r) => r.inr_minor,
      render: (r) => (
        <span className="text-emerald-300 font-medium tabular-nums">
          {formatInrMinor(r.inr_minor)}
        </span>
      ),
    },
  ]

  const paymentColumns: Column<CashPositionRow>[] = [
    {
      key: 'channel',
      header: 'Card type',
      render: (r) => (
        <span className="text-white font-medium">{r.channel.replace(/_/g, ' ')}</span>
      ),
    },
    {
      key: 'movements',
      header: 'Cards',
      align: 'right',
      hideOnMobile: true,
      render: (r) => <span className="tabular-nums">{formatCount(r.movements)}</span>,
    },
    {
      key: 'detail',
      header: 'Detail',
      sortable: false,
      hideOnMobile: true,
      render: (r) => <span className="text-slate-500 text-xs">{r.detail}</span>,
    },
    {
      key: 'inr_minor',
      header: 'Amount (INR)',
      align: 'right',
      value: (r) => r.inr_minor,
      render: (r) => (
        <span className="text-orange-300 font-medium tabular-nums">
          {formatInrMinor(r.inr_minor)}
        </span>
      ),
    },
  ]

  const liabilityColumns: Column<LiabilityRow>[] = [
    {
      key: 'liability',
      header: 'Liability',
      render: (r) => (
        <div>
          <p className="text-white font-medium">{r.liability.replace(/_/g, ' ')}</p>
          <p className="text-slate-500 text-xs mt-0.5">{r.description}</p>
        </div>
      ),
    },
    {
      key: 'holders',
      header: 'Holders',
      align: 'right',
      hideOnMobile: true,
      render: (r) => <span className="tabular-nums">{formatCount(r.holders)}</span>,
    },
    {
      key: 'native_amount',
      header: 'Native amount',
      align: 'right',
      hideOnMobile: true,
      value: (r) => r.native_amount,
      render: (r) => (
        <span className="text-slate-300 tabular-nums">
          {formatNativeAmount(r.native_amount, r.native_currency)}
        </span>
      ),
    },
    {
      key: 'inr_minor',
      header: 'Value (INR)',
      align: 'right',
      value: (r) => r.inr_minor,
      render: (r) => (
        <span
          className={`font-semibold tabular-nums ${
            r.counts_as_liability ? 'text-orange-300' : 'text-sky-300'
          }`}
        >
          {formatInrMinor(r.inr_minor)}
        </span>
      ),
    },
    {
      key: 'counts_as_liability',
      header: 'Counts as owed',
      align: 'right',
      hideOnMobile: true,
      value: (r) => (r.counts_as_liability ? 1 : 0),
      render: (r) =>
        r.counts_as_liability ? (
          <span className="text-orange-300 text-xs">owed out</span>
        ) : (
          <span className="text-sky-300 text-xs">receivable</span>
        ),
    },
  ]

  const overdueColumns: Column<OverdueSeller>[] = [
    {
      key: 'name',
      header: 'Seller',
      render: (r) => (
        <Link
          href={`/sellers?id=${encodeURIComponent(r.id)}`}
          className="text-white font-medium hover:text-pink-400 transition-colors"
        >
          {r.name || r.id}
        </Link>
      ),
    },
    {
      key: 'outstanding',
      header: 'Outstanding (coins)',
      align: 'right',
      value: (r) => r.outstanding,
      render: (r) => (
        <span className="text-orange-300 tabular-nums">
          {formatCount(r.outstanding)} coins
        </span>
      ),
    },
    {
      key: 'days_overdue',
      header: 'Days overdue',
      align: 'right',
      value: (r) => r.days_overdue,
      render: (r) => (
        <span className="text-red-300 font-semibold tabular-nums">
          {formatCount(r.days_overdue)}
        </span>
      ),
    },
  ]

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white">Finance</h1>
          <p className="text-slate-400 mt-1 text-sm max-w-2xl leading-relaxed">
            Cash in and cash out for{' '}
            <span className="text-slate-200">{range.label.toLowerCase()}</span>, what is
            owed right now, and everything waiting on a person. Amounts are in Indian
            rupees (₹) — the API reports paise and they are converted once, here.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <DateRangePicker value={range} onChange={setRange} />
          <Link
            href="/reports"
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3.5 py-2.5 text-sm transition-colors whitespace-nowrap"
          >
            All reports <ChevronRight size={14} />
          </Link>
        </div>
      </div>

      {apiReady && apiError && <Warning>{apiError}</Warning>}
      {exportError && <Warning onDismiss={() => setExportError('')}>{exportError}</Warning>}
      {sideError && <Warning onDismiss={() => setSideError('')}>{sideError}</Warning>}

      {!apiReady && apiError ? (
        <ErrorState message={apiError} />
      ) : loading || !apiReady ? (
        <Loading label="Producing the cash position…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !cash ? (
        <ErrorState message="No cash position report came back." onRetry={load} />
      ) : (
        <>
          {provisional && (
            <Warning>
              <span className="font-semibold">These figures are provisional.</span>{' '}
              {provisional}{' '}
              {cash.rates.missing?.length
                ? `Missing rate${cash.rates.missing.length > 1 ? 's' : ''}: ${cash.rates.missing.join(', ')}.`
                : ''}{' '}
              Fix the rate in the economy config before quoting any of this.
            </Warning>
          )}

          {/* ── Cash position ─────────────────────────────────────────────── */}
          <section className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold text-white">Cash position</h2>
                <p className="text-slate-500 text-sm mt-0.5 max-w-2xl">
                  Money actually received, with payment evidence on the movement — not
                  imputed diamond consumption. Payments out are executed payout cards
                  only; signed and not yet executed is not a payment.
                </p>
              </div>
              <button
                onClick={() => exportCsv('cash', '/cash-position', 'cash-position')}
                disabled={busy === 'cash'}
                className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300 rounded-lg px-3.5 py-2 text-sm transition-colors shrink-0"
              >
                {busy === 'cash' ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Download size={14} />
                )}
                Export cash position
              </button>
            </div>

            {cash.empty ? (
              <Empty
                title="No data for this period"
                hint={
                  cash.warnings[0] ??
                  'No receipt and no executed payout falls between these dates. There is nothing to report, which is not the same as a result of zero.'
                }
              />
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
                  <Figure
                    icon={ArrowDownLeft}
                    label="Receipts (INR)"
                    value={formatInrMinorShort(cash.totals.receipts_inr_minor)}
                    tone="text-emerald-300"
                    sub={`Across ${formatCount(
                      Object.keys(cash.totals.receipts_by_channel).length,
                    )} channel(s). This is the answer to “how much came in”.`}
                  />
                  <Figure
                    icon={ArrowUpRight}
                    label="Payments out (INR)"
                    value={formatInrMinorShort(cash.totals.payments_out_inr_minor)}
                    tone="text-orange-300"
                    sub="Executed payout cards only — money that has actually left."
                  />
                  <Figure
                    icon={Wallet}
                    label="Net (INR)"
                    value={formatInrMinorShort(cash.totals.net_inr_minor)}
                    tone={cash.totals.net_inr_minor < 0 ? 'text-red-300' : 'text-white'}
                    sub="Receipts − payments out, over the selected range."
                  />
                  <Figure
                    icon={AlertTriangle}
                    label="Non-cash credits"
                    value={formatCount(cash.totals.non_cash_credits_excluded.movements)}
                    tone="text-slate-300"
                    sub="Promotions, corrections and winnings — credited but never received as cash, so excluded from revenue."
                  />
                </div>

                {notes.length > 0 && (
                  <div className="space-y-2">
                    {notes.map((w, i) => (
                      <Warning key={i}>{w}</Warning>
                    ))}
                  </div>
                )}

                <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                  <div>
                    <h3 className="text-white text-sm font-semibold mb-2">
                      Receipts by channel
                    </h3>
                    <DataTable<CashPositionRow>
                      rows={receipts}
                      columns={receiptColumns}
                      rowKey={(r) => `${r.line}-${r.channel}`}
                      searchPlaceholder="Search channels…"
                      searchKeys={['channel', 'detail']}
                      onExport={() => exportCsv('cash', '/cash-position', 'cash-position')}
                      exportName="receipts"
                      emptyTitle="No receipts in this period"
                      emptyHint="No movement between these dates carried cash evidence."
                    />
                  </div>

                  <div>
                    <h3 className="text-white text-sm font-semibold mb-2">
                      Payments out by card type
                    </h3>
                    <DataTable<CashPositionRow>
                      rows={paymentsOut}
                      columns={paymentColumns}
                      rowKey={(r) => `${r.line}-${r.channel}`}
                      searchPlaceholder="Search card types…"
                      searchKeys={['channel', 'detail']}
                      onExport={() => exportCsv('cash', '/cash-position', 'cash-position')}
                      exportName="payments-out"
                      emptyTitle="No payout executed in this period"
                      emptyHint="Nothing left the business between these dates. Anything signed but unexecuted is listed further down, not here."
                    />
                  </div>
                </div>
              </>
            )}
          </section>

          {/* ── Outstanding liabilities ───────────────────────────────────── */}
          <section className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold text-white">
                  Outstanding liabilities
                </h2>
                <p className="text-slate-500 text-sm mt-0.5 max-w-2xl">
                  What is owed to agencies and hosts right now. A point-in-time figure —
                  it ignores the date range above, because a debt is not a period.
                </p>
              </div>
              <button
                onClick={() => exportCsv('liabilities', '/liabilities', 'liabilities')}
                disabled={busy === 'liabilities'}
                className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300 rounded-lg px-3.5 py-2 text-sm transition-colors shrink-0"
              >
                {busy === 'liabilities' ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Download size={14} />
                )}
                Export liabilities
              </button>
            </div>

            {!liabilities ? (
              <ErrorState
                message="The liabilities report did not come back."
                onRetry={load}
              />
            ) : liabilities.empty ? (
              <Empty
                title="No data"
                hint={
                  liabilities.warnings[0] ??
                  'No positive agency, host or seller balance exists. If that is unexpected, treat it as a data problem rather than as nothing being owed.'
                }
              />
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
                  <Figure
                    icon={Scale}
                    label="Total owed (INR)"
                    value={formatInrMinorShort(liabilities.totals.total_owed_inr_minor)}
                    tone="text-orange-300"
                    sub="Agency commission and host beans not yet paid."
                  />
                  <Figure
                    icon={TrendingUp}
                    label="Seller receivable (INR)"
                    value={formatInrMinorShort(
                      liabilities.totals.seller_credit_receivable_minor,
                    )}
                    tone="text-sky-300"
                    sub="Owed TO the business by sellers on credit. Not a liability."
                  />
                  <Figure
                    icon={Wallet}
                    label="Net position (INR)"
                    value={formatInrMinorShort(liabilities.totals.net_position_inr_minor)}
                    tone={
                      liabilities.totals.net_position_inr_minor < 0
                        ? 'text-red-300'
                        : 'text-white'
                    }
                    sub="Receivable − owed. Negative means we owe more than we are owed."
                  />
                  <Figure
                    icon={Clock}
                    label="Sellers overdue"
                    value={formatCount(liabilities.totals.sellers_overdue)}
                    tone={
                      liabilities.totals.sellers_overdue > 0
                        ? 'text-red-300'
                        : 'text-slate-300'
                    }
                    sub="Past their credit due date."
                  />
                </div>

                <DataTable<LiabilityRow>
                  rows={liabilities.rows}
                  columns={liabilityColumns}
                  rowKey={(r) => r.liability}
                  searchPlaceholder="Search liabilities…"
                  searchKeys={['liability', 'description']}
                  onExport={() => exportCsv('liabilities', '/liabilities', 'liabilities')}
                  exportName="liabilities"
                  emptyTitle="Nothing outstanding"
                />

                {otherWarnings(liabilities).map((w, i) => (
                  <Warning key={i}>{w}</Warning>
                ))}
              </>
            )}
          </section>

          {/* ── Queue ─────────────────────────────────────────────────────── */}
          <section className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold text-white">Waiting on someone</h2>
              <p className="text-slate-500 text-sm mt-0.5 max-w-2xl">
                Teams verify, owners sign, and nothing moves without both. These are the
                cards standing between a request and money leaving.
              </p>
            </div>

            {!inbox ? (
              <div className="bg-slate-900 border border-slate-800 rounded-xl px-5 py-4">
                <p className="text-slate-300 text-sm">
                  The queue could not be read, so its depth is unknown.
                </p>
                <p className="text-slate-500 text-xs mt-1">
                  This is deliberately not shown as zero — an unread queue and an empty
                  queue are not the same thing.{' '}
                  <button
                    onClick={load}
                    className="text-pink-400 hover:text-pink-300 underline underline-offset-2"
                  >
                    Try again
                  </button>
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
                <Link href="/board" className="block">
                  <Figure
                    icon={Users}
                    label="Awaiting verification"
                    value={formatCount(inbox.to_verify)}
                    tone={inbox.to_verify > 0 ? 'text-blue-300' : 'text-slate-300'}
                    sub="Raised, not yet checked by a team. Open the board."
                  />
                </Link>
                <Link href="/board" className="block">
                  <Figure
                    icon={PenLine}
                    label="Awaiting signature"
                    value={formatCount(inbox.to_sign)}
                    tone={inbox.to_sign > 0 ? 'text-amber-300' : 'text-slate-300'}
                    sub="Verified, waiting on an owner. Open the board."
                  />
                </Link>
                <Link href="/board" className="block">
                  <Figure
                    icon={Clock}
                    label="Raised by you, pending"
                    value={formatCount(inbox.mine_pending)}
                    tone="text-slate-300"
                    sub="Your own requests still moving through the board."
                  />
                </Link>
                <Link href="/board" className="block">
                  <Figure
                    icon={Wallet}
                    label="Open cards, all stages"
                    value={formatCount(inbox.total)}
                    tone="text-slate-300"
                    sub="Everything not yet executed or rejected."
                  />
                </Link>
              </div>
            )}
          </section>

          {/* ── Overdue and stuck ─────────────────────────────────────────── */}
          <section className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold text-white">Overdue</h2>
              <p className="text-slate-500 text-sm mt-0.5 max-w-2xl">
                Money that should have moved and has not — in either direction.
              </p>
            </div>

            {stuck.length > 0 && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-5">
                <div className="flex items-start gap-3">
                  <AlertTriangle size={18} className="text-amber-400 mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-amber-100 font-semibold">
                      {stuck.length} payout{stuck.length > 1 ? 's were' : ' was'} signed
                      and never executed
                    </p>
                    <p className="text-amber-100/80 text-sm mt-1 leading-relaxed">
                      An owner approved this money and it has not left. It is excluded
                      from the payment-out figure above on purpose — money that has not
                      moved is not a payout — which is exactly why it needs saying here.
                    </p>
                    <div className="flex flex-wrap gap-x-5 gap-y-1 mt-3">
                      {Object.entries(stuckTotalByCurrency).map(([currency, amount]) => (
                        <span key={currency} className="text-amber-200 text-sm tabular-nums">
                          {formatNativeAmount(amount, currency)}
                        </span>
                      ))}
                    </div>
                    <div className="mt-3 space-y-1.5 max-h-56 overflow-y-auto">
                      {stuck
                        .slice()
                        .sort(
                          (a, b) =>
                            new Date(a.signed_at ?? a.created_at).getTime() -
                            new Date(b.signed_at ?? b.created_at).getTime(),
                        )
                        .map((c) => (
                          <div
                            key={c.id}
                            className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs"
                          >
                            <span className="text-amber-100">{c.title}</span>
                            <span className="text-amber-200/70">
                              {formatNativeAmount(Math.abs(c.amount), c.currency)} ·{' '}
                              signed {formatDateTime(c.signed_at)} ·{' '}
                              {ageDays(c.signed_at ?? c.created_at).toFixed(1)} days ago
                            </span>
                          </div>
                        ))}
                    </div>
                    <Link
                      href="/board"
                      className="inline-flex items-center gap-1 text-amber-200 hover:text-white text-xs mt-3 underline underline-offset-2"
                    >
                      Open the board <ChevronRight size={12} />
                    </Link>
                  </div>
                </div>
              </div>
            )}

            <div>
              <h3 className="text-white text-sm font-semibold mb-2">
                Sellers past their credit due date
              </h3>
              <DataTable<OverdueSeller>
                rows={overdue}
                columns={overdueColumns}
                rowKey={(r) => r.id}
                searchPlaceholder="Search sellers…"
                searchKeys={['name', 'id']}
                exportName="overdue-sellers"
                emptyTitle="No seller is overdue"
                emptyHint="Every seller on credit is within their terms — or the list could not be read, in which case the banner above says so."
              />
            </div>
          </section>

          {/* ── Where to go next ──────────────────────────────────────────── */}
          <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {[
              {
                href: '/finance/profit',
                icon: TrendingUp,
                title: 'Profitability',
                blurb: 'Margin, the bean-payout ratio, revenue by day/week/month and the channel split.',
              },
              {
                href: '/finance/reports',
                icon: Users,
                title: 'Weekly payout runs',
                blurb: 'One row per agency for a chosen week, with per-host detail and an export.',
              },
              {
                href: '/finance/payouts',
                icon: Wallet,
                title: 'Payout approvals',
                blurb: 'Agency payout reports awaiting approval, and anything approved that has not moved.',
              },
              {
                href: '/finance/withdrawals',
                icon: ArrowUpRight,
                title: 'Host withdrawals',
                blurb: 'Approve, pay and record proof. Approved-but-unpaid is surfaced first.',
              },
            ].map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="bg-slate-900 border border-slate-800 hover:border-pink-500/50 rounded-xl p-5 transition-colors group flex items-start justify-between gap-4"
              >
                <div className="flex items-start gap-3">
                  <link.icon size={18} className="text-slate-600 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-white font-semibold">{link.title}</p>
                    <p className="text-slate-500 text-sm mt-1">{link.blurb}</p>
                  </div>
                </div>
                <ChevronRight
                  size={18}
                  className="text-slate-700 group-hover:text-pink-400 transition-colors shrink-0"
                />
              </Link>
            ))}
          </section>

          {/* Rates and definitions */}
          {rates && (
            <p className="text-slate-600 text-xs">
              {rates} Period {cash.period.bounds}.
            </p>
          )}

          {Object.keys(definitions).length > 0 && (
            <details className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
              <summary className="cursor-pointer px-5 py-4 text-sm text-slate-300 hover:text-white flex items-center gap-2 select-none">
                <BookOpen size={15} className="text-slate-600" />
                What each figure means
                <span className="text-slate-600 text-xs ml-1">
                  — one definition, published by the API
                </span>
              </summary>
              <div className="border-t border-slate-800 px-5 py-4 space-y-4">
                {Object.entries(definitions).map(([key, text]) => (
                  <div key={key}>
                    <p className="text-slate-200 text-sm font-medium capitalize">
                      {key.replace(/_/g, ' ')}
                    </p>
                    <p className="text-slate-500 text-sm mt-1 leading-relaxed">{text}</p>
                  </div>
                ))}
                <p className="text-slate-600 text-xs pt-2 border-t border-slate-800">
                  Every one of these is also on the{' '}
                  <Link href="/reports" className="text-pink-400 hover:text-pink-300">
                    reporting hub
                  </Link>
                  , where each report can be downloaded as CSV.
                </p>
              </div>
            </details>
          )}
        </>
      )}
    </div>
  )
}

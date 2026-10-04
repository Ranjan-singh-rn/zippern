'use client'

/**
 * Cash position — how much money actually came in, and what went out.
 *
 * This is the question nothing in the CRM could answer: pick a week, get the
 * receipts. It comes from `/reports/cash-position`, which reads the ledger and
 * the executed cards.
 *
 * The distinction this screen exists to protect: **cash received is not
 * diamond-consumption revenue.** A receipt is money that arrived and carries
 * payment evidence. Diamond consumption is an imputed value — what users spent
 * in-app, valued at a rate. They are different numbers, they move differently,
 * and quoting one while meaning the other is how a business talks itself into
 * a shortfall.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  ArrowDownLeft, ArrowLeft, ArrowUpRight, Download, Info, Wallet,
} from 'lucide-react'

import { useAuth } from '@/components/AuthProvider'
import { canAccess, CrmRole } from '@/lib/auth'
import { ApiError } from '@/lib/api'
import { Column, DataTable } from '@/components/ui/DataTable'
import { DateRangePicker, Range, defaultRange, toParams } from '@/components/ui/DateRange'
import { Denied, Empty, ErrorState, Loading, Warning } from '@/components/ui/States'
import {
  CashPositionReport, CashPositionRow,
  formatCount, formatInrMinor, formatInrMinorShort,
  otherWarnings, provisionalNote, rateSummary, reports,
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

const CHANNEL_LABELS: Record<string, string> = {
  reseller: 'Reseller',
  direct: 'Direct',
  unattributed: 'Unattributed',
}

type KeyedRow = CashPositionRow & { _key: string }

export default function CashPositionPage() {
  const { crmUser, apiUser, loading: authLoading, apiReady, apiError } = useAuth()
  // The Observer has no Firestore `crmUser` on purpose, so `canAccess` alone
  // locks the one role that exists to watch the money out of the money. The API
  // grants them `can_read_all`; they are admitted here and the API decides the
  // rest. Same pattern as app/reports/page.tsx.
  const isObserver = apiUser?.role === 'observer'
  const allowed = isObserver || canAccess(crmUser, FINANCE_ROLES)

  const [range, setRange] = useState<Range>(defaultRange)
  const [report, setReport] = useState<CashPositionReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [exportError, setExportError] = useState('')

  const load = useCallback(() => {
    if (!allowed || !apiReady) return
    setLoading(true)
    setError('')
    reports
      .cashPosition(toParams(range))
      .then(setReport)
      .catch((err: unknown) => {
        setError(
          err instanceof ApiError
            ? err.message
            : 'The cash position could not be produced.',
        )
      })
      .finally(() => setLoading(false))
  }, [allowed, apiReady, range])

  useEffect(() => { load() }, [load])

  async function exportCsv() {
    setExportError('')
    try {
      await reports.csv.cashPosition(toParams(range))
    } catch (err) {
      setExportError(err instanceof ApiError ? err.message : 'The export failed.')
    }
  }

  const receipts = useMemo<KeyedRow[]>(
    () =>
      (report?.rows ?? [])
        .filter((r) => r.line === 'receipt')
        .map((r, i) => ({ ...r, _key: `receipt-${r.channel}-${i}` })),
    [report],
  )

  const payments = useMemo<KeyedRow[]>(
    () =>
      (report?.rows ?? [])
        .filter((r) => r.line === 'payment_out')
        .map((r, i) => ({ ...r, _key: `out-${r.channel}-${i}` })),
    [report],
  )

  if (authLoading) return <Loading label="Checking your access…" />
  if (!allowed) return <Denied what="Finance reporting" />

  const t = report?.totals
  const provisional = report ? provisionalNote(report) : null
  const rates = report ? rateSummary(report) : null
  const notes = report ? otherWarnings(report) : []
  const nonCash = t?.non_cash_credits_excluded

  const receiptColumns: Column<KeyedRow>[] = [
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
      key: 'movements',
      header: 'Receipts',
      align: 'right',
      render: (r) => <span className="tabular-nums">{formatCount(r.movements)}</span>,
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
    {
      key: 'detail',
      header: 'Rate applied',
      hideOnMobile: true,
      render: (r) => <span className="text-slate-500 text-xs">{r.detail || '—'}</span>,
    },
  ]

  const paymentColumns: Column<KeyedRow>[] = [
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
      render: (r) => <span className="tabular-nums">{formatCount(r.movements)}</span>,
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
    {
      key: 'detail',
      header: 'Native amount and rate',
      hideOnMobile: true,
      render: (r) => <span className="text-slate-500 text-xs">{r.detail || '—'}</span>,
    },
  ]

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <Link
            href="/finance"
            className="inline-flex items-center gap-1.5 text-slate-500 hover:text-slate-300 text-sm mb-2 transition-colors"
          >
            <ArrowLeft size={14} /> Finance
          </Link>
          <h1 className="text-2xl sm:text-3xl font-bold text-white">
            How much money came in {range.label.toLowerCase()}
          </h1>
          <p className="text-slate-400 mt-1 text-sm max-w-2xl">
            Receipts by channel, payments out, and the net. All amounts in Indian
            rupees (₹).
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <DateRangePicker value={range} onChange={setRange} />
          <button
            onClick={exportCsv}
            title="Download this exact report as CSV from the API"
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3.5 py-2.5 text-sm transition-colors"
          >
            <Download size={14} /> Export
          </button>
        </div>
      </div>

      {apiReady && apiError && <Warning>{apiError}</Warning>}
      {exportError && (
        <Warning onDismiss={() => setExportError('')}>{exportError}</Warning>
      )}

      {!apiReady && apiError ? (
        <ErrorState message={apiError} />
      ) : loading || !apiReady ? (
        <Loading label="Reading the ledger…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !report ? (
        <ErrorState message="No cash position report came back." onRetry={load} />
      ) : (
        <>
          {provisional && (
            <Warning>
              <span className="font-semibold">These figures are provisional.</span>{' '}
              {provisional} Recorded cash amounts are unaffected; anything converted
              from beans or diamonds is an estimate.
            </Warning>
          )}

          {/* What this number is, and what it is not */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 sm:p-5 flex items-start gap-3">
            <Info size={16} className="text-sky-400 mt-0.5 shrink-0" />
            <div className="text-sm text-slate-400 leading-relaxed">
              <p className="text-slate-200 font-medium">
                This is actual cash from the ledger — not diamond-consumption revenue.
              </p>
              <p className="mt-1.5">
                A receipt counted here is a positive movement that carries payment
                evidence: a recorded cash amount, a gateway reference, a UTR or a
                payment reference. Diamond consumption is a different figure entirely —
                an imputed value of what users spent in-app, at whatever rate was in
                force. The two are not interchangeable and must never be quoted as one
                another. Diamond value consumed appears on the{' '}
                <Link href="/finance" className="text-pink-400 hover:text-pink-300 underline underline-offset-2">
                  Finance hub
                </Link>{' '}
                as part of the bean-payout ratio.
              </p>
            </div>
          </div>

          {report.empty ? (
            <Empty
              title="No activity in this period"
              hint={
                report.warnings[0] ??
                'No receipt and no executed payout falls between these dates. There is nothing to report — this is not a measured zero.'
              }
            />
          ) : (
            <>
              {/* The three numbers */}
              <section className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                  <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide mb-2">
                    <ArrowDownLeft size={13} className="text-emerald-400" /> Money in (INR)
                  </div>
                  <p className="text-2xl sm:text-3xl font-bold text-emerald-300 tabular-nums">
                    {formatInrMinorShort(t?.receipts_inr_minor)}
                  </p>
                  <p className="text-slate-500 text-xs mt-1.5">
                    Cash received across {formatCount(receipts.length)} channel
                    {receipts.length === 1 ? '' : 's'}.
                  </p>
                </div>

                <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                  <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide mb-2">
                    <ArrowUpRight size={13} className="text-orange-400" /> Money out (INR)
                  </div>
                  <p className="text-2xl sm:text-3xl font-bold text-orange-300 tabular-nums">
                    {formatInrMinorShort(t?.payments_out_inr_minor)}
                  </p>
                  <p className="text-slate-500 text-xs mt-1.5">
                    Executed payout cards only — signed but unexecuted has not left.
                  </p>
                </div>

                <div
                  className={`rounded-xl p-5 border ${
                    (t?.net_inr_minor ?? 0) < 0
                      ? 'bg-red-500/10 border-red-500/30'
                      : 'bg-emerald-500/10 border-emerald-500/30'
                  }`}
                >
                  <div className="flex items-center gap-2 text-slate-400 text-xs uppercase tracking-wide mb-2">
                    <Wallet size={13} /> Net cash (INR)
                  </div>
                  <p
                    className={`text-2xl sm:text-3xl font-bold tabular-nums ${
                      (t?.net_inr_minor ?? 0) < 0 ? 'text-red-300' : 'text-emerald-200'
                    }`}
                  >
                    {formatInrMinorShort(t?.net_inr_minor)}
                  </p>
                  <p className="text-slate-400 text-xs mt-1.5">
                    Receipts less payments out.{' '}
                    {(t?.net_inr_minor ?? 0) < 0
                      ? 'More left than arrived in this period.'
                      : 'More arrived than left in this period.'}
                  </p>
                </div>
              </section>

              {notes.length > 0 && (
                <div className="space-y-2">
                  {notes.map((w, i) => (
                    <Warning key={i}>{w}</Warning>
                  ))}
                </div>
              )}

              {/* Receipts */}
              <section>
                <h2 className="text-lg font-semibold text-white mb-1">
                  Receipts by channel
                </h2>
                <p className="text-slate-500 text-sm mb-3">
                  Reseller and direct are counted separately. Anything the ledger could
                  not attribute sits in its own row rather than being folded into either.
                </p>
                {receipts.length === 0 ? (
                  <Empty
                    title="No receipts in this period"
                    hint="No positive movement with payment evidence falls between these dates."
                  />
                ) : (
                  <DataTable<KeyedRow>
                    rows={receipts}
                    columns={receiptColumns}
                    rowKey={(r) => r._key}
                    searchPlaceholder="Search channels…"
                    searchKeys={['channel', 'detail']}
                    onExport={exportCsv}
                    exportName="cash-position-receipts"
                  />
                )}
              </section>

              {/* Payments out */}
              <section>
                <h2 className="text-lg font-semibold text-white mb-1">Payments out</h2>
                <p className="text-slate-500 text-sm mb-3">
                  Executed payout cards, by type — commission, sub-agency, host
                  withdrawals, weekly payouts and salary.
                </p>
                {payments.length === 0 ? (
                  <Empty
                    title="No payouts executed in this period"
                    hint="No payout card reached the executed stage between these dates."
                  />
                ) : (
                  <DataTable<KeyedRow>
                    rows={payments}
                    columns={paymentColumns}
                    rowKey={(r) => r._key}
                    searchPlaceholder="Search card types…"
                    searchKeys={['channel', 'detail']}
                    onExport={exportCsv}
                    exportName="cash-position-payments"
                  />
                )}
              </section>

              {/* Excluded credits */}
              {nonCash && nonCash.movements > 0 && (
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 text-sm">
                  <p className="text-slate-300 font-medium">
                    {formatCount(nonCash.movements)} credit
                    {nonCash.movements === 1 ? '' : 's'} excluded from receipts
                  </p>
                  <p className="text-slate-500 mt-1 leading-relaxed">
                    These carry no payment evidence — promotions, corrections and game
                    winnings. They are balance movements, not money received, so they
                    are not revenue.
                  </p>
                  <ul className="mt-2 space-y-0.5">
                    {Object.entries(nonCash.by_currency).map(([currency, v]) => (
                      <li key={currency} className="text-slate-500 text-xs tabular-nums">
                        {formatCount(v.movements)} × {currency} ({formatCount(v.amount)}{' '}
                        {currency})
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {rates && (
            <p className="text-slate-600 text-xs">
              {rates} Period {report.period.bounds}.
            </p>
          )}
        </>
      )}
    </div>
  )
}

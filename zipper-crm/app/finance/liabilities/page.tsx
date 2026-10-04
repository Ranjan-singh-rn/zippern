'use client'

/**
 * Outstanding liabilities — what is owed, right now.
 *
 * `/reports/liabilities` is a point-in-time figure, so this screen carries no
 * date range: it is a photograph of the obligations as at the moment it was
 * generated, not a period.
 *
 * The number that matters is the net position — the seller receivable less
 * everything owed to agencies and hosts. Positive means the business is owed
 * more than it owes. Negative means the obligations outrun what is coming in,
 * and the size of that gap is the thing worth knowing before the next payout
 * run.
 *
 * Note what is *not* a liability: coin stock held by sellers has already been
 * paid for, and the seller credit receivable is money owed **to** the business.
 * Both are listed, both are labelled, and neither is added to what is owed.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, ArrowLeft, Clock, Download, RefreshCw, Scale, TrendingDown, TrendingUp,
} from 'lucide-react'

import { useAuth } from '@/components/AuthProvider'
import { canAccess, CrmRole } from '@/lib/auth'
import { ApiError } from '@/lib/api'
import { Column, DataTable } from '@/components/ui/DataTable'
import { Denied, Empty, ErrorState, Loading, Warning } from '@/components/ui/States'
import {
  LiabilityReport, LiabilityRow,
  formatCount, formatDateTime, formatInrMinor, formatInrMinorShort,
  formatNativeAmount, otherWarnings, provisionalNote, rateSummary, reports,
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

const LIABILITY_LABELS: Record<string, string> = {
  agency_commission: 'Commission owed to agencies',
  host_beans: 'Beans held by hosts',
  seller_stock: 'Coin stock held by sellers',
  seller_credit_receivable: 'Seller credit receivable',
}

export default function LiabilitiesPage() {
  const { crmUser, apiUser, loading: authLoading, apiReady, apiError } = useAuth()
  // The Observer has no Firestore `crmUser` on purpose, so `canAccess` alone
  // locks the one role that exists to watch the money out of the money. The API
  // grants them `can_read_all`; they are admitted here and the API decides the
  // rest. Same pattern as app/reports/page.tsx.
  const isObserver = apiUser?.role === 'observer'
  const allowed = isObserver || canAccess(crmUser, FINANCE_ROLES)

  const [report, setReport] = useState<LiabilityReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [exportError, setExportError] = useState('')

  const load = useCallback(() => {
    if (!allowed || !apiReady) return
    setLoading(true)
    setError('')
    reports
      .liabilities()
      .then(setReport)
      .catch((err: unknown) => {
        setError(
          err instanceof ApiError
            ? err.message
            : 'The liabilities report could not be produced.',
        )
      })
      .finally(() => setLoading(false))
  }, [allowed, apiReady])

  useEffect(() => { load() }, [load])

  async function exportCsv() {
    setExportError('')
    try {
      await reports.csv.liabilities()
    } catch (err) {
      setExportError(err instanceof ApiError ? err.message : 'The export failed.')
    }
  }

  if (authLoading) return <Loading label="Checking your access…" />
  if (!allowed) return <Denied what="Finance reporting" />

  const t = report?.totals
  const net = t?.net_position_inr_minor ?? 0
  const ahead = net >= 0
  const provisional = report ? provisionalNote(report) : null
  const rates = report ? rateSummary(report) : null
  const notes = report ? otherWarnings(report) : []

  const columns: Column<LiabilityRow>[] = [
    {
      key: 'liability',
      header: 'Line',
      render: (r) => (
        <div>
          <p className="text-white font-medium">
            {LIABILITY_LABELS[r.liability] ?? r.liability.replace(/_/g, ' ')}
          </p>
          <p className="text-slate-500 text-xs mt-0.5 max-w-md">{r.description}</p>
        </div>
      ),
    },
    {
      key: 'counts_as_liability',
      header: 'Counts as owed',
      value: (r) => (r.counts_as_liability ? 'yes' : 'no'),
      render: (r) =>
        r.counts_as_liability ? (
          <span className="bg-amber-500/15 text-amber-300 rounded-full px-2 py-0.5 text-xs whitespace-nowrap">
            Owed out
          </span>
        ) : (
          <span className="bg-slate-800 text-slate-400 rounded-full px-2 py-0.5 text-xs whitespace-nowrap">
            Not a liability
          </span>
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
            r.counts_as_liability ? 'text-amber-300' : 'text-slate-300'
          }`}
        >
          {formatInrMinor(r.inr_minor)}
        </span>
      ),
    },
    {
      key: 'rate_applied',
      header: 'Rate applied',
      hideOnMobile: true,
      sortable: false,
      render: (r) => <span className="text-slate-500 text-xs">{r.rate_applied}</span>,
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
          <h1 className="text-2xl sm:text-3xl font-bold text-white">Liabilities</h1>
          <p className="text-slate-400 mt-1 text-sm max-w-2xl">
            What is owed to agencies and hosts right now, and what sellers owe back.
            This is a point in time, not a period — there is no date range to choose.
            All amounts in Indian rupees (₹).
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={load}
            title="Re-read the balances"
            className="flex items-center gap-2 bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-300 rounded-lg px-3.5 py-2.5 text-sm transition-colors"
          >
            <RefreshCw size={14} /> Refresh
          </button>
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
        <Loading label="Reading balances…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !report ? (
        <ErrorState message="No liabilities report came back." onRetry={load} />
      ) : (
        <>
          {provisional && (
            <Warning>
              <span className="font-semibold">These figures are provisional.</span>{' '}
              {provisional} Bean and diamond balances are converted at the fallback
              rate, so the totals below are estimates.
            </Warning>
          )}

          {report.empty ? (
            <Empty
              title="Nothing is recorded as owed"
              icon={<Scale size={28} />}
              hint={
                report.warnings[0] ??
                'No positive agency, host or seller balance exists. If that is unexpected, treat it as a data problem rather than as nothing being owed.'
              }
            />
          ) : (
            <>
              {/* Net position — the number that says ahead or behind */}
              <section
                className={`rounded-2xl border p-6 sm:p-8 ${
                  ahead
                    ? 'bg-emerald-500/10 border-emerald-500/30'
                    : 'bg-red-500/10 border-red-500/30'
                }`}
              >
                <div className="flex items-center gap-2 text-slate-400 text-xs uppercase tracking-wide mb-3">
                  {ahead ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                  Net position (INR)
                </div>
                <p
                  className={`text-4xl sm:text-5xl font-bold tabular-nums ${
                    ahead ? 'text-emerald-200' : 'text-red-200'
                  }`}
                >
                  {formatInrMinorShort(net)}
                </p>
                <p className="text-slate-300 text-sm mt-3 max-w-2xl leading-relaxed">
                  {ahead ? (
                    <>
                      The business is <span className="font-semibold">ahead</span>:
                      sellers owe more than agencies and hosts are owed. Obligations are
                      covered by what is coming in.
                    </>
                  ) : (
                    <>
                      The business is <span className="font-semibold">behind</span> on
                      obligations by {formatInrMinorShort(Math.abs(net))}: more is owed
                      to agencies and hosts than sellers owe back. That gap has to be
                      funded from cash.
                    </>
                  )}
                </p>
                <p className="text-slate-500 text-xs mt-2">
                  Seller receivable {formatInrMinor(t?.seller_credit_receivable_minor)} −
                  owed out {formatInrMinor(t?.total_owed_inr_minor)}. As at{' '}
                  {formatDateTime(report.period.as_at ?? report.generated_at)}.
                </p>
              </section>

              {/* Supporting figures */}
              <section className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                  <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide mb-2">
                    <Scale size={13} /> Total owed out (INR)
                  </div>
                  <p className="text-2xl font-bold text-amber-300 tabular-nums">
                    {formatInrMinorShort(t?.total_owed_inr_minor)}
                  </p>
                  <p className="text-slate-500 text-xs mt-1.5">
                    Agency commission plus beans held by hosts, payable on withdrawal.
                  </p>
                </div>

                <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                  <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide mb-2">
                    <TrendingUp size={13} /> Seller receivable (INR)
                  </div>
                  <p className="text-2xl font-bold text-sky-300 tabular-nums">
                    {formatInrMinorShort(t?.seller_credit_receivable_minor)}
                  </p>
                  <p className="text-slate-500 text-xs mt-1.5">
                    Credit extended to sellers and not yet repaid — owed to the business.
                  </p>
                </div>

                <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                  <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide mb-2">
                    <Clock size={13} /> Sellers overdue
                  </div>
                  <p
                    className={`text-2xl font-bold tabular-nums ${
                      (t?.sellers_overdue ?? 0) > 0 ? 'text-red-300' : 'text-white'
                    }`}
                  >
                    {formatCount(t?.sellers_overdue)}
                  </p>
                  <p className="text-slate-500 text-xs mt-1.5">
                    {(t?.sellers_overdue ?? 0) > 0 ? (
                      <>
                        Past their due date. Part of the receivable above may not
                        arrive.
                      </>
                    ) : (
                      'No seller is past their due date.'
                    )}
                  </p>
                </div>
              </section>

              {(t?.sellers_overdue ?? 0) > 0 && (
                <Warning>
                  <span className="font-semibold">
                    {formatCount(t?.sellers_overdue)} seller
                    {(t?.sellers_overdue ?? 0) === 1 ? ' is' : 's are'} overdue.
                  </span>{' '}
                  The net position above counts the full receivable. If the overdue
                  portion does not come in, the real position is worse than the headline.
                </Warning>
              )}

              {notes.length > 0 && (
                <div className="space-y-2">
                  {notes.map((w, i) => (
                    <Warning key={i}>{w}</Warning>
                  ))}
                </div>
              )}

              {/* Breakdown */}
              <section>
                <h2 className="text-lg font-semibold text-white mb-1">Every line</h2>
                <p className="text-slate-500 text-sm mb-3 flex items-start gap-2 max-w-3xl">
                  <AlertTriangle size={14} className="text-slate-600 mt-0.5 shrink-0" />
                  <span>
                    Only the lines marked <em>Owed out</em> are added to what the
                    business owes. Coin stock held by sellers has already been paid for,
                    and the seller receivable is money owed to the business — both are
                    shown for the net position and neither is a liability.
                  </span>
                </p>
                <DataTable<LiabilityRow>
                  rows={report.rows}
                  columns={columns}
                  rowKey={(r) => r.liability}
                  searchPlaceholder="Search lines…"
                  searchKeys={['liability', 'description']}
                  onExport={exportCsv}
                  exportName="liabilities"
                />
              </section>
            </>
          )}

          <p className="text-slate-600 text-xs">
            {rates ? `${rates} ` : ''}
            {report.period.bounds}. Generated{' '}
            {formatDateTime(report.generated_at)}.
          </p>
        </>
      )}
    </div>
  )
}

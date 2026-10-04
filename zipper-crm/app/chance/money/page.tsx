'use client'

/**
 * The money — what the games earned, what they cost, and whether they are
 * eating the thing that feeds them.
 *
 * Three reports, because they answer three different questions and an owner
 * reads them at different moments (`backend/app/routers/reports.py:270-345`):
 *
 *   • `GET /api/reports/chance-revenue`  `reports.py:282` — gross gaming revenue
 *     as its own line, per mechanic, per country, per day, with actual RTP
 *     beside it (8B.7.1 / 8B.7.2).
 *   • `GET /api/reports/chance-margin`   `reports.py:303` — the bean-payout
 *     ratio per mechanic against the 50% / 5% / none reference of 8B.8.3.
 *   • `GET /api/reports/cannibalisation` `reports.py:323` — 8B.9 and 8B.9A.
 *
 * All three are `_require_business_financials` (`reports.py:128`), which admits
 * owners, the Observer and any team admin. This screen is gated *narrower* than
 * that on purpose: 8B.5.6 gives the margin to Finance, and a page of
 * business-wide money is not Marketing's. Narrower than the API is safe;
 * wider is a link to a page of 403s.
 *
 * Two rules this page will not bend.
 *
 * **The two bean ratios are different numbers.** The server returns
 * `bean_creation_rate_pct` — "Bean creation rate % (units)", beans created per
 * diamond consumed, which is what the 50% / 5% / none reference refers to — and
 * `bean_payout_ratio_pct` — "Bean-payout ratio % (value)", the rupee value of
 * those beans against the rupee value of the diamonds. They are labelled here
 * exactly as the server labels them and are never collapsed into one column,
 * because collapsing them loses the comparison the reference exists for.
 *
 * **Units are never mixed.** Diamonds are diamonds, beans are beans, and every
 * rupee figure is INR minor units divided once by `formatInrMinor`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, ArrowLeft, Coins, Flame, Gauge, RefreshCw, Scale, TrendingUp,
} from 'lucide-react'

import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { attempt, type ReadResult } from '@/lib/readState'
import { Denied, Loading, Warning } from '@/components/ui/States'
import { Panel, ReadPanel, ReadOnlyNote, Stat } from '@/components/ChanceUI'
import { SubSection } from '@/components/ChanceEvaluation'
import { formatInrMinor, formatInrMinorShort, formatInrRupees } from '@/lib/apiReports'
import {
  CHANCE_MONEY_ROLES, chanceReports, count, dateTime, diamonds, pct, signedPct,
  type CannibalisationReport, type ChanceMarginReportEnvelope, type ChanceRevenueReport,
} from '@/lib/apiChance'

const WINDOWS = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
]

function sinceOf(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

export default function ChanceMoneyPage() {
  const { crmUser, apiUser, loading: authLoading, apiReady, apiError } = useAuth()
  const isObserver = apiUser?.role === 'observer'
  const allowed = isObserver || canAccess(crmUser, CHANCE_MONEY_ROLES)

  const [days, setDays] = useState(30)
  const [revenue, setRevenue] = useState<ReadResult<ChanceRevenueReport> | null>(null)
  const [margin, setMargin] = useState<ReadResult<ChanceMarginReportEnvelope> | null>(null)
  const [cannibal, setCannibal] = useState<ReadResult<CannibalisationReport> | null>(null)

  const load = useCallback(() => {
    if (!allowed || !apiReady) return
    const since = sinceOf(days)
    setRevenue(null)
    setMargin(null)
    setCannibal(null)
    attempt(chanceReports.revenue({ since }), 'reports.chance-revenue').then(setRevenue)
    attempt(chanceReports.margin({ since }), 'reports.chance-margin').then(setMargin)
    attempt(chanceReports.cannibalisation({ since }), 'reports.cannibalisation').then(setCannibal)
  }, [allowed, apiReady, days])

  useEffect(() => { load() }, [load])

  const verdict = cannibal?.ok ? cannibal.value.totals.verdict : null
  const consuming = verdict === 'ecosystem_being_consumed'

  if (authLoading) return <Loading label="Checking your access…" />
  if (!allowed) {
    return <Denied what="the chance mechanics' money — gross gaming revenue, the margin model and the cannibalisation report" />
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <Link
            href="/chance"
            className="inline-flex items-center gap-1.5 text-slate-500 hover:text-slate-300 text-sm mb-1.5"
          >
            <ArrowLeft size={14} /> All mechanics
          </Link>
          <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-2.5">
            <Gauge size={24} className="text-pink-400" /> The money
          </h1>
          <p className="text-slate-400 mt-1 text-sm max-w-3xl leading-relaxed">
            Gross gaming revenue as its own line, the bean-payout ratio that
            governs profitability, and whether the games are feeding the host
            economy or eating it. Rupee figures are INR; diamond and bean figures
            are counted in diamonds and beans and never added together.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex gap-1.5">
            {WINDOWS.map((w) => (
              <button
                key={w.days}
                onClick={() => setDays(w.days)}
                className={`rounded-lg border px-2.5 py-2 text-xs ${
                  days === w.days
                    ? 'border-pink-500 bg-pink-500/10 text-white'
                    : 'border-slate-700 text-slate-400 hover:border-slate-600'
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
          <button
            onClick={load}
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3.5 py-2.5 text-sm transition-colors"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {apiReady && apiError && <Warning>{apiError}</Warning>}

      {/* ══ When the ecosystem is being consumed, it dominates ═══════════ */}
      {consuming && cannibal?.ok && (
        <div className="bg-red-500/15 border-2 border-red-500/60 rounded-2xl px-5 py-5">
          <h2 className="flex items-center gap-2.5 text-red-100 text-xl sm:text-2xl font-bold">
            <Flame size={24} className="text-red-300" /> The ecosystem is being consumed
          </h2>
          <p className="text-red-100 text-base mt-2.5 leading-relaxed max-w-4xl">
            {cannibal.value.totals.verdict_text}
          </p>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-4">
            <Stat
              label="Host earnings"
              value={formatInrMinorShort(cannibal.value.totals.host_earnings_inr_minor)}
              tone="bad"
              hint={`${signedPct(cannibal.value.totals.host_earnings_change_pct)} against the period before`}
            />
            <Stat
              label="Game revenue"
              value={formatInrMinorShort(cannibal.value.totals.game_revenue_inr_minor)}
              hint={`${signedPct(cannibal.value.totals.game_revenue_change_pct)} against the period before`}
            />
            <Stat
              label="Winnings spent on hosts"
              value={pct(cannibal.value.totals.winnings_spent_on_hosts_pct)}
              tone="bad"
              hint="The governing metric of 8B.9A.4."
            />
            <Stat
              label="Diamond spend on games"
              value={pct(cannibal.value.totals.diamond_spend_share_games_pct)}
              hint={`against ${pct(cannibal.value.totals.diamond_spend_share_gifting_pct)} on gifting`}
            />
          </div>
        </div>
      )}

      {/* ══ Gross gaming revenue ═════════════════════════════════════════ */}
      <Panel
        title="Gross gaming revenue"
        subtitle="Staked minus paid out, per mechanic, per country, per day, with the actual RTP beside it. Its own revenue line, reported apart from gifting and calls (8B.7.1)."
      >
        <ReadPanel
          result={revenue}
          what="the chance revenue report"
          loadingLabel="Producing the revenue report…"
          onRetry={load}
        >
          {(report) => {
            const t = report.totals
            const dayRows = report.rows.filter((r) => r.scope === 'mechanic_country_day')
            const rollups = report.rows.filter(
              (r) => r.scope === 'mechanic_total' || r.scope === 'country_total' || r.scope === 'kind_total',
            )
            const evidence = report.rows.filter(
              (r) =>
                r.scope === 'ledger_evidence' ||
                r.scope === 'withheld_exception' ||
                r.scope === 'manual_adjustment' ||
                r.scope === 'partner_share',
            )
            return (
              <div className="space-y-5">
                <Envelope report={report} />

                {report.empty ? (
                  <ReadOnlyNote>
                    No chance round settled in this period, so there is nothing to
                    report. The zeroes below would be the absence of data, not a
                    measurement, and are not shown as a result.
                  </ReadOnlyNote>
                ) : (
                  <>
                    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                      <Stat
                        label="Gross gaming revenue"
                        value={formatInrMinor(t.ggr_inr_minor)}
                        tone={t.ggr_inr_minor >= 0 ? 'good' : 'bad'}
                        hint={`${diamonds(t.ggr_diamonds)} diamonds, valued at the rates below`}
                      />
                      <Stat
                        label="Staked"
                        value={diamonds(t.staked_diamonds)}
                        unit="dmd"
                        hint={formatInrMinor(t.staked_inr_minor)}
                      />
                      <Stat
                        label="Paid out"
                        value={diamonds(t.paid_out_diamonds)}
                        unit="dmd"
                        hint={formatInrMinor(t.paid_out_inr_minor)}
                      />
                      <Stat
                        label="Actual RTP"
                        value={pct(t.actual_rtp_percent)}
                        hint={`${count(t.rounds)} rounds · ${count(t.capped_rounds)} capped`}
                      />
                      <Stat
                        label="Withheld"
                        value={diamonds(t.withheld_diamonds)}
                        unit="dmd"
                        tone={t.withheld_diamonds ? 'bad' : 'muted'}
                        hint={`${diamonds(t.withheld_unsettled_diamonds)} still unsettled`}
                      />
                    </div>

                    <p className="text-slate-500 text-xs leading-relaxed">
                      {t.revenue_line} Reported separately from{' '}
                      {t.reported_separately_from.join(', ')}.
                    </p>

                    <SubSection
                      title="Per mechanic, per country, per day"
                      hint="Actual RTP against the RTP the live version was signed with, and the gap in percentage points. A gap is a fact, not a verdict — the monitoring screen is where it is judged against a confidence bound."
                    >
                      {dayRows.length === 0 ? (
                        <ReadOnlyNote>No day-level row in this period.</ReadOnlyNote>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm min-w-[980px]">
                            <thead>
                              <tr className="text-slate-500 text-[11px] uppercase tracking-wide border-b border-slate-800">
                                <th className="text-left font-medium py-2 pr-3">Day</th>
                                <th className="text-left font-medium py-2 px-3">Mechanic</th>
                                <th className="text-left font-medium py-2 px-3">Country</th>
                                <th className="text-right font-medium py-2 px-3">Rounds</th>
                                <th className="text-right font-medium py-2 px-3">Staked (dmd)</th>
                                <th className="text-right font-medium py-2 px-3">Paid out (dmd)</th>
                                <th className="text-right font-medium py-2 px-3">GGR (dmd)</th>
                                <th className="text-right font-medium py-2 px-3">GGR (INR)</th>
                                <th className="text-right font-medium py-2 px-3">Actual RTP</th>
                                <th className="text-right font-medium py-2 px-3">Configured</th>
                                <th className="text-right font-medium py-2 pl-3">Gap (pp)</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/60">
                              {dayRows.map((r, i) => (
                                <tr key={`${r.day}-${r.mechanic_id}-${r.country}-${i}`}>
                                  <td className="py-2 pr-3 text-slate-300">{r.day}</td>
                                  <td className="py-2 px-3 text-slate-200">
                                    {r.mechanic ?? r.mechanic_id}
                                    {r.kind && (
                                      <span className="block text-slate-600 text-[11px]">{r.kind}</span>
                                    )}
                                  </td>
                                  <td className="py-2 px-3 text-slate-400">{r.country}</td>
                                  <td className="py-2 px-3 text-right text-slate-400 tabular-nums">
                                    {count(r.rounds)}
                                  </td>
                                  <td className="py-2 px-3 text-right text-slate-400 tabular-nums">
                                    {diamonds(r.staked_diamonds)}
                                  </td>
                                  <td className="py-2 px-3 text-right text-slate-400 tabular-nums">
                                    {diamonds(r.paid_out_diamonds)}
                                  </td>
                                  <td className="py-2 px-3 text-right text-slate-200 tabular-nums">
                                    {diamonds(r.ggr_diamonds)}
                                  </td>
                                  <td className="py-2 px-3 text-right text-slate-100 font-medium tabular-nums">
                                    {formatInrMinor(r.ggr_inr_minor)}
                                  </td>
                                  <td className="py-2 px-3 text-right text-slate-200 tabular-nums">
                                    {pct(r.actual_rtp_percent)}
                                  </td>
                                  <td className="py-2 px-3 text-right text-slate-400 tabular-nums">
                                    {pct(r.configured_rtp_percent)}
                                  </td>
                                  <td
                                    className={`py-2 pl-3 text-right tabular-nums ${
                                      r.rtp_gap_pp !== null && Math.abs(r.rtp_gap_pp) >= 2
                                        ? 'text-amber-300'
                                        : 'text-slate-400'
                                    }`}
                                  >
                                    {signedPct(r.rtp_gap_pp, 2)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </SubSection>

                    {rollups.length > 0 && (
                      <SubSection title="Totals per mechanic, country and kind">
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm min-w-[720px]">
                            <thead>
                              <tr className="text-slate-500 text-[11px] uppercase tracking-wide border-b border-slate-800">
                                <th className="text-left font-medium py-2 pr-3">Scope</th>
                                <th className="text-left font-medium py-2 px-3">What</th>
                                <th className="text-right font-medium py-2 px-3">GGR (dmd)</th>
                                <th className="text-right font-medium py-2 px-3">GGR (INR)</th>
                                <th className="text-right font-medium py-2 pl-3">Actual RTP</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/60">
                              {rollups.map((r, i) => (
                                <tr key={`${r.scope}-${i}`}>
                                  <td className="py-2 pr-3 text-slate-500 text-xs">
                                    {r.scope.replace(/_/g, ' ')}
                                  </td>
                                  <td className="py-2 px-3 text-slate-200">
                                    {r.mechanic ?? r.kind ?? r.country ?? r.mechanic_id}
                                  </td>
                                  <td className="py-2 px-3 text-right text-slate-300 tabular-nums">
                                    {diamonds(r.ggr_diamonds)}
                                  </td>
                                  <td className="py-2 px-3 text-right text-slate-100 tabular-nums">
                                    {formatInrMinor(r.ggr_inr_minor)}
                                  </td>
                                  <td className="py-2 pl-3 text-right text-slate-300 tabular-nums">
                                    {pct(r.actual_rtp_percent)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </SubSection>
                    )}

                    {evidence.length > 0 && (
                      <SubSection
                        title="Underneath the table"
                        hint="Whether a host or agency takes a share (8B.7.3), whether the stakes and payouts reached the ledger (8B.7.4), and what is withheld awaiting an owner's signature (8B.7.5). Each of those is measured, not asserted."
                      >
                        <ul className="space-y-2">
                          {evidence.map((r, i) => (
                            <li
                              key={`${r.scope}-${i}`}
                              className="text-slate-400 text-sm leading-relaxed bg-slate-950/60 border border-slate-800 rounded-lg px-3.5 py-2.5"
                            >
                              <span className="text-slate-300">
                                {r.scope.replace(/_/g, ' ')}
                              </span>{' '}
                              — {r.detail}
                            </li>
                          ))}
                        </ul>
                      </SubSection>
                    )}
                  </>
                )}
              </div>
            )
          }}
        </ReadPanel>
      </Panel>

      {/* ══ Margin model ═════════════════════════════════════════════════ */}
      <Panel
        title="The margin model — bean-payout ratio per mechanic"
        subtitle="Diamonds returned to a player are not a cost; they were already sold for cash (8B.8.1). The only true cash outflow is a bean becoming a payout, so mechanics are ranked by what they commit in beans per diamond they consume."
      >
        <ReadPanel
          result={margin}
          what="the chance margin report"
          loadingLabel="Producing the margin report…"
          onRetry={load}
        >
          {(report) => {
            const t = report.totals
            return (
              <div className="space-y-5">
                <Envelope report={report} />

                <div className="bg-slate-950/60 border border-slate-800 rounded-xl px-4 py-3.5">
                  <p className="flex items-center gap-2 text-slate-200 text-sm font-semibold">
                    <Scale size={15} className="text-pink-400" /> Two ratios, and they are
                    not the same number
                  </p>
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-3">
                    <div>
                      <p className="text-slate-400 text-xs uppercase tracking-wide">
                        Bean creation rate % (units)
                      </p>
                      <p className="text-white text-2xl font-bold tabular-nums mt-0.5">
                        {pct(t.bean_creation_rate_pct)}
                      </p>
                      <p className="text-slate-500 text-xs mt-1 leading-relaxed">
                        Beans created per diamond consumed, counted as units. This is
                        what the 8B.8.3 reference refers to.
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-400 text-xs uppercase tracking-wide">
                        Bean-payout ratio % (value)
                      </p>
                      <p className="text-white text-2xl font-bold tabular-nums mt-0.5">
                        {pct(t.bean_payout_ratio_pct_created_basis)}
                      </p>
                      <p className="text-slate-500 text-xs mt-1 leading-relaxed">
                        The rupee value of those beans against the rupee value of the
                        diamonds. A different question with a different answer, and it
                        is never shown in place of the one on the left.
                      </p>
                    </div>
                  </div>
                  {t.bean_payout_ratio_pct_realised !== null && (
                    <p className="text-slate-500 text-xs mt-3 leading-relaxed">
                      On a realised basis rather than a created one, the value ratio is{' '}
                      <span className="text-slate-300">{pct(t.bean_payout_ratio_pct_realised)}</span>.
                      Realised and created are two different bases and both are printed
                      rather than one being chosen.
                    </p>
                  )}
                </div>

                <SubSection
                  title="The 8B.8.3 reference"
                  hint="A normal gift creates a bean for half the diamonds it consumes. A lucky gift creates one for a twentieth. A game creates none at all — every diamond staked on a game that the house keeps is kept whole."
                >
                  <div className="grid grid-cols-3 gap-3">
                    {Object.entries(t.reference ?? {}).map(([key, value]) => (
                      <Stat
                        key={key}
                        label={key.replace(/_/g, ' ')}
                        value={pct(value)}
                        tone="muted"
                        hint="reference bean creation rate"
                      />
                    ))}
                  </div>
                </SubSection>

                {report.empty ? (
                  <ReadOnlyNote>
                    No gift, no call and no chance round in this period, so there is
                    nothing to compute a margin over. An empty period, not a period of
                    perfect margin.
                  </ReadOnlyNote>
                ) : (
                  <SubSection title="Per mechanic">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm min-w-[1040px]">
                        <thead>
                          <tr className="text-slate-500 text-[11px] uppercase tracking-wide border-b border-slate-800">
                            <th className="text-left font-medium py-2 pr-3">Mechanic</th>
                            <th className="text-left font-medium py-2 px-3">Basis</th>
                            <th className="text-right font-medium py-2 px-3">Diamonds consumed</th>
                            <th className="text-right font-medium py-2 px-3">Diamond value</th>
                            <th className="text-right font-medium py-2 px-3">Beans created</th>
                            <th className="text-right font-medium py-2 px-3">Bean cash cost</th>
                            <th className="text-right font-medium py-2 px-3">
                              Bean creation rate&nbsp;% (units)
                            </th>
                            <th className="text-right font-medium py-2 px-3">8B.8.3 reference&nbsp;%</th>
                            <th className="text-right font-medium py-2 px-3">Variance (pp)</th>
                            <th className="text-right font-medium py-2 pl-3">
                              Bean-payout ratio&nbsp;% (value)
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/60">
                          {report.rows.map((r, i) => (
                            <tr key={`${r.mechanic}-${i}`}>
                              <td className="py-2 pr-3 text-slate-200">
                                {r.label}
                                <span className="block text-slate-600 text-[11px]">
                                  {r.kind} · {r.store}
                                </span>
                              </td>
                              <td className="py-2 px-3 text-slate-500 text-xs">{r.basis}</td>
                              <td className="py-2 px-3 text-right text-slate-300 tabular-nums">
                                {diamonds(r.diamonds_consumed)}
                              </td>
                              <td className="py-2 px-3 text-right text-slate-400 tabular-nums">
                                {formatInrMinor(r.diamond_value_inr_minor)}
                              </td>
                              <td className="py-2 px-3 text-right text-slate-300 tabular-nums">
                                {count(r.beans_created)}
                                <span className="text-slate-600 text-[11px] ml-1">beans</span>
                              </td>
                              <td className="py-2 px-3 text-right text-slate-400 tabular-nums">
                                {formatInrMinor(r.bean_cash_cost_inr_minor)}
                              </td>
                              <td className="py-2 px-3 text-right text-slate-100 font-medium tabular-nums">
                                {pct(r.bean_creation_rate_pct)}
                              </td>
                              <td className="py-2 px-3 text-right text-slate-400 tabular-nums">
                                {pct(r.reference_bean_creation_pct)}
                              </td>
                              <td
                                className={`py-2 px-3 text-right tabular-nums ${
                                  r.variance_from_reference_pp !== null &&
                                  Math.abs(r.variance_from_reference_pp) >= 5
                                    ? 'text-amber-300'
                                    : 'text-slate-400'
                                }`}
                              >
                                {signedPct(r.variance_from_reference_pp, 2)}
                              </td>
                              <td className="py-2 pl-3 text-right text-pink-300 font-medium tabular-nums">
                                {pct(r.bean_payout_ratio_pct)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-slate-500 text-xs mt-2.5 leading-relaxed">
                      The two right-hand columns are the two ratios above, per mechanic.
                      They carry the server&apos;s own headers and are deliberately
                      adjacent rather than merged.
                    </p>
                  </SubSection>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  <div className="bg-slate-950/60 border border-slate-800 rounded-xl px-4 py-3.5">
                    <p className="flex items-center gap-2 text-slate-300 text-sm font-medium">
                      <TrendingUp size={14} className="text-emerald-400" /> Best margin
                    </p>
                    <p className="text-white text-lg font-semibold mt-1">
                      {t.highest_margin_mechanic ?? '—'}
                      {t.highest_margin_mechanic_kind && (
                        <span className="text-slate-500 text-xs font-normal ml-2">
                          {t.highest_margin_mechanic_kind}
                        </span>
                      )}
                    </p>
                    <p className="text-slate-500 text-xs mt-1">
                      Bean-payout ratio % (value) of{' '}
                      {pct(t.highest_margin_ratio_pct)} — the lowest cash cost per rupee
                      of diamond consumed.
                    </p>
                  </div>
                  <div className="bg-slate-950/60 border border-slate-800 rounded-xl px-4 py-3.5">
                    <p className="flex items-center gap-2 text-slate-300 text-sm font-medium">
                      <Coins size={14} className="text-amber-400" /> Creating no bean at all
                    </p>
                    <p className="text-white text-sm mt-1.5 leading-relaxed">
                      {t.mechanics_creating_no_bean.length
                        ? t.mechanics_creating_no_bean.join(', ')
                        : 'None — every mechanic commits some future cash cost.'}
                    </p>
                    <p className="text-slate-500 text-xs mt-1">
                      A mechanic that creates no bean has no cash outflow and therefore no
                      bean-payout ratio to rank.
                    </p>
                  </div>
                </div>
              </div>
            )
          }}
        </ReadPanel>
      </Panel>

      {/* ══ Cannibalisation ══════════════════════════════════════════════ */}
      <Panel
        tone={consuming ? 'danger' : 'plain'}
        title="Cannibalisation — are the games feeding the host economy or eating it?"
        subtitle="8B.9 and 8B.9A. The governing metric is the share of game winnings subsequently spent on hosts: winnings that go back into games are not revenue, they are a loop."
      >
        <ReadPanel
          result={cannibal}
          what="the cannibalisation report"
          loadingLabel="Producing the cannibalisation report…"
          onRetry={load}
        >
          {(report) => {
            const t = report.totals
            return (
              <div className="space-y-5">
                <Envelope report={report} />

                <div
                  className={`border rounded-xl px-4 py-3.5 ${
                    t.verdict === 'ecosystem_being_consumed'
                      ? 'bg-red-500/10 border-red-500/50'
                      : t.verdict === 'healthy'
                        ? 'bg-emerald-500/10 border-emerald-500/30'
                        : t.verdict === null
                          ? 'bg-slate-950/60 border-slate-800'
                          : 'bg-amber-500/10 border-amber-500/30'
                  }`}
                >
                  <p className="text-white text-sm font-semibold">
                    {t.verdict === null
                      ? 'No verdict'
                      : t.verdict.replace(/_/g, ' ')}
                  </p>
                  <p className="text-slate-200 text-sm mt-1.5 leading-relaxed">
                    {t.verdict_text}
                  </p>
                  {t.verdict === null && (
                    <p className="text-slate-500 text-xs mt-2 leading-relaxed">
                      The preceding period could not be compared, so there is no
                      verdict. That is deliberately not the same as “healthy”.
                    </p>
                  )}
                  <p className="text-slate-500 text-xs mt-2">
                    Compared against {t.comparison_period.days} day
                    {t.comparison_period.days === 1 ? '' : 's'} ending{' '}
                    {dateTime(t.comparison_period.until)} · steady band ±
                    {pct(t.steady_band_pct)}
                  </p>
                </div>

                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <Stat
                    label="Host earnings"
                    value={formatInrMinorShort(t.host_earnings_inr_minor)}
                    hint={`was ${formatInrMinorShort(t.host_earnings_previous_inr_minor)} · ${signedPct(t.host_earnings_change_pct)}`}
                    tone={
                      t.host_earnings_change_pct !== null && t.host_earnings_change_pct < 0
                        ? 'bad'
                        : 'plain'
                    }
                  />
                  <Stat
                    label="Per active host"
                    value={formatInrMinorShort(t.host_earnings_per_active_host_inr_minor)}
                    hint={`${count(t.active_hosts)} active, was ${count(t.active_hosts_previous)}`}
                  />
                  <Stat
                    label="Game revenue"
                    value={formatInrMinorShort(t.game_revenue_inr_minor)}
                    hint={`${signedPct(t.game_revenue_change_pct)} against the period before`}
                  />
                  <Stat
                    label="Winnings spent on hosts"
                    value={pct(t.winnings_spent_on_hosts_pct)}
                    tone={
                      t.winnings_spent_on_hosts_pct !== null && t.winnings_spent_on_hosts_pct < 20
                        ? 'bad'
                        : 'good'
                    }
                    hint="8B.9A.4 — the governing metric."
                  />
                </div>

                <SubSection
                  title="Where the diamonds went"
                  hint="Every figure here is diamonds, never rupees, so the split is a split of what players spent rather than of what it was worth."
                >
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    <Stat label="On games" value={diamonds(t.game_staked_diamonds)} unit="dmd" hint={pct(t.diamond_spend_share_games_pct)} />
                    <Stat label="On gifts" value={diamonds(t.gift_diamonds)} unit="dmd" hint={pct(t.diamond_spend_share_gifting_pct)} />
                    <Stat label="On calls" value={diamonds(t.call_diamonds)} unit="dmd" />
                    <Stat label="Total spend" value={diamonds(t.diamond_spend_total)} unit="dmd" />
                  </div>
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
                    <Stat label="Game winnings" value={diamonds(t.game_winnings_diamonds)} unit="dmd" />
                    <Stat
                      label="Winnings spent on hosts"
                      value={diamonds(t.winnings_spent_on_hosts_diamonds)}
                      unit="dmd"
                    />
                    <Stat
                      label="Winnings recycled into games"
                      value={diamonds(t.winnings_recycled_into_games_diamonds)}
                      unit="dmd"
                      tone="bad"
                    />
                    <Stat
                      label="Retained non-spenders"
                      value={count(t.retained_non_spenders)}
                      hint={`${count(t.retained_non_spenders_no_recharge)} of them never recharged — counted as retained, not as failed monetisation (8B.9A.6)`}
                    />
                  </div>
                </SubSection>

                {report.rows.length > 0 && (
                  <SubSection title="Every metric, with what it is made of">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm min-w-[820px]">
                        <thead>
                          <tr className="text-slate-500 text-[11px] uppercase tracking-wide border-b border-slate-800">
                            <th className="text-left font-medium py-2 pr-3">Metric</th>
                            <th className="text-right font-medium py-2 px-3">Value</th>
                            <th className="text-right font-medium py-2 px-3">Previous</th>
                            <th className="text-right font-medium py-2 px-3">Change</th>
                            <th className="text-left font-medium py-2 pl-3">Spec</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/60">
                          {report.rows.map((r) => (
                            <tr key={r.metric}>
                              <td className="py-2 pr-3 text-slate-200">
                                {r.label}
                                <span className="block text-slate-600 text-[11px] max-w-xl">
                                  {r.detail}
                                </span>
                              </td>
                              {/* `value_inr` is rupees — the server divided the
                                  minor units once, in `reports.inr`. It is not
                                  divided again here, and `value` (minor units)
                                  is not shown beside it as though it were a
                                  second figure. */}
                              <td className="py-2 px-3 text-right text-slate-100 tabular-nums whitespace-nowrap">
                                {r.value_inr !== null
                                  ? formatInrRupees(r.value_inr)
                                  : typeof r.value === 'number'
                                    ? count(r.value)
                                    : (r.value ?? '—')}
                                {r.value_inr === null && (
                                  <span className="text-slate-600 text-[11px] ml-1">{r.unit}</span>
                                )}
                              </td>
                              <td className="py-2 px-3 text-right text-slate-400 tabular-nums whitespace-nowrap">
                                {r.previous_inr !== null
                                  ? formatInrRupees(r.previous_inr)
                                  : typeof r.previous === 'number'
                                    ? count(r.previous)
                                    : (r.previous ?? '—')}
                              </td>
                              <td
                                className={`py-2 px-3 text-right tabular-nums ${
                                  r.change_pct !== null && r.change_pct < 0
                                    ? 'text-red-300'
                                    : 'text-slate-300'
                                }`}
                              >
                                {signedPct(r.change_pct)}
                              </td>
                              <td className="py-2 pl-3 text-slate-500 text-xs">{r.spec}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </SubSection>
                )}
              </div>
            )
          }}
        </ReadPanel>
      </Panel>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════

/**
 * The half of a report that is not the numbers: what period it covers, what
 * rates it valued things at, whether any of those rates were a fallback, and
 * whatever the server wanted said out loud. A screen that reads a figure out of
 * `totals` and throws this away puts a guess on the wall as a fact.
 */
function Envelope({
  report,
}: {
  report: {
    title: string
    generated_at: string
    period: { since?: string; until?: string; days?: number; bounds: string }
    currency_unit: string
    rates: { source?: string; provisional?: boolean; note?: string; missing?: string[] }
    warnings: string[]
    empty: boolean
  }
}) {
  return (
    <div className="space-y-2.5">
      <p className="text-slate-500 text-xs leading-relaxed">
        {report.title} · {report.period.bounds} · generated{' '}
        {dateTime(report.generated_at)} · amounts in {report.currency_unit}
      </p>

      {report.rates?.provisional && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3.5 py-2.5">
          <p className="flex items-center gap-2 text-amber-200 text-sm font-medium">
            <AlertTriangle size={14} /> Some figures are estimates
          </p>
          <p className="text-amber-300/80 text-xs mt-1 leading-relaxed">
            A rate was missing and a documented fallback was used
            {report.rates.missing?.length ? ` (${report.rates.missing.join(', ')})` : ''}. Every
            rupee figure below is an estimate rather than a measurement.{' '}
            {report.rates.note ?? ''}
          </p>
        </div>
      )}

      {report.warnings.length > 0 && (
        <ul className="space-y-1.5">
          {report.warnings.map((w, i) => (
            <li
              key={i}
              className="text-amber-100 text-sm leading-relaxed bg-amber-500/5 border border-amber-500/20 rounded-lg px-3 py-2"
            >
              {w}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

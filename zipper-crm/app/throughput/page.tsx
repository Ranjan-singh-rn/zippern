'use client'

/**
 * Team throughput — is the team keeping up?
 *
 * `/reports/team-throughput` counts cards raised, verified, signed, executed
 * and rejected in the period, gives the median time in each stage, and names
 * the oldest item still open.
 *
 * Two things this screen refuses to fudge:
 *
 *   * A stage nobody completed in the period reports null, and shows as "—".
 *     A zero would read as "instant", which is the opposite of the truth.
 *   * Medians, not averages. One card stuck for three weeks should not make a
 *     responsive team look slow, and it should not be hidden either — that is
 *     what the oldest open item is for.
 *
 * Scope is set by the API, not by this page: an owner or the Observer may ask
 * for every team, anyone else gets their own and a 403 if they ask for
 * another. The filter reflects that rather than offering choices that fail.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, CheckCircle2, Clock, Download, FileText, Layers,
  PenLine, ShieldCheck, XCircle,
  type LucideIcon,
} from 'lucide-react'

import { useAuth } from '@/components/AuthProvider'
import { STAFF_ROLES, canAccess, getDeptFromRole } from '@/lib/auth'
import { ApiError } from '@/lib/api'
import { Column, DataTable } from '@/components/ui/DataTable'
import { DateRangePicker, Range, defaultRange, toParams } from '@/components/ui/DateRange'
import { Denied, Empty, ErrorState, Loading, Warning } from '@/components/ui/States'
import {
  REPORT_TEAMS, ThroughputReport, ThroughputRow,
  formatCount, formatDateTime, formatHours, formatNativeAmount,
  reports,
} from '@/lib/apiReports'

const TEAM_LABELS: Record<string, string> = {
  app: 'App',
  ops: 'Operations',
  finance: 'Finance',
  tech: 'Tech',
  support: 'Support',
  marketing: 'Marketing',
}

const STAGE_LABELS: Record<string, string> = {
  requested: 'Requested',
  under_review: 'Under review',
  awaiting_signoff: 'Awaiting sign-off',
  approved: 'Approved, not yet executed',
}

const STAGE_ORDER = ['requested', 'under_review', 'awaiting_signoff', 'approved']

const MEDIANS: { key: string; label: string; hint: string }[] = [
  { key: 'raised_to_verified', label: 'Raised → verified', hint: 'Time waiting for a first check' },
  { key: 'verified_to_signed', label: 'Verified → signed', hint: 'Time waiting on an owner' },
  { key: 'signed_to_executed', label: 'Signed → executed', hint: 'Time from approval to the money moving' },
  { key: 'raised_to_executed', label: 'Raised → executed', hint: 'End to end' },
]

const COUNTS: {
  key: keyof ThroughputReport['totals']['counts']
  label: string
  tone: string
  icon: LucideIcon
}[] = [
  { key: 'raised', label: 'Raised', tone: 'text-sky-300', icon: FileText },
  { key: 'verified', label: 'Verified', tone: 'text-violet-300', icon: ShieldCheck },
  { key: 'signed', label: 'Signed', tone: 'text-amber-300', icon: PenLine },
  { key: 'executed', label: 'Executed', tone: 'text-emerald-300', icon: CheckCircle2 },
  { key: 'rejected', label: 'Rejected', tone: 'text-red-300', icon: XCircle },
]

type KeyedRow = ThroughputRow & { _key: string }

export default function ThroughputPage() {
  const { crmUser, apiUser, loading: authLoading, apiReady, apiError } = useAuth()
  const allowed = canAccess(crmUser, STAFF_ROLES)

  // Who may ask for every team: the API's owner and observer roles, and the
  // CRM superadmin that maps onto them.
  const seesAllTeams =
    crmUser?.role === 'superadmin' ||
    apiUser?.role === 'owner' ||
    apiUser?.role === 'observer'

  const ownTeam = apiUser?.team ?? (crmUser ? getDeptFromRole(crmUser.role) : null)

  const [range, setRange] = useState<Range>(defaultRange)
  const [team, setTeam] = useState<string>('')
  const [report, setReport] = useState<ThroughputReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [exportError, setExportError] = useState('')

  // A team admin or member reports on their own team; the filter is not a
  // choice for them, so it is set once rather than offered and refused.
  useEffect(() => {
    if (!seesAllTeams && ownTeam) setTeam(ownTeam)
  }, [seesAllTeams, ownTeam])

  const load = useCallback(() => {
    if (!allowed || !apiReady) return
    setLoading(true)
    setError('')
    reports
      .teamThroughput({ ...toParams(range), team: team || undefined })
      .then(setReport)
      .catch((err: unknown) => {
        setError(
          err instanceof ApiError
            ? err.message
            : 'The throughput report could not be produced.',
        )
      })
      .finally(() => setLoading(false))
  }, [allowed, apiReady, range, team])

  useEffect(() => { load() }, [load])

  async function exportCsv() {
    setExportError('')
    try {
      await reports.csv.teamThroughput({ ...toParams(range), team: team || undefined })
    } catch (err) {
      setExportError(err instanceof ApiError ? err.message : 'The export failed.')
    }
  }

  const rows = useMemo<KeyedRow[]>(
    () =>
      (report?.rows ?? []).map((r, i) => ({ ...r, _key: `${r.measure}-${i}` })),
    [report],
  )

  if (authLoading) return <Loading label="Checking your access…" />
  if (!allowed) return <Denied what="team throughput" />

  const t = report?.totals
  const oldest = t?.oldest_open_item ?? null
  const openStages = STAGE_ORDER.filter((s) => (t?.open_by_stage?.[s] ?? 0) > 0)
  const scopeLabel =
    !team ? 'all teams' : TEAM_LABELS[team] ?? team

  const columns: Column<KeyedRow>[] = [
    {
      key: 'measure',
      header: 'Measure',
      render: (r) => (
        <span className="text-white font-medium">{r.measure.replace(/_/g, ' ')}</span>
      ),
    },
    {
      key: 'kind',
      header: 'Kind',
      hideOnMobile: true,
      render: (r) => <span className="text-slate-400 text-xs">{r.kind}</span>,
    },
    {
      key: 'value',
      header: 'Value',
      align: 'right',
      value: (r) => r.value,
      render: (r) => (
        <span className={`tabular-nums ${r.value === null ? 'text-slate-600' : 'text-slate-200'}`}>
          {r.value === null
            ? '—'
            : r.unit === 'hours'
              ? formatHours(r.value)
              : `${formatCount(r.value)} ${r.unit}`}
        </span>
      ),
    },
    {
      key: 'detail',
      header: 'Detail',
      sortable: false,
      render: (r) => <span className="text-slate-500 text-xs">{r.detail || '—'}</span>,
    },
  ]

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white">Team throughput</h1>
          <p className="text-slate-400 mt-1 text-sm max-w-2xl">
            Cards raised, verified, signed, executed and rejected for{' '}
            <span className="text-slate-200">{scopeLabel}</span>,{' '}
            {range.label.toLowerCase()} — with how long each stage took and what is
            still waiting.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {seesAllTeams ? (
            <select
              value={team}
              onChange={(e) => setTeam(e.target.value)}
              className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500"
            >
              <option value="">All teams</option>
              {REPORT_TEAMS.map((tm) => (
                <option key={tm} value={tm}>
                  {TEAM_LABELS[tm]}
                </option>
              ))}
            </select>
          ) : (
            <span className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2.5 text-slate-300 text-sm">
              {ownTeam ? TEAM_LABELS[ownTeam] ?? ownTeam : 'Your team'}
            </span>
          )}
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
        <Loading label="Counting cards…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !report ? (
        <ErrorState message="No throughput report came back." onRetry={load} />
      ) : report.empty ? (
        <Empty
          title="No activity in this period"
          icon={<Layers size={28} />}
          hint={
            report.warnings[0] ??
            'No card was raised, verified, signed, executed or rejected for this team between these dates, and nothing is open. There is nothing to measure.'
          }
        />
      ) : (
        <>
          {report.warnings.map((w, i) => (
            <Warning key={i}>{w}</Warning>
          ))}

          {/* Counts */}
          <section className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3 sm:gap-4">
            {COUNTS.map((c) => (
              <div
                key={c.key}
                className="bg-slate-900 border border-slate-800 rounded-xl p-4 sm:p-5"
              >
                <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide mb-2">
                  <c.icon size={13} /> {c.label}
                </div>
                <p className={`text-2xl font-bold tabular-nums ${c.tone}`}>
                  {formatCount(t?.counts?.[c.key])}
                </p>
                <p className="text-slate-600 text-xs mt-1">cards</p>
              </div>
            ))}
          </section>

          {/* Medians */}
          <section>
            <h2 className="text-lg font-semibold text-white mb-1">
              Median time in each stage
            </h2>
            <p className="text-slate-500 text-sm mb-3 max-w-2xl">
              Median, not average — one stuck card should not move the number. A stage
              nobody completed in this period shows “—”, never zero.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
              {MEDIANS.map((m) => {
                const hours = t?.median_hours?.[m.key] ?? null
                return (
                  <div
                    key={m.key}
                    className="bg-slate-900 border border-slate-800 rounded-xl p-4 sm:p-5"
                  >
                    <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide mb-2">
                      <Clock size={13} /> {m.label}
                    </div>
                    <p
                      className={`text-xl font-bold tabular-nums ${
                        hours === null ? 'text-slate-600' : 'text-white'
                      }`}
                    >
                      {formatHours(hours)}
                    </p>
                    <p className="text-slate-600 text-xs mt-1.5">
                      {hours === null
                        ? 'No card completed this transition in the period.'
                        : m.hint}
                    </p>
                  </div>
                )
              })}
            </div>
          </section>

          {/* Open queue and the oldest item */}
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h2 className="text-base font-semibold text-white mb-1">
                Open now — {formatCount(t?.open_total)} card
                {(t?.open_total ?? 0) === 1 ? '' : 's'}
              </h2>
              <p className="text-slate-500 text-xs mb-4">
                Everything not yet executed or rejected, regardless of when it was
                raised.
              </p>
              {openStages.length === 0 ? (
                <p className="text-slate-400 text-sm">
                  Nothing is open. The queue is clear.
                </p>
              ) : (
                <ul className="space-y-2">
                  {openStages.map((stage) => (
                    <li
                      key={stage}
                      className="flex items-center justify-between gap-3 border-b border-slate-800/60 last:border-0 pb-2 last:pb-0"
                    >
                      <span className="text-slate-300 text-sm">
                        {STAGE_LABELS[stage] ?? stage.replace(/_/g, ' ')}
                      </span>
                      <span className="text-white font-semibold tabular-nums">
                        {formatCount(t?.open_by_stage?.[stage])}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div
              className={`rounded-xl p-5 border ${
                oldest && oldest.age_days > 7
                  ? 'bg-amber-500/10 border-amber-500/30'
                  : 'bg-slate-900 border-slate-800'
              }`}
            >
              <h2 className="text-base font-semibold text-white mb-1 flex items-center gap-2">
                <AlertTriangle
                  size={15}
                  className={oldest && oldest.age_days > 7 ? 'text-amber-400' : 'text-slate-600'}
                />
                Oldest open item
              </h2>
              {!oldest ? (
                <p className="text-slate-400 text-sm mt-3">
                  Nothing is open, so there is no oldest item.
                </p>
              ) : (
                <div className="mt-3 space-y-2">
                  <p className="text-2xl font-bold text-white tabular-nums">
                    {oldest.age_days.toFixed(1)} days old
                  </p>
                  <p className="text-slate-200 text-sm">{oldest.title || 'Untitled card'}</p>
                  <dl className="text-xs text-slate-500 space-y-1 pt-1">
                    <div className="flex gap-2">
                      <dt className="w-24 shrink-0">Stage</dt>
                      <dd className="text-slate-400">
                        {STAGE_LABELS[oldest.stage ?? ''] ?? oldest.stage ?? '—'}
                      </dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-24 shrink-0">Type</dt>
                      <dd className="text-slate-400">
                        {oldest.type?.replace(/_/g, ' ') ?? '—'}
                      </dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-24 shrink-0">Amount</dt>
                      <dd className="text-slate-400 tabular-nums">
                        {formatNativeAmount(oldest.amount, oldest.currency)}
                      </dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-24 shrink-0">Raised by</dt>
                      <dd className="text-slate-400">{oldest.requested_by ?? '—'}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-24 shrink-0">Raised at</dt>
                      <dd className="text-slate-400">{formatDateTime(oldest.created_at)}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-24 shrink-0">Card</dt>
                      <dd className="text-slate-400 font-mono">{oldest.card_id}</dd>
                    </div>
                  </dl>
                </div>
              )}
            </div>
          </section>

          {/* Everything the report measured */}
          <section>
            <h2 className="text-lg font-semibold text-white mb-1">
              Every measure in this report
            </h2>
            <p className="text-slate-500 text-sm mb-3">
              The full report, exactly as the API produced it — and exactly what the CSV
              export contains.
            </p>
            <DataTable<KeyedRow>
              rows={rows}
              columns={columns}
              rowKey={(r) => r._key}
              searchPlaceholder="Search measures…"
              searchKeys={['measure', 'detail']}
              onExport={exportCsv}
              exportName={`team-throughput-${team || 'all'}`}
              pageSize={50}
              emptyTitle="No activity in this period"
            />
          </section>

          {/* How things are counted */}
          {Object.keys(report.definitions).length > 0 && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
              {Object.entries(report.definitions).map(([key, text]) => (
                <div key={key}>
                  <p className="text-slate-300 text-sm font-medium capitalize">
                    {key.replace(/_/g, ' ')}
                  </p>
                  <p className="text-slate-500 text-sm mt-1 leading-relaxed">{text}</p>
                </div>
              ))}
            </div>
          )}

          <p className="text-slate-600 text-xs">
            Period {report.period.bounds}. Generated{' '}
            {formatDateTime(report.generated_at)}.
          </p>
        </>
      )}
    </div>
  )
}

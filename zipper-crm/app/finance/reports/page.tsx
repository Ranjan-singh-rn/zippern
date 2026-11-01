'use client'

/**
 * Weekly payout runs — one row per agency, for the week you pick.
 *
 * The run comes from `/reports/partners/summary?kind=agency`, which is the same
 * endpoint the CSV export renders, so the spreadsheet and the screen cannot
 * disagree. Commission is held in the ledger as minor units (paise); every
 * figure below is divided by 100 exactly once and labelled in rupees.
 *
 * Two things the report says that a table would otherwise hide, and which are
 * repeated on this page rather than dropped:
 *
 *   An agency with no movement in the week has **no row**. That means no
 *   activity, not a zero balance — the report states how many are silent, and
 *   so does this screen.
 *
 *   `empty: true` means the whole week had no movement at all. It is rendered
 *   as "no data for this period", never as ₹0.
 *
 * Per-host expansion comes from `/partners/agencies/{id}/hosts`, scoped to the
 * selected week by passing `since`. Without that it returns standing lifetime
 * earnings, and a lifetime figure sitting under a weekly heading is exactly the
 * kind of quiet mismatch this rebuild exists to remove.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, Building2, ChevronRight, Download, Loader2, Users, X,
} from 'lucide-react'

import { useAuth } from '@/components/AuthProvider'
import { canAccess, CrmRole } from '@/lib/auth'
import api, { ApiError } from '@/lib/api'
import { nameOrReference } from '@/lib/identity'
import { useIdentities } from '@/lib/useIdentities'
import { Column, DataTable } from '@/components/ui/DataTable'
import { DateRangePicker, PRESETS, Range, toParams } from '@/components/ui/DateRange'
import { Denied, Empty, ErrorState, Loading, Warning } from '@/components/ui/States'
import {
  AnyReport,
  downloadReportCsv, formatCount, formatDateTime, formatInrMinor,
  formatInrMinorShort, otherWarnings, provisionalNote, rateSummary,
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

/** A payout run is read for a completed week, so that is the opening range. */
function lastWeek(): Range {
  return (PRESETS.find((p) => p.key === 'last_week') ?? PRESETS[0]).build()
}

// ── Reading the report's untyped rows ─────────────────────────────────────────
//
// The rows come back as plain JSON. These readers keep the casts in one place
// and — importantly — return null rather than 0 for a field that is missing, so
// a shape change shows up as "—" instead of as a confident zero.

function str(row: Record<string, unknown>, key: string): string {
  const v = row[key]
  if (typeof v === 'string') return v
  return v === null || v === undefined ? '' : String(v)
}

function num(row: Record<string, unknown>, key: string): number | null {
  const v = row[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

interface AgencyRun {
  partnerId: string
  name: string
  status: string
  movements: number | null
  earnedMinor: number | null
  paidMinor: number | null
  outstandingMinor: number | null
  lastMovementAt: string
}

function toRun(row: Record<string, unknown>): AgencyRun {
  return {
    partnerId: str(row, 'partner_id'),
    name: str(row, 'name'),
    status: str(row, 'status'),
    movements: num(row, 'movements'),
    earnedMinor: num(row, 'commission_earned_minor'),
    paidMinor: num(row, 'commission_paid_minor'),
    outstandingMinor: num(row, 'commission_outstanding_minor'),
    lastMovementAt: str(row, 'last_movement_at'),
  }
}

interface AgencyHost {
  host_id: string
  beans_earned: number
  movements: number
}

const STATUS_TONE: Record<string, string> = {
  approved: 'bg-green-500/15 text-green-300',
  pending: 'bg-amber-500/15 text-amber-300',
  rejected: 'bg-red-500/15 text-red-300',
  suspended: 'bg-red-500/15 text-red-300',
}

export default function WeeklyPayoutRunsPage() {
  const { crmUser, apiUser, loading: authLoading, apiReady, apiError } = useAuth()
  // The Observer has no Firestore `crmUser` on purpose, so `canAccess` alone
  // locks the one role that exists to watch the money out of the money. The API
  // grants them `can_read_all`; they are admitted here and the API decides the
  // rest. Same pattern as app/reports/page.tsx.
  const isObserver = apiUser?.role === 'observer'
  const allowed = isObserver || canAccess(crmUser, FINANCE_ROLES)

  const [range, setRange] = useState<Range>(lastWeek)
  const [report, setReport] = useState<AnyReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [exportError, setExportError] = useState('')

  // Per-host expansion for the selected agency.
  const [selected, setSelected] = useState<AgencyRun | null>(null)
  const [hosts, setHosts] = useState<AgencyHost[]>([])
  const [hostsLoading, setHostsLoading] = useState(false)
  const [hostsError, setHostsError] = useState('')
  // B1: each host_id is a Firebase uid — named from `users` (names only).
  const hostNames = useIdentities({ people: hosts.map((h) => h.host_id) })

  const load = useCallback(() => {
    if (!allowed || !apiReady) return
    setLoading(true)
    setError('')
    setSelected(null)
    // `/reports/partners/summary` has no wrapper in lib/apiReports; it is called
    // through lib/api and re-typed to the envelope every report actually
    // returns, because lib/api's `ReportEnvelope` predates that shape.
    api.reports
      .partnersSummary({ ...toParams(range), kind: 'agency' })
      .then((r) => setReport(r as unknown as AnyReport))
      .catch((err: unknown) => {
        setReport(null)
        setError(
          err instanceof ApiError
            ? err.message
            : 'The agency payout run could not be produced.',
        )
      })
      .finally(() => setLoading(false))
  }, [allowed, apiReady, range])

  useEffect(() => { load() }, [load])

  function openHosts(run: AgencyRun) {
    if (selected?.partnerId === run.partnerId) {
      setSelected(null)
      return
    }
    setSelected(run)
    setHosts([])
    setHostsError('')
    setHostsLoading(true)
    api.partners
      // Scoped to the week on screen. The endpoint defaults to lifetime, which
      // under a heading that names a week would be silently wrong.
      .agencyHosts(run.partnerId, { since: range.since.toISOString() })
      .then(setHosts)
      .catch((err: unknown) => {
        setHostsError(
          err instanceof ApiError
            ? err.message
            : 'The per-host breakdown could not be loaded.',
        )
      })
      .finally(() => setHostsLoading(false))
  }

  async function exportRun() {
    setBusy('run')
    setExportError('')
    try {
      await downloadReportCsv(
        '/partners/summary',
        { ...toParams(range), kind: 'agency' },
        'agency-payout-run',
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

  async function exportStatement(run: AgencyRun) {
    setBusy(run.partnerId)
    setExportError('')
    try {
      await downloadReportCsv(
        `/agencies/${encodeURIComponent(run.partnerId)}/statement`,
        toParams(range),
        `agency-statement-${run.partnerId}`,
      )
    } catch (err) {
      setExportError(
        err instanceof ApiError
          ? err.message
          : 'The statement export failed and no file was produced.',
      )
    } finally {
      setBusy('')
    }
  }

  const runs = useMemo<AgencyRun[]>(
    () => (report?.rows ?? []).map(toRun),
    [report],
  )

  if (authLoading) return <Loading label="Checking your access…" />
  if (!allowed) return <Denied what="Finance reporting" />

  const totals = report?.totals ?? {}
  const provisional = report ? provisionalNote(report) : null
  const notes = report ? otherWarnings(report) : []
  const rates = report ? rateSummary(report) : null

  const withMovement = num(totals, 'partners_with_movement')
  const onFile = num(totals, 'partners_on_file')
  const silent =
    withMovement === null || onFile === null ? null : onFile - withMovement

  const columns: Column<AgencyRun>[] = [
    {
      key: 'name',
      header: 'Agency',
      render: (r) => (
        <div className="flex items-center gap-2">
          <ChevronRight
            size={13}
            className={`shrink-0 transition-transform ${
              selected?.partnerId === r.partnerId
                ? 'rotate-90 text-pink-400'
                : 'text-slate-600'
            }`}
          />
          <div className="min-w-0">
            <p className="text-white font-medium truncate">{r.name || r.partnerId}</p>
            <p className="text-slate-600 text-xs font-mono truncate">{r.partnerId}</p>
          </div>
        </div>
      ),
      value: (r) => r.name || r.partnerId,
    },
    {
      key: 'status',
      header: 'Status',
      hideOnMobile: true,
      render: (r) =>
        r.status ? (
          <span
            className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${
              STATUS_TONE[r.status] ?? 'bg-slate-700 text-slate-300'
            }`}
          >
            {r.status}
          </span>
        ) : (
          <span className="text-slate-600 text-xs">no partner record</span>
        ),
    },
    {
      key: 'movements',
      header: 'Movements',
      align: 'right',
      hideOnMobile: true,
      value: (r) => r.movements,
      render: (r) => <span className="tabular-nums">{formatCount(r.movements)}</span>,
    },
    {
      key: 'earnedMinor',
      header: 'Earned (INR)',
      align: 'right',
      value: (r) => r.earnedMinor,
      render: (r) => (
        <span className="text-emerald-300 tabular-nums">
          {formatInrMinor(r.earnedMinor)}
        </span>
      ),
    },
    {
      key: 'paidMinor',
      header: 'Paid (INR)',
      align: 'right',
      hideOnMobile: true,
      value: (r) => r.paidMinor,
      render: (r) => (
        <span className="text-orange-300 tabular-nums">{formatInrMinor(r.paidMinor)}</span>
      ),
    },
    {
      key: 'outstandingMinor',
      header: 'Outstanding (INR)',
      align: 'right',
      value: (r) => r.outstandingMinor,
      render: (r) => (
        <span className="text-white font-semibold tabular-nums">
          {formatInrMinor(r.outstandingMinor)}
        </span>
      ),
    },
    {
      key: 'lastMovementAt',
      header: 'Last movement',
      align: 'right',
      hideOnMobile: true,
      value: (r) => r.lastMovementAt,
      render: (r) => (
        <span className="text-slate-500 text-xs whitespace-nowrap">
          {formatDateTime(r.lastMovementAt)}
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
          <h1 className="text-2xl sm:text-3xl font-bold text-white">
            Weekly payout runs
          </h1>
          <p className="text-slate-400 mt-1 text-sm max-w-2xl leading-relaxed">
            One row per agency for{' '}
            <span className="text-slate-200">{range.label.toLowerCase()}</span>. Commission
            is held in paise and shown in rupees (₹). Select a row for the per-host
            breakdown.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <DateRangePicker value={range} onChange={setRange} />
          <button
            onClick={exportRun}
            disabled={busy === 'run'}
            title="Download this week's run as CSV, produced and logged by the API"
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300 rounded-lg px-3.5 py-2.5 text-sm transition-colors whitespace-nowrap"
          >
            {busy === 'run' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Download size={14} />
            )}
            Export this week
          </button>
        </div>
      </div>

      {apiReady && apiError && <Warning>{apiError}</Warning>}
      {exportError && <Warning onDismiss={() => setExportError('')}>{exportError}</Warning>}

      {!apiReady && apiError ? (
        <ErrorState message={apiError} />
      ) : loading || !apiReady ? (
        <Loading label="Producing the payout run…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !report ? (
        <ErrorState message="No payout run came back." onRetry={load} />
      ) : (
        <>
          {provisional && (
            <Warning>
              <span className="font-semibold">These figures are provisional.</span>{' '}
              {provisional}
            </Warning>
          )}

          {report.empty ? (
            <Empty
              title="No data for this period"
              hint={
                report.warnings[0] ??
                'No agency had any movement in this week. Nothing to pay out, which is not the same as every agency being owed zero — use an individual statement for a standing balance.'
              }
            />
          ) : (
            <>
              {/* Roll-up */}
              <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                  <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide mb-2">
                    <Building2 size={13} /> Agencies in this run
                  </div>
                  <p className="text-2xl font-bold text-white tabular-nums">
                    {formatCount(withMovement)}
                  </p>
                  <p className="text-slate-500 text-xs mt-1.5 leading-relaxed">
                    {silent === null
                      ? 'The count of agencies on file did not come back.'
                      : `${formatCount(silent)} of ${formatCount(onFile)} on file had no movement and are not listed. That means no activity, not a zero balance.`}
                  </p>
                </div>

                <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                  <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide mb-2">
                    Commission earned (INR)
                  </div>
                  <p className="text-2xl font-bold text-emerald-300 tabular-nums">
                    {formatInrMinorShort(num(totals, 'credits_total'))}
                  </p>
                  <p className="text-slate-500 text-xs mt-1.5">
                    Positive movements on agency commission balances this week.
                  </p>
                </div>

                <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                  <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide mb-2">
                    Commission paid (INR)
                  </div>
                  <p className="text-2xl font-bold text-orange-300 tabular-nums">
                    {formatInrMinorShort(num(totals, 'debits_total'))}
                  </p>
                  <p className="text-slate-500 text-xs mt-1.5">
                    Negative movements — what was actually settled this week.
                  </p>
                </div>

                <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                  <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide mb-2">
                    Still outstanding (INR)
                  </div>
                  <p className="text-2xl font-bold text-white tabular-nums">
                    {formatInrMinorShort(num(totals, 'closing_total'))}
                  </p>
                  <p className="text-slate-500 text-xs mt-1.5">
                    Closing balance across the agencies that moved.
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

              <section>
                <DataTable<AgencyRun>
                  rows={runs}
                  columns={columns}
                  rowKey={(r) => r.partnerId}
                  searchPlaceholder="Search agency name or id…"
                  searchKeys={['name', 'partnerId', 'status']}
                  onRowClick={openHosts}
                  onExport={exportRun}
                  exportName="agency-payout-run"
                  pageSize={50}
                  emptyTitle="No data for this period"
                  emptyHint="No agency had commission movement in this week."
                />
              </section>

              {/* Per-host expansion */}
              {selected && (
                <section className="bg-slate-900 border border-pink-500/30 rounded-xl overflow-hidden">
                  <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-800">
                    <div className="min-w-0">
                      <h2 className="text-white font-semibold flex items-center gap-2">
                        <Users size={16} className="text-slate-600 shrink-0" />
                        Hosts under {selected.name || selected.partnerId}
                      </h2>
                      <p className="text-slate-500 text-sm mt-1 max-w-3xl leading-relaxed">
                        Beans earned per host, aggregated from the ledger and scoped to{' '}
                        <span className="text-slate-300">{range.label}</span> — the same
                        window as the row above. For the full commission movements behind
                        it, export the agency statement.
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => exportStatement(selected)}
                        disabled={busy === selected.partnerId}
                        className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300 rounded-lg px-3 py-1.5 text-xs transition-colors"
                      >
                        {busy === selected.partnerId ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Download size={12} />
                        )}
                        Statement CSV
                      </button>
                      <button
                        onClick={() => setSelected(null)}
                        className="text-slate-500 hover:text-white"
                        aria-label="Close the host breakdown"
                      >
                        <X size={17} />
                      </button>
                    </div>
                  </div>

                  <div className="px-5 py-4">
                    {hostsLoading ? (
                      <Loading label="Loading the hosts…" />
                    ) : hostsError ? (
                      <ErrorState
                        message={hostsError}
                        onRetry={() => {
                          const target = selected
                          setSelected(null)
                          openHosts(target)
                        }}
                      />
                    ) : hosts.length === 0 ? (
                      <Empty
                        title="No host earnings recorded"
                        hint="No bean movement is attributed to this agency. If that is unexpected, the agency id may not be stamped on the hosts' ledger entries."
                      />
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full">
                          <thead>
                            <tr className="border-b border-slate-800 text-left">
                              <th className="px-3 py-2 text-slate-400 text-xs font-medium uppercase tracking-wide">
                                Host
                              </th>
                              <th className="px-3 py-2 text-slate-400 text-xs font-medium uppercase tracking-wide text-right">
                                Beans earned
                              </th>
                              <th className="px-3 py-2 text-slate-400 text-xs font-medium uppercase tracking-wide text-right">
                                Movements
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {hosts.map((h) => (
                              <tr
                                key={h.host_id}
                                className="border-b border-slate-800/60 last:border-0"
                              >
                                <td className="px-3 py-2.5 text-sm">
                                  <Link
                                    href={`/users/${encodeURIComponent(h.host_id)}`}
                                    title={h.host_id}
                                    className="text-slate-200 hover:text-pink-400 text-xs transition-colors"
                                  >
                                    {nameOrReference(hostNames.people.get(h.host_id), h.host_id, 'host')}
                                  </Link>
                                </td>
                                <td className="px-3 py-2.5 text-sm text-right text-emerald-300 tabular-nums">
                                  {formatCount(h.beans_earned)} beans
                                </td>
                                <td className="px-3 py-2.5 text-sm text-right text-slate-400 tabular-nums">
                                  {formatCount(h.movements)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </section>
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

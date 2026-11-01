'use client'

/**
 * Agency payout reports — the approval queue.
 *
 * The approval flow itself is unchanged: an agency submits a weekly report, a
 * Finance approver accepts or rejects it with a reason, and the decision is
 * written to `weeklyPayoutReports`. That queue lives in Firestore, which is why
 * this page reads it directly.
 *
 * Three things were added, and one was removed.
 *
 * Added — a date range, a search, and an export, none of which existed. Added
 * too: the block at the top of the page listing payout cards that were **signed
 * and never executed**. Approving a report and an owner signing a payout card
 * are two different acts, and the gap between "an owner approved this money"
 * and "the money left" was invisible on every screen. It is the first thing
 * here now.
 *
 * Removed — the page's own idea of what a payout total is. `/reports/payouts`
 * publishes one definition: value that actually left, from executed cards. That
 * figure sits alongside the queue so the two are never confused. The rupee
 * amounts in the queue rows are the amounts the agency reported and the
 * approver is judging; they are labelled as such and are not a payout until a
 * card executes.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, ArrowLeft, CheckCircle2, ChevronRight, Download,
  ExternalLink, Loader2, Users, Wallet, X, XCircle,
} from 'lucide-react'

import { useAuth } from '@/components/AuthProvider'
import { canAccess, CrmRole } from '@/lib/auth'
import api, { ApiError, type Card } from '@/lib/api'
import {
  getWeeklyPayoutReports, getHostPayouts, approvePayoutReport, rejectPayoutReport,
  type WeeklyPayoutReport, type HostPayout,
} from '@/lib/finance'
import { Column, DataTable } from '@/components/ui/DataTable'
import { DateRangePicker, Range, defaultRange, toParams } from '@/components/ui/DateRange'
import { Denied, Empty, ErrorState, Loading, Warning } from '@/components/ui/States'
import {
  PayoutReport,
  downloadReportCsv, formatCount, formatDate, formatDateTime, formatInrMinor,
  formatInrMinorShort, formatNativeAmount, otherWarnings, provisionalNote,
  rateSummary, reports,
} from '@/lib/apiReports'
import { payoutPolicyLines, type PayoutPolicyView } from '@/lib/moneyIntegrity'

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

/** Copied from the reports service — the card types that count as a payout. */
const PAYOUT_CARD_TYPES = [
  'commission_payout',
  'subagency_payout',
  'host_withdrawal',
  'weekly_payout',
  'salary_request',
]

/** The Firestore query behind the queue is capped; say so rather than imply completeness. */
const QUEUE_LIMIT = 200

const STATUS_STYLE: Record<WeeklyPayoutReport['status'], string> = {
  generated: 'bg-slate-700 text-slate-300',
  submitted: 'bg-blue-500/20 text-blue-300',
  approved: 'bg-green-500/20 text-green-300',
  rejected: 'bg-red-500/20 text-red-300',
}

/** When the report is dated. Null means undated — never silently filtered out. */
function reportMillis(r: WeeklyPayoutReport): number | null {
  if (r.createdAt) {
    const ms = r.createdAt.toMillis()
    if (Number.isFinite(ms)) return ms
  }
  if (r.weekEnd) {
    const d = new Date(r.weekEnd)
    if (!Number.isNaN(d.getTime())) return d.getTime()
  }
  return null
}

function ageDays(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 86_400_000
}

// ── Modals ────────────────────────────────────────────────────────────────────

function RejectModal({
  report, busy, onClose, onReject,
}: {
  report: WeeklyPayoutReport
  busy: boolean
  onClose: () => void
  onReject: (reason: string) => void
}) {
  const [reason, setReason] = useState('')
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md p-6 space-y-4 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-white">Reject this report</h2>
            <p className="text-slate-400 text-sm mt-1">
              {report.agencyName} · {report.weekStart} – {report.weekEnd}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white">
            <X size={18} />
          </button>
        </div>
        <div>
          <label className="text-xs text-slate-400 mb-1.5 block">
            Reason (required — the agency sees this)
          </label>
          <textarea
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-red-500 resize-none"
            placeholder="e.g. Host list does not match the beans ledger for this week…"
          />
        </div>
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => reason.trim() && onReject(reason.trim())}
            disabled={busy || !reason.trim()}
            className="flex-1 flex items-center justify-center gap-2 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <XCircle size={14} />}
            Reject
          </button>
        </div>
      </div>
    </div>
  )
}

function ApproveModal({
  report, busy, onClose, onApprove,
}: {
  report: WeeklyPayoutReport
  busy: boolean
  onClose: () => void
  onApprove: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md p-6 space-y-4 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-bold text-white">Approve this report?</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-white">
            <X size={18} />
          </button>
        </div>
        <div className="bg-slate-800 rounded-xl p-4 space-y-1.5 text-sm">
          <div className="flex justify-between gap-3">
            <span className="text-slate-500">Agency</span>
            <span className="text-white font-medium">{report.agencyName}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-slate-500">Week</span>
            <span className="text-slate-200">
              {report.weekStart} – {report.weekEnd}
            </span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-slate-500">Hosts</span>
            <span className="text-slate-200">{formatCount(report.totalHostCount)}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-slate-500">Amount reported</span>
            <span className="text-white font-semibold">
              {formatNativeAmount(report.totalPayout, 'inr')}
            </span>
          </div>
        </div>
        <p className="text-slate-500 text-xs leading-relaxed">
          Approving accepts the agency&rsquo;s figures for this week. It does not move
          money — a payout card still has to be signed and executed before anything
          leaves, and until it does this is not counted as a payout anywhere.
        </p>
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onApprove}
            disabled={busy}
            className="flex-1 flex items-center justify-center gap-2 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
          >
            {busy ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <CheckCircle2 size={14} />
            )}
            Approve
          </button>
        </div>
      </div>
    </div>
  )
}

function HostPayoutsModal({
  report, onClose,
}: {
  report: WeeklyPayoutReport
  onClose: () => void
}) {
  const [payouts, setPayouts] = useState<HostPayout[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true)
    setError('')
    getHostPayouts(report.id)
      .then(setPayouts)
      .catch(() =>
        setError('The host breakdown could not be read. Treat it as unknown, not empty.'),
      )
      .finally(() => setLoading(false))
  }, [report.id])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-2xl p-6 space-y-4 max-h-[80vh] flex flex-col shadow-2xl">
        <div className="flex items-start justify-between gap-3 shrink-0">
          <div>
            <h2 className="text-lg font-bold text-white">
              Host payouts — {report.agencyName}
            </h2>
            <p className="text-slate-500 text-xs mt-0.5">
              {report.weekStart} – {report.weekEnd} · amounts as the agency reported them
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="overflow-y-auto flex-1">
          {loading ? (
            <Loading label="Loading the host breakdown…" />
          ) : error ? (
            <ErrorState message={error} />
          ) : payouts.length === 0 ? (
            <Empty
              title="No host payouts on this report"
              hint="Neither weeklyPayoutReports/{id}/hostPayouts (what the generator writes) nor the legacy top-level hostPayouts holds rows for this report. If the subcollection read was refused by the rules, that reads as empty here too — treat it as unknown."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-left">
                    <th className="px-3 py-2 text-slate-500 font-medium">Host</th>
                    <th className="px-3 py-2 text-slate-500 font-medium text-right">
                      Beans earned
                    </th>
                    <th className="px-3 py-2 text-slate-500 font-medium text-right">
                      Amount reported
                    </th>
                    <th className="px-3 py-2 text-slate-500 font-medium text-right">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {payouts.map((p) => (
                    <tr key={p.id} className="border-b border-slate-800/60 last:border-0">
                      <td className="px-3 py-2.5 text-white font-medium">{p.hostName}</td>
                      <td className="px-3 py-2.5 text-right text-orange-300 tabular-nums">
                        {formatCount(p.beansEarned)} beans
                      </td>
                      <td className="px-3 py-2.5 text-right text-green-300 font-medium tabular-nums">
                        {formatNativeAmount(p.payoutAmount, 'inr')}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${
                            p.status === 'paid'
                              ? 'bg-green-500/20 text-green-300'
                              : 'bg-slate-700 text-slate-400'
                          }`}
                        >
                          {p.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PayoutsPage() {
  const { crmUser, apiUser, loading: authLoading, apiReady, apiError } = useAuth()
  // The Observer has no Firestore `crmUser` on purpose, so `canAccess` alone
  // locks the one role that exists to watch the money out of the money. The API
  // grants them `can_read_all`; they are admitted here and the API decides the
  // rest. Same pattern as app/reports/page.tsx.
  const isObserver = apiUser?.role === 'observer'
  const allowed = isObserver || canAccess(crmUser, FINANCE_ROLES)

  const [range, setRange] = useState<Range>(defaultRange)
  const [status, setStatus] = useState('all')

  const [queue, setQueue] = useState<WeeklyPayoutReport[]>([])
  const [queueLoading, setQueueLoading] = useState(true)
  const [queueError, setQueueError] = useState('')

  const [payoutReport, setPayoutReport] = useState<PayoutReport | null>(null)
  const [stuck, setStuck] = useState<Card[] | null>(null)
  const [apiSideError, setApiSideError] = useState('')
  // The hold between a week closing and its beans becoming withdrawable —
  // read from the server, never restated here (`GET /reports/payout-policy`).
  const [policy, setPolicy] = useState<PayoutPolicyView | null>(null)
  const [policyError, setPolicyError] = useState('')

  const [hostModal, setHostModal] = useState<WeeklyPayoutReport | null>(null)
  const [approveTarget, setApproveTarget] = useState<WeeklyPayoutReport | null>(null)
  const [rejectTarget, setRejectTarget] = useState<WeeklyPayoutReport | null>(null)
  const [acting, setActing] = useState(false)
  const [flash, setFlash] = useState('')
  const [busy, setBusy] = useState('')
  const [exportError, setExportError] = useState('')

  const loadQueue = useCallback(() => {
    if (!allowed) return
    // The queue is a Firestore collection. The Observer signs in to the API
    // with a one-time code and holds no Firebase session at all, so this read
    // cannot succeed for them — attempting it would produce a permissions
    // error that says nothing useful. It is skipped and said out loud instead.
    if (isObserver) {
      setQueue([])
      setQueueLoading(false)
      return
    }
    setQueueLoading(true)
    setQueueError('')
    getWeeklyPayoutReports()
      .then(setQueue)
      .catch(() =>
        setQueueError(
          'The payout report queue could not be read. Nothing below is a count of zero — the list simply did not load.',
        ),
      )
      .finally(() => setQueueLoading(false))
  }, [allowed, isObserver])

  const loadApi = useCallback(() => {
    if (!allowed || !apiReady) return
    setApiSideError('')
    Promise.all([
      reports.payouts(toParams(range)),
      api.cards.list('approved', 200),
    ])
      .then(([p, approved]) => {
        setPayoutReport(p)
        setStuck(approved.filter((c) => PAYOUT_CARD_TYPES.includes(c.type)))
      })
      .catch((err: unknown) => {
        setPayoutReport(null)
        setStuck(null)
        setApiSideError(
          err instanceof ApiError
            ? `The payout report could not be produced: ${err.message}`
            : 'The payout report could not be produced.',
        )
      })
  }, [allowed, apiReady, range])

  const loadPolicy = useCallback(() => {
    if (!allowed || !apiReady) return
    setPolicyError('')
    api.reports.payoutPolicy()
      .then((p) => {
        const view = payoutPolicyLines(p)
        setPolicy(view)
        if (!view) setPolicyError('The server answered without a payout policy.')
      })
      .catch((err: unknown) => {
        setPolicy(null)
        setPolicyError(err instanceof ApiError ? err.message : 'The payout policy could not be read.')
      })
  }, [allowed, apiReady])

  useEffect(() => { loadQueue() }, [loadQueue])
  useEffect(() => { loadApi() }, [loadApi])
  useEffect(() => { loadPolicy() }, [loadPolicy])

  async function doApprove(report: WeeklyPayoutReport) {
    if (!crmUser) return
    setActing(true)
    try {
      await approvePayoutReport(report.id, crmUser.uid)
      setApproveTarget(null)
      setFlash(`Approved ${report.agencyName} for ${report.weekStart} – ${report.weekEnd}.`)
      loadQueue()
    } catch {
      setQueueError('The approval did not go through. Nothing was changed.')
    } finally {
      setActing(false)
    }
  }

  async function doReject(report: WeeklyPayoutReport, reason: string) {
    if (!crmUser) return
    setActing(true)
    try {
      await rejectPayoutReport(report.id, reason, crmUser.uid)
      setRejectTarget(null)
      setFlash(`Rejected ${report.agencyName}. The reason was recorded on the report.`)
      loadQueue()
    } catch {
      setQueueError('The rejection did not go through. Nothing was changed.')
    } finally {
      setActing(false)
    }
  }

  async function exportPayoutReport() {
    setBusy('payouts')
    setExportError('')
    try {
      await downloadReportCsv('/payouts', toParams(range), 'payouts')
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

  const since = range.since.getTime()
  const until = range.until.getTime()

  const inRange = useMemo(
    () =>
      queue.filter((r) => {
        const ms = reportMillis(r)
        // An undated report is kept rather than dropped — hiding it would make
        // the queue look shorter than it is.
        if (ms === null) return true
        return ms >= since && ms <= until
      }),
    [queue, since, until],
  )

  const undated = useMemo(
    () => inRange.filter((r) => reportMillis(r) === null).length,
    [inRange],
  )

  const filtered = useMemo(
    () => (status === 'all' ? inRange : inRange.filter((r) => r.status === status)),
    [inRange, status],
  )

  const counts = useMemo(() => {
    const acc: Record<string, number> = {
      generated: 0, submitted: 0, approved: 0, rejected: 0,
    }
    for (const r of inRange) acc[r.status] = (acc[r.status] ?? 0) + 1
    return acc
  }, [inRange])

  if (authLoading) return <Loading label="Checking your access…" />
  if (!allowed) return <Denied what="payout approvals" />

  // Reaching this screen and being able to act on it are different questions.
  // The Observer is admitted above to read the money and writes nothing at all
  // (spec 1.1.4), so the approve/reject controls are not theirs.
  const canApprove = !isObserver && canAccess(crmUser, FINANCE_ROLES)
  const stuckTotals = (stuck ?? []).reduce<Record<string, number>>((acc, c) => {
    acc[c.currency] = (acc[c.currency] ?? 0) + Math.abs(c.amount)
    return acc
  }, {})

  const columns: Column<WeeklyPayoutReport>[] = [
    {
      key: 'agencyName',
      header: 'Agency',
      render: (r) => (
        <div className="min-w-0">
          <p className="text-white font-medium truncate">{r.agencyName || r.agencyId}</p>
          <p className="text-slate-600 text-xs font-mono truncate">{r.agencyId}</p>
        </div>
      ),
    },
    {
      key: 'weekStart',
      header: 'Week',
      hideOnMobile: true,
      render: (r) => (
        <span className="text-slate-400 text-xs whitespace-nowrap">
          {r.weekStart} → {r.weekEnd}
        </span>
      ),
    },
    {
      key: 'totalHostCount',
      header: 'Hosts',
      align: 'right',
      hideOnMobile: true,
      render: (r) => <span className="tabular-nums">{formatCount(r.totalHostCount)}</span>,
    },
    {
      key: 'totalBeansEarned',
      header: 'Beans',
      align: 'right',
      hideOnMobile: true,
      value: (r) => r.totalBeansEarned,
      render: (r) => (
        <span className="text-orange-300 tabular-nums">
          {formatCount(r.totalBeansEarned)} beans
        </span>
      ),
    },
    {
      key: 'totalPayout',
      header: 'Amount reported (INR)',
      align: 'right',
      value: (r) => r.totalPayout,
      render: (r) => (
        <span className="text-white font-semibold tabular-nums">
          {formatNativeAmount(r.totalPayout, 'inr')}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <div>
          <span
            className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_STYLE[r.status]}`}
          >
            {r.status}
          </span>
          {r.rejectedReason && (
            <p
              className="text-red-400/80 text-xs mt-1 max-w-[160px] truncate"
              title={r.rejectedReason}
            >
              {r.rejectedReason}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'createdAt',
      header: 'Created',
      align: 'right',
      hideOnMobile: true,
      value: (r) => reportMillis(r),
      render: (r) => {
        const ms = reportMillis(r)
        return (
          <span className="text-slate-500 text-xs whitespace-nowrap">
            {ms === null ? 'undated' : formatDate(new Date(ms).toISOString())}
          </span>
        )
      },
    },
    {
      key: 'actions',
      header: 'Actions',
      sortable: false,
      align: 'right',
      render: (r) => (
        <div className="flex items-center justify-end gap-2.5">
          {r.screenshotUrl && (
            <a
              href={r.screenshotUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-1 text-blue-400 hover:text-blue-300 text-xs transition-colors"
            >
              Proof <ExternalLink size={11} />
            </a>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); setHostModal(r) }}
            className="flex items-center gap-1 text-slate-400 hover:text-white text-xs transition-colors"
          >
            <Users size={12} /> Hosts
          </button>
          {r.status === 'submitted' && canApprove && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); setApproveTarget(r) }}
                className="flex items-center gap-1 text-green-400 hover:text-green-300 text-xs transition-colors"
              >
                <CheckCircle2 size={12} /> Approve
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setRejectTarget(r) }}
                className="flex items-center gap-1 text-red-400 hover:text-red-300 text-xs transition-colors"
              >
                <XCircle size={12} /> Reject
              </button>
            </>
          )}
        </div>
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
          <h1 className="text-2xl sm:text-3xl font-bold text-white">Payout approvals</h1>
          <p className="text-slate-400 mt-1 text-sm max-w-2xl leading-relaxed">
            Weekly agency reports awaiting a decision, for{' '}
            <span className="text-slate-200">{range.label.toLowerCase()}</span>. The
            amounts in the queue are what the agency reported, in Indian rupees (₹) —
            they become a payout only when a signed card executes.
          </p>
        </div>
        <div className="shrink-0">
          <DateRangePicker value={range} onChange={setRange} />
        </div>
      </div>

      {apiReady && apiError && <Warning>{apiError}</Warning>}
      {apiSideError && <Warning onDismiss={() => setApiSideError('')}>{apiSideError}</Warning>}

      {/* When a host's week becomes withdrawable — the server's figure, and
          an Owner decision still pending. Shown so a payout question is
          answered against the rule actually in force. */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl px-5 py-4">
        <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">Payout release policy</p>
        {policy ? (
          <>
            <p className="text-white text-sm mt-1">{policy.headline}</p>
            {policy.lines.map((l) => (
              <p key={l} className="text-slate-400 text-xs mt-0.5">{l}</p>
            ))}
            {policy.pending && (
              <p className="text-amber-300 text-xs mt-1.5">
                The settlement policy is still an Owner decision. Until it is made, this is the behaviour in force.
              </p>
            )}
          </>
        ) : policyError ? (
          <p className="text-amber-200 text-sm mt-1">
            {policyError}{' '}
            <button onClick={loadPolicy} className="text-pink-400 hover:text-pink-300 underline underline-offset-2">Try again</button>
          </p>
        ) : (
          <p className="text-slate-500 text-sm mt-1">Reading the policy…</p>
        )}
      </div>
      {exportError && <Warning onDismiss={() => setExportError('')}>{exportError}</Warning>}
      {flash && (
        <div className="flex items-center justify-between gap-3 bg-green-500/10 border border-green-500/30 rounded-xl px-4 py-3">
          <span className="flex items-center gap-2 text-green-300 text-sm">
            <CheckCircle2 size={14} /> {flash}
          </span>
          <button onClick={() => setFlash('')} className="text-green-400 hover:text-green-200">
            <X size={13} />
          </button>
        </div>
      )}

      {/* Signed and never executed — the money that was approved and did not move */}
      {stuck === null ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl px-5 py-4">
          <p className="text-slate-300 text-sm">
            Signed-but-unexecuted payouts could not be read, so whether any exist is
            unknown.
          </p>
          <p className="text-slate-500 text-xs mt-1">
            Deliberately not shown as none.{' '}
            <button
              onClick={loadApi}
              className="text-pink-400 hover:text-pink-300 underline underline-offset-2"
            >
              Try again
            </button>
          </p>
        </div>
      ) : stuck.length > 0 ? (
        <div className="bg-amber-500/10 border border-amber-500/40 rounded-xl p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle size={19} className="text-amber-400 mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-amber-100 font-semibold text-base">
                {stuck.length} payout{stuck.length > 1 ? 's were' : ' was'} signed and
                never executed
              </p>
              <p className="text-amber-100/80 text-sm mt-1 leading-relaxed">
                An owner approved this money and it has not left. It is excluded from
                every payout figure on purpose — money that has not moved is not a payout
                — so this is the only place it appears. If a card sits here, the transfer
                failed or was never attempted.
              </p>
              <div className="flex flex-wrap gap-x-5 gap-y-1 mt-3">
                {Object.entries(stuckTotals).map(([currency, amount]) => (
                  <span key={currency} className="text-amber-200 text-sm font-semibold tabular-nums">
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
                      <span className="text-amber-200/70 tabular-nums">
                        {formatNativeAmount(Math.abs(c.amount), c.currency)} · signed{' '}
                        {formatDateTime(c.signed_at)} ·{' '}
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
      ) : null}

      {/* What actually left, per the API's one definition */}
      <section className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-white">
              What actually left, {range.label.toLowerCase()}
            </h2>
            <p className="text-slate-500 text-sm mt-0.5 max-w-2xl">
              From <code className="text-slate-400">/reports/payouts</code>: executed cards
              only, valued at the rates the report states. This is the one definition of
              &ldquo;payout&rdquo; — the queue above is a different thing and is labelled
              differently on purpose.
            </p>
          </div>
          <button
            onClick={exportPayoutReport}
            disabled={busy === 'payouts'}
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300 rounded-lg px-3.5 py-2 text-sm transition-colors shrink-0"
          >
            {busy === 'payouts' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Download size={14} />
            )}
            Export payouts
          </button>
        </div>

        {!apiReady ? (
          <Loading label="Waiting for the API session…" />
        ) : !payoutReport ? (
          <div className="bg-slate-900 border border-slate-800 rounded-xl px-5 py-4 text-slate-400 text-sm">
            The executed-payout figure is not available right now. It is left blank rather
            than shown as ₹0.
          </div>
        ) : (
          <>
            {provisionalNote(payoutReport) && (
              <Warning>
                <span className="font-semibold">Provisional.</span>{' '}
                {provisionalNote(payoutReport)}
              </Warning>
            )}
            {payoutReport.empty ? (
              <Empty
                title="No data for this period"
                hint={
                  payoutReport.warnings[0] ??
                  'No payout card executed between these dates. Nothing left the business, which is not the same as a payout of zero.'
                }
              />
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
                  <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                    <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide mb-2">
                      <Wallet size={13} /> Payouts (INR)
                    </div>
                    <p className="text-2xl font-bold text-orange-300 tabular-nums">
                      {formatInrMinorShort(payoutReport.totals.payouts_inr_minor)}
                    </p>
                  </div>
                  <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                    <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide mb-2">
                      Cards executed
                    </div>
                    <p className="text-2xl font-bold text-white tabular-nums">
                      {formatCount(payoutReport.totals.cards_executed)}
                    </p>
                  </div>
                  <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                    <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide mb-2">
                      Card types
                    </div>
                    <p className="text-2xl font-bold text-slate-200 tabular-nums">
                      {formatCount(Object.keys(payoutReport.totals.by_card_type).length)}
                    </p>
                  </div>
                </div>

                <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-slate-800 text-left">
                          <th className="px-4 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide">
                            Card type
                          </th>
                          <th className="px-4 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide text-right">
                            Cards
                          </th>
                          <th className="px-4 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide text-right hidden sm:table-cell">
                            Native amount
                          </th>
                          <th className="px-4 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide text-right">
                            Value (INR)
                          </th>
                          <th className="px-4 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide hidden lg:table-cell">
                            Rate applied
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {payoutReport.rows.map((r) => (
                          <tr
                            key={`${r.card_type}-${r.currency}`}
                            className="border-b border-slate-800/60 last:border-0"
                          >
                            <td className="px-4 py-3 text-sm text-white capitalize">
                              {r.card_type.replace(/_/g, ' ')}
                            </td>
                            <td className="px-4 py-3 text-sm text-right text-slate-300 tabular-nums">
                              {formatCount(r.cards)}
                            </td>
                            <td className="px-4 py-3 text-sm text-right text-slate-400 tabular-nums hidden sm:table-cell">
                              {formatNativeAmount(r.amount_native, r.currency)}
                            </td>
                            <td className="px-4 py-3 text-sm text-right text-orange-300 font-semibold tabular-nums">
                              {formatInrMinor(r.inr_minor)}
                            </td>
                            <td className="px-4 py-3 text-xs text-slate-500 hidden lg:table-cell">
                              {r.rate_applied}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {otherWarnings(payoutReport).map((w, i) => (
                  <Warning key={i}>{w}</Warning>
                ))}

                {rateSummary(payoutReport) && (
                  <p className="text-slate-600 text-xs">
                    {rateSummary(payoutReport)} Period {payoutReport.period.bounds}.
                  </p>
                )}
              </>
            )}
          </>
        )}
      </section>

      {/* The approval queue */}
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Approval queue</h2>
          <p className="text-slate-500 text-sm mt-0.5 max-w-2xl">
            Reports the agencies submitted, dated by creation where they carry one and by
            week end otherwise. Search matches agency name, id, week and status.
            {undated > 0 && (
              <>
                {' '}
                <span className="text-amber-300">
                  {undated} report{undated > 1 ? 's carry' : ' carries'} no date and{' '}
                  {undated > 1 ? 'are' : 'is'} shown regardless of the range.
                </span>
              </>
            )}
          </p>
        </div>

        {isObserver ? (
          <Warning>
            This queue is held in Firestore, and the Observer account signs in to
            the API only — it holds no Firebase session, so the list cannot be
            read for you. Every figure above came from the API and is complete;
            this one queue is not shown rather than shown wrong. A finance admin
            can say what is sitting in it.
          </Warning>
        ) : (
        <DataTable<WeeklyPayoutReport>
          rows={filtered}
          columns={columns}
          rowKey={(r) => r.id}
          loading={queueLoading}
          error={queueError || undefined}
          onRetry={loadQueue}
          searchPlaceholder="Search agency, week or status…"
          searchKeys={['agencyName', 'agencyId', 'weekStart', 'weekEnd', 'status']}
          filters={[
            {
              key: 'status',
              label: 'Status',
              options: [
                { value: 'submitted', label: 'Submitted', count: counts.submitted },
                { value: 'generated', label: 'Generated', count: counts.generated },
                { value: 'approved', label: 'Approved', count: counts.approved },
                { value: 'rejected', label: 'Rejected', count: counts.rejected },
              ],
            },
          ]}
          activeFilters={{ status }}
          onFilterChange={(_key, value) => setStatus(value)}
          exportName="agency-payout-reports"
          pageSize={25}
          truncatedAt={QUEUE_LIMIT}
          emptyTitle="No payout reports in this range"
          emptyHint="Nothing was submitted or generated between these dates. Widen the range or clear the status filter."
        />
        )}
      </section>

      {hostModal && (
        <HostPayoutsModal report={hostModal} onClose={() => setHostModal(null)} />
      )}
      {approveTarget && (
        <ApproveModal
          report={approveTarget}
          busy={acting}
          onClose={() => setApproveTarget(null)}
          onApprove={() => doApprove(approveTarget)}
        />
      )}
      {rejectTarget && (
        <RejectModal
          report={rejectTarget}
          busy={acting}
          onClose={() => setRejectTarget(null)}
          onReject={(reason) => doReject(rejectTarget, reason)}
        />
      )}
    </div>
  )
}

'use client'

/**
 * The report queue.
 *
 * Deciding a report used to write the word "ban" into a text field and stop
 * there: the queue recorded decisions that were never enforced, and the person
 * who reported an account was told it had been dealt with when nothing had
 * happened to it. Every decision here calls the API, which carries it out — so
 * the buttons say what they will actually do to the reported user.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, Check, Loader2, ShieldAlert, X,
} from 'lucide-react'
import api, {
  ApiError, type ReportAction, type ReportOutcome, type ReportStatus, type UserReport,
} from '@/lib/api'
import { DataTable, type Column } from '@/components/ui/DataTable'
import { Denied, Loading } from '@/components/ui/States'
import { useAuth } from '@/components/AuthProvider'
import { canAccess, type CrmRole } from '@/lib/auth'
import { normaliseDaysInput, suspensionPreview, suspensionProblem } from '@/lib/suspensionTerm'
import { formatIst } from '@/lib/istTime'  // QA #54: shown in IST, stored in UTC

const VIEW_ROLES: CrmRole[] = [
  'superadmin', 'ops_admin', 'ops_member', 'app_admin', 'app_member', 'support_admin',
]

/** The API caps a read at 500; ask for a page of that and say when it is full. */
const LIMIT = 200

type StatusFilter = 'all' | ReportStatus

interface Decision {
  action: ReportAction
  label: string
  /** What happens to the reported user, in those words. */
  effect: string
  tone: string
  /** A quantity this action needs before it can be carried out. */
  needs?: 'days' | 'beans'
}

/**
 * The five outcomes.
 *
 * Deliberately not ranked, and none of them is the default: severity is the
 * reviewer's judgement, not the queue's. A first rude message and a scam both
 * arrive here as "a report", and a queue that nudges towards one answer is a
 * queue that makes that answer for you.
 */
const DECISIONS: Decision[] = [
  {
    action: 'ban',
    label: 'Ban',
    effect: 'This will ban the reported user. They are locked out of the app immediately.',
    tone: 'bg-red-500/10 border-red-500/40 text-red-300',
  },
  {
    action: 'suspend',
    label: 'Suspend',
    effect:
      'This will suspend the reported user. It is enforced as a ban. Give a number of days and it lifts itself on the first daily run after it expires; leave it blank and it stays in force until somebody lifts it by hand.',
    tone: 'bg-yellow-500/10 border-yellow-500/40 text-yellow-300',
    needs: 'days',
  },
  {
    action: 'deduct',
    label: 'Deduct beans',
    effect:
      'This does NOT take the beans now. It raises a card on the money board for an owner to sign, and the beans leave the account when they do — the same path as every other movement of value. You will be able to follow it on the board.',
    tone: 'bg-orange-500/10 border-orange-500/40 text-orange-200',
    needs: 'beans',
  },
  {
    action: 'warn',
    label: 'Warn',
    effect:
      'This records a formal warning against the reported user, in your name. Their access is unchanged.',
    tone: 'bg-amber-500/10 border-amber-500/40 text-amber-200',
  },
  {
    action: 'dismiss',
    label: 'Dismiss',
    effect:
      'This closes the report. Nothing happens to the reported user. Use it when the report does not hold up — the reason is kept, and a pattern of dismissed reports against one person, or from one reporter, is itself worth seeing.',
    tone: 'bg-slate-700/40 border-slate-600 text-slate-200',
  },
]

const STATUS_TONES: Record<string, string> = {
  pending: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  reviewed: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  actioned: 'bg-green-500/20 text-green-300 border-green-500/30',
  dismissed: 'bg-slate-700 text-slate-300 border-slate-600',
}

function fmt(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  return isNaN(d.getTime()) ? '—' : formatIst(d)
}

function millis(value: string | null | undefined): number | null {
  if (!value) return null
  const d = new Date(value)
  return isNaN(d.getTime()) ? null : d.getTime()
}

/**
 * How long this has been sitting there, said in the form people actually ask
 * it: "3d ago". A queue with only absolute timestamps hides its own backlog —
 * you cannot see that the oldest pending report is three weeks old.
 */
function age(value: string | null | undefined): string {
  const t = millis(value)
  if (t == null) return 'unknown'
  const secs = Math.max(Math.floor((Date.now() - t) / 1000), 0)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

/** Anything older than this in the pending queue is called out, not just shown. */
const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000

function isStale(value: string | null | undefined): boolean {
  const t = millis(value)
  return t != null && Date.now() - t > STALE_AFTER_MS
}

const TABS: { key: StatusFilter; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'reviewed', label: 'Reviewed' },
  { key: 'actioned', label: 'Actioned' },
  { key: 'dismissed', label: 'Dismissed' },
  { key: 'all', label: 'All' },
]

export default function ReportsPage() {
  const { crmUser, loading: authLoading } = useAuth()
  const canView = canAccess(crmUser, VIEW_ROLES)

  const [status, setStatus] = useState<StatusFilter>('pending')
  const [reports, setReports] = useState<UserReport[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [target, setTarget] = useState<UserReport | null>(null)
  const [decision, setDecision] = useState<ReportAction>('dismiss')
  const [reason, setReason] = useState('')
  /** Quantities. Strings, so an empty box stays empty rather than becoming 0. */
  const [days, setDays] = useState('')
  const [beans, setBeans] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ message: string; isRule: boolean } | null>(null)
  const [outcome, setOutcome] = useState<ReportOutcome | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setReports(await api.users.reports(status === 'all' ? undefined : status, LIMIT))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the report queue.')
    } finally {
      setLoading(false)
    }
  }, [status])

  useEffect(() => {
    if (!canView) return
    load()
  }, [canView, load])

  function open(report: UserReport) {
    setTarget(report)
    setDecision('dismiss')
    setReason('')
    setDays('')
    setBeans('')
    setFailure(null)
    setOutcome(null)
  }

  async function submit() {
    if (!target) return
    const why = reason.trim()
    if (why.length < 3) {
      setFailure({
        message: 'A reason of at least 3 characters is required — it is what the audit log stores.',
        isRule: true,
      })
      return
    }

    // The quantity is checked here as well as on the server, because the
    // server's refusal costs a round trip and this one can point at the field.
    const chosen = DECISIONS.find((d) => d.action === decision)
    const extra: { days?: number; beans?: number } = {}
    if (chosen?.needs === 'beans') {
      const n = Number(beans)
      if (!Number.isInteger(n) || n < 1) {
        setFailure({
          message: 'Say how many beans to take back — a whole number, one or more.',
          isRule: true,
        })
        return
      }
      extra.beans = n
    }
    if (chosen?.needs === 'days' && days.trim() !== '') {
      const n = Number(days)
      if (!Number.isInteger(n) || n < 1 || n > 365) {
        setFailure({
          message: 'A suspension runs from 1 to 365 days. Leave it blank for "until lifted by hand".',
          isRule: true,
        })
        return
      }
      extra.days = n
    }

    setBusy(true)
    setFailure(null)
    try {
      const result = await api.users.actionReport(target.id, decision, why, extra)
      setOutcome(result)
      setTarget(null)
      await load()
    } catch (err) {
      setFailure(
        err instanceof ApiError
          ? { message: err.message, isRule: err.isRule }
          : { message: 'That did not work. Try again.', isRule: false },
      )
    } finally {
      setBusy(false)
    }
  }

  const columns = useMemo<Column<UserReport>[]>(() => [
    {
      key: 'targetName',
      header: 'Reported',
      value: (r) => r.targetName || r.targetUid || '',
      render: (r) => (
        <div className="min-w-0">
          {r.targetUid ? (
            <Link
              href={`/users/${r.targetUid}`}
              className="text-white font-medium hover:text-pink-400 transition-colors"
            >
              {r.targetName || r.targetUid}
            </Link>
          ) : (
            <span className="text-slate-400">Nobody named</span>
          )}
          {r.targetType && <p className="text-slate-500 text-xs">{r.targetType}</p>}
        </div>
      ),
    },
    {
      key: 'reporterName',
      header: 'Reported by',
      hideOnMobile: true,
      value: (r) => r.reporterName || r.reporterUid || '',
      render: (r) => <span className="text-slate-300">{r.reporterName || r.reporterUid || '—'}</span>,
    },
    {
      key: 'reason',
      header: 'Why',
      render: (r) => (
        <div className="max-w-[260px]">
          <p className="text-slate-200 truncate">{r.reason || '—'}</p>
          {r.description && <p className="text-slate-500 text-xs truncate">{r.description}</p>}
        </div>
      ),
    },
    {
      key: 'createdAt',
      header: 'Age',
      // Sorted on the timestamp, not on the words — "3d ago" would sort as text.
      value: (r) => millis(r.createdAt),
      render: (r) => (
        <div className="whitespace-nowrap">
          <p
            className={`text-xs font-medium ${
              r.status === 'pending' && isStale(r.createdAt) ? 'text-amber-300' : 'text-slate-200'
            }`}
          >
            {age(r.createdAt)}
          </p>
          <p className="text-slate-500 text-[11px]">{fmt(r.createdAt)}</p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <span
          className={`px-2 py-0.5 border rounded-full text-[11px] font-medium ${
            STATUS_TONES[r.status ?? 'pending'] ?? STATUS_TONES.pending
          }`}
        >
          {r.status ?? 'pending'}
        </span>
      ),
    },
    {
      key: 'actionTaken',
      header: 'Outcome',
      hideOnMobile: true,
      value: (r) => r.actionTaken ?? '',
      render: (r) =>
        r.actionTaken ? (
          <div className="max-w-[220px]">
            <p className="text-slate-200 text-xs font-medium">{r.actionTaken}</p>
            <p className="text-slate-500 text-xs truncate">
              {r.reviewedByName || r.reviewedBy || 'unknown'} · {fmt(r.reviewedAt)}
            </p>
            {r.reviewReason && <p className="text-slate-500 text-xs truncate">{r.reviewReason}</p>}
          </div>
        ) : (
          <span className="text-slate-600">not decided</span>
        ),
    },
    {
      key: 'decide',
      header: '',
      sortable: false,
      align: 'right',
      render: (r) => (
        <button
          onClick={() => open(r)}
          className="inline-flex items-center gap-1.5 bg-pink-500/15 hover:bg-pink-500/25 border border-pink-500/30 text-pink-300 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap"
        >
          <ShieldAlert size={13} /> Decide
        </button>
      ),
    },
  ], [])

  const chosen = DECISIONS.find((d) => d.action === decision) ?? DECISIONS[3]

  if (authLoading) return <Loading label="Checking your access…" />
  if (!canView) return <Denied what="the report queue" />

  return (
    <div className="max-w-[1400px] mx-auto">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white">Reports</h1>
          <p className="text-slate-400 text-sm mt-1">
            A decision here is carried out. Choosing ban bans the reported account.
          </p>
        </div>
        <Link
          href="/moderation"
          className="text-pink-400 hover:text-pink-300 text-sm underline underline-offset-2"
        >
          Open the combined moderation queue
        </Link>
      </div>

      {outcome && (
        <div className="flex items-start justify-between gap-3 bg-green-500/10 border border-green-500/30 rounded-xl px-4 py-3 mb-4">
          <div className="flex items-start gap-2">
            <Check size={15} className="text-green-400 mt-0.5 shrink-0" />
            <div className="text-green-100 text-sm">
              Report {outcome.status}, decision <strong>{outcome.action}</strong>.{' '}
              {outcome.action === 'deduct' ? (
                <>
                  Nothing has been taken yet — this raised a card on the{' '}
                  <Link
                    href="/board"
                    className="text-green-300 underline underline-offset-2 hover:text-white"
                  >
                    money board
                  </Link>
                  , and the beans leave{' '}
                  {outcome.target_uid ? (
                    <Link
                      href={`/users/${outcome.target_uid}`}
                      className="text-green-300 underline underline-offset-2 hover:text-white"
                    >
                      the account
                    </Link>
                  ) : (
                    'the account'
                  )}{' '}
                  when an owner signs it.
                </>
              ) : outcome.enforced && outcome.target_uid ? (
                <>
                  It was carried out against{' '}
                  <Link
                    href={`/users/${outcome.target_uid}`}
                    className="text-green-300 underline underline-offset-2 hover:text-white"
                  >
                    the reported account
                  </Link>
                  .
                </>
              ) : (
                'Nothing was done to the reported account.'
              )}
            </div>
          </div>
          <button onClick={() => setOutcome(null)} className="text-green-400/70 hover:text-green-200">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Status tabs. Each one is a separate request to the API, so a tab shows
          every report in that state, not the ones that fitted on a page. */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 mb-4 border-b border-slate-800">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setStatus(t.key)}
            className={`px-3 sm:px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
              status === t.key
                ? 'border-pink-500 text-white'
                : 'border-transparent text-slate-400 hover:text-white'
            }`}
          >
            {t.label}
            {status === t.key && !loading && !error && (
              <span className="ml-2 px-1.5 py-0.5 rounded bg-pink-500/20 text-pink-200 text-[10px] tabular-nums">
                {reports.length}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="flex items-start gap-2 bg-red-500/5 border border-red-500/25 rounded-xl px-4 py-3 mb-4">
        <ShieldAlert size={15} className="text-red-400 mt-0.5 shrink-0" />
        <p className="text-red-100/90 text-sm">
          <strong>Deciding a report carries the decision out.</strong> Choosing ban bans the reported
          user, choosing suspend locks them out, choosing warn puts a warning on their account. This
          did not used to be true — the old queue wrote a label and did nothing — so do not expect
          the decision to be a note for somebody else to act on.
        </p>
      </div>

      <DataTable
        rows={reports}
        columns={columns}
        rowKey={(r) => r.id}
        loading={loading}
        error={error}
        onRetry={load}
        searchPlaceholder="Search the loaded queue by reported user, reporter or reason…"
        searchKeys={['targetName', 'reporterName', 'reason']}
        exportName="reports"
        truncatedAt={LIMIT}
        emptyTitle={status === 'all' ? 'No reports' : `No ${status} reports`}
        emptyHint="Reports arrive from the app when a user reports another account."
      />

      {target && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setTarget(null)} />
          <div className="relative w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3 px-6 py-4 border-b border-slate-800">
              <div>
                <h2 className="text-white font-semibold">Decide this report</h2>
                <p className="text-slate-500 text-xs mt-0.5">
                  {target.targetName || target.targetUid || 'no account named'}
                </p>
              </div>
              <button onClick={() => setTarget(null)} className="text-slate-500 hover:text-white">
                <X size={18} />
              </button>
            </div>

            <div className="px-6 py-5 space-y-4">
              <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-4 space-y-1.5 text-sm">
                <Row label="Reported" value={target.targetName || target.targetUid || '—'} />
                <Row label="Reported by" value={target.reporterName || target.reporterUid || '—'} />
                <Row label="Reason" value={target.reason || '—'} />
                {target.description && <Row label="Detail" value={target.description} />}
                <Row label="Received" value={fmt(target.createdAt)} />
              </div>

              {!target.targetUid && (
                <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3">
                  <AlertTriangle size={15} className="text-amber-400 mt-0.5 shrink-0" />
                  <p className="text-amber-100 text-sm">
                    This report does not name an account, so only dismissing it can succeed. The
                    other choices are left here so the API can tell you that itself.
                  </p>
                </div>
              )}

              <div>
                <p className="text-slate-400 text-xs font-medium mb-2">What should happen</p>
                <div className="grid grid-cols-2 gap-2">
                  {DECISIONS.map((d) => (
                    <button
                      key={d.action}
                      onClick={() => setDecision(d.action)}
                      className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                        decision === d.action ? d.tone : 'bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-600'
                      }`}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
                <p className="text-slate-300 text-sm mt-3 leading-relaxed">{chosen.effect}</p>

                {/* The quantity the chosen action needs. Rendered only for that
                    action — the server refuses a `days` on a warning rather
                    than ignoring it, so offering the box would be offering a
                    refusal. */}
                {chosen.needs === 'days' && (
                  <div className="mt-3">
                    <label className="block text-slate-400 text-xs font-medium mb-1.5">
                      For how many days? <span className="text-slate-600">(optional)</span>
                    </label>
                    <input
                      value={days}
                      onChange={(e) => setDays(normaliseDaysInput(e.target.value))}
                      inputMode="numeric"
                      placeholder="Blank = until somebody lifts it by hand"
                      className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm placeholder-slate-600 focus:outline-none focus:border-yellow-500"
                    />
                    <p className="text-slate-600 text-xs mt-1">
                      1 to 365. It lifts on the first daily run after it expires,
                      so give or take a few hours — not to the minute.
                    </p>
                    {/* QA #52: what the decision will do, before it is made — the
                        end in IST, or that it has none. */}
                    <p className="text-xs rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-slate-200 mt-2">
                      {suspensionPreview({ timed: days.trim() !== '', days })
                        ?? suspensionProblem({ timed: true, days })}
                    </p>
                  </div>
                )}

                {chosen.needs === 'beans' && (
                  <div className="mt-3">
                    <label className="block text-slate-400 text-xs font-medium mb-1.5">
                      How many beans? <span className="text-pink-400">(required)</span>
                    </label>
                    <input
                      value={beans}
                      onChange={(e) => setBeans(e.target.value.replace(/[^0-9]/g, ''))}
                      inputMode="numeric"
                      placeholder="e.g. 5000"
                      className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm placeholder-slate-600 focus:outline-none focus:border-orange-500"
                    />
                    <p className="text-slate-600 text-xs mt-1">
                      A positive number — it is subtracted. Nothing moves until an
                      owner signs the card this raises.
                    </p>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-slate-400 text-xs font-medium mb-1.5">
                  Reason <span className="text-pink-400">(required)</span>
                </label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  autoFocus
                  placeholder="What you found, and why this is the right call…"
                  className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2.5 text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 resize-none"
                />
                <p className="text-slate-600 text-xs mt-1">
                  At least 3 characters. It is stored against both the report and the account.
                </p>
              </div>

              {failure && (
                <div
                  className={`flex items-start gap-2 rounded-lg px-4 py-3 border ${
                    failure.isRule
                      ? 'bg-amber-500/10 border-amber-500/30'
                      : 'bg-red-500/10 border-red-500/30'
                  }`}
                >
                  <AlertTriangle
                    size={15}
                    className={`mt-0.5 shrink-0 ${failure.isRule ? 'text-amber-400' : 'text-red-400'}`}
                  />
                  <div className={failure.isRule ? 'text-amber-100 text-sm' : 'text-red-200 text-sm'}>
                    <p className="font-medium">{failure.isRule ? 'Refused' : 'Could not complete that'}</p>
                    <p className="mt-0.5">{failure.message}</p>
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-3 px-6 py-4 border-t border-slate-800">
              <button
                onClick={() => setTarget(null)}
                className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={busy}
                className="flex-1 flex items-center justify-center gap-2 bg-pink-500 hover:bg-pink-600 disabled:opacity-50 text-white rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors"
              >
                {busy ? (
                  <><Loader2 size={15} className="animate-spin" /> Working…</>
                ) : (
                  <><ShieldAlert size={15} /> {chosen.label} and close the report</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="text-slate-500 min-w-[92px] shrink-0">{label}</span>
      <span className="text-slate-200 break-words">{value}</span>
    </div>
  )
}

'use client'

/**
 * Exception alerts — spec 8A.4, plus the two conditions 8A.2 raises the same way.
 *
 * Three different questions are answered here and they are deliberately not
 * merged into one list, because the answers differ:
 *
 *   **Open now** (`/alerts/open`) — what is true at this moment, computed by
 *   running every detector without sending anything. A detector that could not
 *   run is `failed` and a detector that cannot apply here is `not_applicable`.
 *   Neither is "clear", and neither is counted as clear on this page.
 *
 *   **Raised** (`/alerts/raised`) — the suppression state, read directly. This
 *   is the record that answers "I was not told". It carries when the condition
 *   was first seen, when it was last emailed, how many times it has recurred,
 *   and the fingerprint that decides whether a change re-alerts immediately.
 *
 *   **Watched** (`/alerts`) — the catalogue: every detector, its threshold, the
 *   setting that would change that threshold, and who is told.
 *
 * A raised row carries no severity — severity belongs to the detector, so it is
 * joined on `alert`, which is the detector id. Reading it off the row would
 * have produced a blank column that looked like "no severity recorded".
 *
 * Unresolved is the loud state. A condition that is open *and* raised is being
 * suppressed as a repeat right now; that is the one somebody has to act on, and
 * clearing it is what lets it alert again once it recurs.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, BellRing, CheckCircle2, ExternalLink, Eye, HelpCircle, Loader2,
  RefreshCw, ShieldQuestion, Siren, Trash2,
} from 'lucide-react'

import { useAuth } from '@/components/AuthProvider'
import { ApiError, type ApiRole } from '@/lib/api'
import { Column, DataTable } from '@/components/ui/DataTable'
import { DateRangePicker, Range, defaultRange } from '@/components/ui/DateRange'
import { Denied, ErrorState, Loading, Warning } from '@/components/ui/States'
import {
  AlertCatalogue, AlertDetector, OpenAlerts, OpenFinding, RaisedAlert,
  formatCount, formatDateTime, notifications,
} from '@/lib/apiReports'

const MIN_REASON = 8

// ── Authority ─────────────────────────────────────────────────────────────────
//
// `/alerts`, `/alerts/raised` and `/alerts/open` are `require_internal` and then
// `_require_oversight` (backend/app/routers/notifications.py:59, 434, 450, 464)
// — owners, the Observer and team admins. `DELETE /alerts/raised/{key}` is
// `require_owner` (:482), so releasing is owners only.

function isTeamAdmin(role: ApiRole): boolean {
  return role.endsWith('_admin')
}

function canRead(role: ApiRole): boolean {
  return role === 'owner' || role === 'observer' || isTeamAdmin(role)
}

// ── Linking a finding through to the record it concerns ───────────────────────
//
// Every key below is one that a detector actually puts on `Finding.meta` in
// `backend/app/services/alerts.py`. Nothing is guessed from a name: a meta key
// that is not listed here gets no link rather than a broken one.

interface Through {
  href: string
  label: string
}

function linkFor(meta: Record<string, unknown> | undefined): Through | null {
  if (!meta) return null
  const str = (k: string): string =>
    typeof meta[k] === 'string' ? (meta[k] as string) : ''

  // 8A.4.4 / 8A.4.5 / 8A.4.7 — a card. The CRM has no per-card route; the money
  // board is where a card is opened.
  if (str('card_id')) return { href: '/board', label: 'On the money board' }
  // 8A.4.3 — a duplicate payment reference across several cards.
  if (Array.isArray(meta.card_ids) && meta.card_ids.length > 0) {
    return { href: '/board', label: `${meta.card_ids.length} cards on the board` }
  }
  // 8A.2.11 — a seller's overdue credit.
  if (str('seller_id')) return { href: `/sellers/${str('seller_id')}`, label: 'Seller' }
  // 8A.4.1 / 8A.4.8 — an audit entry.
  if (str('audit_id')) return { href: '/audit', label: 'Audit log' }
  // 8A.4.9 — repeated failed sign-ins on a staff account.
  if (str('account')) return { href: '/team-access', label: 'Team access' }
  if (str('uid')) return { href: '/team-access', label: 'Team access' }
  // 8A.2.15 — undelivered mail.
  if (typeof meta.by_outcome === 'object' && meta.by_outcome !== null) {
    return { href: '/tech/email', label: 'Delivery log' }
  }
  // 8A.4.2 — the economy rate feed.
  if (str('rate_key') || str('source')) return { href: '/economy/config', label: 'Economy config' }
  return null
}

function Severity({ value }: { value: string | undefined }) {
  if (!value) {
    return (
      <span className="text-slate-600 text-xs" title="No detector matched this row's alert id.">
        unknown
      </span>
    )
  }
  const skin =
    value === 'critical'
      ? 'bg-red-500/15 text-red-300 border-red-500/30'
      : 'bg-amber-500/15 text-amber-200 border-amber-500/30'
  return (
    <span className={`inline-block border rounded px-1.5 py-0.5 text-xs font-medium ${skin}`}>
      {value}
    </span>
  )
}

function StatusPill({ status }: { status: string }) {
  const skin =
    status === 'ok'
      ? 'bg-red-500/15 text-red-300 border-red-500/30'
      : status === 'failed'
        ? 'bg-orange-500/15 text-orange-200 border-orange-500/30'
        : 'bg-slate-700/50 text-slate-300 border-slate-600'
  const label =
    status === 'ok'
      ? 'true now'
      : status === 'failed'
        ? 'did not run'
        : status === 'not_applicable'
          ? 'cannot apply here'
          : status
  return (
    <span className={`inline-block border rounded px-1.5 py-0.5 text-xs font-medium ${skin}`}>
      {label}
    </span>
  )
}

// ── Release ───────────────────────────────────────────────────────────────────

function ReleaseModal({
  alertKey, busy, error, onClose, onRelease,
}: {
  alertKey: string
  busy: boolean
  error: string
  onClose: () => void
  onRelease: () => void
}) {
  const [reason, setReason] = useState('')
  const ready = reason.trim().length >= MIN_REASON

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-start justify-center overflow-y-auto p-4 sm:p-8">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg">
        <div className="px-6 py-4 border-b border-slate-800">
          <h3 className="text-white font-semibold">Clear this raised condition</h3>
          <p className="text-slate-500 text-sm mt-1 leading-relaxed">
            <code className="text-slate-400 break-all">{alertKey}</code>
          </p>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3.5 py-3">
            <p className="text-amber-100 text-sm leading-relaxed">
              This forgets the suppression state for this condition. It does not
              fix anything and it does not close anything — it means the next scan
              that finds the condition still true will email about it again.
              Clear it <span className="font-semibold">after</span> the underlying
              problem is dealt with, not instead of dealing with it.
            </p>
          </div>

          <div>
            <label className="block text-slate-400 text-xs font-medium uppercase tracking-wide mb-1.5">
              What was done about it?
              <span className="text-pink-400 ml-1 normal-case">(required)</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Bank confirmed one transfer, the duplicate card was rejected with a reason."
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
            />
            <p className="text-slate-600 text-xs mt-1 leading-relaxed">
              At least {MIN_REASON} characters. The release endpoint takes a key
              and nothing else — there is no field on it for this reason, so it
              stays on this screen. Record it wherever the fix is recorded.
            </p>
          </div>

          {error && (
            <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3.5 py-3">
              <AlertTriangle size={15} className="text-red-400 mt-0.5 shrink-0" />
              <p className="text-red-300 text-sm leading-relaxed">{error}</p>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-800 flex gap-3">
          <button
            onClick={onClose}
            disabled={busy}
            className="text-slate-400 hover:text-white text-sm px-4 py-2.5 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={onRelease}
            disabled={busy || !ready}
            title={ready ? undefined : `Say what was done, in at least ${MIN_REASON} characters.`}
            className="flex-1 flex items-center justify-center gap-2 bg-red-600 hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-lg px-4 py-2.5 text-sm transition-colors"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
            Clear it — let it alert again
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

type Slot<T> =
  | { status: 'loading' }
  | { status: 'ok'; value: T }
  | { status: 'error'; message: string }

type Tab = 'open' | 'raised' | 'watched'

export default function AlertsPage() {
  const { apiUser, apiReady, apiError, loading: authLoading } = useAuth()

  const [tab, setTab] = useState<Tab>('open')
  const [open, setOpen] = useState<Slot<OpenAlerts>>({ status: 'loading' })
  const [raised, setRaised] = useState<Slot<RaisedAlert[]>>({ status: 'loading' })
  const [cat, setCat] = useState<Slot<AlertCatalogue>>({ status: 'loading' })

  const [range, setRange] = useState<Range>(defaultRange)
  const [detectorFilter, setDetectorFilter] = useState('all')
  const [severityFilter, setSeverityFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')

  const [releasing, setReleasing] = useState<string | null>(null)
  const [releaseBusy, setReleaseBusy] = useState(false)
  const [releaseError, setReleaseError] = useState('')
  const [released, setReleased] = useState('')

  const role = apiUser?.role ?? null
  const allowed = role !== null && canRead(role)
  const mayRelease = role === 'owner'

  const load = useCallback(() => {
    if (!allowed || !apiReady) return

    function run<T>(p: Promise<T>, set: (s: Slot<T>) => void, what: string) {
      set({ status: 'loading' })
      p.then((value) => set({ status: 'ok', value })).catch((err: unknown) =>
        set({
          status: 'error',
          message: err instanceof ApiError ? err.message : `The ${what} could not be read.`,
        }),
      )
    }

    // Deliberately three independent fetches. `/alerts/open` runs every detector
    // and is the slow one; a failure there must not take the catalogue and the
    // raised history down with it.
    run(notifications.alertsOpen(), setOpen, 'open exceptions')
    run(notifications.alertsRaised({ limit: 500 }).then((r) => r.raised), setRaised, 'alert history')
    run(notifications.alertCatalogue(), setCat, 'detector catalogue')
  }, [allowed, apiReady])

  useEffect(() => { load() }, [load])

  const detectors = cat.status === 'ok' ? cat.value.detectors : []
  const byId = useMemo(() => {
    const m = new Map<string, AlertDetector>()
    detectors.forEach((d) => m.set(d.id, d))
    return m
  }, [detectors])

  const detectorOptions = useMemo(
    () => detectors.map((d) => ({ value: d.id, label: d.id })),
    [detectors],
  )

  async function release() {
    if (!releasing) return
    setReleaseBusy(true)
    setReleaseError('')
    try {
      const res = await notifications.releaseAlert(releasing)
      setReleased(res.released)
      setReleasing(null)
      load()
    } catch (err) {
      setReleaseError(
        err instanceof ApiError ? err.message : 'The alert state was not cleared.',
      )
    } finally {
      setReleaseBusy(false)
    }
  }

  // ── Open findings ───────────────────────────────────────────────────────────

  const openRows = useMemo(() => {
    if (open.status !== 'ok') return []
    return open.value.findings.filter((f) => {
      if (detectorFilter !== 'all' && f.id !== detectorFilter) return false
      if (statusFilter !== 'all' && f.status !== statusFilter) return false
      if (severityFilter !== 'all') {
        const sev = f.severity ?? byId.get(f.id)?.severity
        if (sev !== severityFilter) return false
      }
      return true
    })
  }, [open, detectorFilter, statusFilter, severityFilter, byId])

  const openColumns = useMemo<Column<OpenFinding>[]>(() => [
    {
      key: 'status',
      header: 'State',
      value: (f) => f.status,
      render: (f) => <StatusPill status={f.status} />,
    },
    {
      key: 'severity',
      header: 'Severity',
      value: (f) => f.severity ?? byId.get(f.id)?.severity ?? '',
      render: (f) => <Severity value={f.severity ?? byId.get(f.id)?.severity} />,
    },
    {
      key: 'id',
      header: 'Watch',
      value: (f) => f.id,
      render: (f) => (
        <span className="text-slate-200">
          {f.id}
          <span className="block text-slate-600 text-xs">{f.spec}</span>
        </span>
      ),
    },
    {
      key: 'headline',
      header: 'What is wrong',
      sortable: false,
      value: (f) => f.headline ?? f.reason ?? '',
      render: (f) => (
        <div className="max-w-xl">
          <p className={f.status === 'ok' ? 'text-slate-200' : 'text-orange-200'}>
            {f.headline ?? f.reason ?? '—'}
          </p>
          {f.action && (
            <p className="text-slate-500 text-xs mt-1 leading-relaxed">{f.action}</p>
          )}
          {f.status !== 'ok' && (
            <p className="text-slate-500 text-xs mt-1 leading-relaxed">
              {f.status === 'failed'
                ? 'This condition was NOT checked. Treat it as unknown, not as clear.'
                : 'This condition cannot be evaluated in this deployment, so it is not a clean result — it is an absent one.'}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'link',
      header: 'Record',
      sortable: false,
      hideOnMobile: true,
      value: (f) => linkFor(f.meta)?.label ?? '',
      render: (f) => {
        const through = linkFor(f.meta)
        return through ? (
          <Link
            href={through.href}
            className="inline-flex items-center gap-1 text-pink-400 hover:text-pink-300 text-xs underline underline-offset-2"
          >
            {through.label} <ExternalLink size={11} />
          </Link>
        ) : (
          <span className="text-slate-600 text-xs">—</span>
        )
      },
    },
  ], [byId])

  // ── Raised history ──────────────────────────────────────────────────────────

  const openKeys = useMemo(() => {
    if (open.status !== 'ok') return null
    return new Set(
      open.value.findings
        .filter((f) => f.status === 'ok' && typeof f.key === 'string')
        .map((f) => f.key as string),
    )
  }, [open])

  const raisedRows = useMemo(() => {
    if (raised.status !== 'ok') return []
    const from = range.since.getTime()
    const to = range.until.getTime()
    return raised.value.filter((r) => {
      if (detectorFilter !== 'all' && r.alert !== detectorFilter) return false
      if (severityFilter !== 'all' && byId.get(r.alert)?.severity !== severityFilter) return false
      if (!r.last_sent_at) return true   // never dated — never hidden by a range
      const t = new Date(r.last_sent_at).getTime()
      return Number.isNaN(t) || (t >= from && t <= to)
    })
  }, [raised, range, detectorFilter, severityFilter, byId])

  const raisedColumns = useMemo<Column<RaisedAlert>[]>(() => [
    {
      key: 'unresolved',
      header: 'Now',
      value: (r) => (openKeys?.has(r.key) ? 1 : 0),
      render: (r) => {
        if (openKeys === null) {
          return (
            <span className="text-slate-600 text-xs" title="The open scan could not be read.">
              unknown
            </span>
          )
        }
        return openKeys.has(r.key) ? (
          <span className="inline-flex items-center gap-1 bg-red-500/15 border border-red-500/30 text-red-300 rounded px-1.5 py-0.5 text-xs font-medium">
            <Siren size={11} /> still true
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-slate-500 text-xs">
            <CheckCircle2 size={11} /> not true now
          </span>
        )
      },
    },
    {
      key: 'severity',
      header: 'Severity',
      value: (r) => byId.get(r.alert)?.severity ?? '',
      render: (r) => <Severity value={byId.get(r.alert)?.severity} />,
    },
    {
      key: 'alert',
      header: 'Watch',
      value: (r) => r.alert,
      render: (r) => (
        <span className="text-slate-200">
          {r.alert}
          <span className="block text-slate-600 text-xs">{r.spec}</span>
        </span>
      ),
    },
    {
      key: 'key',
      header: 'Condition',
      value: (r) => r.key,
      render: (r) => (
        <code className="text-slate-300 text-xs break-all">{r.key}</code>
      ),
    },
    {
      key: 'last_sent_at',
      header: 'Last emailed',
      value: (r) => r.last_sent_at ?? '',
      render: (r) => (
        <span className="text-slate-300 text-xs whitespace-nowrap">
          {formatDateTime(r.last_sent_at)}
        </span>
      ),
    },
    {
      key: 'first_seen_at',
      header: 'First seen',
      hideOnMobile: true,
      value: (r) => r.first_seen_at ?? '',
      render: (r) => (
        <span className="text-slate-500 text-xs whitespace-nowrap">
          {formatDateTime(r.first_seen_at)}
        </span>
      ),
    },
    {
      key: 'occurrences',
      header: 'Times',
      align: 'right',
      value: (r) => r.occurrences,
      render: (r) => (
        <span className={r.occurrences > 1 ? 'text-amber-300' : 'text-slate-300'}>
          {formatCount(r.occurrences)}
        </span>
      ),
    },
    {
      key: 'window_hours',
      header: 'Quiet for',
      align: 'right',
      hideOnMobile: true,
      value: (r) => r.window_hours,
      render: (r) => (
        <span className="text-slate-500 text-xs">{formatCount(r.window_hours)} h</span>
      ),
    },
    {
      key: 'record',
      header: 'Record',
      sortable: false,
      hideOnMobile: true,
      value: (r) => linkFor(r.meta)?.label ?? '',
      render: (r) => {
        const through = linkFor(r.meta)
        return through ? (
          <Link
            href={through.href}
            className="inline-flex items-center gap-1 text-pink-400 hover:text-pink-300 text-xs underline underline-offset-2"
          >
            {through.label} <ExternalLink size={11} />
          </Link>
        ) : (
          <span className="text-slate-600 text-xs">—</span>
        )
      },
    },
    ...(mayRelease
      ? [{
          key: 'clear',
          header: '',
          sortable: false,
          value: () => '',
          render: (r: RaisedAlert) => (
            <button
              onClick={() => { setReleaseError(''); setReleasing(r.key) }}
              title="Forget this suppression state so the condition can alert again"
              className="text-slate-500 hover:text-red-300 text-xs underline underline-offset-2"
            >
              Clear
            </button>
          ),
        } as Column<RaisedAlert>]
      : []),
  ], [byId, openKeys, mayRelease])

  // ── Catalogue ───────────────────────────────────────────────────────────────

  const catColumns = useMemo<Column<AlertDetector>[]>(() => [
    {
      key: 'severity',
      header: 'Severity',
      value: (d) => d.severity,
      render: (d) => <Severity value={d.severity} />,
    },
    {
      key: 'id',
      header: 'Watch',
      value: (d) => d.id,
      render: (d) => (
        <span className="text-slate-200">
          {d.id}
          <span className="block text-slate-600 text-xs">{d.spec}</span>
        </span>
      ),
    },
    {
      key: 'watches',
      header: 'What it watches',
      sortable: false,
      value: (d) => d.watches,
      render: (d) => <span className="text-slate-300">{d.watches}</span>,
    },
    {
      key: 'threshold',
      header: 'Threshold',
      sortable: false,
      value: (d) => d.threshold,
      render: (d) => (
        <div className="max-w-md">
          <p className="text-slate-300">{d.threshold}</p>
          <p className="text-slate-600 text-xs mt-0.5">
            Set by <code>{d.threshold_setting}</code>
          </p>
        </div>
      ),
    },
    {
      key: 'audience',
      header: 'Who is told',
      sortable: false,
      hideOnMobile: true,
      value: (d) => d.audience.join(', '),
      render: (d) => <span className="text-slate-400 text-xs">{d.audience.join(', ')}</span>,
    },
    {
      key: 'repeat_hours',
      header: 'Quiet for',
      align: 'right',
      value: (d) => d.repeat_hours,
      render: (d) => <span className="text-slate-400 text-xs">{d.repeat_hours} h</span>,
    },
  ], [])

  if (authLoading) return <Loading label="Checking your access…" />
  if (!apiReady && apiError) return <ErrorState message={apiError} />
  if (!apiReady) return <Loading label="Waiting for the API session…" />
  if (!allowed) return <Denied what="the alert log" />

  const openNow = open.status === 'ok' ? open.value.open : null
  const didNotRun = open.status === 'ok' ? open.value.did_not_run.length : null
  const notApplicable = open.status === 'ok' ? open.value.not_applicable.length : null
  const stillTrue =
    raised.status === 'ok' && openKeys !== null
      ? raised.value.filter((r) => openKeys.has(r.key)).length
      : null

  return (
    <div className="max-w-[1600px] mx-auto space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white">Alerts</h1>
          <p className="text-slate-400 mt-1 text-sm max-w-3xl leading-relaxed">
            Every exception condition this system watches, what is true right now,
            and what has already been emailed about. An alert is keyed on the
            condition rather than on the scan, so a condition that stays true is
            emailed once per repeat window — and re-alerts immediately if it gets
            worse.
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3.5 py-2.5 text-sm transition-colors shrink-0"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {released && (
        <Warning onDismiss={() => setReleased('')}>
          Cleared <code className="break-all">{released}</code>. The next scan that
          finds this condition true will email about it again.
        </Warning>
      )}

      {role === 'observer' && (
        <Warning>
          You are signed in as the Observer. Everything here is readable to you;
          clearing a raised condition is an owner action and is not offered.
        </Warning>
      )}

      {/* Counters — three separate facts, never added together */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <Counter
          icon={<Siren size={16} className="text-red-400" />}
          label="Conditions true right now"
          value={openNow}
          tone={openNow && openNow > 0 ? 'bad' : 'ok'}
          hint="Every detector was run just now. This is what is wrong at this moment."
        />
        <Counter
          icon={<BellRing size={16} className="text-amber-300" />}
          label="Raised and still true"
          value={stillTrue}
          tone={stillTrue && stillTrue > 0 ? 'bad' : 'ok'}
          hint="Already emailed about and still unresolved — suppressed as a repeat until the window expires or it worsens."
        />
        <Counter
          icon={<ShieldQuestion size={16} className="text-orange-300" />}
          label="Checks that did not run"
          value={didNotRun}
          tone={didNotRun && didNotRun > 0 ? 'bad' : 'ok'}
          hint="A check that did not run is not a check that passed. Each one is listed with its reason."
        />
        <Counter
          icon={<HelpCircle size={16} className="text-slate-400" />}
          label="Cannot apply here"
          value={notApplicable}
          tone="neutral"
          hint="Conditions this deployment cannot evaluate at all — an absent reconciliation, not a clean one."
        />
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap items-center gap-2">
        {([
          ['open', 'Open now', openNow],
          ['raised', 'Raised', raised.status === 'ok' ? raised.value.length : null],
          ['watched', 'What is watched', detectors.length || null],
        ] as [Tab, string, number | null][]).map(([id, label, count]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
              tab === id
                ? 'bg-pink-500 text-white'
                : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-white'
            }`}
          >
            {label}
            {count !== null && <span className="ml-1.5 opacity-70">{count}</span>}
          </button>
        ))}

        <div className="flex-1" />

        <select
          value={detectorFilter}
          onChange={(e) => setDetectorFilter(e.target.value)}
          className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-pink-500"
        >
          <option value="all">Watch: all</option>
          {detectorOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        <select
          value={severityFilter}
          onChange={(e) => setSeverityFilter(e.target.value)}
          className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-pink-500"
        >
          <option value="all">Severity: all</option>
          <option value="critical">critical</option>
          <option value="warning">warning</option>
        </select>

        {tab === 'open' && (
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-pink-500"
          >
            <option value="all">State: all</option>
            <option value="ok">true now</option>
            <option value="failed">did not run</option>
            <option value="not_applicable">cannot apply here</option>
          </select>
        )}

        {tab === 'raised' && <DateRangePicker value={range} onChange={setRange} />}
      </div>

      {tab === 'raised' && (
        <p className="text-slate-600 text-xs leading-relaxed">
          The date range filters on when a condition was last emailed about. A row
          with no date on it is never hidden by the range — an undated row is a
          gap in the record, not an old one.
        </p>
      )}

      {/* Tables */}
      {tab === 'open' && (
        <DataTable<OpenFinding>
          rows={openRows}
          columns={openColumns}
          rowKey={(f) => f.key ?? `${f.id}:${f.status}`}
          loading={open.status === 'loading'}
          error={open.status === 'error' ? open.message : undefined}
          onRetry={load}
          searchPlaceholder="Search the headline, the watch or the reason…"
          searchKeys={['id', 'headline', 'status']}
          exportName="open-exceptions"
          emptyTitle="Nothing matched"
          emptyHint="Every detector ran and none of them is currently true. That is a clean scan, not an empty one."
        />
      )}

      {tab === 'raised' && (
        <DataTable<RaisedAlert>
          rows={raisedRows}
          columns={raisedColumns}
          rowKey={(r) => r.key}
          loading={raised.status === 'loading'}
          error={raised.status === 'error' ? raised.message : undefined}
          onRetry={load}
          searchPlaceholder="Search the condition key or the watch…"
          searchKeys={['key', 'alert']}
          exportName="alerts-raised"
          truncatedAt={500}
          emptyTitle="Nothing has been raised in this range"
          emptyHint="No condition has been emailed about inside these dates. Widen the range before reading that as quiet."
        />
      )}

      {tab === 'watched' && (
        <>
          {cat.status === 'ok' && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl px-5 py-4 flex items-start gap-3">
              <Eye size={16} className="text-slate-600 mt-0.5 shrink-0" />
              <p className="text-slate-400 text-sm leading-relaxed max-w-4xl">
                {cat.value.suppression}
              </p>
            </div>
          )}
          <DataTable<AlertDetector>
            rows={detectors.filter(
              (d) =>
                (detectorFilter === 'all' || d.id === detectorFilter) &&
                (severityFilter === 'all' || d.severity === severityFilter),
            )}
            columns={catColumns}
            rowKey={(d) => d.id}
            loading={cat.status === 'loading'}
            error={cat.status === 'error' ? cat.message : undefined}
            onRetry={load}
            searchPlaceholder="Search what is watched…"
            searchKeys={['id', 'watches', 'threshold']}
            exportName="alert-detectors"
            emptyTitle="No detector matches"
          />
        </>
      )}

      {releasing && (
        <ReleaseModal
          alertKey={releasing}
          busy={releaseBusy}
          error={releaseError}
          onClose={() => setReleasing(null)}
          onRelease={release}
        />
      )}
    </div>
  )
}

function Counter({
  icon, label, value, tone, hint,
}: {
  icon: React.ReactNode
  label: string
  value: number | null
  tone: 'ok' | 'bad' | 'neutral'
  hint: string
}) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3.5">
      <div className="flex items-center gap-2">
        {icon}
        <p className="text-slate-500 text-xs">{label}</p>
      </div>
      <p
        className={`text-2xl font-bold tabular-nums mt-1.5 ${
          value === null
            ? 'text-slate-600'
            : tone === 'bad' && value > 0
              ? 'text-red-300'
              : tone === 'neutral'
                ? 'text-slate-300'
                : 'text-white'
        }`}
      >
        {value === null ? '—' : formatCount(value)}
      </p>
      <p className="text-slate-600 text-xs mt-1 leading-relaxed">
        {value === null ? 'Could not be read — this is not a zero.' : hint}
      </p>
    </div>
  )
}

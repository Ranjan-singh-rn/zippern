'use client'

/**
 * The email delivery log — spec 8A.2.14 and 8A.2.15.
 *
 * This is the answer to "did the agency actually get their rejection reason",
 * and to "why has nothing arrived". Every attempted send leaves a row: what was
 * sent, to whom, when, and how it ended. The subject line is stored; the body
 * never is, and no credential is ever in one.
 *
 * **Failures are first, and they are first for a reason.** A payout receipt
 * that bounced is money the recipient does not know about. So the page opens on
 * the failure list, not on the full log — a full log sorted by time buries the
 * one row that matters under fifty that worked.
 *
 * Four outcome groups are kept apart, exactly as `services/email.py` keeps them
 * apart, because collapsing any two of them loses the fact that matters:
 *
 *   sent / delivered — the provider took it, and the mailbox took it
 *   failed          — FAILURE_OUTCOMES, which includes `queued`: a row stuck in
 *                     queued means the process died between recording the send
 *                     and the provider answering, so the outcome is genuinely
 *                     unknown, which is not the same as delivered
 *   withheld        — a deliberate decision not to send: a role that may not
 *                     read that figure, an address that muted the report, an
 *                     event already sent. Not a failure
 *   in flight       — deferred: the provider still has it and is retrying
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  Ban, CheckCircle2, Clock, Info, Mail, MailWarning, Paperclip, RefreshCw, Send, X,
} from 'lucide-react'

import { useAuth } from '@/components/AuthProvider'
import { ApiError, type ApiRole } from '@/lib/api'
import { Column, DataTable } from '@/components/ui/DataTable'
import { Denied, ErrorState, Loading, Warning } from '@/components/ui/States'
import {
  Delivery, DeliveryFailures, DeliveryList, DeliverySummary,
  formatCount, formatDateTime, notifications,
} from '@/lib/apiReports'

// ── Authority ─────────────────────────────────────────────────────────────────
//
// `/deliveries`, `/deliveries/failures` and `/deliveries/summary` are
// `require_internal` and then `_require_oversight`
// (backend/app/routers/notifications.py:59, 369, 399, 421) — owners, the
// Observer and team admins. A member sees their own work, not the company's
// mail: a subject line here reads "Payout approved — ₹75,000.00".

function isTeamAdmin(role: ApiRole): boolean {
  return role.endsWith('_admin')
}

function canRead(role: ApiRole): boolean {
  return role === 'owner' || role === 'observer' || isTeamAdmin(role)
}

// ── Outcome vocabulary ────────────────────────────────────────────────────────
//
// Every value `email.Outcome` can take (`services/email.py:68`), with what it
// actually means. The classification is not re-derived here: the failure list
// endpoint publishes `outcomes_counted_as_failure` and that is what decides.

const OUTCOMES: { value: string; label: string; meaning: string }[] = [
  { value: 'sent', label: 'sent', meaning: 'The provider accepted it.' },
  { value: 'delivered', label: 'delivered', meaning: 'The provider confirmed the mailbox took it.' },
  { value: 'queued', label: 'queued', meaning: 'Recorded, and the provider never answered. The outcome is unknown — this is counted as a failure.' },
  { value: 'failed', label: 'failed', meaning: 'The provider refused it, timed out, or threw.' },
  { value: 'bounced', label: 'bounced', meaning: 'The mailbox rejected it after the provider had accepted it. The address is dead.' },
  { value: 'dropped', label: 'dropped', meaning: 'The provider suppressed it — usually because of a prior bounce.' },
  { value: 'deferred', label: 'deferred', meaning: 'Temporarily refused; the provider is still retrying. Not yet a failure.' },
  { value: 'spam_report', label: 'spam_report', meaning: 'The recipient marked it as spam.' },
  { value: 'unsubscribed', label: 'unsubscribed', meaning: 'The recipient opted out at the provider.' },
  { value: 'no_address', label: 'no_address', meaning: 'There was nothing to send to — a gap in the staff or partner record.' },
  { value: 'not_configured', label: 'not_configured', meaning: 'No SENDGRID_API_KEY in this environment, so nothing was delivered at all.' },
  { value: 'withheld_role', label: 'withheld_role', meaning: 'Deliberately not sent: this role may not read that class of figure.' },
  { value: 'unsubscribed_local', label: 'unsubscribed_local', meaning: 'Deliberately not sent: an owner muted this report for this address.' },
  { value: 'suppressed_repeat', label: 'suppressed_repeat', meaning: 'Deliberately not sent: the same condition, inside its repeat window.' },
  { value: 'duplicate', label: 'duplicate', meaning: 'Deliberately not sent: this exact event had already gone out.' },
]

const MEANING = new Map(OUTCOMES.map((o) => [o.value, o.meaning]))

const GOOD = new Set(['sent', 'delivered'])
const WITHHELD = new Set([
  'withheld_role', 'unsubscribed_local', 'unsubscribed', 'suppressed_repeat', 'duplicate',
])

function OutcomePill({ outcome, failureSet }: { outcome: string; failureSet: Set<string> }) {
  const good = GOOD.has(outcome)
  const held = WITHHELD.has(outcome)
  // Whether an outcome counts as a failure is the API's decision, published on
  // the failure endpoint. If that call has not landed the set is empty, and an
  // outcome that is neither plainly good nor plainly withheld is *unclassified*
  // rather than fine — which the tooltip says rather than the colour implying.
  const classified = failureSet.size > 0
  const bad = failureSet.has(outcome)
  const skin = bad
    ? 'bg-red-500/15 text-red-300 border-red-500/35'
    : good
      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
      : held
        ? 'bg-slate-700/40 text-slate-400 border-slate-600'
        : 'bg-amber-500/15 text-amber-200 border-amber-500/30'
  const title =
    !classified && !good && !held
      ? 'The API’s list of failure outcomes could not be read, so whether this ' +
        'one counts as a failure is unknown on this screen.'
      : MEANING.get(outcome) ?? 'This outcome has no wording on this screen yet.'
  return (
    <span
      className={`inline-block border rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${skin}`}
      title={title}
    >
      {outcome}
    </span>
  )
}

// ── Detail panel ──────────────────────────────────────────────────────────────

function DeliveryPanel({
  row, failureSet, onClose,
}: {
  row: Delivery
  failureSet: Set<string>
  onClose: () => void
}) {
  const bad = failureSet.has(row.outcome)
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex justify-end" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl h-full bg-slate-900 border-l border-slate-800 overflow-y-auto"
      >
        <div className="px-6 py-4 border-b border-slate-800 flex items-start justify-between gap-3 sticky top-0 bg-slate-900">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <OutcomePill outcome={row.outcome} failureSet={failureSet} />
              <span className="text-slate-500 text-xs">{row.kind}</span>
            </div>
            <h3 className="text-white font-semibold mt-2 break-words">{row.subject}</h3>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white shrink-0">
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-5">
          {bad && (
            <div className="bg-red-500/10 border border-red-500/35 rounded-lg px-4 py-3">
              <p className="text-red-200 text-sm font-semibold">This did not reach anybody.</p>
              <p className="text-red-200/80 text-sm mt-1 leading-relaxed">
                {MEANING.get(row.outcome) ?? 'The outcome is not a success.'}
              </p>
              {row.error && (
                <p className="text-red-100 text-sm mt-2 leading-relaxed break-words">
                  {row.error}
                </p>
              )}
            </div>
          )}

          {/* The provider's own answer, unedited. `error` above adds a hint to
              it; this is the evidence with nothing added, because a reason that
              has been summarised is a reason somebody has to take on trust. */}
          {row.provider_error_body && (
            <div>
              <h4 className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-2">
                What the provider actually said
              </h4>
              {(row.provider_error_fields ?? []).length > 0 && (
                <p className="text-amber-300/90 text-xs mb-2">
                  Field(s) it named: {(row.provider_error_fields ?? []).join(', ')}
                </p>
              )}
              <pre className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-300 whitespace-pre-wrap break-words">
                {row.provider_error_body}
              </pre>
            </div>
          )}

          {row.sender && !row.sender.aligned && (
            <div className="bg-amber-500/10 border border-amber-500/35 rounded-lg px-4 py-3">
              <p className="text-amber-200 text-sm font-semibold">
                This was sent from an address that cannot pass DMARC.
              </p>
              <p className="text-amber-200/80 text-sm mt-1 leading-relaxed break-words">
                {row.sender.why}
              </p>
            </div>
          )}

          {!bad && row.error && (
            <div className="bg-slate-800/60 border border-slate-700 rounded-lg px-4 py-3">
              <p className="text-slate-300 text-sm leading-relaxed break-words">{row.error}</p>
            </div>
          )}

          <Facts
            rows={[
              ['To', row.to],
              ['Name on the record', row.to_name || '—'],
              ['Role', row.to_role ?? 'no role — an outside address'],
              ['Authorised by', row.authorised_by ?? '—'],
              ['Sensitivity', row.sensitivity],
              ['Spec', row.spec],
              ['Recorded', formatDateTime(row.queued_at)],
              ['Accepted by the provider', row.sent_at ? formatDateTime(row.sent_at) : '—'],
              ['Attempts', formatCount(row.attempts)],
              ['Provider', row.provider],
              ['Provider status', row.provider_status === null ? '—' : String(row.provider_status)],
              ['Provider message id', row.provider_message_id ?? '—'],
              ['Dedupe key', row.dedupe_key ?? '— (this send carries no dedupe key)'],
              ['Last provider event', row.last_provider_event ?? '—'],
            ]}
          />

          {(row.attachments ?? []).length > 0 && (
            <div>
              <h4 className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-2">
                Attachments
              </h4>
              <ul className="space-y-1">
                {(row.attachments ?? []).map((a) => (
                  <li key={a.filename} className="flex items-center gap-2 text-sm text-slate-300">
                    <Paperclip size={13} className="text-slate-600 shrink-0" />
                    <span className="break-all">{a.filename}</span>
                    <span className="text-slate-600 text-xs">
                      {formatCount(a.bytes)} bytes
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* A missing CSV is a stated omission, never something a reader has to
              notice. The email said the same thing; this is the record of it. */}
          {(row.attachments_omitted ?? []).length > 0 && (
            <div>
              <h4 className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-2">
                Left off, and why — the email still went
              </h4>
              <ul className="space-y-2">
                {(row.attachments_omitted ?? []).map((a) => (
                  <li key={a.filename} className="text-sm">
                    <div className="flex items-center gap-2 text-amber-200">
                      <Paperclip size={13} className="text-amber-500/60 shrink-0" />
                      <span className="break-all">{a.filename}</span>
                      <span className="text-slate-600 text-xs">
                        {formatCount(a.bytes)} bytes
                      </span>
                    </div>
                    <p className="text-slate-400 text-xs mt-1 leading-relaxed break-words">
                      {a.reason}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(row.events ?? []).length > 0 && (
            <div>
              <h4 className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-2">
                What the provider reported afterwards
              </h4>
              <ul className="space-y-2">
                {(row.events ?? []).map((e, i) => (
                  <li key={i} className="border-l-2 border-slate-800 pl-3">
                    <p className="text-slate-200 text-sm">
                      {e.event}{' '}
                      <span className="text-slate-600 text-xs">{formatDateTime(e.at)}</span>
                    </p>
                    {e.reason && (
                      <p className="text-slate-400 text-xs mt-0.5 leading-relaxed break-words">
                        {e.reason}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {Object.keys(row.meta ?? {}).length > 0 && (
            <div>
              <h4 className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-2">
                What it was about
              </h4>
              <Facts
                rows={Object.entries(row.meta ?? {}).map(([k, v]) => [
                  k.replace(/_/g, ' '),
                  v === null || v === undefined
                    ? '—'
                    : typeof v === 'object'
                      ? JSON.stringify(v)
                      : String(v),
                ])}
              />
            </div>
          )}

          <p className="text-slate-600 text-xs leading-relaxed">
            The subject line is stored; the body is not. A delivery record proves
            what was sent and to whom — it is not a second copy of the figures,
            and it never holds a credential.
          </p>
        </div>
      </div>
    </div>
  )
}

function Facts({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="divide-y divide-slate-800/70">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-4 py-2">
          <dt className="text-slate-500 text-xs capitalize shrink-0">{k}</dt>
          <dd className="text-slate-300 text-sm text-right break-all">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

type Slot<T> =
  | { status: 'loading' }
  | { status: 'ok'; value: T }
  | { status: 'error'; message: string }

/** Windows the API accepts: `hours`, 1 to 720 (`notifications.py:396,419`). */
const WINDOWS: { hours: number; label: string }[] = [
  { hours: 24, label: 'Last 24 hours' },
  { hours: 72, label: 'Last 3 days' },
  { hours: 168, label: 'Last 7 days' },
  { hours: 720, label: 'Last 30 days' },
]

/**
 * The page proper. Split out from the default export so the `useSearchParams`
 * inside it can sit behind a `<Suspense>` boundary — this app is a static
 * export (`next.config.js: output: 'export'`), and a client component reading
 * search params without one fails the build rather than the render.
 */
function EmailDeliveryLog() {
  const { apiUser, apiReady, apiError, loading: authLoading } = useAuth()

  // ── Arriving from somewhere with a filter already in mind ─────────────────
  //
  // `?kind=broadcast.<id>` is what the email composer links to after a send
  // (`app/broadcasts/email/page.tsx`, via `BroadcastResult.delivery_log`), so
  // "where did that broadcast actually go" lands on the rows for that one send
  // rather than on the whole log with the answer somewhere in it. `?to=` and
  // `?outcome=` work the same way for anyone linking to a single address.
  //
  // Read once, as the initial state, and not synced back to the URL: after the
  // first render these are ordinary filters the person is free to change, and a
  // URL that rewrote itself on every dropdown would make the back button useless.
  const params = useSearchParams()

  const [hours, setHours] = useState(() => {
    const raw = Number(params.get('hours'))
    return Number.isFinite(raw) && raw >= 1 && raw <= 720 ? raw : 168
  })
  const [outcome, setOutcome] = useState(() => params.get('outcome') ?? 'all')
  const [kind, setKind] = useState(() => params.get('kind') ?? 'all')
  const [to, setTo] = useState(() => params.get('to') ?? '')
  // A link that names a `kind` is a link to one send, and that send's ordinary
  // rows are the point of following it. Opening on the failure list would hide
  // them behind an empty table.
  const [failuresOnly, setFailuresOnly] = useState(() => !params.get('kind') && !params.get('to'))

  const [summary, setSummary] = useState<Slot<DeliverySummary>>({ status: 'loading' })
  const [failures, setFailures] = useState<Slot<DeliveryFailures>>({ status: 'loading' })
  const [log, setLog] = useState<Slot<DeliveryList>>({ status: 'loading' })
  const [selected, setSelected] = useState<Delivery | null>(null)

  const role = apiUser?.role ?? null
  const allowed = role !== null && canRead(role)

  const load = useCallback(() => {
    if (!allowed || !apiReady) return
    // `+00:00` rather than the `Z` that `toISOString` emits. This router parses
    // `since` with `datetime.fromisoformat` (notifications.py:88) rather than
    // through pydantic, and an explicit offset is accepted by every interpreter
    // version — a `Z` is not.
    const since = new Date(Date.now() - hours * 3600_000)
      .toISOString()
      .replace(/Z$/, '+00:00')

    function run<T>(p: Promise<T>, set: (s: Slot<T>) => void, what: string) {
      set({ status: 'loading' })
      p.then((value) => set({ status: 'ok', value })).catch((err: unknown) =>
        set({
          status: 'error',
          message: err instanceof ApiError ? err.message : `The ${what} could not be read.`,
        }),
      )
    }

    run(notifications.deliverySummary({ hours }), setSummary, 'delivery summary')
    run(notifications.deliveryFailures({ hours, limit: 500 }), setFailures, 'failure list')
    // `to` and `kind` are server-side filters — the log is capped at 500 rows,
    // so filtering in the browser over a partial fetch would quietly lie.
    run(
      notifications.deliveries({
        since,
        limit: 500,
        outcome: outcome === 'all' ? undefined : outcome,
        kind: kind === 'all' ? undefined : kind,
        to: to.trim() ? to.trim() : undefined,
      }),
      setLog,
      'delivery log',
    )
  }, [allowed, apiReady, hours, outcome, kind, to])

  useEffect(() => { load() }, [load])

  // The API decides what counts as a failure and publishes the list. Never
  // re-derived here — the precedent for guessing a response shape is a duplicate
  // UTR check that reported every duplicate as clean.
  const failureSet = useMemo(
    () =>
      new Set(
        failures.status === 'ok'
          ? failures.value.outcomes_counted_as_failure
          : [],
      ),
    [failures],
  )

  /** Every `kind` present in what was fetched, so the filter cannot go stale. */
  const kinds = useMemo(() => {
    const seen = new Set<string>()
    if (log.status === 'ok') log.value.deliveries.forEach((d) => seen.add(d.kind))
    if (failures.status === 'ok') failures.value.failures.forEach((d) => seen.add(d.kind))
    // A kind that arrived in the URL belongs in the list even before any row
    // carrying it has come back — otherwise following a link to a send whose
    // rows are still loading (or which returned nothing, which is itself the
    // answer) shows a filter box that has silently reset itself to "all" while
    // the query underneath is still filtered.
    if (kind !== 'all') seen.add(kind)
    return Array.from(seen).sort()
  }, [log, failures, kind])

  const columns = useMemo<Column<Delivery>[]>(() => [
    {
      key: 'outcome',
      header: 'Outcome',
      value: (d) => d.outcome,
      render: (d) => <OutcomePill outcome={d.outcome} failureSet={failureSet} />,
    },
    {
      key: 'queued_at',
      header: 'When',
      value: (d) => d.queued_at,
      render: (d) => (
        <span className="text-slate-300 text-xs whitespace-nowrap">
          {formatDateTime(d.queued_at)}
        </span>
      ),
    },
    {
      key: 'kind',
      header: 'What',
      value: (d) => d.kind,
      render: (d) => (
        <span className="text-slate-200 text-sm">
          {d.kind}
          <span className="block text-slate-600 text-xs">{d.spec}</span>
        </span>
      ),
    },
    {
      key: 'to',
      header: 'To',
      value: (d) => d.to,
      render: (d) => (
        <span className="text-slate-300 text-sm break-all">
          {d.to}
          {d.to_name && <span className="block text-slate-600 text-xs">{d.to_name}</span>}
        </span>
      ),
    },
    {
      key: 'subject',
      header: 'Subject',
      sortable: false,
      hideOnMobile: true,
      value: (d) => d.subject,
      render: (d) => (
        <span className="text-slate-400 text-sm break-words">{d.subject}</span>
      ),
    },
    {
      key: 'error',
      header: 'Cause',
      sortable: false,
      hideOnMobile: true,
      value: (d) => d.error ?? '',
      render: (d) =>
        d.error ? (
          <span
            className={`text-xs break-words ${
              failureSet.has(d.outcome) ? 'text-red-300' : 'text-slate-500'
            }`}
          >
            {d.error.length > 160 ? `${d.error.slice(0, 160)}…` : d.error}
          </span>
        ) : (
          <span className="text-slate-700 text-xs">—</span>
        ),
    },
  ], [failureSet])

  if (authLoading) return <Loading label="Checking your access…" />
  if (!apiReady && apiError) return <ErrorState message={apiError} />
  if (!apiReady) return <Loading label="Waiting for the API session…" />
  if (!allowed) return <Denied what="the email delivery log" />

  const rows =
    failuresOnly
      ? (failures.status === 'ok' ? failures.value.failures : [])
      : (log.status === 'ok' ? log.value.deliveries : [])

  const slotStatus = failuresOnly ? failures.status : log.status
  const slotMessage = failuresOnly
    ? (failures.status === 'error' ? failures.message : undefined)
    : (log.status === 'error' ? log.message : undefined)

  const s = summary.status === 'ok' ? summary.value : null
  const failureCount = failures.status === 'ok' ? failures.value.count : null

  return (
    <div className="max-w-[1600px] mx-auto space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white">Email delivery</h1>
          <p className="text-slate-400 mt-1 text-sm max-w-3xl leading-relaxed">
            Every attempted send: what was sent, to whom, and how it ended. This
            page opens on the failures, because a payout receipt that bounced is
            money the recipient does not know about — and it looks exactly like a
            partner who was told.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <select
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
            className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500"
          >
            {WINDOWS.map((w) => (
              <option key={w.hours} value={w.hours}>{w.label}</option>
            ))}
          </select>
          <button
            onClick={load}
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3.5 py-2.5 text-sm transition-colors"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {failureCount !== null && failureCount > 0 && (
        <div className="bg-red-500/10 border border-red-500/40 rounded-xl px-4 py-3.5 flex items-start gap-2.5">
          <MailWarning size={17} className="text-red-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-red-200 text-sm font-semibold">
              {formatCount(failureCount)} email
              {failureCount === 1 ? '' : 's'} did not reach anybody in this window.
            </p>
            <p className="text-red-200/80 text-sm mt-0.5 leading-relaxed">
              Read the cause on each row. A 403 means the sending address is not a
              verified sender and <em>nothing</em> is being delivered; a bounce
              means one address is dead and whoever is behind it has not been told
              what they think they were told.
            </p>
          </div>
        </div>
      )}

      {failures.status === 'error' && (
        <Warning>
          The failure list could not be read: {failures.message} Nothing on this
          page should be read as &ldquo;no failures&rdquo; until it loads.
        </Warning>
      )}

      {/* Counts by outcome — four groups, never added together */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <Tile
          icon={<CheckCircle2 size={16} className="text-emerald-400" />}
          label="Accepted or delivered"
          value={s?.sent ?? null}
          hint="The provider took it. `delivered` additionally means the mailbox did."
        />
        <Tile
          icon={<MailWarning size={16} className="text-red-400" />}
          label="Did not arrive"
          value={s?.failed ?? null}
          loud
          hint="Includes rows stuck in `queued`, whose outcome is genuinely unknown — which is not the same as delivered."
        />
        <Tile
          icon={<Ban size={16} className="text-slate-400" />}
          label="Deliberately withheld"
          value={s?.withheld ?? null}
          hint="A decision, not a failure: a role that may not read that figure, a muted address, an event already sent."
        />
        <Tile
          icon={<Clock size={16} className="text-amber-300" />}
          label="Still in flight"
          value={s?.in_flight ?? null}
          hint="Deferred — the provider still has it and is retrying. A deferral that never resolves ends as a bounce or a drop."
        />
      </div>

      {s && Object.keys(s.by_outcome).length > 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl px-5 py-4">
          <div className="flex items-start gap-2.5">
            <Info size={15} className="text-slate-600 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-slate-400 text-sm">
                Every outcome recorded since {formatDateTime(s.since)}:
              </p>
              <div className="flex flex-wrap gap-2 mt-2.5">
                {Object.entries(s.by_outcome)
                  .sort((a, b) => b[1] - a[1])
                  .map(([o, n]) => (
                    <button
                      key={o}
                      onClick={() => { setFailuresOnly(false); setOutcome(o) }}
                      className="flex items-center gap-1.5 bg-slate-800/60 hover:bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 transition-colors"
                    >
                      <OutcomePill outcome={o} failureSet={failureSet} />
                      <span className="text-slate-300 text-xs tabular-nums">{formatCount(n)}</span>
                    </button>
                  ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* View switch and server-side filters */}
      <div className="flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setFailuresOnly(true)}
            className={`flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
              failuresOnly
                ? 'bg-red-600 text-white'
                : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-white'
            }`}
          >
            <MailWarning size={14} /> Failures first
            {failureCount !== null && <span className="opacity-70">{failureCount}</span>}
          </button>
          <button
            onClick={() => setFailuresOnly(false)}
            className={`flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
              !failuresOnly
                ? 'bg-pink-500 text-white'
                : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-white'
            }`}
          >
            <Mail size={14} /> Everything sent
            {log.status === 'ok' && <span className="opacity-70">{log.value.count}</span>}
          </button>
        </div>

        <div className="flex-1" />

        {!failuresOnly && (
          <>
            <div className="relative">
              <Send size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="Exact recipient address…"
                className="bg-slate-900 border border-slate-800 rounded-lg pl-9 pr-3 py-2 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 w-full lg:w-64"
              />
            </div>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-pink-500"
            >
              <option value="all">What: all</option>
              {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <select
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
              className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-pink-500"
            >
              <option value="all">Outcome: all</option>
              {OUTCOMES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </>
        )}
      </div>

      {!failuresOnly && (to.trim() || kind !== 'all' || outcome !== 'all') && (
        <p className="text-slate-600 text-xs">
          Filtered by the API, not in this browser — the log is capped at 500 rows
          and filtering a partial fetch looks like it works and quietly lies.{' '}
          <button
            onClick={() => { setTo(''); setKind('all'); setOutcome('all') }}
            className="text-pink-400 hover:text-pink-300 underline underline-offset-2"
          >
            Clear
          </button>
        </p>
      )}

      {failuresOnly && failures.status === 'ok' && (
        <p className="text-slate-600 text-xs leading-relaxed">
          Counted as a failure: {failures.value.outcomes_counted_as_failure.join(', ')}.
          Window: {failures.value.window_hours} hours. The API publishes this list;
          this screen does not decide it.
        </p>
      )}

      <DataTable<Delivery>
        rows={rows}
        columns={columns}
        rowKey={(d) => d.id}
        loading={slotStatus === 'loading'}
        error={slotMessage}
        onRetry={load}
        onRowClick={setSelected}
        searchPlaceholder="Search the subject, the address or the cause…"
        searchKeys={['subject', 'to', 'kind', 'error']}
        exportName={failuresOnly ? 'email-failures' : 'email-deliveries'}
        truncatedAt={500}
        emptyTitle={failuresOnly ? 'Nothing failed in this window' : 'No delivery in this window'}
        emptyHint={
          failuresOnly
            ? 'Every send in this window either reached the provider or was deliberately withheld. Widen the window before reading this as always true.'
            : 'No email was attempted at all in this window. If a scheduled report was due, check the job health page — a job that never ran sends nothing and records nothing here.'
        }
      />

      {selected && (
        <DeliveryPanel
          row={selected}
          failureSet={failureSet}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}

/**
 * `useSearchParams` needs a Suspense boundary under `output: 'export'`. Without
 * one the build fails outright, so the boundary is not decoration — it is the
 * price of being able to link to a filtered log at all.
 */
export default function EmailDeliveryPage() {
  return (
    <Suspense fallback={<Loading label="Reading the delivery log…" />}>
      <EmailDeliveryLog />
    </Suspense>
  )
}

function Tile({
  icon, label, value, hint, loud,
}: {
  icon: React.ReactNode
  label: string
  value: number | null
  hint: string
  loud?: boolean
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
            : loud && value > 0
              ? 'text-red-300'
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

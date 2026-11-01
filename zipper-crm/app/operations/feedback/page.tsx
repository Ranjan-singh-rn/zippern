'use client'

/**
 * App feedback — the Operations view of `feedbackTickets`.
 *
 * This screen and /feedback read the SAME collection. They used to disagree
 * about what a status is: this one knew open/in_review/resolved, the other knew
 * open/assigned/in_progress/resolved/closed. A ticket support moved to
 * `assigned` simply vanished from this page, because the read was a Firestore
 * `where('status','==',tab)` against a vocabulary that did not contain it.
 *
 * Both screens now use the fuller vocabulary:
 *
 *     open → assigned → in_progress → resolved → closed
 *
 * `in_review` — the value this page used to write — is a legacy alias for
 * `in_progress` and is mapped on read, so no historical ticket disappears. The
 * original value stays on the document and is shown in the table until someone
 * deliberately changes the status, at which point the canonical value is written.
 *
 * The status filter is applied client-side against the normalised value, on
 * purpose: a server-side equality filter is what hid tickets in the first place.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Timestamp } from 'firebase/firestore'
import { tickets as apiTickets } from '@/lib/api'
import { useAuth } from '@/components/AuthProvider'
import { canAccess, type CrmRole } from '@/lib/auth'
import { getFeedbackTickets } from '@/lib/operations'
import {
  MessageSquare, Loader2, X, Eye, CheckCircle2, Clock, Image as ImageIcon,
  Search, Filter, History, AlertTriangle, UserCheck, AlertCircle,
} from 'lucide-react'
import { Denied, Empty, ErrorState, Loading, Warning } from '@/components/ui/States'

// ── The one vocabulary ────────────────────────────────────────────────────────
//
// Deliberately duplicated in app/feedback/page.tsx rather than added to
// lib/operations.ts: both screens must agree, and the shared lib is outside the
// scope of this change. If a third reader ever appears, lift this block.

const STATUSES = ['open', 'assigned', 'in_progress', 'resolved', 'closed'] as const
type Status = typeof STATUSES[number]

const STATUS_LABEL: Record<Status, string> = {
  open:        'Open',
  assigned:    'Assigned',
  in_progress: 'In Progress',
  resolved:    'Resolved',
  closed:      'Closed',
}

const STATUS_STYLE: Record<Status, string> = {
  open:        'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
  assigned:    'bg-blue-500/20 text-blue-400 border border-blue-500/30',
  in_progress: 'bg-amber-500/20 text-amber-400 border border-amber-500/30',
  resolved:    'bg-green-500/20 text-green-400 border border-green-500/30',
  closed:      'bg-slate-500/20 text-slate-400 border border-slate-500/30',
}

/** Values found in the data that are not canonical, and what they mean. */
const LEGACY_STATUS: Record<string, Status> = {
  in_review:     'in_progress',   // what this page used to write
  'in-review':   'in_progress',
  reviewing:     'in_progress',
  inprogress:    'in_progress',
  'in-progress': 'in_progress',
  working:       'in_progress',
  pending:       'open',
  new:           'open',
  claimed:       'assigned',
  done:          'resolved',
  complete:      'resolved',
  completed:     'resolved',
  fixed:         'resolved',
}

function normalizeStatus(raw: unknown): { status: Status; raw: string; legacy: boolean } {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if ((STATUSES as readonly string[]).includes(value)) {
    return { status: value as Status, raw: value, legacy: false }
  }
  const mapped = LEGACY_STATUS[value]
  if (mapped) return { status: mapped, raw: value, legacy: true }
  return { status: 'open', raw: value || '(none)', legacy: true }
}

/** The next status Operations would normally move a ticket to, or null at the end. */
function nextStatus(s: Status): Status | null {
  const i = STATUSES.indexOf(s)
  return i >= 0 && i < STATUSES.length - 1 ? STATUSES[i + 1] : null
}

// ── Priority and age ──────────────────────────────────────────────────────────

const PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const
type Priority = typeof PRIORITIES[number]

const PRIORITY_STYLE: Record<string, string> = {
  urgent: 'bg-red-500/20 text-red-400 border border-red-500/30',
  high:   'bg-orange-500/20 text-orange-400 border border-orange-500/30',
  medium: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
  low:    'bg-blue-500/20 text-blue-400 border border-blue-500/30',
}

const AGE_TARGET_HOURS: Record<string, number> = { urgent: 4, high: 12, medium: 48, low: 96 }
const TERMINAL: Status[] = ['resolved', 'closed']
const MIN_REASON = 6

// ── Document ──────────────────────────────────────────────────────────────────
//
// The collection holds two shapes — one written with issueType/description, one
// with subject/message/category. Both are read, because a row that renders blank
// is a row nobody acts on.

interface FeedbackDoc {
  id: string
  userId?: string
  userName?: string
  userPhone?: string
  issueType?: string
  category?: string
  subject?: string
  description?: string
  message?: string
  attachmentUrls?: string[]
  status?: string
  priority?: string
  assignedTo?: string
  response?: string
  statusNote?: string
  createdAt?: Timestamp | null
  occurredAt?: Timestamp | null
}

interface Ticket extends FeedbackDoc {
  norm: { status: Status; raw: string; legacy: boolean }
  typeText: string
  bodyText: string
  priorityKey: string
  attachments: string[]
}

function toTicket(d: FeedbackDoc): Ticket {
  return {
    ...d,
    norm: normalizeStatus(d.status),
    typeText: d.issueType || d.category || d.subject || 'general',
    bodyText: d.description || d.message || '',
    priorityKey: PRIORITIES.includes((d.priority ?? '') as Priority) ? (d.priority as string) : 'medium',
    attachments: Array.isArray(d.attachmentUrls) ? d.attachmentUrls : [],
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function msOf(ts: Timestamp | null | undefined): number | null {
  if (!ts) return null
  try { return ts.toMillis() } catch { return null }
}

function formatDate(ts: Timestamp | null | undefined): string {
  const ms = msOf(ts)
  if (ms == null) return '—'
  return new Date(ms).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

interface Age { label: string; overdue: boolean; targetHours: number; known: boolean }

function ageOf(t: Ticket): Age {
  const target = AGE_TARGET_HOURS[t.priorityKey] ?? AGE_TARGET_HOURS.medium
  const created = msOf(t.createdAt)
  if (created == null) return { label: 'no date', overdue: false, targetHours: target, known: false }
  const hours = (Date.now() - created) / 3_600_000
  const label =
    hours < 1 ? `${Math.max(0, Math.round(hours * 60))}m`
      : hours < 24 ? `${Math.floor(hours)}h`
        : `${Math.floor(hours / 24)}d`
  return {
    label,
    overdue: !TERMINAL.includes(t.norm.status) && hours > target,
    targetHours: target,
    known: true,
  }
}

function truncate(str: string, n = 80): string {
  return str.length > n ? str.slice(0, n) + '…' : str
}

// ── Access ────────────────────────────────────────────────────────────────────

const OPS_ROLES: CrmRole[] = ['ops_admin', 'ops_member', 'support_admin', 'support_member']

// ── Page ──────────────────────────────────────────────────────────────────────

interface Filters {
  search: string
  status: Status | 'all'
  type: string
  priority: string
}

const EMPTY_FILTERS: Filters = { search: '', status: 'all', type: 'all', priority: 'all' }

export default function OpsFeedbackPage() {
  const { crmUser, loading: authLoading } = useAuth()
  const allowed = !!crmUser && canAccess(crmUser, OPS_ROLES)

  const [tickets, setTickets] = useState<Ticket[]>([])
  const [fetching, setFetching] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [detail, setDetail] = useState<Ticket | null>(null)
  const [pending, setPending] = useState<{ ticket: Ticket; next: Status } | null>(null)

  const actorName = crmUser?.name || crmUser?.email || 'Operations'

  // Read EVERYTHING once, then filter locally. Filtering server-side by status
  // is exactly what made half the queue invisible from this page.
  const load = useCallback(async () => {
    setFetching(true)
    setLoadError('')
    try {
      const raw: FeedbackDoc[] = await getFeedbackTickets()
      setTickets(raw.map(toTicket))
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load feedback tickets.')
    } finally {
      setFetching(false)
    }
  }, [])

  useEffect(() => {
    if (authLoading || !allowed) return
    load()
  }, [authLoading, allowed, load])

  const typeOptions = useMemo(() => {
    const seen = new Set<string>()
    for (const t of tickets) seen.add(t.typeText)
    return Array.from(seen).sort()
  }, [tickets])

  const filtered = useMemo(() => tickets.filter((t) => {
    if (filters.status !== 'all' && t.norm.status !== filters.status) return false
    if (filters.type !== 'all' && t.typeText !== filters.type) return false
    if (filters.priority !== 'all' && t.priorityKey !== filters.priority) return false
    const q = filters.search.trim().toLowerCase()
    if (!q) return true
    return [t.userName, t.userPhone, t.userId, t.id, t.typeText, t.bodyText]
      .some((v) => (v ?? '').toLowerCase().includes(q))
  }), [tickets, filters])

  const counts = useMemo(() => {
    const by: Record<Status, number> = { open: 0, assigned: 0, in_progress: 0, resolved: 0, closed: 0 }
    let legacy = 0
    let overdue = 0
    for (const t of tickets) {
      by[t.norm.status] += 1
      if (t.norm.legacy) legacy += 1
      if (ageOf(t).overdue) overdue += 1
    }
    return { by, legacy, overdue }
  }, [tickets])

  async function writeStatus(ticket: Ticket, next: Status, reason: string) {
    // P1-D: the API writes the status (canonical — this is the migration) with
    // the reason as its note, audits it, and names the actor from the session.
    await apiTickets.update('feedback', ticket.id, { status: next }, reason)
    const updated: Ticket = {
      ...ticket,
      status: next,
      statusNote: reason,
      norm: { status: next, raw: next, legacy: false },
    }
    setTickets((prev) => prev.map((t) => (t.id === ticket.id ? updated : t)))
    setDetail((d) => (d && d.id === ticket.id ? updated : d))
  }

  if (authLoading) return <Loading label="Checking your access…" />
  if (!allowed) return <Denied what="app feedback" />

  const filtersActive =
    filters.status !== 'all' || filters.type !== 'all' ||
    filters.priority !== 'all' || !!filters.search.trim()

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2 flex-wrap">
          <MessageSquare size={22} className="text-blue-400" />
          App Feedback
          <span className="text-sm font-medium bg-blue-500/20 text-blue-300 border border-blue-500/30 px-2.5 py-0.5 rounded-full">
            {tickets.length} loaded
          </span>
          {counts.overdue > 0 && (
            <span className="text-sm font-medium bg-red-500/20 text-red-300 border border-red-500/30 px-2.5 py-0.5 rounded-full flex items-center gap-1">
              <Clock size={13} /> {counts.overdue} overdue
            </span>
          )}
        </h1>
        <p className="text-slate-400 text-sm mt-1">
          The same tickets Support sees at <code className="text-slate-300">/feedback</code>, on the
          same status vocabulary: {STATUSES.map((s) => STATUS_LABEL[s]).join(' → ')}.
        </p>
      </div>

      {counts.legacy > 0 && (
        <Warning>
          {counts.legacy} ticket{counts.legacy === 1 ? '' : 's'} still carr
          {counts.legacy === 1 ? 'ies' : 'y'} an older status such as{' '}
          <code>in_review</code>. They are listed under the value they map to and the original is
          shown in the Status column — nothing is hidden, and the document is only rewritten when
          someone changes the status here.
        </Warning>
      )}

      {actionError && (
        <div className="flex items-start justify-between gap-3 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3">
          <div className="flex items-start gap-2">
            <AlertTriangle size={15} className="text-red-400 mt-0.5 shrink-0" />
            <p className="text-red-300 text-sm">{actionError}</p>
          </div>
          <button onClick={() => setActionError('')} className="text-red-400 hover:text-red-200 shrink-0">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat icon={<AlertCircle size={15} className="text-yellow-400" />} label="Open" value={counts.by.open} tone="text-yellow-400" />
        <Stat icon={<UserCheck size={15} className="text-blue-400" />} label="Assigned" value={counts.by.assigned} tone="text-blue-400" />
        <Stat icon={<Clock size={15} className="text-amber-400" />} label="In Progress" value={counts.by.in_progress} tone="text-amber-400" />
        <Stat icon={<CheckCircle2 size={15} className="text-green-400" />} label="Resolved" value={counts.by.resolved} tone="text-green-400" />
      </div>

      {/* Search + filters */}
      <div className="flex flex-col lg:flex-row gap-3">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
            placeholder="Search user, phone, description, user id or ticket id…"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-9 pr-9 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
          />
          {filters.search && (
            <button
              onClick={() => setFilters((f) => ({ ...f, search: '' }))}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white"
            >
              <X size={14} />
            </button>
          )}
        </div>

        <select
          value={filters.type}
          onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value }))}
          className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500"
        >
          <option value="all">Issue type: all</option>
          {typeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>

        <select
          value={filters.priority}
          onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value }))}
          className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500"
        >
          <option value="all">Priority: all</option>
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      {/* Status tabs — every canonical status, with counts */}
      <div className="flex flex-wrap gap-2">
        {(['all', ...STATUSES] as const).map((s) => (
          <button
            key={s}
            onClick={() => setFilters((f) => ({ ...f, status: s }))}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              filters.status === s
                ? 'bg-pink-500 text-white'
                : 'bg-zinc-800 text-slate-400 hover:text-white border border-zinc-700'
            }`}
          >
            {s === 'all' ? `All (${tickets.length})` : `${STATUS_LABEL[s]} (${counts.by[s]})`}
          </button>
        ))}
      </div>

      {filtersActive && (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Filter size={12} />
          Showing {filtered.length} of {tickets.length}
          <button
            onClick={() => setFilters(EMPTY_FILTERS)}
            className="text-pink-400 hover:text-pink-300 underline underline-offset-2"
          >
            clear
          </button>
        </div>
      )}

      {/* Table */}
      <div className="bg-zinc-800 border border-zinc-700 rounded-xl overflow-hidden">
        {fetching ? (
          <Loading label="Loading feedback…" />
        ) : loadError ? (
          <ErrorState message={loadError} onRetry={load} />
        ) : tickets.length === 0 ? (
          <Empty
            icon={<MessageSquare size={28} />}
            title="No feedback tickets"
            hint="Feedback submitted from the app appears here."
          />
        ) : filtered.length === 0 ? (
          <Empty
            title="Nothing matches"
            hint="Try a different search, or pick another status tab."
            action={
              <button
                onClick={() => setFilters(EMPTY_FILTERS)}
                className="bg-zinc-700 hover:bg-zinc-600 text-slate-200 rounded-lg px-4 py-2 text-sm transition-colors"
              >
                Clear filters
              </button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[900px]">
              <thead>
                <tr className="border-b border-zinc-700">
                  {['User', 'Issue Type', 'Description', 'Files', 'Age', 'Status', 'Actions'].map((h) => (
                    <th key={h} className="text-left px-5 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => {
                  const age = ageOf(t)
                  const next = nextStatus(t.norm.status)
                  return (
                    <tr key={t.id} className="border-b border-zinc-700/50 hover:bg-zinc-700/30 transition-colors">
                      <td className="px-5 py-3 text-slate-200 whitespace-nowrap">
                        {t.userName || t.userPhone || t.userId || 'Unknown'}
                      </td>
                      <td className="px-5 py-3">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-700 text-slate-300 font-medium">
                          {t.typeText}
                        </span>
                        <span className={`ml-1.5 text-xs px-2 py-0.5 rounded-full font-medium ${PRIORITY_STYLE[t.priorityKey] ?? 'bg-zinc-700 text-slate-300'}`}>
                          {t.priorityKey}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-slate-400 max-w-[240px]">
                        {truncate(t.bodyText) || <span className="text-slate-600">—</span>}
                      </td>
                      <td className="px-5 py-3">
                        {t.attachments.length > 0 ? (
                          <span className="flex items-center gap-1.5 text-slate-300 text-xs">
                            <ImageIcon size={13} className="text-slate-400" />
                            {t.attachments.length}
                          </span>
                        ) : (
                          <span className="text-slate-600 text-xs">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3 whitespace-nowrap">
                        <span
                          className={`text-xs flex items-center gap-1 ${age.overdue ? 'text-red-300' : 'text-slate-400'}`}
                          title={
                            !age.known
                              ? 'No createdAt on this ticket.'
                              : age.overdue
                                ? `Past the ${age.targetHours}h target for a ${t.priorityKey} ticket.`
                                : `Target for ${t.priorityKey} is ${age.targetHours}h.`
                          }
                        >
                          <Clock size={11} /> {age.label}{age.overdue ? ' overdue' : ''}
                        </span>
                        <span className="text-slate-600 text-[11px]">{formatDate(t.createdAt)}</span>
                      </td>
                      <td className="px-5 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_STYLE[t.norm.status]}`}>
                          {STATUS_LABEL[t.norm.status]}
                        </span>
                        {t.norm.legacy && (
                          <span
                            className="mt-1 text-[11px] text-purple-300 flex items-center gap-1"
                            title={`Stored as "${t.norm.raw}" — mapped onto the shared vocabulary for display.`}
                          >
                            <History size={9} /> was “{t.norm.raw}”
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setDetail(t)}
                            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-slate-200 rounded-lg text-xs font-medium transition-colors"
                          >
                            <Eye size={12} />
                            View
                          </button>
                          {next ? (
                            <button
                              onClick={() => setPending({ ticket: t, next })}
                              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 border border-blue-500/30 rounded-lg text-xs font-medium transition-colors"
                            >
                              <CheckCircle2 size={11} />
                              {STATUS_LABEL[next]}
                            </button>
                          ) : (
                            <span className="text-slate-600 text-xs px-2.5">closed</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-slate-600 text-xs">
        The read is ordered by <code>createdAt</code> and capped at 200, so any ticket written
        without that field is not returned at all, and older feedback exists beyond this list.
      </p>

      {/* Detail */}
      {detail && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-2xl shadow-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-700 flex-shrink-0">
              <div className="min-w-0">
                <h2 className="text-white font-semibold">Feedback Detail</h2>
                <p className="text-slate-400 text-xs mt-0.5 truncate">
                  {detail.userName || detail.userId || 'Unknown'} · {detail.typeText} · {formatDate(detail.createdAt)}
                </p>
              </div>
              <button onClick={() => setDetail(null)} className="text-slate-500 hover:text-white transition-colors shrink-0">
                <X size={18} />
              </button>
            </div>

            <div className="px-6 py-5 space-y-5 overflow-y-auto flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-slate-500 text-xs">Status:</span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_STYLE[detail.norm.status]}`}>
                  {STATUS_LABEL[detail.norm.status]}
                </span>
                {detail.norm.legacy && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-300 border border-purple-500/30 flex items-center gap-1">
                    <History size={10} /> stored as “{detail.norm.raw}”
                  </span>
                )}
                <span className="text-slate-600 text-xs">· ticket {detail.id}</span>
              </div>

              <div>
                <p className="text-xs font-medium text-slate-400 mb-2 uppercase tracking-wide">Description</p>
                <p className="text-slate-200 text-sm leading-relaxed bg-zinc-800 rounded-lg p-4 whitespace-pre-wrap">
                  {detail.bodyText || 'No description provided.'}
                </p>
              </div>

              {detail.response && (
                <div>
                  <p className="text-xs font-medium text-green-400 mb-2 uppercase tracking-wide">Response sent to user</p>
                  <p className="text-green-300 text-sm bg-green-500/10 border border-green-500/30 rounded-lg p-4 whitespace-pre-wrap">
                    {detail.response}
                  </p>
                </div>
              )}

              {detail.statusNote && (
                <div>
                  <p className="text-xs font-medium text-slate-400 mb-1 uppercase tracking-wide">Last status note</p>
                  <p className="text-slate-300 text-sm">{detail.statusNote}</p>
                </div>
              )}

              {detail.occurredAt && (
                <div>
                  <p className="text-xs font-medium text-slate-400 mb-1 uppercase tracking-wide">Occurred At</p>
                  <p className="text-slate-300 text-sm">{formatDate(detail.occurredAt)}</p>
                </div>
              )}

              {detail.attachments.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-slate-400 mb-3 uppercase tracking-wide">
                    Attachments ({detail.attachments.length})
                  </p>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {detail.attachments.map((url, i) => (
                      <a
                        key={i}
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block rounded-lg overflow-hidden border border-zinc-700 hover:border-pink-500/50 transition-colors"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={url}
                          alt={`Attachment ${i + 1}`}
                          className="w-full h-28 object-cover bg-zinc-800"
                          onError={(e) => {
                            const target = e.currentTarget
                            target.style.display = 'none'
                          }}
                        />
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-zinc-700 flex flex-wrap gap-2 flex-shrink-0">
              <button
                onClick={() => setDetail(null)}
                className="flex-1 min-w-[120px] px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-slate-300 rounded-lg text-sm font-medium transition-colors border border-zinc-700"
              >
                Close
              </button>
              {STATUSES.filter((s) => s !== detail.norm.status).map((s) => (
                <button
                  key={s}
                  onClick={() => setPending({ ticket: detail, next: s })}
                  className="px-3 py-2 bg-blue-500/15 hover:bg-blue-500/25 border border-blue-500/30 text-blue-300 rounded-lg text-sm font-medium transition-colors"
                >
                  {STATUS_LABEL[s]}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {pending && (
        <ReasonModal
          title={`Move to “${STATUS_LABEL[pending.next]}”`}
          blurb={
            `The ticket is written with the shared status “${pending.next}”, replacing ` +
            `“${pending.ticket.norm.raw}”. Support sees the same value at /feedback. Your reason ` +
            `is stored on the ticket.`
          }
          confirmLabel={`Set ${STATUS_LABEL[pending.next]}`}
          placeholder="Reproduced on a test device; passed to Tech as a team ticket…"
          onCancel={() => setPending(null)}
          onConfirm={async (reason) => {
            await writeStatus(pending.ticket, pending.next, reason)
            setPending(null)
          }}
        />
      )}
    </div>
  )
}

// ── Bits ──────────────────────────────────────────────────────────────────────

function Stat({
  icon, label, value, tone,
}: {
  icon: React.ReactNode
  label: string
  value: number
  tone: string
}) {
  return (
    <div className="bg-zinc-800 border border-zinc-700 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-slate-400 text-sm">{label}</span>
      </div>
      <div className={`text-2xl font-bold ${tone}`}>{value}</div>
    </div>
  )
}

function ReasonModal({
  title, blurb, confirmLabel, placeholder, onCancel, onConfirm,
}: {
  title: string
  blurb: string
  confirmLabel: string
  placeholder: string
  onCancel: () => void
  onConfirm: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const tooShort = reason.trim().length < MIN_REASON

  async function submit() {
    if (tooShort || busy) return
    setBusy(true)
    setErr('')
    try {
      await onConfirm(reason.trim())
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That did not work.')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={busy ? undefined : onCancel} />
      <div className="relative w-full max-w-md bg-zinc-900 border border-zinc-700 rounded-2xl p-6 shadow-2xl">
        <h2 className="text-white font-semibold">{title}</h2>
        <p className="text-slate-400 text-sm mt-1 mb-4 leading-relaxed">{blurb}</p>

        <label className="block text-slate-400 text-xs font-medium uppercase tracking-wide mb-1.5">
          Reason (required)
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          autoFocus
          disabled={busy}
          placeholder={placeholder}
          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 disabled:opacity-60"
        />
        {tooShort && reason.length > 0 && (
          <p className="text-slate-500 text-xs mt-1">At least {MIN_REASON} characters.</p>
        )}

        {err && (
          <div className="flex items-start gap-2 mt-3 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
            <AlertTriangle size={14} className="text-red-400 mt-0.5 shrink-0" />
            <p className="text-red-300 text-sm">{err}</p>
          </div>
        )}

        <div className="flex gap-3 mt-5">
          <button
            onClick={onCancel}
            disabled={busy}
            className="flex-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-slate-300 font-medium rounded-lg px-4 py-2.5 text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || tooShort}
            className="flex-1 flex items-center justify-center gap-2 bg-pink-500 hover:bg-pink-600 disabled:bg-zinc-700 disabled:text-slate-500 text-white font-semibold rounded-lg px-4 py-2.5 text-sm transition-colors"
          >
            {busy && <Loader2 size={15} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

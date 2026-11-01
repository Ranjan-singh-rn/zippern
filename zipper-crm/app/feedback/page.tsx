'use client'

/**
 * Feedback & support — the support-team view of `feedbackTickets`.
 *
 * ── The status problem this page fixes ───────────────────────────────────────
 *
 * Two screens read this one collection and used to disagree about what a status
 * is. This one wrote open/assigned/in_progress/resolved/closed. Operations wrote
 * open/in_review/resolved. A ticket moved to `assigned` here was invisible over
 * there, and a ticket moved to `in_review` there showed up here as an unknown
 * status that no filter matched.
 *
 * The fuller vocabulary won, because it is the only one that can express the
 * states support actually works in:
 *
 *     open → assigned → in_progress → resolved → closed
 *
 * Everything else is treated as a legacy alias and mapped on read — `in_review`
 * becomes `in_progress`, `pending`/`new` become `open`, `done`/`completed`
 * become `resolved`. Nothing is rewritten in the database behind anyone's back:
 * the original value is kept next to the ticket and shown on the card, and the
 * document is only ever migrated when someone deliberately changes the status.
 *
 * ── Document shapes ──────────────────────────────────────────────────────────
 *
 * The same collection holds two shapes — one with subject/message/category, one
 * with issueType/description/attachmentUrls. Both are read here, because a
 * ticket that renders blank is a ticket nobody answers.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { db } from '@/lib/firebase'
import { useAuth } from '@/components/AuthProvider'
import { canAccess, type CrmRole } from '@/lib/auth'
import {
  getDocs, collection, query, orderBy, limit, Timestamp,
} from 'firebase/firestore'
import { tickets as apiTickets } from '@/lib/api'
import {
  MessageSquare, ChevronDown, ChevronUp, Search, AlertCircle, Clock,
  CheckCircle2, User, Send, X, UserCheck, Filter, History, AlertTriangle,
  Loader2, Paperclip,
} from 'lucide-react'
import { Denied, Empty, ErrorState, Loading, Warning } from '@/components/ui/States'

// ── The one vocabulary ────────────────────────────────────────────────────────
//
// Deliberately duplicated in app/operations/feedback/page.tsx rather than added
// to lib/operations.ts: both screens must agree, and the shared lib is outside
// the scope of this change. If a third reader ever appears, lift this block.

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
  in_review:   'in_progress',   // the Operations vocabulary
  'in-review': 'in_progress',
  reviewing:   'in_progress',
  inprogress:  'in_progress',
  'in-progress': 'in_progress',
  working:     'in_progress',
  pending:     'open',
  new:         'open',
  claimed:     'assigned',
  done:        'resolved',
  complete:    'resolved',
  completed:   'resolved',
  fixed:       'resolved',
}

/**
 * Map whatever is on the document onto the canonical vocabulary.
 *
 * Returns the raw value too, so an unrecognised status can be shown rather than
 * quietly folded into "open" as if it had always been there.
 */
function normalizeStatus(raw: unknown): { status: Status; raw: string; legacy: boolean } {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if ((STATUSES as readonly string[]).includes(value)) {
    return { status: value as Status, raw: value, legacy: false }
  }
  const mapped = LEGACY_STATUS[value]
  if (mapped) return { status: mapped, raw: value, legacy: true }
  // Unknown or missing. Treat as open so it is worked on, and say so on the card.
  return { status: 'open', raw: value || '(none)', legacy: true }
}

// ── Categories and priority ───────────────────────────────────────────────────

const CATEGORY_STYLE: Record<string, string> = {
  login:       'bg-purple-500/20 text-purple-400 border border-purple-500/30',
  payment:     'bg-green-500/20 text-green-400 border border-green-500/30',
  recharge:    'bg-blue-500/20 text-blue-400 border border-blue-500/30',
  video_call:  'bg-pink-500/20 text-pink-400 border border-pink-500/30',
  live_stream: 'bg-red-500/20 text-red-400 border border-red-500/30',
  account:     'bg-orange-500/20 text-orange-400 border border-orange-500/30',
  bug:         'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30',
  general:     'bg-slate-500/20 text-slate-400 border border-slate-500/30',
}

const CATEGORY_LABEL: Record<string, string> = {
  login: 'Login/Auth', payment: 'Payment', recharge: 'Recharge',
  video_call: 'Video Call', live_stream: 'Live Stream', account: 'Account',
  bug: 'Bug Report', general: 'General',
}

const PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const
type Priority = typeof PRIORITIES[number]

const PRIORITY_STYLE: Record<string, { chip: string; edge: string }> = {
  urgent: { chip: 'bg-red-500/20 text-red-400 border border-red-500/30',       edge: 'border-l-red-500' },
  high:   { chip: 'bg-orange-500/20 text-orange-400 border border-orange-500/30', edge: 'border-l-orange-500' },
  medium: { chip: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30', edge: 'border-l-yellow-500' },
  low:    { chip: 'bg-blue-500/20 text-blue-400 border border-blue-500/30',    edge: 'border-l-slate-700' },
}

/** Hours a ticket may sit before its age is flagged, by priority. */
const AGE_TARGET_HOURS: Record<string, number> = {
  urgent: 4, high: 12, medium: 48, low: 96,
}

/** Statuses where the clock has stopped. */
const TERMINAL: Status[] = ['resolved', 'closed']

const READ_LIMIT = 200
const MIN_REASON = 6

// ── Document ──────────────────────────────────────────────────────────────────

interface FeedbackDoc {
  id: string
  userId?: string
  userName?: string
  userPhone?: string
  category?: string
  issueType?: string       // the Operations shape calls it this
  subject?: string
  message?: string
  description?: string     // …and this
  attachmentUrls?: string[]
  status?: string
  priority?: string
  assignedTo?: string
  /** B1: written next to `assignedTo` when a ticket is claimed — the staff member's name. */
  assignedToName?: string
  assignedTeam?: string
  response?: string
  statusNote?: string
  createdAt?: Timestamp | null
  resolvedAt?: Timestamp | null
}

interface Ticket extends FeedbackDoc {
  norm: { status: Status; raw: string; legacy: boolean }
  subjectText: string
  bodyText: string
  categoryKey: string
  priorityKey: string
}

function toTicket(d: FeedbackDoc): Ticket {
  const norm = normalizeStatus(d.status)
  const categoryKey = (d.category ?? d.issueType ?? 'general').toString()
  const priorityKey = PRIORITIES.includes((d.priority ?? '') as Priority)
    ? (d.priority as string)
    : 'medium'
  return {
    ...d,
    norm,
    subjectText: d.subject || d.issueType || '(no subject)',
    bodyText: d.message || d.description || '',
    categoryKey,
    priorityKey,
  }
}

// ── Age ───────────────────────────────────────────────────────────────────────

function msOf(ts: Timestamp | null | undefined): number | null {
  if (!ts) return null
  try { return ts.toMillis() } catch { return null }
}

interface Age { label: string; overdue: boolean; targetHours: number; known: boolean }

function ageOf(t: Ticket): Age {
  const target = AGE_TARGET_HOURS[t.priorityKey] ?? AGE_TARGET_HOURS.medium
  const created = msOf(t.createdAt)
  if (created == null) return { label: 'no date', overdue: false, targetHours: target, known: false }
  const hours = (Date.now() - created) / 3_600_000
  const label =
    hours < 1 ? `${Math.max(0, Math.round(hours * 60))}m ago`
      : hours < 24 ? `${Math.floor(hours)}h ago`
        : `${Math.floor(hours / 24)}d ago`
  return {
    label,
    overdue: !TERMINAL.includes(t.norm.status) && hours > target,
    targetHours: target,
    known: true,
  }
}

// ── Access ────────────────────────────────────────────────────────────────────

const PAGE_ROLES: CrmRole[] = [
  'app_admin', 'app_member', 'support_admin', 'support_member', 'tech_admin', 'ops_admin',
]

// ── Page ──────────────────────────────────────────────────────────────────────

interface Filters {
  search: string
  status: Status | 'all'
  category: string
  priority: string
  assignee: string
}

const EMPTY_FILTERS: Filters = {
  search: '', status: 'all', category: 'all', priority: 'all', assignee: 'all',
}

export default function FeedbackPage() {
  const { crmUser, loading: authLoading } = useAuth()
  const allowed = !!crmUser && canAccess(crmUser, PAGE_ROLES)

  const [tickets, setTickets] = useState<Ticket[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [responses, setResponses] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [pendingStatus, setPendingStatus] = useState<{ ticket: Ticket; next: Status } | null>(null)

  const actorName = crmUser?.name || crmUser?.email || 'CRM'

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const snap = await getDocs(
        query(collection(db, 'feedbackTickets'), orderBy('createdAt', 'desc'), limit(READ_LIMIT)),
      )
      setTickets(snap.docs.map((d) => toTicket({ id: d.id, ...d.data() } as FeedbackDoc)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load feedback tickets.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (authLoading || !allowed) return
    load()
  }, [authLoading, allowed, load])

  const assigneeOptions = useMemo(() => {
    const seen = new Set<string>()
    for (const t of tickets) if (t.assignedTo) seen.add(t.assignedTo)
    return Array.from(seen).sort()
  }, [tickets])

  const categoryOptions = useMemo(() => {
    const seen = new Set<string>()
    for (const t of tickets) seen.add(t.categoryKey)
    return Array.from(seen).sort()
  }, [tickets])

  const filtered = useMemo(() => tickets.filter((t) => {
    if (filters.status !== 'all' && t.norm.status !== filters.status) return false
    if (filters.category !== 'all' && t.categoryKey !== filters.category) return false
    if (filters.priority !== 'all' && t.priorityKey !== filters.priority) return false
    if (filters.assignee === 'unassigned' && t.assignedTo) return false
    if (filters.assignee !== 'all' && filters.assignee !== 'unassigned' && t.assignedTo !== filters.assignee) return false
    const q = filters.search.trim().toLowerCase()
    if (!q) return true
    return [t.subjectText, t.bodyText, t.userName, t.userPhone, t.userId, t.id, t.assignedTo]
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

  async function writeStatus(ticket: Ticket, next: Status, note: string, extra: Record<string, unknown> = {}) {
    // P1-D: the API writes the ticket, audits it and names the actor from the
    // session. A `response` resolves the ticket server-side; anything else is a
    // status move whose note is the audit reason. The status is always written
    // canonical — this is still the migration.
    if (typeof extra.response === 'string') {
      await apiTickets.update('feedback', ticket.id, { response: extra.response })
    } else {
      await apiTickets.update('feedback', ticket.id, { status: next }, note)
    }
    setTickets((prev) => prev.map((t) => (
      t.id === ticket.id
        ? { ...t, ...extra, status: next, statusNote: note, norm: { status: next, raw: next, legacy: false } }
        : t
    )))
  }

  async function assignToMe(ticket: Ticket) {
    if (!crmUser) return
    setBusyId(ticket.id)
    setActionError('')
    try {
      // Claiming work is not destructive and the actor is recorded, so it does
      // not stop for a reason prompt — the status move it implies is `assigned`.
      // The server assigns the session's own staff record ("me").
      await apiTickets.update('feedback', ticket.id, { assignedTo: 'me' })
      setTickets((prev) => prev.map((t) => (
        t.id === ticket.id
          ? {
            ...t,
            assignedTo: crmUser.email || crmUser.uid,
            assignedToName: actorName,
            status: 'assigned',
            norm: { status: 'assigned', raw: 'assigned', legacy: false },
          }
          : t
      )))
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not assign this ticket.')
    } finally {
      setBusyId(null)
    }
  }

  async function updatePriority(ticket: Ticket, priority: string) {
    setBusyId(ticket.id)
    setActionError('')
    try {
      await apiTickets.update('feedback', ticket.id, { priority })
      setTickets((prev) => prev.map((t) => (
        t.id === ticket.id ? { ...t, priority, priorityKey: priority } : t
      )))
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not change the priority.')
    } finally {
      setBusyId(null)
    }
  }

  async function sendResponse(ticket: Ticket) {
    const response = (responses[ticket.id] ?? '').trim()
    if (response.length < MIN_REASON) {
      setActionError(`Write a response of at least ${MIN_REASON} characters before resolving.`)
      return
    }
    setBusyId(ticket.id)
    setActionError('')
    try {
      await writeStatus(ticket, 'resolved', response, { response })
      setResponses((prev) => ({ ...prev, [ticket.id]: '' }))
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not send the response.')
    } finally {
      setBusyId(null)
    }
  }

  if (authLoading) return <Loading label="Checking your access…" />
  if (!allowed) return <Denied what="user feedback" />

  const filtersActive =
    filters.status !== 'all' || filters.category !== 'all' ||
    filters.priority !== 'all' || filters.assignee !== 'all' || !!filters.search.trim()

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <MessageSquare className="w-7 h-7 text-pink-500" />
        <h1 className="text-2xl font-bold text-white">Feedback &amp; Support</h1>
        <span className="bg-pink-500/20 text-pink-400 border border-pink-500/30 text-sm px-3 py-1 rounded-full font-medium">
          {tickets.length} loaded
        </span>
        {counts.overdue > 0 && (
          <span className="bg-red-500/20 text-red-300 border border-red-500/30 text-sm px-3 py-1 rounded-full font-medium flex items-center gap-1">
            <Clock size={13} /> {counts.overdue} overdue
          </span>
        )}
      </div>

      <p className="text-slate-400 text-sm">
        One status vocabulary across both feedback screens:{' '}
        {STATUSES.map((s) => STATUS_LABEL[s]).join(' → ')}. Older values such as{' '}
        <code className="text-slate-300">in_review</code> are mapped on read and shown with their
        original next to them.
      </p>

      {counts.legacy > 0 && (
        <Warning>
          {counts.legacy} ticket{counts.legacy === 1 ? ' carries' : 's carry'} a status this
          vocabulary does not use. They are listed under the value they map to, and the original is
          shown on the card. The document is only rewritten when someone changes the status here.
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
        <Stat icon={<AlertCircle className="w-4 h-4 text-yellow-400" />} label="Open" value={counts.by.open} tone="text-yellow-400" />
        <Stat icon={<UserCheck className="w-4 h-4 text-blue-400" />} label="Assigned" value={counts.by.assigned} tone="text-blue-400" />
        <Stat icon={<Clock className="w-4 h-4 text-amber-400" />} label="In Progress" value={counts.by.in_progress} tone="text-amber-400" />
        <Stat icon={<CheckCircle2 className="w-4 h-4 text-green-400" />} label="Resolved" value={counts.by.resolved} tone="text-green-400" />
      </div>

      {/* Filters */}
      <div className="bg-slate-900 border border-slate-700 rounded-xl p-4 space-y-3">
        <div className="flex flex-col md:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="Search subject, message, name, phone, user id or ticket id…"
              value={filters.search}
              onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
              className="bg-slate-800 border border-slate-700 rounded-lg pl-10 pr-4 py-2 text-white placeholder:text-slate-500 w-full text-sm focus:outline-none focus:border-pink-500"
            />
          </div>
          <select
            value={filters.category}
            onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value }))}
            className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:border-pink-500"
          >
            <option value="all">All Categories</option>
            {categoryOptions.map((c) => (
              <option key={c} value={c}>{CATEGORY_LABEL[c] ?? c}</option>
            ))}
          </select>
          <select
            value={filters.priority}
            onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value }))}
            className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:border-pink-500"
          >
            <option value="all">All Priorities</option>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <select
            value={filters.assignee}
            onChange={(e) => setFilters((f) => ({ ...f, assignee: e.target.value }))}
            className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:border-pink-500"
          >
            <option value="all">All Assignees</option>
            <option value="unassigned">Unassigned</option>
            {assigneeOptions.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>

        <div className="flex flex-wrap gap-2">
          {(['all', ...STATUSES] as const).map((s) => (
            <button
              key={s}
              onClick={() => setFilters((f) => ({ ...f, status: s }))}
              className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
                filters.status === s
                  ? 'bg-pink-500 text-white'
                  : 'bg-slate-800 text-slate-400 border border-slate-700 hover:border-pink-500 hover:text-pink-400'
              }`}
            >
              {s === 'all' ? 'All' : STATUS_LABEL[s]}
              {s !== 'all' && <span className="ml-1 opacity-60">{counts.by[s]}</span>}
            </button>
          ))}
        </div>
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

      {/* List */}
      {loading ? (
        <Loading label="Loading feedback…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : tickets.length === 0 ? (
        <Empty
          icon={<MessageSquare size={28} />}
          title="No feedback yet"
          hint="Tickets submitted from the app land here."
        />
      ) : filtered.length === 0 ? (
        <Empty
          title="Nothing matches"
          hint="Try a different search or clear the filters."
          action={
            <button
              onClick={() => setFilters(EMPTY_FILTERS)}
              className="bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-4 py-2 text-sm transition-colors"
            >
              Clear filters
            </button>
          }
        />
      ) : (
        <div className="space-y-3">
          {filtered.map((ticket) => {
            const age = ageOf(ticket)
            const expanded = expandedId === ticket.id
            const edge = PRIORITY_STYLE[ticket.priorityKey]?.edge ?? 'border-l-slate-700'
            return (
              <div
                key={ticket.id}
                className={`bg-slate-800 border ${age.overdue ? 'border-red-500/40' : 'border-slate-700'} border-l-4 ${edge} rounded-xl overflow-hidden`}
              >
                {/* Row */}
                <div
                  className="p-4 cursor-pointer flex items-center gap-3 flex-wrap"
                  onClick={() => setExpandedId(expanded ? null : ticket.id)}
                >
                  <span className={`text-xs px-2 py-0.5 rounded font-medium uppercase tracking-wide shrink-0 ${
                    PRIORITY_STYLE[ticket.priorityKey]?.chip ?? 'bg-slate-700 text-slate-400'
                  }`}>
                    {ticket.priorityKey}
                  </span>

                  <span className={`text-xs px-2 py-0.5 rounded font-medium shrink-0 ${
                    CATEGORY_STYLE[ticket.categoryKey] ?? 'bg-slate-700 text-slate-400'
                  }`}>
                    {CATEGORY_LABEL[ticket.categoryKey] ?? ticket.categoryKey}
                  </span>

                  <span className={`text-xs px-2 py-0.5 rounded font-medium shrink-0 ${STATUS_STYLE[ticket.norm.status]}`}>
                    {STATUS_LABEL[ticket.norm.status]}
                  </span>

                  {ticket.norm.legacy && (
                    <span
                      className="text-xs px-2 py-0.5 rounded font-medium shrink-0 bg-purple-500/15 text-purple-300 border border-purple-500/30 flex items-center gap-1"
                      title={`Stored as "${ticket.norm.raw}", which is not part of the shared vocabulary. Shown as ${STATUS_LABEL[ticket.norm.status]}.`}
                    >
                      <History size={10} /> was “{ticket.norm.raw}”
                    </span>
                  )}

                  <div className="flex items-center gap-1 text-slate-300 text-sm shrink-0">
                    <User className="w-3.5 h-3.5 text-slate-500" />
                    <span>{ticket.userName || ticket.userPhone || ticket.userId || 'Unknown'}</span>
                  </div>

                  <div className="flex-1 text-white text-sm font-medium truncate min-w-[120px]">
                    {ticket.subjectText}
                  </div>

                  <span
                    className={`text-xs shrink-0 flex items-center gap-1 ${age.overdue ? 'text-red-300' : 'text-slate-500'}`}
                    title={
                      !age.known
                        ? 'No createdAt on this ticket.'
                        : age.overdue
                          ? `Past the ${age.targetHours}h target for a ${ticket.priorityKey} ticket.`
                          : `Target for ${ticket.priorityKey} is ${age.targetHours}h.`
                    }
                  >
                    <Clock size={11} /> {age.label}{age.overdue ? ' · overdue' : ''}
                  </span>

                  {expanded
                    ? <ChevronUp className="w-4 h-4 text-slate-400 shrink-0" />
                    : <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />}
                </div>

                {/* Detail */}
                {expanded && (
                  <div className="px-4 pb-4 border-t border-slate-700">
                    <div className="mt-3 mb-3">
                      <div className="text-slate-400 text-xs mb-1 uppercase tracking-wide">Message</div>
                      <div className="text-slate-200 text-sm bg-slate-700/50 rounded-lg p-3 whitespace-pre-wrap">
                        {ticket.bodyText || '(no message)'}
                      </div>
                    </div>

                    {(ticket.attachmentUrls?.length ?? 0) > 0 && (
                      <div className="mb-3">
                        <div className="text-slate-400 text-xs mb-2 uppercase tracking-wide flex items-center gap-1.5">
                          <Paperclip size={11} /> Attachments ({ticket.attachmentUrls?.length})
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {(ticket.attachmentUrls ?? []).map((url, i) => (
                            <a
                              key={i}
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-blue-300 hover:text-blue-200 underline underline-offset-2"
                            >
                              Attachment {i + 1}
                            </a>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="text-slate-400 text-xs mb-3">
                      <span className="text-slate-500">Ticket ID</span> {ticket.id}
                      {ticket.assignedTo && (
                        <>
                          {' · '}
                          <span className="text-slate-500">assigned to</span>{' '}
                          {ticket.assignedToName?.trim() ? (
                            <>
                              <span className="text-slate-200">{ticket.assignedToName.trim()}</span>{' '}
                              <span className="text-slate-500">({ticket.assignedTo})</span>
                            </>
                          ) : (
                            <span className="text-slate-200">{ticket.assignedTo}</span>
                          )}
                        </>
                      )}
                      {ticket.assignedTeam && <span className="ml-1 text-slate-500">({ticket.assignedTeam})</span>}
                    </div>

                    {ticket.response && (
                      <div className="mb-3">
                        <div className="text-green-400 text-xs mb-1 uppercase tracking-wide">Previous Response</div>
                        <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-3 text-green-300 text-sm whitespace-pre-wrap">
                          {ticket.response}
                        </div>
                      </div>
                    )}

                    {ticket.statusNote && (
                      <div className="mb-3 text-xs text-slate-500">
                        Last status note: <span className="text-slate-300">{ticket.statusNote}</span>
                      </div>
                    )}

                    <textarea
                      rows={3}
                      placeholder="Type your response to the user… (sending it resolves the ticket)"
                      value={responses[ticket.id] ?? ''}
                      onChange={(e) => setResponses((prev) => ({ ...prev, [ticket.id]: e.target.value }))}
                      className="bg-slate-700 border border-slate-600 rounded-lg px-4 py-2.5 text-white w-full mt-1 focus:outline-none focus:border-pink-500 placeholder:text-slate-400 text-sm resize-none"
                    />

                    <div className="flex flex-wrap items-center gap-2 mt-3">
                      <button
                        onClick={() => assignToMe(ticket)}
                        disabled={busyId === ticket.id}
                        className="flex items-center gap-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-200 text-sm px-3 py-1.5 rounded-lg transition-colors"
                      >
                        {busyId === ticket.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserCheck className="w-3.5 h-3.5" />}
                        Assign to Me
                      </button>

                      <select
                        value={ticket.priorityKey}
                        onChange={(e) => updatePriority(ticket, e.target.value)}
                        disabled={busyId === ticket.id}
                        className="bg-slate-700 border border-slate-600 rounded-lg px-3 py-1.5 text-slate-200 text-sm focus:outline-none focus:border-pink-500 disabled:opacity-50"
                      >
                        {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                      </select>

                      <select
                        value={ticket.norm.status}
                        onChange={(e) => setPendingStatus({ ticket, next: e.target.value as Status })}
                        disabled={busyId === ticket.id}
                        title="Changing status asks for a reason, which is stored on the ticket."
                        className="bg-slate-700 border border-slate-600 rounded-lg px-3 py-1.5 text-slate-200 text-sm focus:outline-none focus:border-pink-500 disabled:opacity-50"
                      >
                        {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                      </select>

                      <button
                        onClick={() => sendResponse(ticket)}
                        disabled={busyId === ticket.id || (responses[ticket.id] ?? '').trim().length < MIN_REASON}
                        title={
                          (responses[ticket.id] ?? '').trim().length < MIN_REASON
                            ? `Write at least ${MIN_REASON} characters first`
                            : 'Send the response and mark this resolved'
                        }
                        className="flex items-center gap-1.5 bg-pink-500 hover:bg-pink-600 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm px-4 py-1.5 rounded-lg transition-colors font-medium"
                      >
                        <Send className="w-3.5 h-3.5" />
                        Send &amp; Resolve
                      </button>

                      <button
                        onClick={() => setPendingStatus({ ticket, next: 'closed' })}
                        disabled={busyId === ticket.id || ticket.norm.status === 'closed'}
                        className="flex items-center gap-1.5 bg-slate-600 hover:bg-slate-500 disabled:opacity-40 text-slate-200 text-sm px-3 py-1.5 rounded-lg transition-colors"
                      >
                        <X className="w-3.5 h-3.5" />
                        Close
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {tickets.length >= READ_LIMIT && (
        <p className="text-amber-400/80 text-xs">
          Showing the newest {READ_LIMIT} tickets — older feedback exists beyond this list. The read
          is ordered by <code>createdAt</code>, so any ticket written without that field is not
          returned at all.
        </p>
      )}

      {pendingStatus && (
        <ReasonModal
          title={`Move to “${STATUS_LABEL[pendingStatus.next]}”`}
          blurb={
            `The ticket is written with the shared status “${pendingStatus.next}”, replacing ` +
            `“${pendingStatus.ticket.norm.raw}”. Your reason is stored on the ticket and both ` +
            `feedback screens will show the new status.`
          }
          confirmLabel={`Set ${STATUS_LABEL[pendingStatus.next]}`}
          placeholder="Reproduced the crash and handed it to Tech as a team ticket…"
          onCancel={() => setPendingStatus(null)}
          onConfirm={async (reason) => {
            await writeStatus(pendingStatus.ticket, pendingStatus.next, reason)
            setPendingStatus(null)
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
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={busy ? undefined : onCancel} />
      <div className="relative w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl p-6 shadow-2xl">
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
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 disabled:opacity-60"
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
            className="flex-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 font-medium rounded-lg px-4 py-2.5 text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || tooShort}
            className="flex-1 flex items-center justify-center gap-2 bg-pink-500 hover:bg-pink-600 disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold rounded-lg px-4 py-2.5 text-sm transition-colors"
          >
            {busy && <Loader2 size={15} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

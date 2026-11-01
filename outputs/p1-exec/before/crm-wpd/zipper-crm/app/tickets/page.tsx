'use client'

/**
 * App support tickets — the queue of things users have asked us for.
 *
 * Still a kanban, because status is the thing people move tickets through. What
 * it now also has:
 *
 *   • search across subject, message, user and ticket id
 *   • filters on priority, category and assignee
 *   • an age on every card, measured against a target that depends on priority,
 *     so "this has been sitting for four days" is visible without opening it
 *
 * Closing a ticket asks for a reason in a modal and records it on the document —
 * a ticket that vanishes with no explanation is how a queue rots quietly.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/components/AuthProvider'
import {
  canAccess, CrmRole, DEPT_NAMES, DEPT_LABELS, getDeptStaff,
  type Dept, type DeptStaffMember,
} from '@/lib/auth'
import { db } from '@/lib/firebase'
import { collection, doc, getDocs, query, serverTimestamp, updateDoc, where } from 'firebase/firestore'
import {
  getSupportTickets,
  getSupportTicketsByAssignee,
  respondToTicket,
  setSupportTicketStatus,
  setSupportTicketPriority,
  assignSupportTicket,
  routeSupportTicketToTeam,
  SupportTicketRecord,
  SupportTicketStatus,
  SupportTicketPriority,
  SupportTicketCategory,
} from '@/lib/firestore'
import {
  MessageSquare, Loader2, Check, AlertTriangle, X, Send, CheckCheck,
  ChevronRight, ArrowUpRight, UserCheck, Flame, Search, Clock, Filter,
} from 'lucide-react'
import type { Timestamp } from 'firebase/firestore'
import { Denied, Empty, ErrorState, Loading } from '@/components/ui/States'

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUSES: { key: SupportTicketStatus; label: string; color: string }[] = [
  { key: 'open',        label: 'Open',        color: 'border-yellow-500/40 bg-yellow-500/5' },
  { key: 'in_progress', label: 'In Progress', color: 'border-blue-500/40 bg-blue-500/5' },
  { key: 'replied',     label: 'Replied',     color: 'border-purple-500/40 bg-purple-500/5' },
  { key: 'closed',      label: 'Closed',      color: 'border-green-500/40 bg-green-500/5' },
]

const STATUS_ORDER: SupportTicketStatus[] = ['open', 'in_progress', 'replied', 'closed']

const PRIORITIES: SupportTicketPriority[] = ['critical', 'high', 'medium', 'low']

const PRIORITY_STYLE: Record<SupportTicketPriority, string> = {
  critical: 'bg-red-500/20 text-red-300 border border-red-500/30',
  high:     'bg-orange-500/20 text-orange-300 border border-orange-500/30',
  medium:   'bg-yellow-500/20 text-yellow-300 border border-yellow-500/30',
  low:      'bg-zinc-700/60 text-zinc-400 border border-zinc-600',
}

const CATEGORY_STYLE: Record<SupportTicketCategory, string> = {
  billing:       'bg-emerald-900/40 text-emerald-300',
  ban_appeal:    'bg-red-900/40 text-red-300',
  bug_report:    'bg-orange-900/40 text-orange-300',
  account_issue: 'bg-blue-900/40 text-blue-300',
  other:         'bg-zinc-700/60 text-zinc-400',
}

const CATEGORY_LABELS: Record<SupportTicketCategory, string> = {
  billing:       'Billing',
  ban_appeal:    'Ban Appeal',
  bug_report:    'Bug',
  account_issue: 'Account',
  other:         'Other',
}

/**
 * How long a ticket may sit before its age is flagged, in hours, by priority.
 * These are targets, not SLAs anyone signed — but a number on the card beats a
 * vague feeling that support is behind.
 */
const AGE_TARGET_HOURS: Record<SupportTicketPriority, number> = {
  critical: 4,
  high:     12,
  medium:   48,
  low:      96,
}

/** Statuses that stop the clock. A closed ticket is not "old", it is finished. */
const TERMINAL: SupportTicketStatus[] = ['closed']

// ── Types ─────────────────────────────────────────────────────────────────────

interface SupportMember {
  uid: string
  name: string
  role: CrmRole
}

type Msg = { type: 'success' | 'error'; text: string }

interface Filters {
  search: string
  priority: SupportTicketPriority | 'all'
  category: SupportTicketCategory | 'all'
  assignee: string  // uid | 'unassigned' | 'all'
}

const EMPTY_FILTERS: Filters = { search: '', priority: 'all', category: 'all', assignee: 'all' }

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(ts: Timestamp | null) {
  if (!ts) return '—'
  try { return new Date(ts.toMillis()).toLocaleDateString('en-IN') } catch { return '—' }
}

function formatDateTime(ts: Timestamp | null) {
  if (!ts) return '—'
  try { return new Date(ts.toMillis()).toLocaleString('en-IN') } catch { return '—' }
}

function msOf(ts: Timestamp | null): number | null {
  if (!ts) return null
  try { return ts.toMillis() } catch { return null }
}

interface Age {
  /** null when the ticket carries no usable createdAt — say so rather than guess. */
  hours: number | null
  label: string
  /** True when this ticket has run past the target for its priority. */
  overdue: boolean
  targetHours: number
}

function ageOf(ticket: SupportTicketRecord): Age {
  const target = AGE_TARGET_HOURS[ticket.priority] ?? AGE_TARGET_HOURS.medium
  const created = msOf(ticket.createdAt)
  if (created == null) {
    return { hours: null, label: 'no date', overdue: false, targetHours: target }
  }
  const hours = (Date.now() - created) / 3_600_000
  const label =
    hours < 1 ? `${Math.max(0, Math.round(hours * 60))}m`
      : hours < 24 ? `${Math.floor(hours)}h`
        : `${Math.floor(hours / 24)}d`
  return {
    hours,
    label,
    overdue: !TERMINAL.includes(ticket.status) && hours > target,
    targetHours: target,
  }
}

function matchesSearch(ticket: SupportTicketRecord, term: string): boolean {
  const q = term.trim().toLowerCase()
  if (!q) return true
  return [
    ticket.subject,
    ticket.message,
    ticket.userName,
    ticket.userId,
    ticket.id,
    ticket.assignedToName,
  ].some((v) => (v ?? '').toLowerCase().includes(q))
}

// ── Age chip ──────────────────────────────────────────────────────────────────

function AgeChip({ age, status }: { age: Age; status: SupportTicketStatus }) {
  if (age.hours == null) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-500"
        title="This ticket has no createdAt, so its age cannot be measured."
      >
        <Clock size={9} /> no date
      </span>
    )
  }
  const done = TERMINAL.includes(status)
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded ${
        age.overdue
          ? 'bg-red-500/15 text-red-300 border border-red-500/30'
          : done
            ? 'bg-slate-800 text-slate-500'
            : 'bg-slate-800 text-slate-400'
      }`}
      title={
        done
          ? 'Closed — the clock stopped.'
          : age.overdue
            ? `Open for ${age.label}, past the ${age.targetHours}h target for this priority.`
            : `Open for ${age.label}. Target for this priority is ${age.targetHours}h.`
      }
    >
      <Clock size={9} /> {age.label}{age.overdue ? ' overdue' : ''}
    </span>
  )
}

// ── Reason modal ──────────────────────────────────────────────────────────────

const MIN_REASON = 6

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

// ── Ticket card ───────────────────────────────────────────────────────────────

function TicketCard({
  ticket,
  isAdmin,
  onSelect,
  onAdvance,
}: {
  ticket: SupportTicketRecord
  isAdmin: boolean
  onSelect: (t: SupportTicketRecord) => void
  onAdvance: (t: SupportTicketRecord) => void
}) {
  const nextStatus = STATUS_ORDER[STATUS_ORDER.indexOf(ticket.status) + 1]
  const age = ageOf(ticket)

  return (
    <div
      className={`bg-slate-900 border rounded-lg p-3 space-y-2.5 cursor-pointer hover:border-slate-500 transition-colors ${
        age.overdue
          ? 'border-red-500/40'
          : ticket.escalatedTeam
            ? 'border-orange-500/40'
            : 'border-slate-700'
      }`}
      onClick={() => onSelect(ticket)}
    >
      <p className="text-white text-sm font-medium leading-snug line-clamp-2">
        {ticket.subject || ticket.message.slice(0, 80) || '(no subject)'}
      </p>

      <div className="flex flex-wrap gap-1.5">
        <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${PRIORITY_STYLE[ticket.priority]}`}>
          {ticket.priority}
        </span>
        <span className={`text-xs px-2 py-0.5 rounded-full ${CATEGORY_STYLE[ticket.category] ?? CATEGORY_STYLE.other}`}>
          {CATEGORY_LABELS[ticket.category] ?? ticket.category}
        </span>
        <AgeChip age={age} status={ticket.status} />
        {ticket.escalatedTeam && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-300 border border-orange-500/30 flex items-center gap-1">
            <Flame size={10} /> {DEPT_LABELS[ticket.escalatedTeam as Dept] ?? ticket.escalatedTeam}
          </span>
        )}
      </div>

      <div className="flex items-center justify-between text-xs text-slate-500">
        <div className="flex items-center gap-1.5 min-w-0">
          {ticket.userPhotoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={ticket.userPhotoUrl} alt="" className="w-4 h-4 rounded-full object-cover shrink-0" />
          ) : (
            <div className="w-4 h-4 rounded-full bg-slate-700 flex items-center justify-center text-slate-400 shrink-0" style={{ fontSize: 8 }}>
              {ticket.userName?.[0]?.toUpperCase() ?? '?'}
            </div>
          )}
          <span className="truncate max-w-[90px]">{ticket.userName || ticket.userId || 'Unknown'}</span>
        </div>
        <span className="shrink-0">{formatDate(ticket.createdAt)}</span>
      </div>

      {ticket.assignedToName ? (
        <div className="flex items-center gap-1 text-xs text-slate-500">
          <UserCheck size={11} />
          <span className="truncate">{ticket.assignedToName}</span>
        </div>
      ) : (
        <div className="flex items-center gap-1 text-xs text-slate-600">
          <UserCheck size={11} /> unassigned
        </div>
      )}

      {nextStatus && isAdmin && ticket.status !== 'closed' && (
        <button
          onClick={(e) => { e.stopPropagation(); onAdvance(ticket) }}
          className="w-full flex items-center justify-center gap-1 text-xs text-slate-400 hover:text-pink-400 border border-slate-700 hover:border-pink-500/50 rounded-md py-1 transition-colors"
        >
          → {STATUSES.find((s) => s.key === nextStatus)?.label}
          <ChevronRight size={11} />
        </button>
      )}
    </div>
  )
}

// ── Detail panel ──────────────────────────────────────────────────────────────

function DetailPanel({
  ticket,
  isAdmin,
  isSA,
  supportTeam,
  routedByName,
  onClose,
  onAction,
}: {
  ticket: SupportTicketRecord
  isAdmin: boolean
  isSA: boolean
  supportTeam: SupportMember[]
  routedByName: string
  onClose: () => void
  onAction: () => void
}) {
  const [replyText, setReplyText] = useState('')
  const [sending, setSending] = useState(false)
  const [escalateNote, setEscalateNote] = useState('')
  const [escalateTeam, setEscalateTeam] = useState<Dept>('tech')
  const [escalateAssignee, setEscalateAssignee] = useState('')
  const [teamStaff, setTeamStaff] = useState<DeptStaffMember[]>([])
  const [loadingStaff, setLoadingStaff] = useState(false)
  const [showEscalate, setShowEscalate] = useState(false)
  const [closing, setClosing] = useState(false)
  const [msg, setMsg] = useState<Msg | null>(null)

  const age = ageOf(ticket)

  useEffect(() => {
    if (!showEscalate) return
    setLoadingStaff(true)
    setEscalateAssignee('')
    getDeptStaff(escalateTeam)
      .then(setTeamStaff)
      .catch(() => setTeamStaff([]))
      .finally(() => setLoadingStaff(false))
  }, [escalateTeam, showEscalate])

  async function handleReply() {
    const reply = replyText.trim()
    if (!reply) return
    setSending(true)
    try {
      await respondToTicket(ticket.id, ticket.userId, reply)
      setMsg({ type: 'success', text: 'Reply sent.' })
      setReplyText('')
      onAction()
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Failed to send reply.' })
    } finally {
      setSending(false)
    }
  }

  async function handleAssign(uid: string, name: string) {
    setSending(true)
    try {
      await assignSupportTicket(ticket.id, uid, name)
      setMsg({ type: 'success', text: name ? `Assigned to ${name}.` : 'Unassigned.' })
      onAction()
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Failed to assign.' })
    } finally {
      setSending(false)
    }
  }

  async function handlePriority(p: SupportTicketPriority) {
    setSending(true)
    try {
      await setSupportTicketPriority(ticket.id, p)
      onAction()
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Failed to update priority.' })
    } finally {
      setSending(false)
    }
  }

  async function handleStatus(s: SupportTicketStatus) {
    if (s === 'closed') { setClosing(true); return }
    setSending(true)
    try {
      await setSupportTicketStatus(ticket.id, s)
      onAction()
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Failed to update status.' })
    } finally {
      setSending(false)
    }
  }

  async function handleEscalate() {
    if (escalateNote.trim().length < MIN_REASON) {
      setMsg({ type: 'error', text: `Say why this is being routed — at least ${MIN_REASON} characters.` })
      return
    }
    setSending(true)
    try {
      const assignee = teamStaff.find((m) => m.uid === escalateAssignee)
      await routeSupportTicketToTeam(
        ticket, escalateTeam, escalateNote.trim(), { name: routedByName },
        assignee ? { uid: assignee.uid, name: assignee.name } : undefined,
      )
      setShowEscalate(false)
      setEscalateNote('')
      setMsg({
        type: 'success',
        text: assignee
          ? `Routed to ${assignee.name} (${DEPT_LABELS[escalateTeam]}).`
          : `Routed to ${DEPT_LABELS[escalateTeam]} team.`,
      })
      onAction()
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Failed to route ticket.' })
    } finally {
      setSending(false)
    }
  }

  const canAssign = isAdmin || isSA

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      <div className="relative w-full max-w-lg bg-slate-900 border-l border-slate-700 h-full overflow-y-auto flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 flex-shrink-0 sticky top-0 bg-slate-900 z-10">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`text-xs px-2 py-0.5 rounded-full font-semibold shrink-0 ${PRIORITY_STYLE[ticket.priority]}`}>
              {ticket.priority}
            </span>
            <span className="text-white font-semibold text-sm truncate">
              {ticket.subject || 'Ticket'}
            </span>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white ml-3 shrink-0">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 p-5 space-y-5">
          {msg && (
            <div className={`flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-sm border ${
              msg.type === 'success'
                ? 'bg-green-500/10 border-green-500/30 text-green-400'
                : 'bg-red-500/10 border-red-500/30 text-red-400'
            }`}>
              <div className="flex items-center gap-1.5">
                {msg.type === 'success' ? <Check size={14} /> : <AlertTriangle size={14} />}
                {msg.text}
              </div>
              <button onClick={() => setMsg(null)}><X size={12} /></button>
            </div>
          )}

          {age.overdue && (
            <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2.5">
              <Clock size={14} className="text-red-400 mt-0.5 shrink-0" />
              <p className="text-red-200 text-sm">
                Open for {age.label} — past the {age.targetHours}h target for a{' '}
                {ticket.priority} ticket.
              </p>
            </div>
          )}

          {ticket.escalatedTeam && (
            <div className="bg-orange-500/10 border border-orange-500/30 rounded-lg p-3">
              <p className="text-orange-300 text-xs font-semibold flex items-center gap-1.5 mb-1">
                <Flame size={13} /> Routed to {DEPT_LABELS[ticket.escalatedTeam as Dept] ?? ticket.escalatedTeam} team — {formatDateTime(ticket.escalatedAt)}
              </p>
              {ticket.escalationNote && (
                <p className="text-slate-400 text-xs">{ticket.escalationNote}</p>
              )}
            </div>
          )}

          <div className="flex items-center gap-3 p-3 bg-slate-800 rounded-lg">
            {ticket.userPhotoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={ticket.userPhotoUrl} alt="" className="w-10 h-10 rounded-full object-cover shrink-0" />
            ) : (
              <div className="w-10 h-10 rounded-full bg-blue-500/20 flex items-center justify-center text-blue-400 font-bold shrink-0">
                {ticket.userName?.[0]?.toUpperCase() ?? '?'}
              </div>
            )}
            <div className="min-w-0">
              <p className="text-white text-sm font-medium truncate">{ticket.userName || 'Unknown'}</p>
              <p className="text-slate-500 text-xs">{formatDateTime(ticket.createdAt)}</p>
            </div>
            <div className="ml-auto flex flex-col items-end gap-1">
              <span className={`text-xs px-2 py-0.5 rounded-full ${CATEGORY_STYLE[ticket.category] ?? CATEGORY_STYLE.other}`}>
                {CATEGORY_LABELS[ticket.category] ?? ticket.category}
              </span>
              <span className="text-slate-600 text-[10px]">id {ticket.id}</span>
            </div>
          </div>

          {(isAdmin || isSA) && (
            <div>
              <p className="text-slate-500 text-xs font-semibold uppercase tracking-wide mb-2">Status</p>
              <div className="flex gap-2 flex-wrap">
                {STATUS_ORDER.map((s) => (
                  <button
                    key={s}
                    onClick={() => handleStatus(s)}
                    disabled={sending || ticket.status === s}
                    className={`text-xs px-3 py-1 rounded-full border transition ${
                      ticket.status === s
                        ? 'border-pink-500 bg-pink-500/20 text-pink-300'
                        : 'border-slate-700 text-slate-400 hover:border-slate-500 hover:text-white'
                    } disabled:opacity-50`}
                  >
                    {STATUSES.find((st) => st.key === s)?.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {(isAdmin || isSA) && (
            <div>
              <p className="text-slate-500 text-xs font-semibold uppercase tracking-wide mb-2">Priority</p>
              <div className="flex gap-2 flex-wrap">
                {PRIORITIES.map((p) => (
                  <button
                    key={p}
                    onClick={() => handlePriority(p)}
                    disabled={sending || ticket.priority === p}
                    className={`text-xs px-3 py-1 rounded-full border transition capitalize ${
                      ticket.priority === p
                        ? PRIORITY_STYLE[p]
                        : 'border-slate-700 text-slate-400 hover:border-slate-500 hover:text-white'
                    } disabled:opacity-50`}
                  >
                    {p}
                  </button>
                ))}
              </div>
              <p className="text-slate-600 text-[11px] mt-1.5">
                Priority sets the age target: {PRIORITIES.map((p) => `${p} ${AGE_TARGET_HOURS[p]}h`).join(' · ')}
              </p>
            </div>
          )}

          {canAssign && (
            <div>
              <p className="text-slate-500 text-xs font-semibold uppercase tracking-wide mb-2">
                Assign To
                {ticket.assignedToName && (
                  <span className="normal-case text-slate-400 font-normal ml-1">
                    — currently {ticket.assignedToName}
                  </span>
                )}
              </p>
              {supportTeam.length === 0 ? (
                <p className="text-slate-600 text-xs">
                  No active support staff found in <code>crmUsers</code>, so there is nobody to assign to.
                </p>
              ) : (
                <select
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-pink-500"
                  value={ticket.assignedTo}
                  onChange={(e) => {
                    const member = supportTeam.find((m) => m.uid === e.target.value)
                    if (member) handleAssign(member.uid, member.name)
                  }}
                  disabled={sending}
                >
                  <option value="">— Unassigned —</option>
                  {supportTeam.map((m) => (
                    <option key={m.uid} value={m.uid}>{m.name}</option>
                  ))}
                </select>
              )}
            </div>
          )}

          <div>
            <p className="text-slate-500 text-xs font-semibold uppercase tracking-wide mb-2">User Message</p>
            <div className="bg-slate-800 rounded-lg p-4 text-slate-200 text-sm leading-relaxed whitespace-pre-wrap">
              {ticket.message || <em className="text-slate-500">No message</em>}
            </div>
          </div>

          {ticket.adminReply && (
            <div>
              <p className="text-blue-300 text-xs font-semibold uppercase tracking-wide mb-2">Support Reply</p>
              <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4 text-slate-200 text-sm leading-relaxed whitespace-pre-wrap">
                {ticket.adminReply}
              </div>
              {ticket.repliedAt && (
                <p className="text-slate-600 text-xs mt-1">Replied {formatDateTime(ticket.repliedAt)}</p>
              )}
            </div>
          )}

          {ticket.status !== 'closed' && (
            <div>
              <p className="text-slate-500 text-xs font-semibold uppercase tracking-wide mb-2">
                {ticket.adminReply ? 'Update Reply' : 'Reply to User'}
              </p>
              <textarea
                rows={4}
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder="Type your reply to the user..."
                className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg p-3 text-sm focus:outline-none focus:border-blue-500 transition resize-none"
              />
              <div className="flex items-center gap-2 mt-2">
                <button
                  onClick={handleReply}
                  disabled={sending || !replyText.trim()}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/30 text-blue-400 rounded-lg text-sm font-medium transition disabled:opacity-50"
                >
                  {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                  Send Reply
                </button>
                <button
                  onClick={() => setClosing(true)}
                  disabled={sending}
                  className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 rounded-lg text-sm font-medium transition disabled:opacity-50"
                >
                  <CheckCheck size={14} />
                  Close Ticket
                </button>
              </div>
            </div>
          )}

          {canAssign && !ticket.escalatedTeam && ticket.status !== 'closed' && (
            <div>
              {!showEscalate ? (
                <button
                  onClick={() => setShowEscalate(true)}
                  className="flex items-center gap-2 text-sm text-orange-400 hover:text-orange-300 border border-orange-500/30 hover:border-orange-500/60 bg-orange-500/10 px-4 py-2 rounded-lg transition"
                >
                  <ArrowUpRight size={15} />
                  Route to Team
                </button>
              ) : (
                <div className="space-y-3">
                  <div>
                    <p className="text-orange-300 text-xs font-semibold uppercase tracking-wide mb-2">Assign To Team</p>
                    <div className="flex gap-2 flex-wrap">
                      {DEPT_NAMES.map((d) => (
                        <button
                          key={d}
                          onClick={() => setEscalateTeam(d)}
                          className={`text-xs px-3 py-1.5 rounded-full border transition ${
                            escalateTeam === d
                              ? 'border-orange-500 bg-orange-500/20 text-orange-300'
                              : 'border-slate-700 text-slate-400 hover:border-slate-500 hover:text-white'
                          }`}
                        >
                          {DEPT_LABELS[d]}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <p className="text-orange-300 text-xs font-semibold uppercase tracking-wide mb-2">
                      Assign To Person{' '}
                      <span className="text-slate-500 normal-case font-normal">(optional — leave unassigned for whole team)</span>
                    </p>
                    <select
                      value={escalateAssignee}
                      onChange={(e) => setEscalateAssignee(e.target.value)}
                      disabled={loadingStaff}
                      className="w-full bg-slate-800 border border-orange-500/30 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-orange-500 disabled:opacity-50"
                    >
                      <option value="">
                        {loadingStaff ? 'Loading team...' : `— Unassigned (${DEPT_LABELS[escalateTeam]} team) —`}
                      </option>
                      {teamStaff.map((m) => (
                        <option key={m.uid} value={m.uid}>{m.name}</option>
                      ))}
                    </select>
                  </div>

                  <p className="text-orange-300 text-xs font-semibold uppercase tracking-wide">
                    Reason (required — becomes the Team Ticket)
                  </p>
                  <textarea
                    rows={3}
                    value={escalateNote}
                    onChange={(e) => setEscalateNote(e.target.value)}
                    placeholder={`Describe why this is being routed to ${DEPT_LABELS[escalateTeam]}...`}
                    className="w-full bg-slate-800 border border-orange-500/30 text-white rounded-lg p-3 text-sm focus:outline-none focus:border-orange-500 transition resize-none"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={handleEscalate}
                      disabled={sending || escalateNote.trim().length < MIN_REASON}
                      className="flex items-center gap-2 px-4 py-2 bg-orange-500/20 hover:bg-orange-500/30 border border-orange-500/30 text-orange-300 rounded-lg text-sm font-medium transition disabled:opacity-50"
                    >
                      {sending ? <Loader2 size={14} className="animate-spin" /> : <ArrowUpRight size={14} />}
                      Confirm — Route to {DEPT_LABELS[escalateTeam]}
                    </button>
                    <button
                      onClick={() => setShowEscalate(false)}
                      className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-lg text-sm transition"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {ticket.status === 'closed' && (
            <div className="flex items-center gap-2 text-slate-500 text-sm py-2">
              <CheckCheck size={16} />
              <span>Ticket closed.</span>
            </div>
          )}
        </div>
      </div>

      {closing && (
        <ReasonModal
          title="Close this ticket"
          blurb="The ticket leaves the active queue. The reason is written onto the ticket so anyone reopening it later can see why it was closed."
          confirmLabel="Close ticket"
          placeholder="Resolved by refunding the failed recharge; user confirmed…"
          onCancel={() => setClosing(false)}
          onConfirm={async (reason) => {
            await updateDoc(doc(db, 'supportTickets', ticket.id), {
              status: 'closed',
              closeReason: reason,
              closedAt: serverTimestamp(),
              closedByName: routedByName,
            })
            setClosing(false)
            onAction()
          }}
        />
      )}
    </div>
  )
}

// ── Routed-to-my-team view (read-only) ────────────────────────────────────────

function EscalatedView({ tickets, team }: { tickets: SupportTicketRecord[]; team: Dept }) {
  const escalated = tickets.filter((t) => t.escalatedTeam === team)

  if (escalated.length === 0) {
    return (
      <Empty
        icon={<Flame size={28} />}
        title={`Nothing routed to ${DEPT_LABELS[team]}`}
        hint="Either support has not routed anything here, or your search and filters exclude it all."
      />
    )
  }

  return (
    <div className="space-y-3">
      {escalated.map((ticket) => {
        const age = ageOf(ticket)
        return (
          <div key={ticket.id} className="bg-slate-800 border border-orange-500/30 rounded-xl p-5 space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-white font-semibold text-sm">{ticket.subject || 'No subject'}</p>
                <p className="text-slate-400 text-xs mt-0.5">
                  {ticket.userName} — {formatDateTime(ticket.createdAt)}
                </p>
              </div>
              <div className="flex gap-1.5 shrink-0 flex-wrap justify-end">
                <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${PRIORITY_STYLE[ticket.priority]}`}>
                  {ticket.priority}
                </span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${CATEGORY_STYLE[ticket.category] ?? CATEGORY_STYLE.other}`}>
                  {CATEGORY_LABELS[ticket.category] ?? ticket.category}
                </span>
                <AgeChip age={age} status={ticket.status} />
              </div>
            </div>
            <div className="bg-slate-900 rounded-lg p-3 text-slate-300 text-sm leading-relaxed whitespace-pre-wrap">
              {ticket.message}
            </div>
            <div className="bg-orange-500/10 border border-orange-500/30 rounded-lg p-3">
              <p className="text-orange-300 text-xs font-semibold mb-1">
                Escalation Note — {formatDateTime(ticket.escalatedAt)}
              </p>
              <p className="text-slate-400 text-sm">{ticket.escalationNote || 'No note provided'}</p>
            </div>
            {ticket.adminReply && (
              <div>
                <p className="text-slate-500 text-xs font-semibold uppercase tracking-wide mb-1">Support Reply</p>
                <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 text-slate-300 text-sm">
                  {ticket.adminReply}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

const PAGE_ROLES: CrmRole[] = [
  'support_admin', 'support_member', 'tech_admin', 'tech_member',
]

export default function TicketsPage() {
  const { crmUser, loading: authLoading } = useAuth()
  const [tickets, setTickets] = useState<SupportTicketRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [supportTeam, setSupportTeam] = useState<SupportMember[]>([])
  const [selected, setSelected] = useState<SupportTicketRecord | null>(null)
  const [msg, setMsg] = useState<Msg | null>(null)
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)

  const role = crmUser?.role as CrmRole | undefined
  const isSA = role === 'superadmin'
  const isSupportAdmin = role === 'support_admin'
  const isSupportMember = role === 'support_member'
  const isTechRole = role === 'tech_admin' || role === 'tech_member'
  const isAdmin = isSA || isSupportAdmin
  const routedByName = crmUser?.name || crmUser?.email || 'Support'
  const allowed = !!crmUser && canAccess(crmUser, PAGE_ROLES)

  const load = useCallback(async () => {
    if (!crmUser) return
    setLoading(true)
    setLoadError('')
    try {
      const data = isSupportMember
        ? await getSupportTicketsByAssignee(crmUser.uid)
        : await getSupportTickets()
      setTickets(data)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load tickets.')
    } finally {
      setLoading(false)
    }
  }, [crmUser, isSupportMember])

  useEffect(() => {
    if (!isAdmin) return
    const q = query(
      collection(db, 'crmUsers'),
      where('role', 'in', ['support_admin', 'support_member']),
      where('isActive', '==', true),
    )
    getDocs(q)
      .then((snap) => {
        setSupportTeam(snap.docs.map((d) => ({
          uid: d.id,
          name: (d.data().name as string) ?? '',
          role: d.data().role as CrmRole,
        })))
      })
      .catch(() => setSupportTeam([]))
  }, [isAdmin])

  useEffect(() => {
    if (authLoading || !crmUser || !allowed) return
    load()
  }, [authLoading, crmUser, allowed, load])

  const refresh = useCallback(async () => {
    await load()
    setSelected(null)
  }, [load])

  // Assignees actually present on the data, so the filter is never a list of
  // people with nothing in the queue.
  const assigneeOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const t of tickets) {
      if (t.assignedTo) seen.set(t.assignedTo, t.assignedToName || t.assignedTo)
    }
    return Array.from(seen.entries()).sort((a, b) => a[1].localeCompare(b[1]))
  }, [tickets])

  const visible = useMemo(() => tickets.filter((t) => {
    if (filters.priority !== 'all' && t.priority !== filters.priority) return false
    if (filters.category !== 'all' && t.category !== filters.category) return false
    if (filters.assignee === 'unassigned' && t.assignedTo) return false
    if (filters.assignee !== 'all' && filters.assignee !== 'unassigned' && t.assignedTo !== filters.assignee) return false
    return matchesSearch(t, filters.search)
  }), [tickets, filters])

  const activeFilterCount =
    (filters.priority !== 'all' ? 1 : 0) +
    (filters.category !== 'all' ? 1 : 0) +
    (filters.assignee !== 'all' ? 1 : 0)

  async function handleAdvance(ticket: SupportTicketRecord) {
    const idx = STATUS_ORDER.indexOf(ticket.status)
    const next = STATUS_ORDER[idx + 1]
    if (!next) return
    if (next === 'closed') {
      // Closing needs a reason, so route it through the panel rather than
      // silently terminating the ticket from a one-click arrow.
      setSelected(ticket)
      return
    }
    try {
      await setSupportTicketStatus(ticket.id, next)
      load()
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Failed to update status.' })
    }
  }

  if (authLoading) return <Loading label="Checking your access…" />
  if (!allowed) return <Denied what="support tickets" />

  const byStatus = (status: SupportTicketStatus) => visible.filter((t) => t.status === status)
  const openCount = tickets.filter((t) => t.status === 'open').length
  const criticalCount = tickets.filter((t) => t.priority === 'critical' && t.status !== 'closed').length
  const overdueCount = tickets.filter((t) => ageOf(t).overdue).length

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-2 flex-wrap">
          <MessageSquare size={26} className="text-blue-400" />
          Support Tickets
          {openCount > 0 && (
            <span className="text-sm font-semibold bg-yellow-500/20 text-yellow-300 px-2.5 py-0.5 rounded-full">
              {openCount} open
            </span>
          )}
          {criticalCount > 0 && (
            <span className="text-sm font-semibold bg-red-500/20 text-red-300 px-2.5 py-0.5 rounded-full flex items-center gap-1">
              <Flame size={13} /> {criticalCount} critical
            </span>
          )}
          {overdueCount > 0 && (
            <span className="text-sm font-semibold bg-red-500/20 text-red-300 px-2.5 py-0.5 rounded-full flex items-center gap-1">
              <Clock size={13} /> {overdueCount} overdue
            </span>
          )}
        </h1>
        <p className="text-slate-400 mt-1 text-sm">
          {isTechRole
            ? 'Tickets routed to your team from support'
            : isSupportMember
              ? 'Tickets assigned to you'
              : 'All support tickets — open one to reply, assign or route it'}
          {' · '}
          <span className="text-slate-500">
            age target by priority: {PRIORITIES.map((p) => `${p} ${AGE_TARGET_HOURS[p]}h`).join(', ')}
          </span>
        </p>
      </div>

      {/* Search + filters */}
      <div className="flex flex-col lg:flex-row gap-3">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
            placeholder="Search subject, message, user name, user id or ticket id…"
            className="w-full bg-slate-900 border border-slate-800 rounded-lg pl-9 pr-9 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
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
          value={filters.priority}
          onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value as Filters['priority'] }))}
          className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500"
        >
          <option value="all">Priority: all</option>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>

        <select
          value={filters.category}
          onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value as Filters['category'] }))}
          className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500"
        >
          <option value="all">Category: all</option>
          {(Object.keys(CATEGORY_LABELS) as SupportTicketCategory[]).map((c) => (
            <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
          ))}
        </select>

        <select
          value={filters.assignee}
          onChange={(e) => setFilters((f) => ({ ...f, assignee: e.target.value }))}
          className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500"
        >
          <option value="all">Assignee: all</option>
          <option value="unassigned">Unassigned</option>
          {assigneeOptions.map(([uid, name]) => (
            <option key={uid} value={uid}>{name}</option>
          ))}
        </select>
      </div>

      {(activeFilterCount > 0 || filters.search) && (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Filter size={12} />
          Showing {visible.length} of {tickets.length} tickets
          <button
            onClick={() => setFilters(EMPTY_FILTERS)}
            className="text-pink-400 hover:text-pink-300 underline underline-offset-2"
          >
            clear
          </button>
        </div>
      )}

      {msg && (
        <div className={`flex items-center justify-between gap-2 px-4 py-3 rounded-xl text-sm border ${
          msg.type === 'success'
            ? 'bg-green-500/10 border-green-500/30 text-green-400'
            : 'bg-red-500/10 border-red-500/30 text-red-400'
        }`}>
          <div className="flex items-center gap-2">
            {msg.type === 'success' ? <Check size={15} /> : <AlertTriangle size={15} />}
            {msg.text}
          </div>
          <button onClick={() => setMsg(null)}><X size={13} /></button>
        </div>
      )}

      {loading ? (
        <Loading label="Loading tickets…" />
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={load} />
      ) : tickets.length === 0 ? (
        <Empty
          icon={<MessageSquare size={28} />}
          title="No tickets yet"
          hint={isSupportMember ? 'Nothing is assigned to you right now.' : 'Nothing has come in from the app.'}
        />
      ) : isTechRole ? (
        <EscalatedView tickets={visible} team="tech" />
      ) : visible.length === 0 ? (
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
        /* Kanban — horizontally scrollable on narrow screens rather than squashed */
        <div className="-mx-4 px-4 overflow-x-auto sm:mx-0 sm:px-0 sm:overflow-visible">
          <div className="flex gap-4 min-w-[900px] sm:min-w-0 sm:grid sm:grid-cols-2 xl:grid-cols-4">
            {STATUSES.map(({ key, label, color }) => {
              const items = byStatus(key)
              return (
                <div key={key} className={`border rounded-xl p-4 w-72 sm:w-auto shrink-0 ${color}`}>
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-semibold text-white text-sm">{label}</h3>
                    <span className="text-xs bg-slate-800/80 text-slate-400 px-2 py-0.5 rounded-full">
                      {items.length}
                    </span>
                  </div>
                  <div className="space-y-3 min-h-[140px]">
                    {items.map((ticket) => (
                      <TicketCard
                        key={ticket.id}
                        ticket={ticket}
                        isAdmin={isAdmin}
                        onSelect={setSelected}
                        onAdvance={handleAdvance}
                      />
                    ))}
                    {items.length === 0 && (
                      <p className="text-slate-600 text-xs text-center pt-8">No tickets</p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {selected && (
        <DetailPanel
          ticket={selected}
          isAdmin={isAdmin}
          isSA={isSA}
          supportTeam={supportTeam}
          routedByName={routedByName}
          onClose={() => setSelected(null)}
          onAction={refresh}
        />
      )}
    </div>
  )
}
